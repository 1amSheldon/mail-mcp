import type { ParsedMail } from 'mailparser';

export const MESSAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (D-04)
export const MESSAGE_CACHE_MAX_SIZE = 100; // max entries (D-05)

interface CacheEntry {
  value: ParsedMail;
  insertedAt: number;
}

/**
 * In-memory TTL cache for parsed email bodies.
 * Key format: `${accountId}:${folder}:${uid}` (D-01)
 * Eviction: TTL expiry on read OR oldest-first when capacity exceeded (D-05, D-06)
 * Zero external dependencies (D-09). Lost on server restart (D-08).
 * Instantiate per MailService — NOT as a module-level singleton.
 */
export class MessageBodyCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs = MESSAGE_CACHE_TTL_MS, maxSize = MESSAGE_CACHE_MAX_SIZE) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  get(key: string): ParsedMail | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.insertedAt >= this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: ParsedMail): void {
    // Delete first to reset insertion order when key already exists
    this.store.delete(key);
    // Evict oldest entry if at capacity (Map preserves insertion order)
    if (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, insertedAt: Date.now() });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }
}
