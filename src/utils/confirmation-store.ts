import { randomUUID } from 'node:crypto';

export const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface PendingConfirmation {
  toolName: string;
  args: Record<string, unknown>;
  createdAt: number;
  ttlMs: number;
}

/**
 * In-memory store for pending write-tool confirmations.
 *
 * Mirrors the MessageBodyCache pattern: injectable TTL for tests, lazy eviction
 * on consume(), size reports raw store count (stale entries included).
 */
export class ConfirmationStore {
  private readonly store = new Map<string, PendingConfirmation>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = CONFIRMATION_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Store a pending confirmation and return its UUID.
   */
  create(toolName: string, args: Record<string, unknown>): string {
    const id = randomUUID();
    this.store.set(id, {
      toolName,
      args: { ...args },
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
    return this.store.size;
  }
}
