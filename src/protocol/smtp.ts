import nodemailer from 'nodemailer';
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

export class SmtpClient {
  private transporter: nodemailer.Transporter | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly composer: nodemailer.Transporter;

  constructor(
    private readonly account: EmailAccount,
    private readonly options: SmtpClientOptions = {}
  ) {
    this.composer = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'windows',
    } as any);
  }

  async connect(): Promise<void> {
    if (this.transporter) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.createVerifiedTransport();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async createVerifiedTransport(): Promise<void> {
    const authConfig: Record<string, unknown> = { user: this.account.user };

    if (this.account.authType === 'oauth2') {
      const accessToken = await getValidAccessToken(this.account.id);
      authConfig.type = 'OAuth2';
      authConfig.accessToken = accessToken;
    } else {
      const password = await loadCredentials(this.account.id);
      if (!password) {
        throw new Error(`Credentials not found for account: ${this.account.id}`);
      }
      authConfig.pass = password;
    }

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
    });

    try {
      await candidate.verify();
      this.transporter = candidate;
    } catch (error) {
      if (typeof (candidate as any).close === 'function') {
        (candidate as any).close();
      }
      throw error;
    }
  }

  disconnect(): void {
    if (this.transporter && typeof (this.transporter as any).close === 'function') {
      (this.transporter as any).close();
    }
    this.transporter = null;
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

    const { rawMessage, messageId, envelope } = await this.composeMessage(message);

    try {
      const info = await this.transporter.sendMail({
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
      this.disconnect();
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
