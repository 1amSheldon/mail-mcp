import { ImapFlow } from 'imapflow';
import type { EmailAccount } from '../config.js';
import { loadCredentials } from '../security/keychain.js';
import { getValidAccessToken } from '../security/oauth2.js';
import { simpleParser, ParsedMail } from 'mailparser';

export interface MailboxStatus {
  name: string;
  total: number | null;
  unread: number | null;
  recent: number | null;
  error?: string;
}

export interface MailboxMetadata {
  path: string;
  name: string;
  parentPath: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
  listed: boolean;
  subscribed: boolean;
  total: number | null;
  unread: number | null;
  recent: number | null;
  uidNext: number | null;
  uidValidity: string | null;
  highestModseq: string | null;
}

export interface MailboxIdentity {
  path: string;
  uidValidity: string;
}

export interface CopyMessagesResult {
  destination: string;
  uidValidity?: string;
  uidMap?: Record<string, number>;
}

export interface MessageMetadata {
  id: string;
  uid: number;
  subject?: string;
  from?: string;
  date?: Date;
  snippet?: string;
  threadId?: string;
}

export interface SenderEnvelope {
  name: string;
  email: string;
  date: Date;
}

export interface AppendMessageResult {
  uid?: number;
}

const MAX_MAILBOX_STATUS_CONCURRENCY = 8;
const MAX_IMAP_UID = 4_294_967_295n;

function assertValidUid(uid: string): void {
  if (!/^[1-9]\d{0,9}$/.test(uid) || BigInt(uid) > MAX_IMAP_UID) {
    throw new Error(`Invalid message UID: ${uid}`);
  }
}

function encodeUidSet(uids: string[]): string {
  if (uids.length === 0) throw new Error('At least one UID is required');
  for (const uid of uids) assertValidUid(uid);
  return uids.join(',');
}

export class ImapClient {
  private client: ImapFlow | null = null;
  private account: EmailAccount;
  public onClose: (() => void) | null = null;

  constructor(account: EmailAccount) {
    this.account = account;
  }

  async connect(): Promise<void> {
    let authConfig: any = { user: this.account.user };

    if (this.account.authType === 'oauth2') {
      const accessToken = await getValidAccessToken(this.account.id);
      authConfig.accessToken = accessToken;
    } else {
      const password = await loadCredentials(this.account.id);
      if (!password) {
        throw new Error(`Credentials not found for account: ${this.account.id}`);
      }
      authConfig.pass = password;
    }

    this.client = new ImapFlow({
      host: this.account.host,
      port: this.account.port,
      secure: this.account.useTLS,
      auth: authConfig,
      logger: false
    });

    await this.client.connect();
    this.client.once('close', () => {
      this.onClose?.();
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      if (this.client.usable) {
        await this.client.logout();
      }
      this.client = null;
    }
  }

  async scanSenderEnvelopes(folder: string = 'INBOX', count: number = 100): Promise<SenderEnvelope[]> {
    if (!this.client) {
      throw new Error('Not connected');
    }

    const effectiveCount = Math.min(count, 500);

    const lock = await this.client.getMailboxLock(folder);
    try {
      const mailbox = this.client.mailbox;
      const total = (mailbox && typeof mailbox !== 'boolean') ? mailbox.exists : 0;
      if (total === 0) return [];

      const end = total;
      const start = Math.max(1, end - effectiveCount + 1);
      const range = `${start}:${end}`;

      const envelopes: SenderEnvelope[] = [];
      for await (const msg of this.client.fetch(range, { envelope: true })) {
        const fromList = msg.envelope?.from;
        if (!fromList || fromList.length === 0) continue;
        const sender = fromList[0];
        if (!sender?.address) continue;
        envelopes.push({
          name: sender.name ?? '',
          email: sender.address.toLowerCase(),
          date: msg.envelope?.date ?? new Date(0),
        });
      }
      return envelopes;
    } finally {
      lock.release();
    }
  }

  async fetchMessageBody(uid: string, folder: string = 'INBOX'): Promise<ParsedMail> {
    if (!this.client) {
      throw new Error('Not connected');
    }
    assertValidUid(uid);

    const lock = await this.client.getMailboxLock(folder);
    try {
      const msg = await this.client.fetchOne(uid, { source: true, internalDate: true }, { uid: true });
      if (!msg || !msg.source) {
        throw new Error(`Message with UID ${uid} not found`);
      }
      return await simpleParser(msg.source);
    } finally {
      lock.release();
    }
  }

  async fetchThreadMessages(threadId: string, folder: string = 'INBOX'): Promise<MessageMetadata[]> {
    if (!this.client) {
      throw new Error('Not connected');
    }

    const lock = await this.client.getMailboxLock(folder);
    try {
      // Use GM-THRID for Gmail, fall back to References/Message-ID header search
      let uids: number[] = [];
      try {
        uids = await this.client.search({ 'x-gm-thrid': threadId } as any, { uid: true }) as number[];
      } catch (e) {
        // x-gm-thrid not supported — fall through to header search below
      }

      if (!uids || uids.length === 0) {
        try {
          const refUids = await this.client.search(
            { header: { References: threadId } },
            { uid: true },
          ) as number[];
          const replyUids = await this.client.search(
            { header: { 'In-Reply-To': threadId } },
            { uid: true },
          ) as number[];
          const rootUids = await this.client.search(
            { header: { 'Message-ID': threadId } },
            { uid: true },
          ) as number[];
          uids = [...new Set([...(refUids || []), ...(replyUids || []), ...(rootUids || [])])];
        } catch (e2) {
          // header search not supported — return empty
          return [];
        }
      }

      if (!uids || uids.length === 0) return [];

      const messages: MessageMetadata[] = [];
      for await (const msg of this.client.fetch(uids.join(','), { envelope: true, flags: true, internalDate: true }, { uid: true })) {
        messages.push({
          id: msg.uid.toString(),
          uid: msg.uid,
          subject: msg.envelope?.subject,
          from: msg.envelope?.from?.[0]?.address || 'Unknown',
          date: msg.envelope?.date || (msg.internalDate instanceof Date ? msg.internalDate : (msg.internalDate ? new Date(msg.internalDate) : undefined)),
          snippet: '',
          threadId: (msg as any).threadId?.toString() || threadId,
        });
      }
      return messages.sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0));
    } finally {
      lock.release();
    }
  }

  async appendMessage(folder: string, rawMessage: string | Buffer, flags: string[] = []): Promise<AppendMessageResult> {
    if (!this.client) {
      throw new Error('Not connected');
    }

    const lock = await this.client.getMailboxLock(folder);
    try {
      const response = await this.client.append(folder, rawMessage, flags);
      if (!response) {
        throw new Error(`IMAP APPEND to ${folder} returned no confirmation`);
      }
      return { uid: response.uid };
    } finally {
      lock.release();
    }
  }

  async listFolders(): Promise<string[]> {
    if (!this.client) throw new Error('Not connected');
    const folders = await this.client.list();
    return folders.map(f => f.path);
  }

  async listMessageUids(folder: string = 'INBOX', maximum: number = 10_000): Promise<number[]> {
    if (!this.client) throw new Error('Not connected');
    const lock = await this.client.getMailboxLock(folder);
    try {
      const mailbox = this.client.mailbox;
      const total = mailbox && typeof mailbox !== 'boolean' ? mailbox.exists : 0;
      if (total === 0) return [];
      if (total > maximum) {
        throw new Error(`Pagination snapshot exceeds ${maximum} messages`);
      }
      const uids: number[] = [];
      for await (const message of this.client.fetch(`1:${total}`, { uid: true })) {
        uids.push(message.uid);
      }
      return uids.sort((left, right) => right - left);
    } finally {
      lock.release();
    }
  }

  async searchMessageUids(
    criteria: unknown,
    folder: string = 'INBOX',
    maximum: number = 10_000,
  ): Promise<number[]> {
    if (!this.client) throw new Error('Not connected');
    const lock = await this.client.getMailboxLock(folder);
    try {
      const found = await this.client.search(criteria as any, { uid: true });
      if (!found || typeof found === 'boolean') return [];
      if (found.length > maximum) {
        throw new Error(`Pagination snapshot exceeds ${maximum} messages`);
      }
      return [...found].sort((left, right) => right - left);
    } finally {
      lock.release();
    }
  }

  async fetchMessagesByUids(
    uids: readonly number[],
    folder: string = 'INBOX',
    headerOnly: boolean = false,
  ): Promise<MessageMetadata[]> {
    if (!this.client) throw new Error('Not connected');
    if (uids.length === 0) return [];
    const lock = await this.client.getMailboxLock(folder);
    try {
      const fetchOptions: any = { envelope: true, flags: true, internalDate: true };
      if (!headerOnly) fetchOptions.bodyParts = ['TEXT'];
      const byUid = new Map<number, MessageMetadata>();
      for await (const msg of this.client.fetch(uids.join(','), fetchOptions, { uid: true })) {
        const textBuffer = headerOnly ? undefined : (msg as any).bodyParts?.get('TEXT');
        byUid.set(msg.uid, {
          id: msg.uid.toString(),
          uid: msg.uid,
          subject: msg.envelope?.subject,
          from: msg.envelope?.from?.[0]?.address || 'Unknown',
          date: msg.envelope?.date || (msg.internalDate instanceof Date
            ? msg.internalDate
            : msg.internalDate ? new Date(msg.internalDate) : undefined),
          snippet: textBuffer
            ? textBuffer.toString('utf-8').replace(/\s+/g, ' ').slice(0, 200).trim()
            : '',
          threadId: (msg as any).threadId?.toString(),
        });
      }
      return uids.flatMap(uid => {
        const message = byUid.get(uid);
        return message ? [message] : [];
      });
    } finally {
      lock.release();
    }
  }

  async listMailboxMetadata(): Promise<MailboxMetadata[]> {
    if (!this.client) throw new Error('Not connected');
    const folders = await this.client.list({
      statusQuery: {
        messages: true,
        unseen: true,
        recent: true,
        uidNext: true,
        uidValidity: true,
        highestModseq: true,
      },
    });
    return folders.map(folder => ({
      path: folder.path,
      name: folder.name,
      parentPath: folder.parentPath,
      delimiter: folder.delimiter,
      flags: [...folder.flags].sort(),
      specialUse: folder.specialUse,
      listed: folder.listed,
      subscribed: folder.subscribed,
      total: folder.status?.messages ?? null,
      unread: folder.status?.unseen ?? null,
      recent: folder.status?.recent ?? null,
      uidNext: folder.status?.uidNext ?? null,
      uidValidity: folder.status?.uidValidity?.toString() ?? null,
      highestModseq: folder.status?.highestModseq?.toString() ?? null,
    }));
  }

  async getMailboxIdentity(folder: string): Promise<MailboxIdentity> {
    if (!this.client) throw new Error('Not connected');
    const status = await this.client.status(folder, { uidValidity: true });
    if (!status || status.uidValidity === undefined) {
      throw new Error(`Mailbox ${folder} did not report UIDVALIDITY`);
    }
    return { path: status.path, uidValidity: status.uidValidity.toString() };
  }

  getCapabilities(): string[] {
    if (!this.client) throw new Error('Not connected');
    return [...this.client.capabilities.keys()].map(capability => capability.toUpperCase()).sort();
  }

  hasCapability(capability: string): boolean {
    if (!this.client) throw new Error('Not connected');
    const normalized = capability.toUpperCase();
    return [...this.client.capabilities.keys()].some(candidate => candidate.toUpperCase() === normalized);
  }

  async createMailbox(path: string): Promise<{ path: string; created: boolean; mailboxId?: string }> {
    if (!this.client) throw new Error('Not connected');
    this.validateMailboxPath(path);
    const result = await this.client.mailboxCreate(path);
    return { path: result.path, created: result.created, mailboxId: result.mailboxId };
  }

  async renameMailbox(path: string, newPath: string): Promise<{ path: string; newPath: string }> {
    if (!this.client) throw new Error('Not connected');
    this.validateMailboxPath(path);
    this.validateMailboxPath(newPath);
    return await this.client.mailboxRename(path, newPath);
  }

  async deleteMailbox(path: string): Promise<{ path: string }> {
    if (!this.client) throw new Error('Not connected');
    this.validateMailboxPath(path);
    return await this.client.mailboxDelete(path);
  }

  async findSpecialUseFolder(specialUse: string): Promise<string | undefined> {
    if (!this.client) throw new Error('Not connected');
    const normalized = specialUse.toLowerCase();
    const folders = await this.client.list();
    return folders.find(folder => folder.specialUse?.toLowerCase() === normalized)?.path;
  }

  async moveMessage(uid: string, sourceFolder: string, targetFolder: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    assertValidUid(uid);
    const lock = await this.client.getMailboxLock(sourceFolder);
    try {
      await this.client.messageMove(uid, targetFolder, { uid: true });
    } finally {
      lock.release();
    }
  }

  async copyMessage(uid: string, sourceFolder: string, targetFolder: string): Promise<CopyMessagesResult> {
    return await this.copyMessages([uid], sourceFolder, targetFolder);
  }

  async batchCopyMessages(uids: string[], sourceFolder: string, targetFolder: string): Promise<CopyMessagesResult> {
    return await this.copyMessages(uids, sourceFolder, targetFolder);
  }

  async modifyLabels(uid: string, folder: string, addLabels: string[], removeLabels: string[]): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    assertValidUid(uid);
    const lock = await this.client.getMailboxLock(folder);
    try {
      if (addLabels.length > 0) {
        await this.client.messageFlagsAdd(uid, addLabels, { uid: true });
      }
      if (removeLabels.length > 0) {
        await this.client.messageFlagsRemove(uid, removeLabels, { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  async batchMoveMessages(uids: string[], sourceFolder: string, targetFolder: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const sequence = encodeUidSet(uids);
    const lock = await this.client.getMailboxLock(sourceFolder);
    try {
      await this.client.messageMove(sequence, targetFolder, { uid: true });
    } finally {
      lock.release();
    }
  }

  async deleteMessage(uid: string, folder: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    assertValidUid(uid);
    const lock = await this.client.getMailboxLock(folder);
    try {
      await this.client.messageDelete(uid, { uid: true });
    } finally {
      lock.release();
    }
  }

  async batchDeleteMessages(uids: string[], folder: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const sequence = encodeUidSet(uids);
    const lock = await this.client.getMailboxLock(folder);
    try {
      await this.client.messageDelete(sequence, { uid: true });
    } finally {
      lock.release();
    }
  }

  async batchModifyLabels(uids: string[], folder: string, addLabels: string[], removeLabels: string[]): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const sequence = encodeUidSet(uids);
    const lock = await this.client.getMailboxLock(folder);
    try {
      if (addLabels.length > 0) {
        await this.client.messageFlagsAdd(sequence, addLabels, { uid: true });
      }
      if (removeLabels.length > 0) {
        await this.client.messageFlagsRemove(sequence, removeLabels, { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  async fetchAttachmentSize(uid: string, filename: string, folder: string = 'INBOX'): Promise<number | null> {
    if (!this.client) throw new Error('Not connected');
    assertValidUid(uid);
    const lock = await this.client.getMailboxLock(folder);
    try {
      const msg = await this.client.fetchOne(uid, { bodyStructure: true }, { uid: true });
      if (!msg || !(msg as any).bodyStructure) return null;
      const bodyStructure = (msg as any).bodyStructure;

      function findSize(node: any): number | null {
        const name = node.parameters?.name ?? node.dispositionParameters?.filename;
        if (name === filename && node.size != null) {
          return node.size;
        }
        if (node.childNodes) {
          for (const child of node.childNodes) {
            const result = findSize(child);
            if (result !== null) return result;
          }
        }
        return null;
      }

      return findSize(bodyStructure);
    } finally {
      lock.release();
    }
  }

  async fetchRawMessage(uid: string, folder: string = 'INBOX', maxBytes: number = 10 * 1024 * 1024): Promise<Buffer> {
    if (!this.client) throw new Error('Not connected');
    assertValidUid(uid);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('maxBytes must be a positive integer');
    }

    const lock = await this.client.getMailboxLock(folder);
    try {
      const metadata = await this.client.fetchOne(uid, { size: true }, { uid: true });
      if (!metadata) {
        throw new Error(`Message with UID ${uid} not found`);
      }
      if (typeof metadata.size === 'number' && metadata.size > maxBytes) {
        throw new Error(`Message with UID ${uid} exceeds the ${maxBytes} byte limit`);
      }

      const message = await this.client.fetchOne(uid, { source: true }, { uid: true });
      if (!message || !message.source) {
        throw new Error(`Message with UID ${uid} not found`);
      }
      const source = Buffer.isBuffer(message.source) ? message.source : Buffer.from(message.source);
      if (source.length > maxBytes) {
        throw new Error(`Message with UID ${uid} exceeds the ${maxBytes} byte limit`);
      }
      return source;
    } finally {
      lock.release();
    }
  }

  async getMailboxStatus(folders: string[]): Promise<MailboxStatus[]> {
    if (!this.client) throw new Error('Not connected');
    if (folders.length === 0) return [];

    const results: MailboxStatus[] = new Array(folders.length);
    let nextIndex = 0;
    const workerCount = Math.min(MAX_MAILBOX_STATUS_CONCURRENCY, folders.length);

    const readNextStatus = async (): Promise<void> => {
      while (nextIndex < folders.length) {
        const index = nextIndex++;
        const folder = folders[index];
        try {
          const info = await (this.client as any).status(folder, {
            messages: true,
            unseen: true,
            recent: true,
          });
          results[index] = {
            name: folder,
            total: info.messages ?? null,
            unread: info.unseen ?? null,
            recent: info.recent ?? null,
          };
        } catch (err) {
          results[index] = {
            name: folder,
            total: null,
            unread: null,
            recent: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => readNextStatus()));
    return results;
  }

  private async copyMessages(uids: string[], sourceFolder: string, targetFolder: string): Promise<CopyMessagesResult> {
    if (!this.client) throw new Error('Not connected');
    const sequence = encodeUidSet(uids);
    this.validateMailboxPath(sourceFolder);
    this.validateMailboxPath(targetFolder);

    const lock = await this.client.getMailboxLock(sourceFolder);
    try {
      const result = await this.client.messageCopy(sequence, targetFolder, { uid: true });
      if (!result) {
        throw new Error(`IMAP COPY to ${targetFolder} returned no confirmation`);
      }
      const uidMap = result.uidMap
        ? Object.fromEntries([...result.uidMap.entries()].map(([sourceUid, destinationUid]) => [sourceUid.toString(), destinationUid]))
        : undefined;
      return {
        destination: result.destination,
        uidValidity: result.uidValidity?.toString(),
        uidMap,
      };
    } finally {
      lock.release();
    }
  }

  private validateMailboxPath(path: string): void {
    if (!path || path.length > 4_096 || /[\u0000-\u001f\u007f]/.test(path)) {
      throw new Error('Invalid mailbox path');
    }
  }
}
