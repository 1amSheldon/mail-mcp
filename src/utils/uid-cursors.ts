import { randomBytes } from 'node:crypto';
import type { PaginationScope } from './pagination-store.js';

/** Opaque, expiring capabilities holding only a UID boundary, never whole folders. */
export class UidCursorStore {
  private readonly entries = new Map<string, { scope: string; before: number; expires: number }>();

  read(cursor: string, scope: PaginationScope): number {
    const entry = this.entries.get(cursor);
    if (!entry || entry.expires <= Date.now()) throw new Error('Pagination cursor is expired or unknown');
    if (entry.scope !== JSON.stringify(scope)) throw new Error('Pagination cursor does not match this query');
    return entry.before;
  }

  issue(scope: PaginationScope, before: number): string {
    for (const [key, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(key);
    while (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value!);
    const cursor = `uid-page:v1:${randomBytes(32).toString('base64url')}`;
    this.entries.set(cursor, { scope: JSON.stringify(scope), before, expires: Date.now() + 300_000 });
    return cursor;
  }

  retire(cursor: string): void { this.entries.delete(cursor); }

  clear(): void { this.entries.clear(); }
}
