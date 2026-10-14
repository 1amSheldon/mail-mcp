import type { ParsedMail } from 'mailparser';

export const MESSAGE_CACHE_TTL_MS = 5 * 60 * 1000;
export const MESSAGE_CACHE_MAX_SIZE = 100;
export const MESSAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

interface CacheEntry {
  value: ParsedMail;
  insertedAt: number;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

function payloadBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return value.length * 2;
  if (!value || typeof value !== 'object') return 16;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof Map) return [...value].reduce((sum, item) => sum + payloadBytes(item, seen), 64);
  return Object.entries(value).reduce((sum, [key, item]) => sum + key.length * 2 + payloadBytes(item, seen), 64);
}

/**
 * In-memory TTL cache for parsed email bodies.
 * Keys encode account, folder, UIDVALIDITY and UID. Timers release expired bodies;
 * both payload bytes and entry count are bounded. Each MailService owns one cache.
 */
export class MessageBodyCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private bytes = 0;

  constructor(ttlMs = MESSAGE_CACHE_TTL_MS, maxSize = MESSAGE_CACHE_MAX_SIZE, private readonly maxBytes = MESSAGE_CACHE_MAX_BYTES) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  get(key: string): ParsedMail | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.insertedAt >= this.ttlMs) {
      this.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: ParsedMail): void {
    // Delete first to reset insertion order when key already exists
    this.delete(key);
    const bytes = payloadBytes(value);
    if (bytes > this.maxBytes) return;
    // Evict oldest entry if at capacity (Map preserves insertion order)
    while (this.store.size > 0 && (this.store.size >= this.maxSize || this.bytes + bytes > this.maxBytes)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.delete(oldestKey);
    }
    const timer = setTimeout(() => this.delete(key), this.ttlMs);
    timer.unref?.();
    this.store.set(key, { value, insertedAt: Date.now(), bytes, timer });
    this.bytes += bytes;
  }

  delete(key: string): void {
    const entry = this.store.get(key);
    if (entry) { clearTimeout(entry.timer); this.bytes -= entry.bytes; }
    this.store.delete(key);
  }

  clear(): void {
    for (const key of this.store.keys()) this.delete(key);
  }

  get byteSize(): number { return this.bytes; }

  get size(): number {
    return this.store.size;
  }
}
