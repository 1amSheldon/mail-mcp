import nodemailer from 'nodemailer';
import type { EmailAccount } from '../config.js';
import { loadCredentials } from '../security/keychain.js';
import { getValidAccessToken } from '../security/oauth2.js';

export interface SmtpSendResult {
  accepted: string[];
  rejected: string[];
  messageId: string;
  response?: string;
  rawMessage: Buffer;
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

  constructor(private readonly account: EmailAccount) {
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
    const candidate = nodemailer.createTransport({
      host: this.account.smtpHost || this.account.host,
      port: smtpPort,
      secure: smtpPort === 465,
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
    if (!this.transporter) {
      throw new Error('SMTP client not connected');
    }

    const mailOptions: Record<string, unknown> = {
      from: this.account.user,
      to,
      subject,
    };
    if (cc) mailOptions.cc = cc;
    if (bcc) mailOptions.bcc = bcc;
    if (extraHeaders && Object.keys(extraHeaders).length > 0) {
      mailOptions.headers = extraHeaders;
    }

    if (isHtml) {
      mailOptions.html = body;
    } else {
      mailOptions.text = body;
    }

    const prepared = await this.composer.sendMail(mailOptions) as any;
    const rawMessage = Buffer.isBuffer(prepared.message)
      ? prepared.message
      : Buffer.from(prepared.message);
    const messageId = String(prepared.messageId || '');

    try {
      const info = await this.transporter.sendMail({
        raw: rawMessage,
        envelope: prepared.envelope,
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
}
