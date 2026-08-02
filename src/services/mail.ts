import { ImapClient, MessageMetadata, MailboxStatus, SenderEnvelope } from '../protocol/imap.js';
import { SmtpClient } from '../protocol/smtp.js';
import { htmlToMarkdown } from '../utils/markdown.js';
import { EmailAccount } from '../types/index.js';
import { ValidationError } from '../errors.js';
import { MessageBodyCache } from '../utils/message-cache.js';
import { redactSensitiveContent } from '../utils/redact.js';
import type { ParsedMail } from 'mailparser';

/**
 * Pure helper — appends `signature` to `body` when `includeSignature` is true and
 * `signature` is non-empty. Plain-text bodies get the RFC 3676 separator (`\n-- \n`);
 * HTML bodies get the signature wrapped in a styled paragraph.
 */
export function applySignature(
  body: string,
  signature: string | undefined,
  isHtml: boolean,
  includeSignature: boolean
): string {
  if (!includeSignature || !signature) return body;
  if (isHtml) {
    return `${body}<br><br><p style="white-space: pre-line">-- \n${signature}</p>`;
  }
  return `${body}\n-- \n${signature}`;
}

export interface ContactInfo {
  name: string;
  email: string;
  count: number;
  lastSeen: string;
}

export class MailService {
  private imapClient: ImapClient;
  private smtpClient: SmtpClient;
  private account: EmailAccount;

  private smtpConnected = false;
  private readonly bodyCache = new MessageBodyCache();

  constructor(account: EmailAccount, private readonly readOnly: boolean = false, private readonly redact: boolean = false) {
    this.account = account;
    this.imapClient = new ImapClient(account);
    this.smtpClient = new SmtpClient(account);
  }

  get imap(): ImapClient {
    return this.imapClient;
  }

  async connect() {
    await this.imapClient.connect();
  }

  private async ensureSmtp(): Promise<void> {
    if (!this.smtpConnected) {
      await this.smtpClient.connect();
      this.smtpConnected = true;
    }
  }

  async disconnect() {
    await this.imapClient.disconnect();
    // nodemailer transporter doesn't strictly need closing, but good practice if pooling
  }

  async listEmails(folder: string = 'INBOX', count: number = 10, offset: number = 0, headerOnly: boolean = false): Promise<MessageMetadata[]> {
    return this.imapClient.listMessages(folder, count, offset, headerOnly);
  }

  async searchEmails(query: { from?: string, subject?: string, since?: string, before?: string, keywords?: string }, folder: string = 'INBOX', count: number = 10, offset: number = 0): Promise<MessageMetadata[]> {
    const criteria: any = {};
    if (query.from) criteria.from = query.from;
    if (query.subject) criteria.subject = query.subject;
    if (query.since) criteria.since = query.since;
    if (query.before) criteria.before = query.before;
    if (query.keywords) criteria.body = query.keywords;

    return this.imapClient.searchMessages(criteria, folder, count, offset);
  }

  async sendEmail(to: string, subject: string, body: string, isHtml: boolean = false, cc?: string, bcc?: string, includeSignature: boolean = true): Promise<any> {
    const effectiveBody = applySignature(body, this.account.signature, isHtml, includeSignature);

    // Build raw message before sending so we can append to Sent folder
    const rawMessage = [
      `From: ${this.account.user}`,
      `To: ${to}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      ...(bcc ? [`Bcc: ${bcc}`] : []),
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
      '',
      effectiveBody
    ].join('\r\n');

    await this.ensureSmtp();
    const info = await this.smtpClient.send(to, subject, effectiveBody, isHtml, cc, bcc);
    try {
      await this.imapClient.appendMessage('Sent', rawMessage, ['\\Seen']);
    } catch (e) {
      console.error('Failed to append to Sent folder:', e);
    }
    return info;
  }

  async replyEmail(uid: string, folder: string = 'INBOX', body: string, isHtml: boolean = false, cc?: string, bcc?: string, includeSignature: boolean = true): Promise<any> {
    const parsed = await this._cachedFetchBody(uid, folder);

    const originalMessageId = parsed.messageId;
    const existingReferences = parsed.headers.get('references') as string | undefined;

    // Build RFC 2822 threading headers only when we have a Message-ID
    const extraHeaders: Record<string, string> = {};
    if (originalMessageId) {
      extraHeaders['In-Reply-To'] = originalMessageId;
      if (existingReferences) {
        extraHeaders['References'] = `${existingReferences} ${originalMessageId}`;
      } else {
        extraHeaders['References'] = originalMessageId;
      }
    }

    // Determine reply-to address (original sender)
    const originalFrom = Array.isArray(parsed.from?.value)
      ? parsed.from!.value[0]?.address
      : (parsed.from as any)?.address;
    const replyTo = originalFrom || 'unknown@example.com';

    // Build subject with "Re: " prefix
    const originalSubject = parsed.subject || '';
    const replySubject = originalSubject.startsWith('Re: ')
      ? originalSubject
      : `Re: ${originalSubject}`;

    const effectiveBody = applySignature(body, this.account.signature, isHtml, includeSignature);

    // Build raw message for Sent folder append
    const rawMessage = [
      `From: ${this.account.user}`,
      `To: ${replyTo}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      ...(bcc ? [`Bcc: ${bcc}`] : []),
      `Subject: ${replySubject}`,
      ...(extraHeaders['In-Reply-To'] ? [`In-Reply-To: ${extraHeaders['In-Reply-To']}`] : []),
      ...(extraHeaders['References'] ? [`References: ${extraHeaders['References']}`] : []),
      'MIME-Version: 1.0',
      `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
      '',
      effectiveBody,
    ].join('\r\n');

    await this.ensureSmtp();
    const info = await this.smtpClient.send(replyTo, replySubject, effectiveBody, isHtml, cc, bcc, Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined);
    try {
      await this.imapClient.appendMessage('Sent', rawMessage, ['\\Seen']);
    } catch (e) {
      console.error('Failed to append reply to Sent folder:', e);
    }
    return info;
  }

  async forwardEmail(uid: string, folder: string = 'INBOX', to: string, body: string = '', isHtml: boolean = false, cc?: string, bcc?: string, includeSignature: boolean = true): Promise<any> {
    const parsed = await this._cachedFetchBody(uid, folder);

    // Build subject with "Fwd: " prefix
    const originalSubject = parsed.subject || '';
    const fwdSubject = originalSubject.startsWith('Fwd: ')
      ? originalSubject
      : `Fwd: ${originalSubject}`;

    // Build forwarded message block (plain-text format)
    const originalFrom = parsed.from?.text || 'Unknown';
    const originalDate = parsed.date?.toISOString() || 'Unknown';
    const originalTo = Array.isArray(parsed.to)
      ? parsed.to.map((t: any) => t.text).join(', ')
      : (parsed.to as any)?.text || 'Unknown';
    const originalBody = parsed.text || '';

    const forwardedBlock = [
      '',
      '',
      '--- Forwarded message ---',
      `From: ${originalFrom}`,
      `Date: ${originalDate}`,
      `Subject: ${originalSubject}`,
      `To: ${originalTo}`,
      '',
      originalBody,
    ].join('\n');

    const combinedBody = body + forwardedBlock;
    const effectiveBody = applySignature(combinedBody, this.account.signature, isHtml, includeSignature);

    // Build raw message for Sent folder append
    const rawMessage = [
      `From: ${this.account.user}`,
      `To: ${to}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      ...(bcc ? [`Bcc: ${bcc}`] : []),
      `Subject: ${fwdSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
      '',
      effectiveBody,
    ].join('\r\n');

    await this.ensureSmtp();
    const info = await this.smtpClient.send(to, fwdSubject, effectiveBody, isHtml, cc, bcc);
    try {
      await this.imapClient.appendMessage('Sent', rawMessage, ['\\Seen']);
    } catch (e) {
      console.error('Failed to append forward to Sent folder:', e);
    }
    return info;
  }

  async createDraft(to: string, subject: string, body: string, isHtml: boolean = false, cc?: string, bcc?: string, includeSignature: boolean = true): Promise<void> {
    const effectiveBody = applySignature(body, this.account.signature, isHtml, includeSignature);

    const headers = [
      `From: ${this.account.user}`,
      `To: ${to}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      ...(bcc ? [`Bcc: ${bcc}`] : []),
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
      '',
      effectiveBody
    ].join('\r\n');

    await this.imapClient.appendMessage('Drafts', headers, ['\\Draft']);
  }

  private async _cachedFetchBody(uid: string, folder: string): Promise<ParsedMail> {
    const key = `${this.account.id}:${folder}:${uid}`;
    const cached = this.bodyCache.get(key);
    if (cached) return cached;
    const parsed = await this.imapClient.fetchMessageBody(uid, folder);
    this.bodyCache.set(key, parsed);
    return parsed;
  }

  invalidateBodyCache(folder: string, uid: string): void {
    this.bodyCache.delete(`${this.account.id}:${folder}:${uid}`);
  }

  /**
   * Parses the raw value of a `List-Unsubscribe` header.
   * The header contains angle-bracket-delimited tokens, e.g.:
   *   `<mailto:unsub@example.com>, <https://example.com/unsub>`
   * Returns separate arrays for https URLs and mailto addresses.
   */
  private parseUnsubscribeHeader(raw: string): { https: string[]; mailto: string[] } {
    const https: string[] = [];
    const mailto: string[] = [];
    const tokenRegex = /<([^>]+)>/g;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(raw)) !== null) {
      const value = match[1].trim();
      if (value.startsWith('https://') || value.startsWith('http://')) {
        https.push(value);
      } else if (value.startsWith('mailto:')) {
        mailto.push(value.slice('mailto:'.length));
      }
    }
    return { https, mailto };
  }

  async readEmail(uid: string, folder: string = 'INBOX'): Promise<string> {
    const parsed = await this._cachedFetchBody(uid, folder);
    
    let content = '';

    if (parsed.html) {
      let html = parsed.html;
      // Convert inline images to base64 if needed
      if (parsed.attachments) {
        for (const att of parsed.attachments) {
          if (att.contentId && att.content && att.contentType.startsWith('image/')) {
            const base64 = att.content.toString('base64');
            const dataUri = `data:${att.contentType};base64,${base64}`;
            const cidRegex = new RegExp(`cid:${att.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
            html = html.replace(cidRegex, dataUri);
          }
        }
      }
      content = htmlToMarkdown(html);
    } else if (parsed.textAsHtml) {
      content = htmlToMarkdown(parsed.textAsHtml);
    } else if (parsed.text) {
      content = parsed.text;
    }

    let attachmentInfo = '';
    if (parsed.attachments && parsed.attachments.length > 0) {
      attachmentInfo = '\n\n**Attachments:**\n';
      parsed.attachments.forEach(att => {
        attachmentInfo += `- ${att.filename || 'Unnamed'} (${att.contentType}, ${Math.round(att.size / 1024)} KB)\n`;
      });
    }

    let header = `**From:** ${parsed.from?.text || 'Unknown'}\n`;
    const toText = Array.isArray(parsed.to) ? parsed.to.map(t => t.text).join(', ') : parsed.to?.text;
    header += `**To:** ${toText || 'Unknown'}\n`;
    if (parsed.cc) {
      const ccText = Array.isArray(parsed.cc) ? parsed.cc.map(t => t.text).join(', ') : parsed.cc.text;
      header += `**Cc:** ${ccText}\n`;
    }
    header += `**Subject:** ${parsed.subject || 'No Subject'}\n`;
    header += `**Date:** ${parsed.date?.toISOString() || 'Unknown'}\n`;
    
    // Check for thread ID in headers
    const threadId = parsed.headers.get('x-gm-thrid');
    if (threadId) {
      header += `**Thread ID:** ${threadId}\n`;
    }

    // Expose Message-ID so non-Gmail callers have a threadId for get_thread
    const messageId = parsed.messageId || parsed.headers.get('message-id');
    if (messageId) {
      header += `**Message-ID:** ${messageId}\n`;
    }

    // Extract RFC 2369 List-Unsubscribe headers for mailing list management
    const rawUnsub = parsed.headers.get('list-unsubscribe');
    if (rawUnsub) {
      const { https: httpsUrls, mailto: mailtoAddresses } = this.parseUnsubscribeHeader(String(rawUnsub));
      for (const url of httpsUrls) {
        header += `**Unsubscribe:** ${url}\n`;
      }
      const rawUnsubPost = parsed.headers.get('list-unsubscribe-post');
      if (rawUnsubPost && String(rawUnsubPost).includes('List-Unsubscribe=One-Click')) {
        header += `**Unsubscribe (one-click):** yes\n`;
      }
      for (const address of mailtoAddresses) {
        header += `**Unsubscribe (mailto):** ${address}\n`;
      }
    }

    header += `\n---\n\n`;

    const body = this.redact ? redactSensitiveContent(content) : content;
    return header + body + attachmentInfo;
  }

  async getThread(threadId: string, folder: string = 'INBOX'): Promise<MessageMetadata[]> {
    return this.imapClient.fetchThreadMessages(threadId, folder);
  }

  async downloadAttachment(uid: string, filename: string, folder: string = 'INBOX', maxBytes: number = 50 * 1024 * 1024): Promise<{ content: Buffer, contentType: string }> {
    const size = await this.imapClient.fetchAttachmentSize(uid, filename, folder);
    if (size != null && size > maxBytes) {
      throw new ValidationError(
        `Attachment "${filename}" is ${Math.round(size / 1024 / 1024)} MB, which exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit. Use an email client to download large attachments directly.`
      );
    }
    const parsed = await this._cachedFetchBody(uid, folder);
    if (!parsed.attachments || parsed.attachments.length === 0) {
      throw new Error('No attachments found in this email');
    }
    const attachment = parsed.attachments.find(a => a.filename === filename);
    if (!attachment) {
      throw new Error(`Attachment "${filename}" not found`);
    }
    return {
      content: attachment.content,
      contentType: attachment.contentType
    };
  }

  async extractAttachmentText(uid: string, filename: string, folder: string = 'INBOX'): Promise<string> {
    const { content, contentType } = await this.downloadAttachment(uid, filename, folder);
    if (contentType === 'application/pdf') {
      const pdf = await import('pdf-parse');
      // Some modules have a .default property when imported via dynamic import in ESM
      const pdfParser = (pdf as any).default || pdf;
      const data = await pdfParser(content);
      return data.text;
    } else if (contentType.startsWith('text/')) {
      return content.toString('utf-8');
    } else {
      throw new Error(`Extraction not supported for content type: ${contentType}`);
    }
  }

  async extractContacts(folder: string = 'INBOX', count: number = 100): Promise<ContactInfo[]> {
    const envelopes: SenderEnvelope[] = await this.imapClient.scanSenderEnvelopes(folder, count);

    // Aggregate by email address
    const map = new Map<string, { name: string; count: number; lastDate: Date }>();
    for (const env of envelopes) {
      const existing = map.get(env.email);
      if (!existing) {
        map.set(env.email, { name: env.name, count: 1, lastDate: env.date });
      } else {
        existing.count++;
        if (env.date > existing.lastDate) {
          existing.lastDate = env.date;
          existing.name = env.name;
        }
      }
    }

    // Build and sort
    const contacts: ContactInfo[] = Array.from(map.entries()).map(([email, data]) => ({
      email,
      name: data.name,
      count: data.count,
      lastSeen: data.lastDate.toISOString(),
    }));

    contacts.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastSeen.localeCompare(a.lastSeen);
    });

    return contacts.slice(0, 50);
  }

  async listFolders(): Promise<string[]> {
    return this.imapClient.listFolders();
  }

  async getMailboxStats(folders?: string[]): Promise<MailboxStatus[]> {
    const targetFolders = (!folders || folders.length === 0)
      ? await this.imapClient.listFolders()
      : folders;
    return this.imapClient.getMailboxStatus(targetFolders);
  }

  async moveMessage(uid: string, sourceFolder: string, targetFolder: string): Promise<void> {
    return this.imapClient.moveMessage(uid, sourceFolder, targetFolder);
  }

  async deleteEmail(uid: string, folder: string = 'INBOX'): Promise<void> {
    await this.imapClient.deleteMessage(uid, folder);
    this.invalidateBodyCache(folder, uid);
  }

  async modifyLabels(uid: string, folder: string, addLabels: string[], removeLabels: string[]): Promise<void> {
    return this.imapClient.modifyLabels(uid, folder, addLabels, removeLabels);
  }

  async batchOperations(
    uids: string[],
    folder: string,
    operation:
      | { type: 'move'; targetFolder: string }
      | { type: 'delete' }
      | { type: 'label'; addLabels?: string[]; removeLabels?: string[] }
  ): Promise<{ processed: number }> {
    if (uids.length === 0) {
      throw new Error('No UIDs provided for batch operation');
    }
    if (uids.length > 100) {
      throw new Error('Batch operations are limited to 100 emails at once');
    }

    if (operation.type === 'move') {
      await this.imapClient.batchMoveMessages(uids, folder, operation.targetFolder);
    } else if (operation.type === 'delete') {
      await this.imapClient.batchDeleteMessages(uids, folder);
    } else if (operation.type === 'label') {
      await this.imapClient.batchModifyLabels(
        uids,
        folder,
        operation.addLabels || [],
        operation.removeLabels || []
      );
    } else {
      throw new Error(`Unknown batch operation type: ${(operation as any).type}`);
    }

    return { processed: uids.length };
  }
}
