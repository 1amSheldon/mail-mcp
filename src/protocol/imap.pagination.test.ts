import { describe, it, expect, vi } from 'vitest';
import { ImapClient } from './imap.js';
import { UidCursorStore } from '../utils/uid-cursors.js';
import type { EmailAccount } from '../config.js';

describe('bounded UID pagination', () => {
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
    const first = await client.searchUidPage('INBOX', '1', { all: true }, 25);
    expect(first.uids).toHaveLength(25);
    expect(first.uids[0]).toBe(total);
    remaining.delete(total - 25);
    remaining.add(++flow.mailbox.uidNext - 1);
    const next = await client.searchUidPage('INBOX', '1', { all: true }, 25, first.nextBefore!);
    expect(next.uids).toHaveLength(25);
    expect(next.uids[0]).toBe(total - 26);
    expect(next.uids.some(uid => first.uids.includes(uid))).toBe(false);
    expect(flow.search).toHaveBeenCalledTimes(2);
    flow.mailbox.uidValidity = 2n;
    await expect(client.searchUidPage('INBOX', '1', {}, 25)).rejects.toThrow('identity changed');
  });

  it('returns continuation after bounded work in a sparse filtered UID space', async () => {
    const client = new ImapClient({} as EmailAccount);
    const search = vi.fn(async () => []);
    (client as any).client = { mailbox: { uidValidity: 1n, uidNext: 500001 }, getMailboxLock: async () => ({ release() {} }), search };
    expect(await client.searchUidPage('INBOX', '1', { unseen: true }, 25)).toEqual({ uids: [], nextBefore: 400001 });
    expect(search).toHaveBeenCalledTimes(10);
    expect(search).toHaveBeenCalledWith({ unseen: true, uid: '490001:500000' }, { uid: true });
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
