import { describe, it, expect, vi } from 'vitest';
import { ImapClient } from './imap.js';
import type { EmailAccount } from '../config.js';

vi.mock('../security/keychain.js', () => ({
  loadCredentials: vi.fn(() => Promise.resolve('test-password'))
}));

vi.mock('imapflow', () => {
  return {
    ImapFlow: vi.fn().mockImplementation(function() {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        once: vi.fn(),
        logout: vi.fn().mockResolvedValue(undefined),
        getMailboxLock: vi.fn().mockResolvedValue({
          release: vi.fn()
        }),
        fetch: vi.fn().mockImplementation(async function* () {
          yield {
            uid: 1,
            envelope: {
              subject: 'Test Subject',
              from: [{ address: 'test@example.com' }],
              date: new Date()
            },
            internalDate: new Date(),
            threadId: '123'
          };
        }),
        fetchOne: vi.fn().mockResolvedValue({
          source: Buffer.from('Email Source'),
          internalDate: new Date()
        }),
        search: vi.fn().mockResolvedValue([1]),
        list: vi.fn().mockResolvedValue([
          { path: 'INBOX' },
          { path: 'Sent', specialUse: '\\Sent' },
          { path: 'Drafts' },
          { path: 'Trash' }
        ]),
        append: vi.fn().mockResolvedValue({ uid: 321 }),
        messageMove: vi.fn().mockResolvedValue(undefined),
        messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
        messageFlagsRemove: vi.fn().mockResolvedValue(undefined),
        messageDelete: vi.fn().mockResolvedValue(undefined),
        status: vi.fn().mockImplementation((folder: string) =>
          Promise.resolve({ messages: 100, unseen: 5, recent: 2, path: folder })
        ),
        once: vi.fn(),
        mailbox: {
          exists: 1
        }
      };
    })
  };
});

describe('ImapClient', () => {
  const account: EmailAccount = {
    id: 'test-account',
    name: 'Test',
    host: 'imap.test.com',
    port: 993,
    user: 'test@test.com',
    authType: 'login',
    useTLS: true
  };

  it('should connect to the IMAP server', async () => {
    const client = new ImapClient(account);
    await client.connect();
    expect(client).toBeDefined();
  });

  it('should fetch message metadata by UID', async () => {
    const client = new ImapClient(account);
    await client.connect();
    const messages = await client.fetchMessagesByUids([1]);
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe('Test Subject');
  });

  it('should fetch message body', async () => {
    const client = new ImapClient(account);
    await client.connect();
    const body = await client.fetchMessageBody('1');
    expect(body.headerLines[0].line).toBe('Email Source');
  });

  it('should fetch thread messages', async () => {
    const client = new ImapClient(account);
    await client.connect();
    const messages = await client.fetchThreadMessages('123');
    expect(messages).toHaveLength(1);
    expect(messages[0].threadId).toBe('123');
    const latestInstance = (await import('imapflow')).ImapFlow as any;
    const flow = latestInstance.mock.results.at(-1)?.value;
    expect(flow.search).toHaveBeenCalledWith({ 'x-gm-thrid': '123' }, { uid: true });
  });

  it('uses UIDs for every thread search so sequence numbers cannot select the wrong messages', async () => {
    const { ImapFlow } = await import('imapflow');
    const MockImapFlow = ImapFlow as any;
    const search = vi.fn().mockImplementation((criteria: any, options?: { uid?: boolean }) => {
      if (criteria['x-gm-thrid']) return Promise.resolve([]);

      const header = Object.keys(criteria.header ?? {})[0];
      const uidByHeader: Record<string, number> = {
        References: 7001,
        'In-Reply-To': 7002,
        'Message-ID': 7003,
      };
      const sequenceByHeader: Record<string, number> = {
        References: 11,
        'In-Reply-To': 12,
        'Message-ID': 13,
      };
      return Promise.resolve([options?.uid ? uidByHeader[header] : sequenceByHeader[header]]);
    });
    const fetch = vi.fn().mockImplementation(async function* (range: string) {
      for (const uid of range.split(',').map(Number)) {
        yield {
          uid,
          envelope: {
            subject: `Message ${uid}`,
            from: [{ address: 'sender@example.com' }],
            date: new Date(uid),
          },
          internalDate: new Date(uid),
        };
      }
    });
    MockImapFlow.mockImplementationOnce(function () {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        once: vi.fn(),
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        search,
        fetch,
      };
    });

    const client = new ImapClient(account);
    await client.connect();
    const messages = await client.fetchThreadMessages('thread-message-id');

    expect(search).toHaveBeenCalledTimes(4);
    expect(search).toHaveBeenNthCalledWith(1, { 'x-gm-thrid': 'thread-message-id' }, { uid: true });
    expect(search).toHaveBeenNthCalledWith(2, { header: { References: 'thread-message-id' } }, { uid: true });
    expect(search).toHaveBeenNthCalledWith(3, { header: { 'In-Reply-To': 'thread-message-id' } }, { uid: true });
    expect(search).toHaveBeenNthCalledWith(4, { header: { 'Message-ID': 'thread-message-id' } }, { uid: true });
    expect(fetch).toHaveBeenCalledWith('7001,7002,7003', { envelope: true, flags: true, internalDate: true }, { uid: true });
    expect(messages.map(message => message.uid)).toEqual([7001, 7002, 7003]);
  });

  it('should search message UIDs with criteria', async () => {
    const client = new ImapClient(account);
    await client.connect();
    const uids = await client.searchMessageUids({ from: 'sender@example.com', subject: 'Test' });
    expect(uids).toEqual([1]);
  });

  describe('IMAP-04: listFolders', () => {
    it('should list folders returning an array of path strings', async () => {
      const client = new ImapClient(account);
      await client.connect();
      const folders = await client.listFolders();
      expect(folders).toEqual(['INBOX', 'Sent', 'Drafts', 'Trash']);
    });

    it('resolves the server special-use Sent folder', async () => {
      const client = new ImapClient(account);
      await client.connect();
      await expect(client.findSpecialUseFolder('\\Sent')).resolves.toBe('Sent');
    });
  });

  describe('appendMessage', () => {
    it('returns the UID supplied by UIDPLUS', async () => {
      const client = new ImapClient(account);
      await client.connect();
      await expect(client.appendMessage('Sent', Buffer.from('raw'), ['\\Seen']))
        .resolves.toEqual({ uid: 321 });
    });

    it('treats an empty APPEND response as unconfirmed', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          append: vi.fn().mockResolvedValue(false),
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      await expect(client.appendMessage('Sent', 'raw')).rejects.toThrow('no confirmation');
    });
  });

  describe('ORG-01: moveMessage', () => {
    it('should call messageMove with correct uid and target folder', async () => {
      const { ImapFlow } = await import('imapflow');
      const instance = (ImapFlow as any).mock.results.at(-1)?.value;
      const client = new ImapClient(account);
      await client.connect();
      await client.moveMessage('5', 'INBOX', 'Archive');
      const latestInstance = (ImapFlow as any).mock.results.at(-1)?.value;
      expect(latestInstance.messageMove).toHaveBeenCalledWith('5', 'Archive', { uid: true });
    });
  });

  describe('ORG-02: modifyLabels', () => {
    it('should call messageFlagsAdd when addLabels provided', async () => {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapClient(account);
      await client.connect();
      await client.modifyLabels('5', 'INBOX', ['\\Flagged'], []);
      const latestInstance = (ImapFlow as any).mock.results.at(-1)?.value;
      expect(latestInstance.messageFlagsAdd).toHaveBeenCalledWith('5', ['\\Flagged'], { uid: true });
    });

    it('should call messageFlagsRemove when removeLabels provided', async () => {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapClient(account);
      await client.connect();
      await client.modifyLabels('5', 'INBOX', [], ['\\Seen']);
      const latestInstance = (ImapFlow as any).mock.results.at(-1)?.value;
      expect(latestInstance.messageFlagsRemove).toHaveBeenCalledWith('5', ['\\Seen'], { uid: true });
    });

    it('should call both add and remove when both lists are non-empty', async () => {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapClient(account);
      await client.connect();
      await client.modifyLabels('5', 'INBOX', ['\\Flagged'], ['\\Seen']);
      const latestInstance = (ImapFlow as any).mock.results.at(-1)?.value;
      expect(latestInstance.messageFlagsAdd).toHaveBeenCalledWith('5', ['\\Flagged'], { uid: true });
      expect(latestInstance.messageFlagsRemove).toHaveBeenCalledWith('5', ['\\Seen'], { uid: true });
    });
  });

  describe('UID validation', () => {
    it.each(['1:*', '1,2', '0', '01', '4294967296', '-1', 'abc', ''])(
      'rejects non-scalar UID %j before any single-message operation',
      async (uid) => {
        const client = new ImapClient(account);
        await client.connect();

        await expect(client.moveMessage(uid, 'INBOX', 'Archive')).rejects.toThrow('Invalid message UID');
        await expect(client.copyMessage(uid, 'INBOX', 'Archive')).rejects.toThrow('Invalid message UID');
        await expect(client.modifyLabels(uid, 'INBOX', ['\\Seen'], [])).rejects.toThrow('Invalid message UID');
        await expect(client.deleteMessage(uid, 'INBOX')).rejects.toThrow('Invalid message UID');
        await expect(client.fetchMessageBody(uid, 'INBOX')).rejects.toThrow('Invalid message UID');
        await expect(client.fetchRawMessage(uid, 'INBOX')).rejects.toThrow('Invalid message UID');
        await expect(client.fetchAttachmentSize(uid, 'file.txt', 'INBOX')).rejects.toThrow('Invalid message UID');
      },
    );

    it('validates every UID before encoding a batch sequence', async () => {
      const client = new ImapClient(account);
      await client.connect();
      const invalidBatch = ['1', '1:*'];

      await expect(client.batchMoveMessages(invalidBatch, 'INBOX', 'Archive')).rejects.toThrow('Invalid message UID');
      await expect(client.batchCopyMessages(invalidBatch, 'INBOX', 'Archive')).rejects.toThrow('Invalid message UID');
      await expect(client.batchDeleteMessages(invalidBatch, 'INBOX')).rejects.toThrow('Invalid message UID');
      await expect(client.batchModifyLabels(invalidBatch, 'INBOX', ['\\Seen'], [])).rejects.toThrow('Invalid message UID');
    });

    it('rejects empty batch UID lists', async () => {
      const client = new ImapClient(account);
      await client.connect();

      await expect(client.batchMoveMessages([], 'INBOX', 'Archive')).rejects.toThrow('At least one UID');
      await expect(client.batchCopyMessages([], 'INBOX', 'Archive')).rejects.toThrow('At least one UID');
      await expect(client.batchDeleteMessages([], 'INBOX')).rejects.toThrow('At least one UID');
      await expect(client.batchModifyLabels([], 'INBOX', ['\\Seen'], [])).rejects.toThrow('At least one UID');
    });
  });

  it('should return empty array when search finds no messages', async () => {
    const { ImapFlow } = await import('imapflow');
    const MockImapFlow = ImapFlow as any;
    MockImapFlow.mockImplementationOnce(function() {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        once: vi.fn(),
        logout: vi.fn().mockResolvedValue(undefined),
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        search: vi.fn().mockResolvedValue([]),
        fetch: vi.fn().mockImplementation(async function* () {}),
        mailbox: { exists: 0 }
      };
    });
    const emptyClient = new ImapClient(account);
    await emptyClient.connect();
    const uids = await emptyClient.searchMessageUids({ from: 'nobody@example.com' });
    expect(uids).toEqual([]);
  });

  describe('disconnect() liveness check', () => {
    it('calls logout() when client exists and client.usable is true', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      const logoutMock = vi.fn().mockResolvedValue(undefined);
      MockImapFlow.mockImplementationOnce(function() {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          logout: logoutMock,
          usable: true,
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: vi.fn().mockImplementation(async function* () {}),
          mailbox: { exists: 0 }
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      await client.disconnect();
      expect(logoutMock).toHaveBeenCalledOnce();
    });

    it('does NOT call logout() when client exists but client.usable is false', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      const logoutMock = vi.fn().mockResolvedValue(undefined);
      MockImapFlow.mockImplementationOnce(function() {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          logout: logoutMock,
          usable: false,
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: vi.fn().mockImplementation(async function* () {}),
          mailbox: { exists: 0 }
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      await client.disconnect();
      expect(logoutMock).not.toHaveBeenCalled();
    });

    it('sets this.client to null after successful logout', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      MockImapFlow.mockImplementationOnce(function() {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          logout: vi.fn().mockResolvedValue(undefined),
          usable: true,
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: vi.fn().mockImplementation(async function* () {}),
          mailbox: { exists: 0 }
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      await client.disconnect();
      expect((client as any).client).toBeNull();
    });

    it('sets this.client to null even when client.usable is false (cleanup)', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      MockImapFlow.mockImplementationOnce(function() {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          logout: vi.fn().mockResolvedValue(undefined),
          usable: false,
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: vi.fn().mockImplementation(async function* () {}),
          mailbox: { exists: 0 }
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      await client.disconnect();
      expect((client as any).client).toBeNull();
    });

    it('does nothing when client is null (no throw)', async () => {
      const client = new ImapClient(account);
      // client is null since we never called connect()
      await expect(client.disconnect()).resolves.toBeUndefined();
      expect((client as any).client).toBeNull();
    });
  });

  describe('CE-01: scanSenderEnvelopes', () => {
    it('returns [] when mailbox has 0 messages', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: vi.fn().mockImplementation(async function* () {}),
          mailbox: { exists: 0 },
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const result = await client.scanSenderEnvelopes('INBOX', 100);
      expect(result).toEqual([]);
    });

    it('returns SenderEnvelope[] with name, email, date for each message', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      const fixedDate = new Date('2024-01-15T10:00:00Z');
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: vi.fn().mockImplementation(async function* () {
            yield {
              uid: 1,
              envelope: {
                from: [{ name: 'Alice Smith', address: 'alice@example.com' }],
                date: fixedDate,
              },
            };
            yield {
              uid: 2,
              envelope: {
                from: [{ name: '', address: 'bob@example.com' }],
                date: fixedDate,
              },
            };
          }),
          mailbox: { exists: 2 },
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const result = await client.scanSenderEnvelopes('INBOX', 10);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'Alice Smith', email: 'alice@example.com', date: fixedDate });
      expect(result[1]).toEqual({ name: '', email: 'bob@example.com', date: fixedDate });
    });

    it('normalizes email addresses to lowercase', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: vi.fn().mockImplementation(async function* () {
            yield {
              uid: 1,
              envelope: {
                from: [{ name: 'Alice', address: 'Alice@Example.COM' }],
                date: new Date(),
              },
            };
          }),
          mailbox: { exists: 1 },
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const result = await client.scanSenderEnvelopes();
      expect(result[0].email).toBe('alice@example.com');
    });

    it('caps count to 500', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      const fetchMock = vi.fn().mockImplementation(async function* () {});
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: fetchMock,
          mailbox: { exists: 1000 },
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      // Request 999 but should be capped at 500 → range 501:1000
      await client.scanSenderEnvelopes('INBOX', 999);
      expect(fetchMock).toHaveBeenCalledWith('501:1000', expect.objectContaining({ envelope: true }));
    });

    it('skips messages with no from address without throwing', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: vi.fn().mockImplementation(async function* () {
            yield { uid: 1, envelope: { from: null, date: new Date() } };
            yield { uid: 2, envelope: { from: [], date: new Date() } };
            yield {
              uid: 3,
              envelope: {
                from: [{ name: 'Valid', address: 'valid@example.com' }],
                date: new Date(),
              },
            };
          }),
          mailbox: { exists: 3 },
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const result = await client.scanSenderEnvelopes();
      expect(result).toHaveLength(1);
      expect(result[0].email).toBe('valid@example.com');
    });
  });

  describe('fetchAttachmentSize', () => {
    it('returns size when bodyStructure has part matching parameters.name', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      const mockRelease = vi.fn();
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: mockRelease }),
          fetchOne: vi.fn().mockResolvedValue({
            bodyStructure: {
              parameters: { name: 'report.pdf' },
              size: 1000,
              childNodes: [],
            },
          }),
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const size = await client.fetchAttachmentSize('1', 'report.pdf');
      expect(size).toBe(1000);
      expect(mockRelease).toHaveBeenCalledOnce();
    });

    it('returns size when bodyStructure has part matching dispositionParameters.filename', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetchOne: vi.fn().mockResolvedValue({
            bodyStructure: {
              dispositionParameters: { filename: 'report.pdf' },
              size: 2000,
              childNodes: [],
            },
          }),
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const size = await client.fetchAttachmentSize('1', 'report.pdf');
      expect(size).toBe(2000);
    });

    it('returns correct size when matching part is nested in childNodes', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetchOne: vi.fn().mockResolvedValue({
            bodyStructure: {
              childNodes: [
                {
                  childNodes: [
                    {
                      parameters: { name: 'nested.pdf' },
                      size: 5000,
                      childNodes: [],
                    },
                  ],
                },
              ],
            },
          }),
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const size = await client.fetchAttachmentSize('1', 'nested.pdf');
      expect(size).toBe(5000);
    });

    it('returns null when no part matches the filename', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetchOne: vi.fn().mockResolvedValue({
            bodyStructure: {
              parameters: { name: 'other.pdf' },
              size: 999,
              childNodes: [],
            },
          }),
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const size = await client.fetchAttachmentSize('1', 'report.pdf');
      expect(size).toBeNull();
    });

    it('returns null when msg.bodyStructure is undefined', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetchOne: vi.fn().mockResolvedValue({ bodyStructure: undefined }),
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const size = await client.fetchAttachmentSize('1', 'report.pdf');
      expect(size).toBeNull();
    });

    it('returns null when fetchOne returns null', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetchOne: vi.fn().mockResolvedValue(null),
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const size = await client.fetchAttachmentSize('1', 'report.pdf');
      expect(size).toBeNull();
    });
  });

  describe('STATS-01: getMailboxStatus', () => {
    it('returns status for a single folder', async () => {
      const client = new ImapClient(account);
      await client.connect();
      const result = await client.getMailboxStatus(['INBOX']);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('INBOX');
      expect(result[0].total).toBe(100);
      expect(result[0].unread).toBe(5);
      expect(result[0].recent).toBe(2);
    });

    it('returns status for multiple folders concurrently', async () => {
      const client = new ImapClient(account);
      await client.connect();
      const result = await client.getMailboxStatus(['INBOX', 'Sent', 'Drafts']);
      expect(result).toHaveLength(3);
      const names = result.map(r => r.name);
      expect(names).toContain('INBOX');
      expect(names).toContain('Sent');
      expect(names).toContain('Drafts');
    });

    it('bounds concurrent status requests while preserving folder order', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      let active = 0;
      let maximumActive = 0;
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          status: vi.fn().mockImplementation(async (folder: string) => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise(resolve => setTimeout(resolve, 1));
            active -= 1;
            return { messages: folder.length, unseen: 0, recent: 0, path: folder };
          }),
        };
      });

      const client = new ImapClient(account);
      await client.connect();
      const folders = Array.from({ length: 20 }, (_, index) => `Folder-${index}`);
      const result = await client.getMailboxStatus(folders);

      expect(maximumActive).toBeLessThanOrEqual(8);
      expect(maximumActive).toBeGreaterThan(1);
      expect(result.map(status => status.name)).toEqual(folders);
    });

    it('isolates per-folder errors — other folders still return data', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      MockImapFlow.mockImplementationOnce(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          logout: vi.fn().mockResolvedValue(undefined),
          usable: true,
          status: vi.fn().mockImplementation((folder: string) => {
            if (folder === 'Broken') return Promise.reject(new Error('Folder not found'));
            return Promise.resolve({ messages: 10, unseen: 1, recent: 0, path: folder });
          }),
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const result = await client.getMailboxStatus(['INBOX', 'Broken']);
      expect(result).toHaveLength(2);
      const inbox = result.find(r => r.name === 'INBOX');
      const broken = result.find(r => r.name === 'Broken');
      expect(inbox?.total).toBe(10);
      expect(broken?.total).toBeNull();
      expect(broken?.error).toContain('Folder not found');
    });

    it('throws when client is not connected', async () => {
      const client = new ImapClient(account);
      await expect(client.getMailboxStatus(['INBOX'])).rejects.toThrow('Not connected');
    });
  });
});
