import nodemailer, { type Transporter } from 'nodemailer';
import { createConnection, type Socket } from 'node:net';
import type { EmailAccount } from '../config.js';
import {
  prepareOutgoingMessage,
  type OutgoingMessage,
} from '../domain/outgoing-message.js';
import { loadCredentials } from '../security/keychain.js';
import { getValidAccessToken } from '../security/oauth2.js';

export type SmtpSecurityMode = NonNullable<EmailAccount['smtpSecurity']>;

export interface SmtpClientOptions {
  securityMode?: SmtpSecurityMode;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function resolveSmtpSecurityMode(
  host: string,
  port: number,
  requestedMode?: SmtpSecurityMode
): SmtpSecurityMode {
  const mode = requestedMode ?? (port === 465 ? 'tls' : 'starttls');
  if (mode === 'plain' && !isLoopbackHost(host)) {
    throw new Error('Plain SMTP is allowed only for localhost');
  }
  return mode;
}

function smtpTransportSecurityOptions(mode: SmtpSecurityMode): {
  secure: boolean;
  requireTLS: boolean;
  ignoreTLS: boolean;
  tls?: { rejectUnauthorized: true };
} {
  return {
    secure: mode === 'tls',
    requireTLS: mode === 'starttls',
    ignoreTLS: mode === 'plain',
    ...(mode === 'plain' ? {} : { tls: { rejectUnauthorized: true as const } }),
  };
}

/** Remove the top-level Bcc field while preserving its recipients in the SMTP envelope. */
export function stripBccHeader(rawMessage: Buffer): Buffer {
  const crlfSeparator = Buffer.from('\r\n\r\n');
  const lfSeparator = Buffer.from('\n\n');
  let separator = crlfSeparator;
  let separatorIndex = rawMessage.indexOf(separator);
  let newline = '\r\n';

  if (separatorIndex < 0) {
    separator = lfSeparator;
    separatorIndex = rawMessage.indexOf(separator);
    newline = '\n';
  }
  if (separatorIndex < 0) return rawMessage;

  const headerLines = rawMessage.subarray(0, separatorIndex).toString('latin1').split(newline);
  const retained: string[] = [];
  let removingBcc = false;

  for (const line of headerLines) {
    if (!/^[ \t]/.test(line)) {
      removingBcc = /^bcc\s*:/i.test(line);
    }
    if (!removingBcc) retained.push(line);
  }

  if (retained.length === headerLines.length) return rawMessage;
  return Buffer.concat([
    Buffer.from(retained.join(newline), 'latin1'),
    separator,
    rawMessage.subarray(separatorIndex + separator.length),
  ]);
}

export interface SmtpSendResult {
  accepted: string[];
  rejected: string[];
  messageId: string;
  response?: string;
  rawMessage: Buffer;
}

export interface SmtpComposedMessage {
  rawMessage: Buffer;
  messageId: string;
  envelope: Record<string, unknown>;
}

export class SmtpSendError extends Error {
  constructor(
    message: string,
    public readonly messageId: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'SmtpSendError';
  }
}

export class SmtpRecipientRejectedError extends Error {
  constructor(
    message: string,
    public readonly messageId: string,
    public readonly rejected: string[],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'SmtpRecipientRejectedError';
  }
}

export class SmtpPreflightError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Unable to compose outgoing message', { cause });
    this.name = 'SmtpPreflightError';
  }
}

export class SmtpClient {
  private transporter: Transporter | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectingTransport: Transporter | null = null;
  private generation = 0;
  private readonly sockets = new Set<Socket>();
  private readonly composer: Transporter;

  constructor(
    private readonly account: EmailAccount,
    private readonly options: SmtpClientOptions = {}
  ) {
    this.composer = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'windows',
      // All allowed attachment sources have already been resolved to checked bytes.
      disableFileAccess: true,
      disableUrlAccess: true,
    } as any);
  }

  async connect(): Promise<void> {
    if (this.transporter) return;
    if (this.connectPromise) return this.connectPromise;

    const pending = this.createVerifiedTransport(this.generation);
    this.connectPromise = pending;
    try {
      await pending;
    } finally {
      if (this.connectPromise === pending) this.connectPromise = null;
    }
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error('SMTP connection was cancelled');
  }

  private async createVerifiedTransport(generation: number): Promise<void> {
    const authConfig: Record<string, unknown> = { user: this.account.user };

    if (this.account.authType === 'oauth2') {
      authConfig.type = 'OAuth2';
      authConfig.provisionCallback = (
        _user: string,
        renew: boolean,
        callback: (error: Error | null, token?: string, expires?: number) => void,
      ) => {
        if (generation !== this.generation) { callback(new Error('SMTP connection was cancelled')); return; }
        void getValidAccessToken(this.account.id, renew).then(
          // Token caching and expiry belong to our credential store. Ask it on
          // every new SMTP connection, including after workstation sleep.
          token => generation === this.generation
            ? callback(null, token, Date.now() - 1)
            : callback(new Error('SMTP connection was cancelled')),
          error => callback(error instanceof Error ? error : new Error('OAuth2 token refresh failed')),
        );
      };
    } else {
      const password = await loadCredentials(this.account.id);
      if (!password) {
        throw new Error(`Credentials not found for account: ${this.account.id}`);
      }
      authConfig.pass = password;
    }
    this.assertGeneration(generation);

    const smtpPort = this.account.smtpPort || 465;
    const smtpHost = this.account.smtpHost || this.account.host;
    const securityMode = resolveSmtpSecurityMode(
      smtpHost,
      smtpPort,
      this.options.securityMode ?? this.account.smtpSecurity
    );
    const candidate = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      ...smtpTransportSecurityOptions(securityMode),
      auth: authConfig,
      // Non-pooled Nodemailer close() does not destroy verify/send sockets.
      // Own their lifecycle while leaving TLS negotiation and validation to Nodemailer.
      getSocket: (_options: unknown, callback: (error: Error | null, value?: { connection: Socket }) => void) => {
        if (generation !== this.generation) { callback(new Error('SMTP connection was cancelled')); return; }
        const socket = createConnection({ host: smtpHost, port: smtpPort });
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
        const timeout = setTimeout(() => socket.destroy(new Error('SMTP connection timed out')), 30_000);
        const failed = (error: Error) => { clearTimeout(timeout); callback(error); };
        socket.once('error', failed);
        socket.once('connect', () => {
          clearTimeout(timeout);
          socket.removeListener('error', failed);
          if (generation !== this.generation) { socket.destroy(); callback(new Error('SMTP connection was cancelled')); return; }
          callback(null, { connection: socket });
        });
      },
    });

    this.connectingTransport = candidate;
    try {
      await candidate.verify();
      this.assertGeneration(generation);
      this.transporter = candidate;
    } catch (error) {
      if (typeof (candidate as any).close === 'function') {
        (candidate as any).close();
      }
      this.assertGeneration(generation);
      throw error;
    } finally {
      if (this.connectingTransport === candidate) this.connectingTransport = null;
    }
  }

  disconnect(): void {
    this.generation++;
    for (const socket of this.sockets) socket.destroy(new Error('SMTP connection was cancelled'));
    this.sockets.clear();
    this.connectPromise = null;
    for (const transport of new Set([this.transporter, this.connectingTransport])) {
      if (transport && typeof (transport as any).close === 'function') transport.close();
    }
    this.transporter = null;
    this.connectingTransport = null;
  }

  async send(
    to: string,
    subject: string,
    body: string,
    isHtml: boolean = false,
    cc?: string,
    bcc?: string,
    extraHeaders?: Record<string, string>
  ): Promise<SmtpSendResult> {
    const inReplyTo = extraHeaders
      ? Object.entries(extraHeaders).find(([name]) => name.toLowerCase() === 'in-reply-to')?.[1]
      : undefined;
    const references = extraHeaders
      ? Object.entries(extraHeaders).find(([name]) => name.toLowerCase() === 'references')?.[1]
      : undefined;
    const threading = inReplyTo || references
      ? {
          ...(inReplyTo ? { inReplyTo } : {}),
          ...(references ? { references } : {}),
        }
      : undefined;
    const headers = extraHeaders
      ? Object.fromEntries(
          Object.entries(extraHeaders).filter(([name]) => {
            const lower = name.toLowerCase();
            return lower !== 'in-reply-to' && lower !== 'references';
          })
        )
      : undefined;

    return this.sendMessage({
      to,
      subject,
      ...(isHtml ? { html: body } : { text: body }),
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      ...(threading && Object.keys(threading).length > 0 ? { threading } : {}),
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    });
  }

  async sendMessage(message: OutgoingMessage): Promise<SmtpSendResult> {
    if (!this.transporter) {
      throw new Error('SMTP client not connected');
    }

    let composed: SmtpComposedMessage;
    const generation = this.generation;
    try {
      composed = await this.composeMessage(message);
      this.assertGeneration(generation);
    } catch (error) {
      // No SMTP transaction has started; callers can correct this without delivery ambiguity.
      throw new SmtpPreflightError(error);
    }
    return this.sendRawMessage(composed);
  }

  async sendRawMessage({ rawMessage, messageId, envelope }: SmtpComposedMessage): Promise<SmtpSendResult> {
    if (!this.transporter) throw new Error('SMTP client not connected');
    const transport = this.transporter;

    try {
      const info = await transport.sendMail({
        raw: rawMessage,
        envelope: {
          ...envelope,
          from: this.account.user,
        },
      } as any) as any;
      return {
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
        messageId: messageId || String(info.messageId || ''),
        ...(info.response ? { response: String(info.response) } : {}),
        rawMessage,
      };
    } catch (error) {
      if (this.transporter === transport) this.disconnect();
      const reason = error instanceof Error ? error.message : String(error);
      const smtpError = error && typeof error === 'object'
        ? error as { code?: unknown; command?: unknown; rejected?: unknown }
        : undefined;
      const rejected = smtpError?.code === 'EENVELOPE' &&
        smtpError.command === 'RCPT TO' &&
        Array.isArray(smtpError.rejected)
        ? smtpError.rejected.map(String)
        : [];

      if (rejected.length > 0) {
        throw new SmtpRecipientRejectedError(
          `SMTP rejected all recipients: ${reason}`,
          messageId,
          rejected,
          { cause: error }
        );
      }

      throw new SmtpSendError(
        `SMTP outcome is unknown: ${reason}`,
        messageId,
        { cause: error }
      );
    }
  }

  async composeMessage(
    message: OutgoingMessage,
    options: { stripBcc?: boolean } = {},
  ): Promise<SmtpComposedMessage> {
    const mailOptions = await prepareOutgoingMessage(message, this.account.user, {
      allowedAttachmentRoots: this.account.allowedAttachmentRoots ?? [],
    });
    const prepared = await this.composer.sendMail(mailOptions) as any;
    const composedMessage = Buffer.isBuffer(prepared.message)
      ? prepared.message
      : Buffer.from(prepared.message);
    return {
      rawMessage: options.stripBcc === false ? composedMessage : stripBccHeader(composedMessage),
      messageId: String(prepared.messageId || ''),
      envelope: { ...(prepared.envelope ?? {}) },
    };
  }
}
