import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailAccount } from '../config.js';
import { ImapClient } from './imap.js';

const account: EmailAccount = {
  id: 'work',
  name: 'Work',
  host: 'imap.example.com',
  port: 993,
  user: 'user@example.com',
  authType: 'login',
  useTLS: true,
};

function connectedClient(flow: Record<string, unknown>): ImapClient {
  const client = new ImapClient(account);
  (client as unknown as { client: Record<string, unknown> }).client = flow;
  return client;
}

describe('ImapClient mailbox and capability primitives', () => {
  const release = vi.fn();

  beforeEach(() => {
    release.mockClear();
  });

  it('returns typed mailbox metadata including stable UIDVALIDITY', async () => {
    const list = vi.fn().mockResolvedValue([{
      path: 'Projects/2026',
      name: '2026',
      parentPath: 'Projects',
      delimiter: '/',
      flags: new Set(['\\HasNoChildren']),
      specialUse: undefined,
      listed: true,
      subscribed: true,
      status: {
        messages: 10,
        unseen: 2,
        recent: 1,
        uidNext: 90,
        uidValidity: 123n,
        highestModseq: 456n,
      },
    }]);
    const client = connectedClient({ list });

    await expect(client.listMailboxMetadata()).resolves.toEqual([{
      path: 'Projects/2026',
      name: '2026',
      parentPath: 'Projects',
      delimiter: '/',
      flags: ['\\HasNoChildren'],
      specialUse: undefined,
      listed: true,
      subscribed: true,
      total: 10,
      unread: 2,
      recent: 1,
      uidNext: 90,
      uidValidity: '123',
      highestModseq: '456',
    }]);
    expect(list).toHaveBeenCalledWith({ statusQuery: expect.objectContaining({ uidValidity: true }) });
  });

  it('exposes capabilities case-insensitively without leaking the mutable map', () => {
    const client = connectedClient({ capabilities: new Map([['IMAP4rev1', true], ['MOVE', true]]) });
    expect(client.getCapabilities()).toEqual(['IMAP4REV1', 'MOVE']);
    expect(client.hasCapability('move')).toBe(true);
    expect(client.hasCapability('UIDPLUS')).toBe(false);
  });

  it('gets mailbox UIDVALIDITY for locator and cursor isolation', async () => {
    const status = vi.fn().mockResolvedValue({ path: 'INBOX', uidValidity: 999n });
    const client = connectedClient({ status });
    await expect(client.getMailboxIdentity('INBOX')).resolves.toEqual({ path: 'INBOX', uidValidity: '999' });
    expect(status).toHaveBeenCalledWith('INBOX', { uidValidity: true });
  });

  it('creates, renames, and deletes mailboxes through ImapFlow', async () => {
    const mailboxCreate = vi.fn().mockResolvedValue({ path: 'Projects', created: true, mailboxId: 'id-1' });
    const mailboxRename = vi.fn().mockResolvedValue({ path: 'Projects', newPath: 'Archive/Projects' });
    const mailboxDelete = vi.fn().mockResolvedValue({ path: 'Archive/Projects' });
    const client = connectedClient({ mailboxCreate, mailboxRename, mailboxDelete });

    await expect(client.createMailbox('Projects')).resolves.toEqual({ path: 'Projects', created: true, mailboxId: 'id-1' });
    await expect(client.renameMailbox('Projects', 'Archive/Projects')).resolves.toEqual({ path: 'Projects', newPath: 'Archive/Projects' });
    await expect(client.deleteMailbox('Archive/Projects')).resolves.toEqual({ path: 'Archive/Projects' });
  });

  it('copies UIDs under a source mailbox lock and returns UIDPLUS mapping', async () => {
    const messageCopy = vi.fn().mockResolvedValue({
      destination: 'Archive',
      uidValidity: 777n,
      uidMap: new Map([[4, 40], [5, 50]]),
    });
    const getMailboxLock = vi.fn().mockResolvedValue({ release });
    const client = connectedClient({ messageCopy, getMailboxLock });

    await expect(client.batchCopyMessages(['4', '5'], 'INBOX', 'Archive')).resolves.toEqual({
      destination: 'Archive',
      uidValidity: '777',
      uidMap: { '4': 40, '5': 50 },
    });
    expect(messageCopy).toHaveBeenCalledWith('4,5', 'Archive', { uid: true });
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects invalid UID sequences before issuing COPY', async () => {
    const messageCopy = vi.fn();
    const client = connectedClient({ messageCopy, getMailboxLock: vi.fn() });
    await expect(client.batchCopyMessages(['1:*'], 'INBOX', 'Archive')).rejects.toThrow('Invalid message UID');
    expect(messageCopy).not.toHaveBeenCalled();
  });

  it('rejects oversized raw messages before fetching source bytes', async () => {
    const fetchOne = vi.fn().mockResolvedValueOnce({ size: 101 });
    const client = connectedClient({
      getMailboxLock: vi.fn().mockResolvedValue({ release }),
      fetchOne,
    });

    await expect(client.fetchRawMessage('9', 'INBOX', 100)).rejects.toThrow('exceeds the 100 byte limit');
    expect(fetchOne).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('checks the actual raw byte length when server size is absent or stale', async () => {
    const fetchOne = vi.fn()
      .mockResolvedValueOnce({ size: 3 })
      .mockResolvedValueOnce({ source: Buffer.from('RFC822') });
    const client = connectedClient({
      getMailboxLock: vi.fn().mockResolvedValue({ release }),
      fetchOne,
    });

    await expect(client.fetchRawMessage('9', 'INBOX', 5)).rejects.toThrow('exceeds the 5 byte limit');
    expect(release).toHaveBeenCalledOnce();
  });

  it('snapshots only UIDs and fetches metadata for the requested page', async () => {
    const fetch = vi.fn()
      .mockReturnValueOnce([{ uid: 1 }, { uid: 2 }, { uid: 3 }])
      .mockReturnValueOnce([
        { uid: 2, envelope: { subject: 'Two', from: [{ address: 'two@example.com' }] } },
        { uid: 3, envelope: { subject: 'Three', from: [{ address: 'three@example.com' }] } },
      ]);
    const client = connectedClient({
      mailbox: { exists: 3 },
      getMailboxLock: vi.fn().mockResolvedValue({ release }),
      fetch,
    });

    await expect(client.listMessageUids('INBOX', 10)).resolves.toEqual([3, 2, 1]);
    await expect(client.fetchMessagesByUids([3, 2], 'INBOX', true)).resolves.toEqual([
      expect.objectContaining({ uid: 3, subject: 'Three', snippet: '' }),
      expect.objectContaining({ uid: 2, subject: 'Two', snippet: '' }),
    ]);
    expect(fetch).toHaveBeenNthCalledWith(1, '1:3', { uid: true });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '3,2',
      { envelope: true, flags: true, internalDate: true },
      { uid: true },
    );
  });

  it('rejects an oversized list snapshot before fetching message metadata', async () => {
    const fetch = vi.fn();
    const client = connectedClient({
      mailbox: { exists: 10_001 },
      getMailboxLock: vi.fn().mockResolvedValue({ release }),
      fetch,
    });

    await expect(client.listMessageUids('INBOX', 10_000)).rejects.toThrow(
      'Pagination snapshot exceeds 10000 messages',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
