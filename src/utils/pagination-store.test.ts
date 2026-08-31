import { describe, expect, it } from 'vitest';
import { PaginationSnapshotStore, type PaginationScope } from './pagination-store.js';

const scope: PaginationScope = {
  accountId: 'work',
  mailbox: 'INBOX',
  uidValidity: '123',
  queryKey: '{"unread":true}',
};

describe('PaginationSnapshotStore', () => {
  it('creates the first page without a cursor and continues only through nextCursor', () => {
    const store = new PaginationSnapshotStore<number>();
    const first = store.getFirstPage(scope, [9, 8, 7, 6, 5], 2);
    expect(first).toEqual({ items: [9, 8], nextCursor: expect.any(String), total: 5 });

    const second = store.getNextPage(first.nextCursor!, scope, 2);
    expect(second.items).toEqual([7, 6]);
    expect(second.nextCursor).toEqual(expect.any(String));

    const third = store.getNextPage(second.nextCursor!, scope, 2);
    expect(third).toEqual({ items: [5], nextCursor: null, total: 5 });
  });

  it('holds a stable snapshot when the caller mutates the source array', () => {
    const source = [3, 2, 1];
    const store = new PaginationSnapshotStore<number>();
    const first = store.getFirstPage(scope, source, 1);
    source.unshift(4);

    expect(store.getNextPage(first.nextCursor!, scope, 5).items).toEqual([2, 1]);
  });

  it('isolates cursors by account, mailbox, UIDVALIDITY, and query', () => {
    const store = new PaginationSnapshotStore<number>();
    const first = store.getFirstPage(scope, [2, 1], 1);

    for (const mismatch of [
      { ...scope, accountId: 'other' },
      { ...scope, mailbox: 'Archive' },
      { ...scope, uidValidity: '124' },
      { ...scope, queryKey: '{"unread":false}' },
    ]) {
      expect(() => store.getNextPage(first.nextCursor!, mismatch, 1)).toThrow('does not match');
    }
  });

  it('rejects cursor tampering', () => {
    const store = new PaginationSnapshotStore<number>();
    const first = store.getFirstPage(scope, [2, 1], 1);
    const cursor = first.nextCursor!;
    const replacement = cursor.endsWith('A') ? 'B' : 'A';
    expect(() => store.getNextPage(`${cursor.slice(0, -1)}${replacement}`, scope, 1)).toThrow('Invalid pagination cursor');
  });

  it('expires snapshots at the configured absolute TTL', () => {
    let now = 1_000;
    const store = new PaginationSnapshotStore<number>({ ttlMs: 50, now: () => now });
    const first = store.getFirstPage(scope, [2, 1], 1);
    now = 1_050;
    expect(() => store.getNextPage(first.nextCursor!, scope, 1)).toThrow('expired or unknown');
  });

  it('evicts the least recently used snapshot at the bound', () => {
    let now = 1_000;
    const store = new PaginationSnapshotStore<number>({ maxSnapshots: 2, now: () => now });
    const first = store.getFirstPage(scope, [2, 1], 1);
    now += 1;
    const secondScope = { ...scope, queryKey: 'second' };
    const second = store.getFirstPage(secondScope, [2, 1], 1);
    now += 1;
    store.getNextPage(first.nextCursor!, scope, 1);
    now += 1;
    store.getFirstPage({ ...scope, queryKey: 'third' }, [2, 1], 1);

    expect(() => store.getNextPage(second.nextCursor!, secondScope, 1)).toThrow('expired or unknown');
  });

  it('enforces item and page bounds', () => {
    const store = new PaginationSnapshotStore<number>({ maxItemsPerSnapshot: 2, maxPageSize: 2 });
    expect(() => store.getFirstPage(scope, [1, 2, 3], 2)).toThrow('exceeds 2');
    expect(() => store.getFirstPage(scope, [1], 3)).toThrow('between 1 and 2');
  });

  it('requires a valid IMAP UIDVALIDITY in the snapshot scope', () => {
    const store = new PaginationSnapshotStore<number>();
    expect(() => store.getFirstPage({ ...scope, uidValidity: '0' }, [1], 1)).toThrow('uidValidity');
    expect(() => store.getFirstPage({ ...scope, uidValidity: '4294967296' }, [1], 1)).toThrow('uidValidity');
  });
});
