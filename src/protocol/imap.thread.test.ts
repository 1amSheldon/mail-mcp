import { describe, it, expect, vi } from 'vitest';
import { ImapClient } from './imap.js';
import { MailService } from '../services/mail.js';
import { decodeMessageLocator } from '../domain/message-locator.js';
import type { EmailAccount } from '../config.js';

const account = { id: 'test', user: 'me@example.test' } as EmailAccount;
function fixture() {
  let folder = 'INBOX';
  const headers: Record<string, Record<number, string>> = {
    INBOX: { 1: 'Message-ID: <a@test>\r\n', 3: 'Message-ID: <c@test>\r\nReferences: <a@test> <b@test>\r\n' },
    Sent: { 2: 'Message-ID: <b@test>\r\nReferences: <a@test>\r\n' },
  };
  const flow = {
    capabilities: new Map(), mailbox: { uidValidity: 1n },
    getMailboxLock: vi.fn(async (path: string) => { folder = path; return { release() {} }; }),
    status: vi.fn(async (path: string) => ({ path, uidValidity: 1n })),
    search: vi.fn(async (query: any) => Object.entries(headers[folder]).filter(([, raw]) => {
      const [key, value] = Object.entries(query.header)[0];
      return raw.split('\r\n').some(line => line.startsWith(key + ':') && line.includes(value as string));
    }).map(([uid]) => Number(uid))),
    fetch: vi.fn(async function* (range: string) {
      for (const uid of range.split(',').map(Number)) yield { uid, headers: Buffer.from(headers[folder][uid]), envelope: { date: new Date(uid) } };
    }),
  };
  const client = new ImapClient(account);
  (client as any).client = flow;
  return { client, flow };
}

describe('thread reconstruction', () => {
  it('shares one real SEARCH budget across a long reference graph and multiple folders', async () => {
    const { client, flow } = fixture();
    const ids = Array.from({ length: 40 }, (_, i) => `<id${i}@test>`);
    flow.search.mockResolvedValue([1]);
    flow.fetch.mockImplementation(async function* () {
      yield { uid: 1, headers: Buffer.from(`Message-ID: ${ids[0]}\r\nReferences: ${ids.slice(1).join(' ')}\r\n`), envelope: { date: new Date() } };
    });
    const service = new MailService(account);
    (service as any).imapClient = client;
    expect((await service.getThread(ids[0], 'INBOX', ['INBOX', 'Sent'])).partial).toBe(true);
    expect(flow.search.mock.calls.length).toBeLessThanOrEqual(100);
  });
  it('walks ancestors from the last message and retains explicit partial scope', async () => {
    const { client } = fixture();
    const service = new MailService(account);
    (service as any).imapClient = client;
    const result = await service.getThread('<c@test>', 'INBOX', ['INBOX', 'Sent']);
    expect(result.items.map(item => item.uid)).toEqual([1, 2, 3]);
    expect(result.items.map(item => decodeMessageLocator(item.locator).mailbox)).toEqual(['INBOX', 'Sent', 'INBOX']);
    expect(result.partial).toBe(true);
  });
  it('passes the supported Gmail threadId criterion and requests thread IDs in FETCH', async () => {
    const { client, flow } = fixture();
    flow.capabilities.set('X-GM-EXT-1', true);
    flow.search.mockResolvedValue([1]);
    await client.fetchThreadMessages('123');
    expect(flow.search).toHaveBeenCalledExactlyOnceWith({ threadId: '123' }, { uid: true });
    expect(flow.fetch).toHaveBeenCalledWith('1', expect.objectContaining({ threadId: true }), { uid: true });
  });

  it('uses only the Gmail thread ID in every requested folder despite long References', async () => {
    const { client, flow } = fixture();
    flow.capabilities.set('X-GM-EXT-1', true);
    flow.search.mockResolvedValue([1]);
    flow.fetch.mockImplementation(async function* () {
      yield {
        uid: 1, threadId: 123n, envelope: {},
        headers: Buffer.from(`Message-ID: <root@test>\r\nReferences: ${Array.from({ length: 40 }, (_, i) => `<ref${i}@test>`).join(' ')}\r\n`),
      };
    });
    const service = new MailService(account);
    (service as any).imapClient = client;
    await service.getThread('123', 'INBOX', ['INBOX', 'Sent', 'Archive']);
    expect(flow.search.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ threadId: '123' }, { uid: true }]));
  });
});
