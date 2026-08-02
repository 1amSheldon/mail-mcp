import nodemailer from 'nodemailer';
import { EmailAccount } from '../types/index.js';
import { loadCredentials } from '../security/keychain.js';
import { getValidAccessToken } from '../security/oauth2.js';

export class SmtpClient {
  private transporter: nodemailer.Transporter | null = null;
  private account: EmailAccount;

  constructor(account: EmailAccount) {
    this.account = account;
  }

  async connect(): Promise<void> {
    let authConfig: any = { user: this.account.user };

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
    this.transporter = nodemailer.createTransport({
      host: this.account.smtpHost || this.account.host,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: authConfig
    });

    await this.transporter.verify();
  }

  async send(to: string, subject: string, body: string, isHtml: boolean = false, cc?: string, bcc?: string, extraHeaders?: Record<string, string>): Promise<any> {
    if (!this.transporter) {
      throw new Error('SMTP client not connected');
    }

    const mailOptions: any = {
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

    const info = await this.transporter.sendMail(mailOptions);
    return info;
  }
}
