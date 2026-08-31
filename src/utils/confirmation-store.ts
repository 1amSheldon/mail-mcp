import { createHash, randomUUID } from 'node:crypto';

export const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_PENDING_CONFIRMATIONS = 1_024;

export interface PendingConfirmation {
  toolName: string;
  argsHash: string;
  createdAt: number;
  ttlMs: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function confirmationArgsHash(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

/**
 * In-memory store for pending write-tool confirmations.
 *
 * Stores only a digest of approved arguments so pending confirmations cannot
 * retain message bodies or attachments in memory.
 */
export class ConfirmationStore {
  private readonly store = new Map<string, PendingConfirmation>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number = CONFIRMATION_TTL_MS, maxEntries: number = MAX_PENDING_CONFIRMATIONS) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Confirmation TTL must be positive');
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('Confirmation capacity must be a positive integer');
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  private purgeExpired(now = Date.now()): void {
    for (const [id, entry] of this.store) {
      if (now - entry.createdAt >= entry.ttlMs) this.store.delete(id);
    }
  }

  /**
   * Store a pending confirmation and return its UUID.
   */
  create(toolName: string, args: Record<string, unknown>): string {
    this.purgeExpired();
    if (this.store.size >= this.maxEntries) {
      throw new Error('Too many pending confirmations; consume or wait for an existing token to expire');
    }
    const id = randomUUID();
    this.store.set(id, {
      toolName,
      argsHash: confirmationArgsHash(args),
      createdAt: Date.now(),
      ttlMs: this.ttlMs,
    });
    return id;
  }

  /**
   * Retrieve and remove a confirmation by ID.
   * Returns undefined if not found or if the TTL has expired.
   * Expired entries are removed (lazy eviction).
   */
  consume(id: string): PendingConfirmation | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;

    // Remove regardless — expired or consumed, it's gone
    this.store.delete(id);

    if (Date.now() - entry.createdAt >= entry.ttlMs) {
      return undefined;
    }

    return entry;
  }

  /**
   * Raw store count — includes stale entries until they are consumed.
   * Same semantics as MessageBodyCache.size.
   */
  get size(): number {
    this.purgeExpired();
    return this.store.size;
  }
}
