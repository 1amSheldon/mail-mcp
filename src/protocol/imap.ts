import { ImapFlow } from 'imapflow';
import { EmailAccount } from '../types/index.js';
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

  async listMessages(folder: string = 'INBOX', count: number = 10, offset: number = 0, headerOnly: boolean = false): Promise<MessageMetadata[]> {
    if (!this.client) {
      throw new Error('Not connected');
    }

    const lock = await this.client.getMailboxLock(folder);
    try {
      const messages: MessageMetadata[] = [];
      const mailbox = this.client.mailbox;
      const total = (mailbox && typeof mailbox !== 'boolean') ? mailbox.exists : 0;
      if (total === 0) return [];

      const end = total - offset;
      if (end < 1) return [];
      const start = Math.max(1, end - count + 1);
      const range = `${start}:${end}`;

      const fetchOptions: any = { envelope: true, flags: true, internalDate: true };
      if (!headerOnly) {
        fetchOptions.bodyParts = ['TEXT'];
      }

      for await (const msg of this.client.fetch(range, fetchOptions)) {
        const textBuf = headerOnly ? null : (msg as any).bodyParts?.get('TEXT');
        const snippet = textBuf
          ? textBuf.toString('utf-8').replace(/\s+/g, ' ').slice(0, 200).trim()
          : '';
        messages.push({
          id: msg.uid.toString(),
          uid: msg.uid,
          subject: msg.envelope?.subject,
          from: msg.envelope?.from?.[0]?.address || 'Unknown',
          date: msg.envelope?.date || (msg.internalDate instanceof Date ? msg.internalDate : (msg.internalDate ? new Date(msg.internalDate) : undefined)),
          snippet,
          threadId: (msg as any).threadId?.toString(),
        });
      }
      return messages.reverse();
    } finally {
      lock.release();
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

  async searchMessages(criteria: any, folder: string = 'INBOX', count: number = 10, offset: number = 0): Promise<MessageMetadata[]> {
    if (!this.client) {
      throw new Error('Not connected');
    }

    const lock = await this.client.getMailboxLock(folder);
    try {
      const uids = await this.client.search(criteria, { uid: true });
      if (!uids || typeof uids === 'boolean' || uids.length === 0) return [];

      const uidsArray = (uids as number[]).sort((a, b) => a - b);
      if (offset >= uidsArray.length) return [];

      const end = uidsArray.length - offset;
      const start = Math.max(0, end - count);
      const sliced = uidsArray.slice(start, end);
      const messages: MessageMetadata[] = [];

      for await (const msg of this.client.fetch(sliced.join(','), { envelope: true, flags: true, internalDate: true, bodyParts: ['TEXT'] }, { uid: true })) {
        const textBuf = (msg as any).bodyParts?.get('TEXT');
        const snippet = textBuf
          ? textBuf.toString('utf-8').replace(/\s+/g, ' ').slice(0, 200).trim()
          : '';
        messages.push({
          id: msg.uid.toString(),
          uid: msg.uid,
          subject: msg.envelope?.subject,
          from: msg.envelope?.from?.[0]?.address || 'Unknown',
          date: msg.envelope?.date || (msg.internalDate instanceof Date ? msg.internalDate : (msg.internalDate ? new Date(msg.internalDate) : undefined)),
          snippet,
          threadId: (msg as any).threadId?.toString(),
        });
      }
      return messages.reverse();
    } finally {
      lock.release();
    }
  }

  async fetchMessageBody(uid: string, folder: string = 'INBOX'): Promise<ParsedMail> {
    if (!this.client) {
      throw new Error('Not connected');
    }

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
        uids = await this.client.search({ 'x-gm-thrid': threadId } as any) as number[];
      } catch (e) {
        // x-gm-thrid not supported — fall through to header search below
      }

      if (!uids || uids.length === 0) {
        try {
          const refUids = await this.client.search(
            { header: { References: threadId } }
          ) as number[];
          const rootUids = await this.client.search(
            { header: { 'Message-ID': threadId } }
          ) as number[];
          uids = [...new Set([...(refUids || []), ...(rootUids || [])])];
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

  async appendMessage(folder: string, rawMessage: string | Buffer, flags: string[] = []): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected');
    }

    const lock = await this.client.getMailboxLock(folder);
    try {
      await this.client.append(folder, rawMessage, flags);
    } finally {
      lock.release();
    }
  }

  async listFolders(): Promise<string[]> {
    if (!this.client) throw new Error('Not connected');
    const folders = await this.client.list();
    return folders.map(f => f.path);
  }

  async moveMessage(uid: string, sourceFolder: string, targetFolder: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const lock = await this.client.getMailboxLock(sourceFolder);
    try {
      await this.client.messageMove(uid, targetFolder, { uid: true });
    } finally {
      lock.release();
    }
  }

  async modifyLabels(uid: string, folder: string, addLabels: string[], removeLabels: string[]): Promise<void> {
    if (!this.client) throw new Error('Not connected');
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
    const sequence = uids.join(',');
    const lock = await this.client.getMailboxLock(sourceFolder);
    try {
      await this.client.messageMove(sequence, targetFolder, { uid: true });
    } finally {
      lock.release();
    }
  }

  async deleteMessage(uid: string, folder: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const lock = await this.client.getMailboxLock(folder);
    try {
      await this.client.messageDelete(uid, { uid: true });
    } finally {
      lock.release();
    }
  }

  async batchDeleteMessages(uids: string[], folder: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const sequence = uids.join(',');
    const lock = await this.client.getMailboxLock(folder);
    try {
      await this.client.messageDelete(sequence, { uid: true });
    } finally {
      lock.release();
    }
  }

  async batchModifyLabels(uids: string[], folder: string, addLabels: string[], removeLabels: string[]): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const sequence = uids.join(',');
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

  async getMailboxStatus(folders: string[]): Promise<MailboxStatus[]> {
    if (!this.client) throw new Error('Not connected');
    return Promise.all(
      folders.map(async (folder): Promise<MailboxStatus> => {
        try {
          const info = await (this.client as any).status(folder, {
            messages: true,
            unseen: true,
            recent: true,
          });
          return {
            name: folder,
            total: info.messages ?? null,
            unread: info.unseen ?? null,
            recent: info.recent ?? null,
          };
        } catch (err) {
          return {
            name: folder,
            total: null,
            unread: null,
            recent: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );
  }
}
