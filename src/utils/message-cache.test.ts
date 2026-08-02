import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageBodyCache, MESSAGE_CACHE_TTL_MS, MESSAGE_CACHE_MAX_SIZE } from './message-cache.js';
import type { ParsedMail } from 'mailparser';

function makeMail(subject: string): ParsedMail {
  return { subject } as unknown as ParsedMail;
}

describe('MessageBodyCache', () => {
  let cache: MessageBodyCache;

  beforeEach(() => {
    // Use short TTL for tests (100ms), small max size
    cache = new MessageBodyCache(100, 5);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constants', () => {
    it('exports MESSAGE_CACHE_TTL_MS as 5 minutes', () => {
      expect(MESSAGE_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    });

    it('exports MESSAGE_CACHE_MAX_SIZE as 100', () => {
      expect(MESSAGE_CACHE_MAX_SIZE).toBe(100);
    });
  });

  describe('get / set', () => {
    it('returns undefined for a missing key', () => {
      expect(cache.get('no:such:key')).toBeUndefined();
    });

    it('set then get before TTL returns the same object', () => {
      const mail = makeMail('hello');
      cache.set('a:inbox:1', mail);
      vi.advanceTimersByTime(50); // half TTL
      expect(cache.get('a:inbox:1')).toBe(mail);
    });

    it('get after TTL returns undefined and removes the entry', () => {
      const mail = makeMail('expired');
      cache.set('a:inbox:2', mail);
      vi.advanceTimersByTime(101); // past TTL
      expect(cache.get('a:inbox:2')).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it('get at exactly TTL boundary is treated as expired (>=)', () => {
      const mail = makeMail('boundary');
      cache.set('a:inbox:3', mail);
      vi.advanceTimersByTime(100); // exactly TTL
      expect(cache.get('a:inbox:3')).toBeUndefined();
    });

    it('set same key twice updates value and resets TTL', () => {
      const mail1 = makeMail('first');
      const mail2 = makeMail('second');
      cache.set('a:inbox:4', mail1);
      vi.advanceTimersByTime(80); // not yet expired
      cache.set('a:inbox:4', mail2); // reset timestamp
      vi.advanceTimersByTime(80); // 80ms after reset — still valid
      expect(cache.get('a:inbox:4')).toBe(mail2);
      expect(cache.size).toBe(1);
    });
  });

  describe('size', () => {
    it('reports count of all entries including stale', () => {
      cache.set('a:inbox:1', makeMail('one'));
      cache.set('a:inbox:2', makeMail('two'));
      vi.advanceTimersByTime(101); // both now stale
      // size reports raw store count (Map semantics), not live-only count
      expect(cache.size).toBe(2);
    });

    it('size is 0 for empty cache', () => {
      expect(cache.size).toBe(0);
    });
  });

  describe('delete', () => {
    it('delete removes an existing entry', () => {
      cache.set('a:inbox:5', makeMail('deleteme'));
      cache.delete('a:inbox:5');
      expect(cache.get('a:inbox:5')).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it('delete is a no-op for a missing key', () => {
      expect(() => cache.delete('no:such:key')).not.toThrow();
      expect(cache.size).toBe(0);
    });
  });

  describe('capacity / eviction (maxSize=5)', () => {
    it('set 6 entries evicts the oldest (first inserted)', () => {
      for (let i = 1; i <= 5; i++) {
        cache.set(`a:inbox:${i}`, makeMail(`msg${i}`));
      }
      expect(cache.size).toBe(5);
      // Insert 6th — should evict entry 1
      cache.set('a:inbox:6', makeMail('msg6'));
      expect(cache.size).toBe(5);
      expect(cache.get('a:inbox:1')).toBeUndefined(); // evicted
      expect(cache.get('a:inbox:6')).toBeDefined();   // newest present
    });

    it('evicts oldest-first (insertion order)', () => {
      for (let i = 1; i <= 5; i++) {
        cache.set(`a:inbox:${i}`, makeMail(`msg${i}`));
      }
      cache.set('a:inbox:6', makeMail('msg6')); // evicts 1
      cache.set('a:inbox:7', makeMail('msg7')); // evicts 2
      expect(cache.get('a:inbox:1')).toBeUndefined();
      expect(cache.get('a:inbox:2')).toBeUndefined();
      expect(cache.get('a:inbox:3')).toBeDefined();
    });

    it('re-setting an existing key resets insertion order (moves to newest)', () => {
      for (let i = 1; i <= 5; i++) {
        cache.set(`a:inbox:${i}`, makeMail(`msg${i}`));
      }
      // Re-set entry 1 — it moves to end, so entry 2 becomes oldest
      cache.set('a:inbox:1', makeMail('msg1-updated'));
      cache.set('a:inbox:6', makeMail('msg6')); // should evict entry 2
      expect(cache.get('a:inbox:2')).toBeUndefined(); // evicted
      expect(cache.get('a:inbox:1')).toBeDefined();   // still present (moved to end)
    });
  });

  describe('default constructor values', () => {
    it('default instance uses MESSAGE_CACHE_TTL_MS and MESSAGE_CACHE_MAX_SIZE', () => {
      const defaultCache = new MessageBodyCache();
      // Set 100 entries — should all fit
      for (let i = 0; i < 100; i++) {
        defaultCache.set(`a:inbox:${i}`, makeMail(`msg${i}`));
      }
      expect(defaultCache.size).toBe(100);
      // 101st should evict the first
      defaultCache.set('a:inbox:100', makeMail('msg100'));
      expect(defaultCache.size).toBe(100);
    });
  });
});
