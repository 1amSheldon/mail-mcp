import { describe, it, expect, vi } from 'vitest';
import { ImapClient } from './imap.js';
import { EmailAccount } from '../types/index.js';

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
          { path: 'Sent' },
          { path: 'Drafts' },
          { path: 'Trash' }
        ]),
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

  it('should list messages', async () => {
    const client = new ImapClient(account);
    await client.connect();
    const messages = await client.listMessages();
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
  });

  it('should search messages with criteria', async () => {
    const client = new ImapClient(account);
    await client.connect();
    const messages = await client.searchMessages({ from: 'sender@example.com', subject: 'Test' });
    expect(messages).toHaveLength(1);
    expect(messages[0].uid).toBe(1);
  });

  describe('IMAP-04: listFolders', () => {
    it('should list folders returning an array of path strings', async () => {
      const client = new ImapClient(account);
      await client.connect();
      const folders = await client.listFolders();
      expect(folders).toEqual(['INBOX', 'Sent', 'Drafts', 'Trash']);
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
    const messages = await emptyClient.searchMessages({ from: 'nobody@example.com' });
    expect(messages).toHaveLength(0);
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

  describe('pagination', () => {
    it('listMessages with offset=0 returns normal results (backward compat)', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      const fetchMock = vi.fn().mockImplementation(async function* () {
        yield {
          uid: 50,
          envelope: { subject: 'Latest', from: [{ address: 'a@b.com' }], date: new Date() },
          internalDate: new Date(),
        };
      });
      MockImapFlow.mockImplementationOnce(function() {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: fetchMock,
          mailbox: { exists: 50 },
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const messages = await client.listMessages('INBOX', 5, 0);
      // With offset=0, total=50, count=5: end=50, start=max(1,50-5+1)=46 → range '46:50'
      expect(fetchMock).toHaveBeenCalledWith('46:50', expect.any(Object));
      expect(messages).toHaveLength(1);
    });

    it('listMessages with offset=10, count=5, total=50 calls fetch with range "36:40"', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      const fetchMock = vi.fn().mockImplementation(async function* () {});
      MockImapFlow.mockImplementationOnce(function() {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: fetchMock,
          mailbox: { exists: 50 },
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      await client.listMessages('INBOX', 5, 10);
      // end=50-10=40, start=max(1,40-5+1)=36 → range '36:40'
      expect(fetchMock).toHaveBeenCalledWith('36:40', expect.any(Object));
    });

    it('listMessages with offset >= total returns []', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      const fetchMock = vi.fn().mockImplementation(async function* () {});
      MockImapFlow.mockImplementationOnce(function() {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: fetchMock,
          mailbox: { exists: 50 },
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      // offset=50 >= total=50: end=0 which is < 1, return []
      const messages = await client.listMessages('INBOX', 5, 50);
      expect(messages).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('listMessages with offset leaving fewer than count messages clamps start to 1', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      const fetchMock = vi.fn().mockImplementation(async function* () {});
      MockImapFlow.mockImplementationOnce(function() {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          fetch: fetchMock,
          mailbox: { exists: 50 },
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      // offset=48, count=5, total=50: end=50-48=2, start=max(1,2-5+1)=max(1,-2)=1 → range '1:2'
      await client.listMessages('INBOX', 5, 48);
      expect(fetchMock).toHaveBeenCalledWith('1:2', expect.any(Object));
    });

    it('searchMessages with offset=0 returns normal results (backward compat)', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      const fetchMock = vi.fn().mockImplementation(async function* () {
        yield {
          uid: 7,
          envelope: { subject: 'Matched', from: [{ address: 'x@y.com' }], date: new Date() },
          internalDate: new Date(),
        };
      });
      MockImapFlow.mockImplementationOnce(function() {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          search: vi.fn().mockResolvedValue([1, 2, 3, 4, 5, 6, 7]),
          fetch: fetchMock,
          mailbox: { exists: 10 },
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      await client.searchMessages({}, 'INBOX', 2, 0);
      // uids=[1,2,3,4,5,6,7], offset=0, count=2: end=7, start=max(0,7-2)=5 → slice(5,7)=[6,7]
      expect(fetchMock).toHaveBeenCalledWith('6,7', expect.any(Object), expect.any(Object));
    });

    it('searchMessages with offset=3, count=2, uids=[1..7] calls fetch with UIDs "3,4"', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      const fetchMock = vi.fn().mockImplementation(async function* () {});
      MockImapFlow.mockImplementationOnce(function() {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          search: vi.fn().mockResolvedValue([1, 2, 3, 4, 5, 6, 7]),
          fetch: fetchMock,
          mailbox: { exists: 10 },
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      await client.searchMessages({}, 'INBOX', 2, 3);
      // uids=[1,2,3,4,5,6,7], offset=3, count=2: end=7-3=4, start=max(0,4-2)=2 → slice(2,4)=[3,4]
      expect(fetchMock).toHaveBeenCalledWith('3,4', expect.any(Object), expect.any(Object));
    });

    it('searchMessages with offset >= uids.length returns []', async () => {
      const { ImapFlow } = await import('imapflow');
      const MockImapFlow = ImapFlow as any;
      const fetchMock = vi.fn().mockImplementation(async function* () {});
      MockImapFlow.mockImplementationOnce(function() {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
          search: vi.fn().mockResolvedValue([1, 2, 3]),
          fetch: fetchMock,
          mailbox: { exists: 10 },
        };
      });
      const client = new ImapClient(account);
      await client.connect();
      const messages = await client.searchMessages({}, 'INBOX', 2, 5);
      expect(messages).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
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

    it('returns status for multiple folders in parallel', async () => {
      const client = new ImapClient(account);
      await client.connect();
      const result = await client.getMailboxStatus(['INBOX', 'Sent', 'Drafts']);
      expect(result).toHaveLength(3);
      const names = result.map(r => r.name);
      expect(names).toContain('INBOX');
      expect(names).toContain('Sent');
      expect(names).toContain('Drafts');
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
