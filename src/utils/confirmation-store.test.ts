import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ConfirmationStore,
  CONFIRMATION_TTL_MS,
  confirmationArgsHash,
} from './confirmation-store.js';
import type { PendingConfirmation } from './confirmation-store.js';

describe('CONFIRMATION_TTL_MS', () => {
  it('is 5 minutes in milliseconds', () => {
    expect(CONFIRMATION_TTL_MS).toBe(5 * 60 * 1000);
  });
});

describe('ConfirmationStore', () => {
  let store: ConfirmationStore;

  beforeEach(() => {
    // Use short TTL for tests (100ms)
    store = new ConfirmationStore(100);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('create()', () => {
    it('returns a UUID string', () => {
      const id = store.create('send_email', { to: 'a@b.com' });
      expect(typeof id).toBe('string');
      // UUID v4 pattern
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('returns a different UUID on each call', () => {
      const id1 = store.create('send_email', { to: 'a@b.com' });
      const id2 = store.create('send_email', { to: 'b@c.com' });
      expect(id1).not.toBe(id2);
    });

    it('increments size', () => {
      expect(store.size).toBe(0);
      store.create('send_email', { to: 'a@b.com' });
      expect(store.size).toBe(1);
      store.create('delete_email', { uid: '42' });
      expect(store.size).toBe(2);
    });
  });

  describe('consume()', () => {
    it('returns the stored PendingConfirmation before TTL', () => {
      const id = store.create('send_email', { to: 'alice@example.com', subject: 'Hi' });
      vi.advanceTimersByTime(50); // half TTL
      const result = store.consume(id);
      expect(result).toBeDefined();
      expect(result!.toolName).toBe('send_email');
      expect(result!.argsHash).toBe(confirmationArgsHash({ to: 'alice@example.com', subject: 'Hi' }));
    });

    it('returns undefined for a non-existent ID', () => {
      expect(store.consume('non-existent-id')).toBeUndefined();
    });

    it('removes the entry on consume (single-use)', () => {
      const id = store.create('delete_email', { uid: '123' });
      store.consume(id);
      expect(store.consume(id)).toBeUndefined();
      expect(store.size).toBe(0);
    });

    it('returns undefined and removes entry after TTL', () => {
      const id = store.create('move_email', { uid: '1', sourceFolder: 'INBOX', targetFolder: 'Trash' });
      vi.advanceTimersByTime(101); // past TTL
      expect(store.consume(id)).toBeUndefined();
      expect(store.size).toBe(0);
    });

    it('returns undefined at exactly TTL boundary (>= semantics)', () => {
      const id = store.create('reply_email', { uid: '5', body: 'Thanks' });
      vi.advanceTimersByTime(100); // exactly TTL
      expect(store.consume(id)).toBeUndefined();
    });

    it('stores only an argument digest', () => {
      const args = { to: 'x@y.com', subject: 'Test', body: 'Hello' };
      const id = store.create('send_email', args);
      const result = store.consume(id);
      expect(result!.argsHash).toBe(confirmationArgsHash(args));
      expect(result).not.toHaveProperty('args');
    });

    it('uses a stable digest regardless of object key order', () => {
      expect(confirmationArgsHash({ subject: 'Hi', to: 'a@b.com' }))
        .toBe(confirmationArgsHash({ to: 'a@b.com', subject: 'Hi' }));
    });
  });

  describe('size', () => {
    it('is 0 for empty store', () => {
      expect(store.size).toBe(0);
    });

    it('purges stale entries', () => {
      store.create('send_email', { to: 'a@b.com' });
      store.create('delete_email', { uid: '1' });
      vi.advanceTimersByTime(101); // both now stale
      expect(store.size).toBe(0);
    });

    it('enforces a bounded pending confirmation capacity', () => {
      const bounded = new ConfirmationStore(100, 1);
      bounded.create('send_email', { to: 'a@b.com' });
      expect(() => bounded.create('send_email', { to: 'b@c.com' }))
        .toThrow('Too many pending confirmations');
    });
  });

  describe('PendingConfirmation interface', () => {
    it('createdAt is a timestamp set at create() time', () => {
      const before = Date.now();
      const id = store.create('send_email', { to: 'a@b.com' });
      const after = Date.now();
      const result = store.consume(id);
      expect(result!.createdAt).toBeGreaterThanOrEqual(before);
      expect(result!.createdAt).toBeLessThanOrEqual(after);
    });

    it('ttlMs matches the constructor TTL', () => {
      const id = store.create('send_email', { to: 'a@b.com' });
      const result = store.consume(id);
      expect(result!.ttlMs).toBe(100); // test TTL
    });

    it('default constructor uses CONFIRMATION_TTL_MS', () => {
      vi.useRealTimers(); // Need real Date.now() here
      const defaultStore = new ConfirmationStore();
      const id = defaultStore.create('send_email', { to: 'a@b.com' });
      const result = defaultStore.consume(id);
      expect(result!.ttlMs).toBe(CONFIRMATION_TTL_MS);
      vi.useFakeTimers();
    });
  });
});
