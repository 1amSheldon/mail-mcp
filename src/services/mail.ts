import {
  ImapClient,
  type CopyMessagesResult,
  type MailboxMetadata,
  type MailboxStatus,
  type MessageMetadata,
  type SenderEnvelope,
} from '../protocol/imap.js';
import {
  SmtpClient,
  SmtpRecipientRejectedError,
  SmtpSendError,
} from '../protocol/smtp.js';
import { htmlToMarkdown } from '../utils/markdown.js';
import type { EmailAccount } from '../config.js';
import { ValidationError } from '../errors.js';
import { MessageBodyCache } from '../utils/message-cache.js';
import { redactSensitiveContent } from '../utils/redact.js';
import { validateRecipients } from '../utils/validation.js';
import {
  decodeMessageLocator,
  encodeMessageLocator,
  type MessageLocator,
} from '../domain/message-locator.js';
import type { OutgoingAttachment, OutgoingMessage as SmtpOutgoingMessage } from '../domain/outgoing-message.js';
import {
  PaginationSnapshotStore,
  type PaginationPage,
  type PaginationScope,
} from '../utils/pagination-store.js';
import type { ParsedMail } from 'mailparser';

const DEFAULT_SENT_FOLDER = 'Sent';
const DEFAULT_DRAFTS_FOLDER = 'Drafts';
const DEFAULT_TRASH_FOLDER = 'Trash';
const MAX_PAGINATION_SNAPSHOT_ITEMS = 10_000;
const MAX_READ_BODY_CHARS = 200_000;
const INLINE_DATA_IMAGE_PATTERN = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/_=-]+/gi;

const CONVENTIONAL_MAILBOX_NAMES = {
  '\\Sent': ['Sent', 'Sent Items', 'Sent Mail', '\u041e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043d\u044b\u0435', '\u041e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043d\u044b\u0435 \u043f\u0438\u0441\u044c\u043c\u0430', 'Gesendet', 'Envoyés'],
  '\\Drafts': ['Drafts', 'Draft', '\u0427\u0435\u0440\u043d\u043e\u0432\u0438\u043a\u0438', 'Entwürfe', 'Brouillons'],
  '\\Trash': ['Trash', 'Bin', 'Deleted Items', 'Deleted Messages', '\u041a\u043e\u0440\u0437\u0438\u043d\u0430', '\u0423\u0434\u0430\u043b\u0435\u043d\u043d\u044b\u0435', 'Papierkorb', 'Corbeille', 'Papelera'],
} as const;

export type DeliveryStatus =
  | 'sent_and_saved'
  | 'partially_sent_and_saved'
  | 'smtp_accepted_sent_not_confirmed'
  | 'smtp_partially_accepted_sent_not_confirmed'
  | 'smtp_rejected'
  | 'smtp_connection_failed'
  | 'smtp_outcome_unknown'
  | 'sent_provider_managed'
  | 'partially_sent_provider_managed'
  | 'sent_without_saved_copy'
  | 'partially_sent_without_saved_copy';

export interface SendDeliveryResult {
  status: DeliveryStatus;
  smtpAccepted: boolean | null;
  accepted: string[];
  rejected: string[];
  messageId?: string;
  sentFolder?: string;
  sentFolderSaved: boolean;
  sentFolderUid?: number;
  retrySafe: boolean;
  nextAction: string;
  warning?: string;
  error?: string;
}

export interface MailSendMessage extends SmtpOutgoingMessage {
  includeSignature?: boolean;
}

export interface LocatedMessageMetadata extends Omit<MessageMetadata, 'id'> {
  id: string;
  locator: string;
}

export interface ListEmailsPageOptions {
  folder?: string;
  limit?: number;
  cursor?: string;
  headerOnly?: boolean;
}

export interface SearchEmailsQuery {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  since?: string;
  before?: string;
  keywords?: string;
  messageId?: string;
}

export interface SearchEmailsPageOptions {
  folder?: string;
  limit?: number;
  cursor?: string;
  headerOnly?: boolean;
}

export interface RawEmailResult {
  locator: string;
  mediaType: 'message/rfc822';
  transferEncoding: 'base64';
  size: number;
  contentBase64: string;
}

export interface CopyEmailResult extends CopyMessagesResult {
  sourceLocator: string;
  destinationLocator?: string;
}

export interface DraftCreationResult {
  folder: string;
  uid?: number;
  locator?: string;
  messageId?: string;
}

export interface BatchOperationItemResult {
  uid?: string;
  locator?: string;
  success: boolean;
  error?: string;
}

export interface BatchOperationResult {
  processed: number;
  succeeded: number;
  failed: number;
  items: BatchOperationItemResult[];
}

export type BatchOperation =
  | { type: 'move'; targetFolder: string }
  | { type: 'delete' }
  | { type: 'copy'; targetFolder: string }
  | { type: 'label'; addLabels?: string[]; removeLabels?: string[] };

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

  private sentFolderPromise: Promise<string> | null = null;
  private draftsFolderPromise: Promise<string> | null = null;
  private trashFolderPromise: Promise<string> | null = null;
  private readonly bodyCache = new MessageBodyCache();
  private readonly bodyFetches = new Map<string, Promise<ParsedMail>>();
  private readonly paginationStore = new PaginationSnapshotStore<number>({
    maxItemsPerSnapshot: MAX_PAGINATION_SNAPSHOT_ITEMS,
  });

  constructor(account: EmailAccount, private readonly redact: boolean = false) {
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
    await this.smtpClient.connect();
  }

  async disconnect() {
    this.smtpClient.disconnect();
    await this.imapClient.disconnect();
    this.paginationStore.clear();
  }

  async listEmailsPage(options: ListEmailsPageOptions = {}): Promise<PaginationPage<LocatedMessageMetadata>> {
    const folder = options.folder ?? 'INBOX';
    const limit = options.limit ?? 10;
    const identity = await this.imapClient.getMailboxIdentity(folder);
    const scope = this.paginationScope(identity.path, identity.uidValidity, JSON.stringify({
      kind: 'list',
      headerOnly: options.headerOnly ?? false,
    }));

    const page = options.cursor
      ? this.paginationStore.getNextPage(options.cursor, scope, limit)
      : this.paginationStore.getFirstPage(
          scope,
          await this.imapClient.listMessageUids(identity.path, MAX_PAGINATION_SNAPSHOT_ITEMS),
          limit,
        );
    return this.hydrateUidPage(page, identity.path, identity.uidValidity, options.headerOnly ?? false);
  }

  async searchEmailsPage(
    query: SearchEmailsQuery,
    options: SearchEmailsPageOptions = {}
  ): Promise<PaginationPage<LocatedMessageMetadata>> {
    const folder = options.folder ?? 'INBOX';
    const limit = options.limit ?? 10;
    const identity = await this.imapClient.getMailboxIdentity(folder);
    const normalizedQuery = this.normalizeSearchQuery(query);
    const scope = this.paginationScope(
      identity.path,
      identity.uidValidity,
      JSON.stringify({
        kind: 'search',
        query: normalizedQuery,
        headerOnly: options.headerOnly ?? false,
      })
    );

    const page = options.cursor
      ? this.paginationStore.getNextPage(options.cursor, scope, limit)
      : this.paginationStore.getFirstPage(
          scope,
          await this.imapClient.searchMessageUids(
            this.buildSearchCriteria(normalizedQuery),
            identity.path,
            MAX_PAGINATION_SNAPSHOT_ITEMS,
          ),
          limit,
        );
    return this.hydrateUidPage(page, identity.path, identity.uidValidity, options.headerOnly ?? false);
  }

  private async hydrateUidPage(
    page: PaginationPage<number>,
    mailbox: string,
    uidValidity: string,
    headerOnly: boolean,
  ): Promise<PaginationPage<LocatedMessageMetadata>> {
    const messages = await this.imapClient.fetchMessagesByUids(page.items, mailbox, headerOnly);
    return {
      items: this.locateMessages(messages, mailbox, uidValidity),
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  private buildSearchCriteria(query: SearchEmailsQuery): Record<string, unknown> {
    const criteria: Record<string, unknown> = {};
    if (query.from) criteria.from = query.from;
    if (query.to) criteria.to = query.to;
    if (query.cc) criteria.cc = query.cc;
    if (query.subject) criteria.subject = query.subject;
    if (query.since) criteria.since = query.since;
    if (query.before) criteria.before = query.before;
    if (query.keywords) criteria.body = query.keywords;
    if (query.messageId) criteria.header = { 'Message-ID': query.messageId };
    return criteria;
  }

  private normalizeSearchQuery(query: SearchEmailsQuery): SearchEmailsQuery {
    return Object.fromEntries(
      Object.entries(query)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
        .sort(([left], [right]) => left.localeCompare(right))
    ) as SearchEmailsQuery;
  }

  async resolveSentFolder(explicitFolder?: string): Promise<string> {
    if (explicitFolder) return explicitFolder;
    if (this.account.sentFolder) return this.account.sentFolder;
    if (!this.sentFolderPromise) {
      this.sentFolderPromise = this.resolveMailboxFolder('\\Sent', DEFAULT_SENT_FOLDER);
    }
    return this.sentFolderPromise;
  }

  async resolveDraftsFolder(explicitFolder?: string): Promise<string> {
    if (explicitFolder) return explicitFolder;
    if (!this.draftsFolderPromise) {
      this.draftsFolderPromise = this.resolveMailboxFolder('\\Drafts', DEFAULT_DRAFTS_FOLDER);
    }
    return this.draftsFolderPromise;
  }

  async resolveTrashFolder(explicitFolder?: string): Promise<string> {
    if (explicitFolder) return explicitFolder;
    if (!this.trashFolderPromise) {
      this.trashFolderPromise = this.resolveMailboxFolder('\\Trash', DEFAULT_TRASH_FOLDER);
    }
    return this.trashFolderPromise;
  }

  private paginationScope(mailbox: string, uidValidity: string, queryKey: string): PaginationScope {
    return {
      accountId: this.account.id,
      mailbox,
      uidValidity,
      queryKey,
    };
  }

  private locateMessages(
    messages: MessageMetadata[],
    mailbox: string,
    uidValidity: string
  ): LocatedMessageMetadata[] {
    return messages.map(message => {
      const locator = encodeMessageLocator({
        accountId: this.account.id,
        mailbox,
        uidValidity,
        uid: message.uid,
      });
      return { ...this.redactMessageMetadata(message), id: locator, locator };
    });
  }

  private redactText(text: string): string {
    return this.redact ? redactSensitiveContent(text) : text;
  }

  private redactMessageMetadata(message: MessageMetadata): MessageMetadata {
    if (!this.redact) return message;
    return {
      ...message,
      ...(message.subject !== undefined ? { subject: this.redactText(message.subject) } : {}),
      ...(message.from !== undefined ? { from: this.redactText(message.from) } : {}),
      ...(message.snippet !== undefined ? { snippet: this.redactText(message.snippet) } : {}),
    };
  }

  private async resolveLocator(locator: string): Promise<MessageLocator> {
    const decoded = decodeMessageLocator(locator);
    if (decoded.accountId !== this.account.id) {
      throw new ValidationError('Message locator belongs to a different account.');
    }
    const identity = await this.imapClient.getMailboxIdentity(decoded.mailbox);
    if (identity.path !== decoded.mailbox || identity.uidValidity !== decoded.uidValidity) {
      throw new ValidationError('Message locator is stale because the mailbox identity changed.');
    }
    return decoded;
  }

  private async resolveMailboxFolder(
    specialUse: keyof typeof CONVENTIONAL_MAILBOX_NAMES,
    fallback: string
  ): Promise<string> {
    const specialFolder = await this.imapClient.findSpecialUseFolder(specialUse).catch(() => undefined);
    if (specialFolder) return specialFolder;

    const folders = await this.imapClient.listFolders().catch(() => [] as string[]);
    const conventionalNames = CONVENTIONAL_MAILBOX_NAMES[specialUse];
    for (const name of conventionalNames) {
      const normalized = name.toLocaleLowerCase();
      const match = folders.find(folder => {
        const leaf = folder.split(/[\\/]/).at(-1) ?? folder;
        return leaf.toLocaleLowerCase() === normalized;
      });
      if (match) return match;
    }
    return fallback;
  }

  private sentCopyPolicy(): 'manual' | 'provider' | 'none' {
    if (this.account.sentPolicy === 'always') return 'manual';
    if (this.account.sentPolicy === 'never') return 'none';
    const hosts = [this.account.host, this.account.smtpHost]
      .filter((host): host is string => typeof host === 'string')
      .map(host => host.trim().toLowerCase());
    const providerManaged = hosts.some(host =>
      host === 'gmail.com' || host.endsWith('.gmail.com') ||
      host === 'googlemail.com' || host.endsWith('.googlemail.com') ||
      host === 'zoho.com' || host.endsWith('.zoho.com') ||
      /^([a-z0-9-]+\.)*zoho\.(eu|in|jp|ca|com\.au)$/.test(host)
    );
    return providerManaged ? 'provider' : 'manual';
  }

  private async sendAndRecord(message: SmtpOutgoingMessage): Promise<SendDeliveryResult> {
    try {
      await this.ensureSmtp();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        status: 'smtp_connection_failed',
        smtpAccepted: false,
        accepted: [],
        rejected: [],
        sentFolderSaved: false,
        retrySafe: true,
        nextAction: 'No SMTP message was attempted. Fix the connection before a new user-requested send.',
        error: reason,
      };
    }

    let info;
    try {
      info = await this.smtpClient.sendMessage(message);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof SmtpRecipientRejectedError) {
        return {
          status: 'smtp_rejected',
          smtpAccepted: false,
          accepted: [],
          rejected: error.rejected,
          ...(error.messageId ? { messageId: error.messageId } : {}),
          sentFolderSaved: false,
          retrySafe: false,
          nextAction: 'Correct the rejected recipients or SMTP policy failure before a new user-requested send.',
          error: reason,
        };
      }

      const messageId = error instanceof SmtpSendError ? error.messageId : undefined;
      return {
        status: 'smtp_outcome_unknown',
        smtpAccepted: null,
        accepted: [],
        rejected: [],
        ...(messageId ? { messageId } : {}),
        sentFolderSaved: false,
        retrySafe: false,
        nextAction: 'Do not retry automatically. Use verify_sent_message with messageId before any user-approved resend.',
        error: reason,
      };
    }

    if (info.accepted.length === 0) {
      const rejected = info.rejected.length > 0;
      return {
        status: rejected ? 'smtp_rejected' : 'smtp_outcome_unknown',
        smtpAccepted: rejected ? false : null,
        accepted: info.accepted,
        rejected: info.rejected,
        ...(info.messageId ? { messageId: info.messageId } : {}),
        sentFolderSaved: false,
        retrySafe: false,
        nextAction: rejected
          ? 'Do not retry automatically. Correct the recipients or SMTP policy failure first.'
          : 'Do not retry automatically. Use verify_sent_message before any user-approved resend.',
        warning: rejected ? 'SMTP accepted no recipients.' : 'SMTP returned no accepted or rejected recipients.',
      };
    }

    const partial = info.rejected.length > 0;
    const sentCopyPolicy = this.sentCopyPolicy();
    if (sentCopyPolicy !== 'manual') {
      const providerManaged = sentCopyPolicy === 'provider';
      return {
        status: providerManaged
          ? (partial ? 'partially_sent_provider_managed' : 'sent_provider_managed')
          : (partial ? 'partially_sent_without_saved_copy' : 'sent_without_saved_copy'),
        smtpAccepted: true,
        accepted: info.accepted,
        rejected: info.rejected,
        ...(info.messageId ? { messageId: info.messageId } : {}),
        sentFolderSaved: false,
        retrySafe: false,
        nextAction: partial
          ? 'Do not resend accepted recipients. Review the rejected recipient list.'
          : 'Do not resend this message.',
        warning: providerManaged
          ? 'The provider manages Sent copies; manual IMAP append was skipped to prevent duplicates.'
          : 'The account sentPolicy is never; no Sent copy was appended.',
      };
    }

    const sentFolder = await this.resolveSentFolder();
    try {
      const appendResult = await this.imapClient.appendMessage(sentFolder, info.rawMessage, ['\\Seen']);
      return {
        status: partial ? 'partially_sent_and_saved' : 'sent_and_saved',
        smtpAccepted: true,
        accepted: info.accepted,
        rejected: info.rejected,
        ...(info.messageId ? { messageId: info.messageId } : {}),
        sentFolder,
        sentFolderSaved: true,
        ...(appendResult.uid !== undefined ? { sentFolderUid: appendResult.uid } : {}),
        retrySafe: false,
        nextAction: partial
          ? 'Do not resend accepted recipients. Review the rejected recipient list.'
          : 'Do not resend this message.',
        ...(partial ? { warning: 'SMTP rejected one or more recipients; accepted recipients were still sent.' } : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        status: partial
          ? 'smtp_partially_accepted_sent_not_confirmed'
          : 'smtp_accepted_sent_not_confirmed',
        smtpAccepted: true,
        accepted: info.accepted,
        rejected: info.rejected,
        ...(info.messageId ? { messageId: info.messageId } : {}),
        sentFolder,
        sentFolderSaved: false,
        retrySafe: false,
        nextAction: 'Do not retry SMTP. Use verify_sent_message to inspect the Sent folder.',
        warning: `SMTP accepted the message, but IMAP could not confirm the Sent copy: ${reason}`,
      };
    }
  }

  async sendMessage(message: MailSendMessage): Promise<SendDeliveryResult> {
    return this.sendAndRecord(this.effectiveOutgoingMessage(message));
  }

  private effectiveOutgoingMessage(message: MailSendMessage): SmtpOutgoingMessage {
    this.validateFromAddress(message.from);
    if (this.account.allowedRecipients && this.account.allowedRecipients.length > 0) {
      validateRecipients(
        [message.to, message.cc, message.bcc],
        this.account.allowedRecipients,
        this.account.id,
      );
    }
    const includeSignature = message.includeSignature ?? true;
    const { includeSignature: _includeSignature, ...outgoing } = message;
    void _includeSignature;
    const effective: SmtpOutgoingMessage = {
      ...outgoing,
      ...(message.text !== undefined
        ? { text: applySignature(message.text, this.account.signature, false, includeSignature) }
        : {}),
      ...(message.html !== undefined
        ? { html: applySignature(message.html, this.account.signature, true, includeSignature) }
        : {}),
    };
    return effective;
  }

  private validateFromAddress(from: string | undefined): void {
    if (!from) return;
    const address = (from.match(/<([^<>]+)>/)?.[1] ?? from).trim().toLowerCase();
    const allowed = [this.account.user, ...(this.account.fromAliases ?? [])]
      .map(candidate => candidate.trim().toLowerCase());
    if (!allowed.includes(address)) {
      throw new ValidationError('From must match the account address or a configured alias.');
    }
  }

  async sendEmail(to: string, subject: string, body: string, isHtml: boolean = false, cc?: string, bcc?: string, includeSignature: boolean = true): Promise<SendDeliveryResult> {
    return this.sendMessage({
      to,
      subject,
      ...(isHtml ? { html: body } : { text: body }),
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      includeSignature,
    });
  }

  async replyEmail(uid: string, folder: string = 'INBOX', body: string, isHtml: boolean = false, cc?: string, bcc?: string, includeSignature: boolean = true, attachments?: OutgoingAttachment[]): Promise<SendDeliveryResult> {
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
    const originalFrom = parsed.replyTo?.value[0]?.address ?? parsed.from?.value[0]?.address;
    if (!originalFrom) {
      throw new ValidationError('Cannot reply because the original message has no valid From address.');
    }
    const replyTo = originalFrom;

    // Build subject with "Re: " prefix
    const originalSubject = parsed.subject || '';
    const replySubject = originalSubject.startsWith('Re: ')
      ? originalSubject
      : `Re: ${originalSubject}`;

    const effectiveBody = applySignature(body, this.account.signature, isHtml, includeSignature);

    return this.sendMessage({
      to: replyTo,
      subject: replySubject,
      ...(isHtml ? { html: effectiveBody } : { text: effectiveBody }),
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      threading: {
        ...(extraHeaders['In-Reply-To'] ? { inReplyTo: extraHeaders['In-Reply-To'] } : {}),
        ...(extraHeaders.References ? { references: extraHeaders.References } : {}),
      },
      includeSignature: false,
    });
  }

  async replyLocatedEmail(
    locator: string,
    body: string,
    isHtml: boolean = false,
    cc?: string,
    bcc?: string,
    includeSignature: boolean = true,
    attachments?: OutgoingAttachment[],
  ): Promise<SendDeliveryResult> {
    const resolved = await this.resolveLocator(locator);
    return this.replyEmail(
      resolved.uid.toString(),
      resolved.mailbox,
      body,
      isHtml,
      cc,
      bcc,
      includeSignature,
      attachments,
    );
  }

  async replyAllEmail(
    locator: string,
    body: string,
    options: {
      isHtml?: boolean;
      bcc?: string;
      includeSignature?: boolean;
      includeOriginalAttachments?: boolean;
      attachments?: OutgoingAttachment[];
    } = {}
  ): Promise<SendDeliveryResult> {
    const resolved = await this.resolveLocator(locator);
    const parsed = await this._cachedFetchBody(resolved.uid.toString(), resolved.mailbox);
    const selfAddresses = [this.account.user, ...(this.account.fromAliases ?? [])]
      .map(address => address.trim().toLowerCase());
    const seen = new Set<string>(selfAddresses);
    const unique = (addresses: Array<string | undefined>): string[] => {
      const result: string[] = [];
      for (const candidate of addresses) {
        if (!candidate) continue;
        const normalized = candidate.trim().toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(candidate);
      }
      return result;
    };

    const replyTargets = unique([
      ...((parsed.replyTo?.value ?? parsed.from?.value ?? []).map(address => address.address)),
    ]);
    const originalTo = unique(this.addresses(parsed.to));
    const originalCc = unique(this.addresses(parsed.cc));
    const toRecipients = replyTargets.length > 0 ? replyTargets : originalTo;
    const ccRecipients = replyTargets.length > 0 ? [...originalTo, ...originalCc] : originalCc;
    if (toRecipients.length === 0) {
      throw new ValidationError('Cannot reply all because the original message has no recipient other than this account.');
    }

    const originalMessageId = parsed.messageId;
    const existingReferences = parsed.headers.get('references');
    const references = originalMessageId
      ? `${existingReferences ? String(existingReferences) + ' ' : ''}${originalMessageId}`
      : undefined;
    const subject = parsed.subject?.startsWith('Re: ')
      ? parsed.subject
      : `Re: ${parsed.subject ?? ''}`;
    const originalAttachments: OutgoingAttachment[] = options.includeOriginalAttachments
      ? (parsed.attachments ?? []).map(attachment => ({
          contentBase64: attachment.content.toString('base64'),
          filename: attachment.filename || 'attachment',
          contentType: attachment.contentType,
          contentDisposition: attachment.contentDisposition === 'inline' ? 'inline' : 'attachment',
          ...(attachment.contentId ? { cid: attachment.contentId } : {}),
        }))
      : [];
    const attachments = [...originalAttachments, ...(options.attachments ?? [])];

    return this.sendMessage({
      to: toRecipients.join(', '),
      subject,
      ...(options.isHtml ? { html: body } : { text: body }),
      ...(ccRecipients.length > 0 ? { cc: ccRecipients.join(', ') } : {}),
      ...(options.bcc ? { bcc: options.bcc } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      threading: {
        ...(originalMessageId ? { inReplyTo: originalMessageId } : {}),
        ...(references ? { references } : {}),
      },
      includeSignature: options.includeSignature ?? true,
    });
  }

  private addresses(value: ParsedMail['to'] | ParsedMail['cc']): Array<string | undefined> {
    if (!value) return [];
    const objects = Array.isArray(value) ? value : [value];
    return objects.flatMap(object => object.value.map(address => address.address));
  }

  async forwardEmail(uid: string, folder: string = 'INBOX', to: string, body: string = '', isHtml: boolean = false, cc?: string, bcc?: string, includeSignature: boolean = true, attachments?: OutgoingAttachment[], includeOriginalAttachments: boolean = false): Promise<SendDeliveryResult> {
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
    const originalAttachments: OutgoingAttachment[] = includeOriginalAttachments
      ? (parsed.attachments ?? []).map(attachment => ({
          contentBase64: attachment.content.toString('base64'),
          filename: attachment.filename || 'attachment',
          contentType: attachment.contentType,
          contentDisposition: attachment.contentDisposition === 'inline' ? 'inline' : 'attachment',
          ...(attachment.contentId ? { cid: attachment.contentId } : {}),
        }))
      : [];
    const outgoingAttachments = [...originalAttachments, ...(attachments ?? [])];

    return this.sendMessage({
      to,
      subject: fwdSubject,
      ...(isHtml ? { html: effectiveBody } : { text: effectiveBody }),
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      ...(outgoingAttachments.length > 0 ? { attachments: outgoingAttachments } : {}),
      includeSignature: false,
    });
  }

  async forwardLocatedEmail(
    locator: string,
    to: string,
    body: string = '',
    isHtml: boolean = false,
    cc?: string,
    bcc?: string,
    includeSignature: boolean = true,
    attachments?: OutgoingAttachment[],
    includeOriginalAttachments: boolean = false,
  ): Promise<SendDeliveryResult> {
    const resolved = await this.resolveLocator(locator);
    return this.forwardEmail(
      resolved.uid.toString(),
      resolved.mailbox,
      to,
      body,
      isHtml,
      cc,
      bcc,
      includeSignature,
      attachments,
      includeOriginalAttachments,
    );
  }

  async createDraftMessage(message: MailSendMessage): Promise<DraftCreationResult> {
    const effective = this.effectiveOutgoingMessage(message);
    const composed = await this.smtpClient.composeMessage(effective, { stripBcc: false });
    const draftsFolder = await this.resolveDraftsFolder();
    const appended = await this.imapClient.appendMessage(draftsFolder, composed.rawMessage, ['\\Draft']);
    let locator: string | undefined;
    if (appended.uid !== undefined) {
      const identity = await this.imapClient.getMailboxIdentity(draftsFolder);
      locator = encodeMessageLocator({
        accountId: this.account.id,
        mailbox: identity.path,
        uidValidity: identity.uidValidity,
        uid: appended.uid,
      });
    }
    return {
      folder: draftsFolder,
      ...(appended.uid !== undefined ? { uid: appended.uid } : {}),
      ...(locator ? { locator } : {}),
      ...(composed.messageId ? { messageId: composed.messageId } : {}),
    };
  }

  async createDraft(to: string, subject: string, body: string, isHtml: boolean = false, cc?: string, bcc?: string, includeSignature: boolean = true): Promise<void> {
    await this.createDraftMessage({
      to,
      subject,
      ...(isHtml ? { html: body } : { text: body }),
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      includeSignature,
    });
  }

  private async _cachedFetchBody(uid: string, folder: string): Promise<ParsedMail> {
    const key = `${this.account.id}:${folder}:${uid}`;
    const cached = this.bodyCache.get(key);
    if (cached) return cached;

    const existingFetch = this.bodyFetches.get(key);
    if (existingFetch) return existingFetch;

    const fetch = this.imapClient.fetchMessageBody(uid, folder)
      .then(parsed => {
        if (this.bodyFetches.get(key) === fetch) {
          this.bodyCache.set(key, parsed);
        }
        return parsed;
      })
      .finally(() => {
        if (this.bodyFetches.get(key) === fetch) {
          this.bodyFetches.delete(key);
        }
      });

    this.bodyFetches.set(key, fetch);
    return fetch;
  }

  invalidateBodyCache(folder: string, uid: string): void {
    const key = `${this.account.id}:${folder}:${uid}`;
    this.bodyCache.delete(key);
    this.bodyFetches.delete(key);
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
      // Keep binary image data out of tool responses. Agents can fetch the
      // original attachment explicitly through get_attachment when needed.
      if (parsed.attachments) {
        for (const att of parsed.attachments) {
          if (att.contentId && att.contentType.startsWith('image/')) {
            const attachmentName = att.filename || att.contentId;
            const attachmentUri = `mail-attachment://${encodeURIComponent(this.account.id)}/${encodeURIComponent(uid)}/${encodeURIComponent(attachmentName)}`;
            const cidRegex = new RegExp(`cid:${att.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
            html = html.replace(cidRegex, attachmentUri);
          }
        }
      }
      html = html.replace(INLINE_DATA_IMAGE_PATTERN, 'mail-inline-image://omitted');
      content = htmlToMarkdown(html);
    } else if (parsed.textAsHtml) {
      content = htmlToMarkdown(parsed.textAsHtml.replace(INLINE_DATA_IMAGE_PATTERN, 'mail-inline-image://omitted'));
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

    let header = `**From:** ${this.redactText(parsed.from?.text || 'Unknown')}\n`;
    const toText = Array.isArray(parsed.to) ? parsed.to.map(t => t.text).join(', ') : parsed.to?.text;
    header += `**To:** ${this.redactText(toText || 'Unknown')}\n`;
    if (parsed.cc) {
      const ccText = Array.isArray(parsed.cc) ? parsed.cc.map(t => t.text).join(', ') : parsed.cc.text;
      header += `**Cc:** ${this.redactText(ccText)}\n`;
    }
    header += `**Subject:** ${this.redactText(parsed.subject || 'No Subject')}\n`;
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

    if (content.length > MAX_READ_BODY_CHARS) {
      content = `${content.slice(0, MAX_READ_BODY_CHARS)}\n\n[Body truncated at ${MAX_READ_BODY_CHARS} characters]`;
    }
    const body = this.redactText(content);
    return header + body + attachmentInfo;
  }

  async readLocatedEmail(locator: string): Promise<string> {
    const resolved = await this.resolveLocator(locator);
    return this.readEmail(resolved.uid.toString(), resolved.mailbox);
  }

  async getThread(threadId: string, folder: string = 'INBOX'): Promise<MessageMetadata[]> {
    const messages = await this.imapClient.fetchThreadMessages(threadId, folder);
    return messages.map(message => this.redactMessageMetadata(message));
  }

  async readRawEmail(locator: string, maxBytes: number = 10 * 1024 * 1024): Promise<RawEmailResult> {
    const resolved = await this.resolveLocator(locator);
    const content = await this.imapClient.fetchRawMessage(
      resolved.uid.toString(),
      resolved.mailbox,
      maxBytes
    );
    return {
      locator,
      mediaType: 'message/rfc822',
      transferEncoding: 'base64',
      size: content.length,
      contentBase64: content.toString('base64'),
    };
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

  async downloadLocatedAttachment(
    locator: string,
    filename: string,
    maxBytes: number = 50 * 1024 * 1024,
  ): Promise<{ content: Buffer, contentType: string }> {
    const resolved = await this.resolveLocator(locator);
    return this.downloadAttachment(resolved.uid.toString(), filename, resolved.mailbox, maxBytes);
  }

  async extractAttachmentText(uid: string, filename: string, folder: string = 'INBOX'): Promise<string> {
    const { content, contentType } = await this.downloadAttachment(uid, filename, folder);
    if (contentType === 'application/pdf') {
      // pdf-parse v2 exports the PDFParse class and no default function, so the
      // v1 call shape (`pdf.default || pdf`) resolves to the module namespace
      // and throws "pdfParser is not a function".
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: content });
      try {
        const result = await parser.getText();
        return this.redactText(result.text);
      } finally {
        await parser.destroy();
      }
    } else if (contentType.startsWith('text/')) {
      return this.redactText(content.toString('utf-8'));
    } else {
      throw new Error(`Extraction not supported for content type: ${contentType}`);
    }
  }

  async extractLocatedAttachmentText(locator: string, filename: string): Promise<string> {
    const resolved = await this.resolveLocator(locator);
    return this.extractAttachmentText(resolved.uid.toString(), filename, resolved.mailbox);
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
      name: this.redactText(data.name),
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

  async listMailboxMetadata(): Promise<MailboxMetadata[]> {
    return this.imapClient.listMailboxMetadata();
  }

  async createMailbox(path: string): Promise<{ path: string; created: boolean; mailboxId?: string }> {
    return this.imapClient.createMailbox(path);
  }

  async renameMailbox(path: string, newPath: string): Promise<{ path: string; newPath: string }> {
    const result = await this.imapClient.renameMailbox(path, newPath);
    this.clearMailboxResolutionCaches();
    this.paginationStore.clear();
    return result;
  }

  async deleteMailbox(path: string): Promise<{ path: string }> {
    const result = await this.imapClient.deleteMailbox(path);
    this.clearMailboxResolutionCaches();
    this.paginationStore.clear();
    return result;
  }

  async copyEmail(locator: string, targetFolder: string): Promise<CopyEmailResult> {
    const source = await this.resolveLocator(locator);
    const result = await this.imapClient.copyMessage(source.uid.toString(), source.mailbox, targetFolder);
    const destinationUid = result.uidMap?.[source.uid.toString()];
    let destinationLocator: string | undefined;
    if (destinationUid !== undefined) {
      const identity = await this.imapClient.getMailboxIdentity(result.destination || targetFolder);
      destinationLocator = encodeMessageLocator({
        accountId: this.account.id,
        mailbox: identity.path,
        uidValidity: identity.uidValidity,
        uid: destinationUid,
      });
    }
    return {
      ...result,
      sourceLocator: locator,
      ...(destinationLocator ? { destinationLocator } : {}),
    };
  }

  private clearMailboxResolutionCaches(): void {
    this.sentFolderPromise = null;
    this.draftsFolderPromise = null;
    this.trashFolderPromise = null;
  }

  async getMailboxStats(folders?: string[]): Promise<MailboxStatus[]> {
    const targetFolders = (!folders || folders.length === 0)
      ? await this.imapClient.listFolders()
      : folders;
    return this.imapClient.getMailboxStatus(targetFolders);
  }

  async moveMessage(uid: string, sourceFolder: string, targetFolder: string): Promise<void> {
    await this.imapClient.moveMessage(uid, sourceFolder, targetFolder);
    this.invalidateBodyCache(sourceFolder, uid);
  }

  async moveLocatedEmail(locator: string, targetFolder: string): Promise<void> {
    const resolved = await this.resolveLocator(locator);
    await this.moveMessage(resolved.uid.toString(), resolved.mailbox, targetFolder);
  }

  async deleteEmail(uid: string, folder: string = 'INBOX', explicitTrashFolder?: string): Promise<void> {
    const trashFolder = await this.resolveTrashFolder(explicitTrashFolder);
    if (trashFolder.toLocaleLowerCase() === folder.toLocaleLowerCase()) {
      throw new ValidationError('Message is already in Trash. Use permanentlyDeleteEmail for irreversible deletion.');
    }
    await this.imapClient.moveMessage(uid, folder, trashFolder);
    this.invalidateBodyCache(folder, uid);
  }

  async deleteLocatedEmail(locator: string, explicitTrashFolder?: string): Promise<void> {
    const resolved = await this.resolveLocator(locator);
    await this.deleteEmail(resolved.uid.toString(), resolved.mailbox, explicitTrashFolder);
  }

  async permanentlyDeleteEmail(uid: string, folder: string = 'Trash'): Promise<void> {
    await this.imapClient.deleteMessage(uid, folder);
    this.invalidateBodyCache(folder, uid);
  }

  async permanentlyDeleteLocatedEmail(locator: string): Promise<void> {
    const resolved = await this.resolveLocator(locator);
    await this.permanentlyDeleteEmail(resolved.uid.toString(), resolved.mailbox);
  }

  async modifyLabels(uid: string, folder: string, addLabels: string[], removeLabels: string[]): Promise<void> {
    return this.imapClient.modifyLabels(uid, folder, addLabels, removeLabels);
  }

  async modifyLocatedLabels(locator: string, addLabels: string[], removeLabels: string[]): Promise<void> {
    const resolved = await this.resolveLocator(locator);
    return this.modifyLabels(resolved.uid.toString(), resolved.mailbox, addLabels, removeLabels);
  }

  private async executeBatchGroup(
    entries: readonly { uid: string; locator?: string }[],
    folder: string,
    operation: BatchOperation,
  ): Promise<BatchOperationItemResult[]> {
    if (entries.length === 0) return [];
    const uids = entries.map(entry => entry.uid);
    try {
      switch (operation.type) {
        case 'move':
          await this.imapClient.batchMoveMessages(uids, folder, operation.targetFolder);
          for (const uid of uids) this.invalidateBodyCache(folder, uid);
          break;
        case 'delete': {
          const trashFolder = await this.resolveTrashFolder();
          if (trashFolder.toLocaleLowerCase() === folder.toLocaleLowerCase()) {
            throw new ValidationError('Message is already in Trash. Use permanentlyDeleteEmail for irreversible deletion.');
          }
          await this.imapClient.batchMoveMessages(uids, folder, trashFolder);
          for (const uid of uids) this.invalidateBodyCache(folder, uid);
          break;
        }
        case 'copy':
          await this.imapClient.batchCopyMessages(uids, folder, operation.targetFolder);
          break;
        case 'label':
          await this.imapClient.batchModifyLabels(
            uids,
            folder,
            operation.addLabels ?? [],
            operation.removeLabels ?? [],
          );
          break;
        default:
          throw new Error(`Unknown batch operation type: ${(operation as { type: string }).type}`);
      }
      return entries.map(entry => ({
        ...(entry.uid !== undefined ? { uid: entry.uid } : {}),
        ...(entry.locator !== undefined ? { locator: entry.locator } : {}),
        success: true,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return entries.map(entry => ({
        ...(entry.uid !== undefined ? { uid: entry.uid } : {}),
        ...(entry.locator !== undefined ? { locator: entry.locator } : {}),
        success: false,
        error: message,
      }));
    }
  }

  async batchOperations(
    uids: string[],
    folder: string,
    operation: BatchOperation,
  ): Promise<BatchOperationResult> {
    if (uids.length === 0) {
      throw new Error('No UIDs provided for batch operation');
    }
    if (uids.length > 100) {
      throw new Error('Batch operations are limited to 100 emails at once');
    }

    // One IMAP command per operation keeps mailbox work bounded. The result
    // still contains one item per requested UID; if the command fails before
    // IMAP reports success, every item is reported with the same error and no
    // retry is attempted because the server may have applied the command.
    const items = await this.executeBatchGroup(
      uids.map(uid => ({ uid })),
      folder,
      operation,
    );

    const succeeded = items.filter(item => item.success).length;
    return {
      processed: items.length,
      succeeded,
      failed: items.length - succeeded,
      items,
    };
  }

  async batchLocatedOperations(
    locators: string[],
    operation: BatchOperation,
  ): Promise<BatchOperationResult> {
    if (locators.length === 0) {
      throw new Error('No message locators provided for batch operation');
    }
    if (locators.length > 100) {
      throw new Error('Batch operations are limited to 100 messages at once');
    }

    type ResolvedEntry = { index: number; locator: string; uid: string; mailbox: string };
    const items: Array<BatchOperationItemResult | undefined> = new Array(locators.length);
    const entries: ResolvedEntry[] = [];
    const identities = new Map<string, Promise<{ path: string; uidValidity: string }>>();

    for (const [index, locator] of locators.entries()) {
      try {
        const decoded = decodeMessageLocator(locator);
        if (decoded.accountId !== this.account.id) {
          throw new ValidationError('Message locator belongs to a different account.');
        }
        let identityPromise = identities.get(decoded.mailbox);
        if (!identityPromise) {
          identityPromise = this.imapClient.getMailboxIdentity(decoded.mailbox);
          identities.set(decoded.mailbox, identityPromise);
        }
        const identity = await identityPromise;
        if (identity.path !== decoded.mailbox || identity.uidValidity !== decoded.uidValidity) {
          throw new ValidationError('Message locator is stale because the mailbox identity changed.');
        }
        entries.push({
          index,
          locator,
          uid: decoded.uid.toString(),
          mailbox: decoded.mailbox,
        });
      } catch (error) {
        items[index] = {
          locator,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const groups = new Map<string, ResolvedEntry[]>();
    for (const entry of entries) {
      const group = groups.get(entry.mailbox) ?? [];
      group.push(entry);
      groups.set(entry.mailbox, group);
    }
    for (const [mailbox, group] of groups) {
      const groupItems = await this.executeBatchGroup(
        group.map(entry => ({ uid: entry.uid, locator: entry.locator })),
        mailbox,
        operation,
      );
      group.forEach((entry, groupIndex) => {
        items[entry.index] = groupItems[groupIndex];
      });
    }

    const completedItems = items.filter((item): item is BatchOperationItemResult => item !== undefined);
    const succeeded = completedItems.filter(item => item.success).length;
    return {
      processed: completedItems.length,
      succeeded,
      failed: completedItems.length - succeeded,
      items: completedItems,
    };
  }
}
