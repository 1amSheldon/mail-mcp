import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const CURSOR_PREFIX = 'page:v1:';
const MAX_CURSOR_LENGTH = 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface PaginationScope {
  accountId: string;
  mailbox: string;
  uidValidity: string;
  queryKey: string;
}

export interface PaginationPage<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export interface PaginationSnapshotStoreOptions {
  ttlMs?: number;
  maxSnapshots?: number;
  maxItemsPerSnapshot?: number;
  maxPageSize?: number;
  now?: () => number;
}

interface CursorPayload {
  i: string;
  o: number;
}

interface Snapshot<T> {
  scopeKey: string;
  items: readonly T[];
  expiresAt: number;
  lastAccessedAt: number;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function scopeValue(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`Invalid pagination scope ${name}`);
  }
  return value;
}

function scopeKey(scope: PaginationScope): string {
  const uidValidity = scopeValue(scope.uidValidity, 'uidValidity', 10);
  if (!/^[1-9]\d{0,9}$/.test(uidValidity) || BigInt(uidValidity) > 4_294_967_295n) {
    throw new Error('Invalid pagination scope uidValidity');
  }
  return JSON.stringify([
    scopeValue(scope.accountId, 'accountId', 256),
    scopeValue(scope.mailbox, 'mailbox', 4_096),
    uidValidity,
    scopeValue(scope.queryKey, 'queryKey', 8_192),
  ]);
}

function signCursor(encodedPayload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function encodeCursor(snapshotId: string, offset: number, secret: Buffer): string {
  const payload: CursorPayload = { i: snapshotId, o: offset };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${CURSOR_PREFIX}${encodedPayload}.${signCursor(encodedPayload, secret)}`;
}

function decodeCursor(cursor: string, secret: Buffer): CursorPayload {
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH || !cursor.startsWith(CURSOR_PREFIX)) {
    throw new Error('Invalid pagination cursor');
  }
  const encoded = cursor.slice(CURSOR_PREFIX.length);
  const [encodedPayload, signature, extra] = encoded.split('.');
  if (!encodedPayload || !signature || extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/.test(encodedPayload) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    throw new Error('Invalid pagination cursor');
  }

  const expectedSignature = Buffer.from(signCursor(encodedPayload, secret), 'ascii');
  const receivedSignature = Buffer.from(signature, 'ascii');
  if (expectedSignature.length !== receivedSignature.length || !timingSafeEqual(expectedSignature, receivedSignature)) {
    throw new Error('Invalid pagination cursor');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid pagination cursor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid pagination cursor');
  }

  const payload = parsed as Partial<CursorPayload>;
  if (typeof payload.i !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.i) ||
      !Number.isSafeInteger(payload.o) || (payload.o as number) < 0) {
    throw new Error('Invalid pagination cursor');
  }
  return { i: payload.i, o: payload.o as number };
}

export class PaginationSnapshotStore<T> {
  private readonly snapshots = new Map<string, Snapshot<T>>();
  private readonly ttlMs: number;
  private readonly maxSnapshots: number;
  private readonly maxItemsPerSnapshot: number;
  private readonly maxPageSize: number;
  private readonly now: () => number;
  private readonly cursorSecret = randomBytes(32);

  constructor(options: PaginationSnapshotStoreOptions = {}) {
    this.ttlMs = positiveInteger(options.ttlMs, 5 * 60_000, 'ttlMs');
    this.maxSnapshots = positiveInteger(options.maxSnapshots, 128, 'maxSnapshots');
    this.maxItemsPerSnapshot = positiveInteger(options.maxItemsPerSnapshot, 10_000, 'maxItemsPerSnapshot');
    this.maxPageSize = positiveInteger(options.maxPageSize, 500, 'maxPageSize');
    this.now = options.now ?? Date.now;
  }

  getFirstPage(scope: PaginationScope, items: readonly T[], limit: number): PaginationPage<T> {
    this.validateLimit(limit);
    if (items.length > this.maxItemsPerSnapshot) {
      throw new Error(`Pagination snapshot exceeds ${this.maxItemsPerSnapshot} items`);
    }

    const currentTime = this.now();
    this.purgeExpired(currentTime);
    while (this.snapshots.size >= this.maxSnapshots) {
      this.evictLeastRecentlyUsed();
    }

    const id = randomUUID();
    this.snapshots.set(id, {
      scopeKey: scopeKey(scope),
      items: items.slice(),
      expiresAt: currentTime + this.ttlMs,
      lastAccessedAt: currentTime,
    });
    return this.readPage({ i: id, o: 0 }, limit, currentTime);
  }

  getNextPage(cursor: string, scope: PaginationScope, limit: number): PaginationPage<T> {
    this.validateLimit(limit);
    const payload = decodeCursor(cursor, this.cursorSecret);
    const currentTime = this.now();
    this.purgeExpired(currentTime);
    const snapshot = this.snapshots.get(payload.i);
    if (!snapshot) {
      throw new Error('Pagination cursor is expired or unknown');
    }
    if (snapshot.scopeKey !== scopeKey(scope)) {
      throw new Error('Pagination cursor does not match this query');
    }
    if (payload.o > snapshot.items.length) {
      throw new Error('Invalid pagination cursor offset');
    }
    return this.readPage(payload, limit, currentTime);
  }

  clear(): void {
    this.snapshots.clear();
  }

  private validateLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxPageSize) {
      throw new Error(`Pagination limit must be between 1 and ${this.maxPageSize}`);
    }
  }

  private readPage(payload: CursorPayload, limit: number, currentTime: number): PaginationPage<T> {
    const snapshot = this.snapshots.get(payload.i);
    if (!snapshot) {
      throw new Error('Pagination cursor is expired or unknown');
    }
    snapshot.lastAccessedAt = currentTime;
    const items = snapshot.items.slice(payload.o, payload.o + limit);
    const nextOffset = payload.o + items.length;
    return {
      items,
      nextCursor: nextOffset < snapshot.items.length ? encodeCursor(payload.i, nextOffset, this.cursorSecret) : null,
      total: snapshot.items.length,
    };
  }

  private purgeExpired(currentTime: number): void {
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= currentTime) {
        this.snapshots.delete(id);
      }
    }
  }

  private evictLeastRecentlyUsed(): void {
    let candidateId: string | undefined;
    let candidateAccess = Number.POSITIVE_INFINITY;
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.lastAccessedAt < candidateAccess) {
        candidateId = id;
        candidateAccess = snapshot.lastAccessedAt;
      }
    }
    if (candidateId) {
      this.snapshots.delete(candidateId);
    }
  }
}
