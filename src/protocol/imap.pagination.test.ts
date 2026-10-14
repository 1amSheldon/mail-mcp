import { describe, it, expect, vi } from 'vitest';
import { ImapClient } from './imap.js';
import { UidCursorStore } from '../utils/uid-cursors.js';
import type { EmailAccount } from '../config.js';
import { buildSearchCriteria } from '../domain/mail-search.js';

describe('bounded UID pagination', () => {
  it('intersects full window results before the page limit and continues below that intersection', async () => {
    const client = new ImapClient({} as EmailAccount);
    const search = vi.fn(async (query: { subject?: string; uid: string }) => {
      const [low, high] = query.uid.split(':').map(Number);
      const values = query.subject ? Array.from({ length: 100 }, (_item, index) => 100 - index) : [3, 2, 1, 3];
      return [0, 15000, ...values.filter(uid => uid >= low && uid <= high)];
    });
    (client as any).client = { mailbox: { uidValidity: 1n, uidNext: 10001 }, getMailboxLock: async () => ({ release() {} }), search };
    const criteria = buildSearchCriteria({ subject: 'required', keywordsAny: ['red', 'blue'] });
    const first = await client.searchUidPage('INBOX', '1', criteria, 2);
    expect(first).toEqual({ uids: [3, 2], nextBefore: 2 });
    expect(search.mock.calls.map(([query]) => query.uid)).toEqual(['1:10000', '1:10000']);
    expect(await client.searchUidPage('INBOX', '1', criteria, 2, first.nextBefore!)).toEqual({ uids: [1], nextBefore: null });
    expect(search.mock.calls.slice(2).map(([query]) => query.uid)).toEqual(['1:1', '1:1']);
  });

  it('skips alternatives for empty conjunction windows', async () => {
    const client = new ImapClient({} as EmailAccount);
    const search = vi.fn(async () => []);
    (client as any).client = { mailbox: { uidValidity: 1n, uidNext: 500001 }, getMailboxLock: async () => ({ release() {} }), search };
    const criteria = buildSearchCriteria({ subject: 'required', keywordsAny: ['red', 'blue'] });
    expect(await client.searchUidPage('INBOX', '1', criteria, 20)).toEqual({ uids: [], nextBefore: 400001 });
    expect(search).toHaveBeenCalledTimes(10);
    expect(search.mock.calls.every(call => !(call[0] as { or?: unknown }).or)).toBe(true);
  });

  it('bounds sparse compound searches to two requests in each of ten UID windows', async () => {
    const client = new ImapClient({} as EmailAccount);
    const search = vi.fn(async (query: { subject?: string; uid: string }) => query.subject ? [Number(query.uid.split(':')[0])] : []);
    (client as any).client = { mailbox: { uidValidity: 1n, uidNext: 500001 }, getMailboxLock: async () => ({ release() {} }), search };
    const criteria = buildSearchCriteria({ subject: 'required', keywordsAny: ['red', 'blue'] });
    expect(await client.searchUidPage('INBOX', '1', criteria, 20)).toEqual({ uids: [], nextBefore: 400001 });
    expect(search).toHaveBeenCalledTimes(20);
    for (let index = 0; index < 20; index += 2) {
      const range = search.mock.calls[index][0].uid;
      expect(search.mock.calls[index + 1][0].uid).toBe(range);
      const [low, high] = range.split(':').map(Number);
      expect(high - low + 1).toBe(10000);
    }
  });

  it.each(['ordinary', 'pure Any'] as const)('executes a %s plan with one request', async kind => {
    const client = new ImapClient({} as EmailAccount);
    const search = vi.fn(async () => [2]);
    (client as any).client = { mailbox: { uidValidity: 1n, uidNext: 5 }, getMailboxLock: async () => ({ release() {} }), search };
    const criteria = buildSearchCriteria(kind === 'ordinary' ? { subject: 'required' } : { keywordsAny: ['red', 'blue'] });
    expect(await client.searchUidPage('INBOX', '1', criteria, 20)).toEqual({ uids: [2], nextBefore: null });
    expect(search).toHaveBeenCalledOnce();
  });

  it.each(['false', 'error'] as const)('propagates a second-query %s and permits retry from the same UID boundary', async failure => {
    const client = new ImapClient({} as EmailAccount);
    const release = vi.fn();
    const search = vi.fn().mockResolvedValueOnce([8, 7]);
    if (failure === 'false') search.mockResolvedValueOnce(false);
    else search.mockRejectedValueOnce(new Error('Connection failed'));
    search.mockResolvedValueOnce([8, 7]).mockResolvedValueOnce([8, 7]);
    (client as any).client = { mailbox: { uidValidity: 1n, uidNext: 11 }, getMailboxLock: async () => ({ release }), search };
    const criteria = buildSearchCriteria({ subject: 'required', keywordsAny: ['red', 'blue'] });
    await expect(client.searchUidPage('INBOX', '1', criteria, 2, 9)).rejects.toThrow(failure === 'false' ? 'results are incomplete' : 'Connection failed');
    expect(await client.searchUidPage('INBOX', '1', criteria, 2, 9)).toEqual({ uids: [8, 7], nextBefore: 7 });
    expect(search.mock.calls.every(([query]) => query.uid === '1:8')).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('does not report a failed first query as an empty page', async () => {
    const client = new ImapClient({} as EmailAccount);
    const search = vi.fn(async () => false);
    (client as any).client = { mailbox: { uidValidity: 1n, uidNext: 11 }, getMailboxLock: async () => ({ release() {} }), search };
    await expect(client.searchUidPage('INBOX', '1', buildSearchCriteria({ subject: 'required' }), 20)).rejects.toThrow('results are incomplete');
    expect(search).toHaveBeenCalledOnce();
  });

  it.each([10001, 100000])('pages through %i messages with insertions and deletions', async total => {
    const client = new ImapClient({} as EmailAccount);
    const remaining = new Set(Array.from({ length: total }, (_, i) => i + 1));
    const flow = {
      mailbox: { uidValidity: 1n, uidNext: total + 1 },
      getMailboxLock: vi.fn(async () => ({ release() {} })),
      search: vi.fn(async (query: { uid: string }) => {
        const [low, high] = query.uid.split(':').map(Number);
        expect(high - low).toBeLessThan(10000);
        return [...remaining].filter(uid => uid >= low && uid <= high);
      }),
    };
    (client as any).client = flow;
    const first = await client.searchUidPage('INBOX', '1', [{ all: true }], 25);
    expect(first.uids).toHaveLength(25);
    expect(first.uids[0]).toBe(total);
    remaining.delete(total - 25);
    remaining.add(++flow.mailbox.uidNext - 1);
    const next = await client.searchUidPage('INBOX', '1', [{ all: true }], 25, first.nextBefore!);
    expect(next.uids).toHaveLength(25);
    expect(next.uids[0]).toBe(total - 26);
    expect(next.uids.some(uid => first.uids.includes(uid))).toBe(false);
    expect(flow.search).toHaveBeenCalledTimes(2);
    flow.mailbox.uidValidity = 2n;
    await expect(client.searchUidPage('INBOX', '1', [{}], 25)).rejects.toThrow('identity changed');
  });

  it('returns continuation after bounded work in a sparse filtered UID space', async () => {
    const client = new ImapClient({} as EmailAccount);
    const search = vi.fn(async () => []);
    (client as any).client = { mailbox: { uidValidity: 1n, uidNext: 500001 }, getMailboxLock: async () => ({ release() {} }), search };
    expect(await client.searchUidPage('INBOX', '1', [{ seen: false }], 25)).toEqual({ uids: [], nextBefore: 400001 });
    expect(search).toHaveBeenCalledTimes(10);
    expect(search).toHaveBeenCalledWith({ seen: false, uid: '490001:500000' }, { uid: true });
  });

  it('binds opaque cursors to mailbox identity and query, expires them and rejects tampering', () => {
    const store = new UidCursorStore();
    const scope = { accountId: 'a', mailbox: 'INBOX', uidValidity: '1', queryKey: 'list' };
    const cursor = store.issue(scope, 30);
    expect(store.read(cursor, scope)).toBe(30);
    expect(() => store.read(cursor, { ...scope, uidValidity: '2' })).toThrow('does not match');
    expect(() => store.read(cursor + 'x', scope)).toThrow('unknown');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
    expect(() => store.read(cursor, scope)).toThrow('expired');
    clock.mockRestore();
  });
});
