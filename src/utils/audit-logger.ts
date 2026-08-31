import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { redactSensitiveContent } from './redact.js';

export interface AuditEntry {
  timestamp: string;
  tool: string;
  accountId?: string;
  args: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  error?: string;
}

/** Field names that contain credentials rather than useful audit metadata. */
const SENSITIVE_FIELD_NAMES = new Set([
  'password', 'passphrase', 'passwd', 'pwd', 'authorization', 'proxyauthorization',
  'cookie', 'setcookie', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'secret', 'clientsecret', 'signingsecret', 'key', 'apikey', 'privatekey',
  'auth', 'credential', 'credentials', 'confirmationid',
]);
/** Human-readable or encoded payload fields that must never enter the audit log. */
const PAYLOAD_FIELD_NAMES = new Set([
  'body', 'html', 'text', 'textbody', 'htmlbody', 'plainbody', 'plaintext',
  'textashtml', 'snippet', 'raw', 'rawemail', 'rawmessage', 'rawrfc822', 'rfc822',
  'mime', 'source', 'content', 'contentbase64', 'base64', 'data', 'bytes',
  'attachment', 'attachments', 'variables', 'templatevariables', 'recipientvariables',
]);
const MAX_AUDIT_DEPTH = 12;
const MAX_AUDIT_ARRAY_ITEMS = 50;
const MAX_AUDIT_OBJECT_KEYS = 100;
const MAX_AUDIT_STRING_CHARS = 1_024;
const MAX_AUDIT_RECORD_BYTES = 32 * 1_024;
const DEFAULT_MAX_LOG_BYTES = 5 * 1_024 * 1_024;
const OMITTED_PAYLOAD = '[omitted sensitive payload]';

function normalizeFieldName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function sanitizeString(value: string): string {
  if (/^\s*(?:[A-Za-z0-9+/]{256,}={0,2})\s*$/.test(value)) {
    return `[base64 omitted:${value.trim().length} chars]`;
  }
  const redacted = redactSensitiveContent(value);
  return redacted.length > MAX_AUDIT_STRING_CHARS
    ? `${redacted.slice(0, MAX_AUDIT_STRING_CHARS)}[truncated]`
    : redacted;
}

function sanitizeError(value: string): string {
  if (/<(?:!doctype|html|body)\b/i.test(value)) return '[error details omitted]';
  if (/^(?:From|To|Subject|MIME-Version|Content-Type):/im.test(value)) {
    return '[error details omitted]';
  }
  return sanitizeString(value);
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > MAX_AUDIT_DEPTH) return '[depth limit]';
  if (value instanceof Uint8Array) return `[binary:${value.byteLength} bytes]`;
  if (typeof value === 'string') return sanitizeString(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const result = value
      .slice(0, MAX_AUDIT_ARRAY_ITEMS)
      .map(item => sanitizeValue(item, seen, depth + 1));
    if (value.length > MAX_AUDIT_ARRAY_ITEMS) {
      result.push(`[${value.length - MAX_AUDIT_ARRAY_ITEMS} more items omitted]`);
    }
    seen.delete(value);
    return result;
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, nested] of entries.slice(0, MAX_AUDIT_OBJECT_KEYS)) {
    const normalizedKey = normalizeFieldName(key);
    if (SENSITIVE_FIELD_NAMES.has(normalizedKey)) continue;
    result[key] = PAYLOAD_FIELD_NAMES.has(normalizedKey)
      ? OMITTED_PAYLOAD
      : sanitizeValue(nested, seen, depth + 1);
  }
  if (entries.length > MAX_AUDIT_OBJECT_KEYS) {
    result.__omittedKeys = entries.length - MAX_AUDIT_OBJECT_KEYS;
  }
  seen.delete(value);
  return result;
}

export class AuditLogger {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly logPath: string,
    private readonly enabled: boolean = true,
    private readonly maxLogBytes: number = DEFAULT_MAX_LOG_BYTES,
  ) {}

  /**
   * Returns a deep copy of args with sensitive fields removed.
   * Does not mutate the original object.
   */
  sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    return sanitizeValue(args, new WeakSet(), 0) as Record<string, unknown>;
  }

  /**
   * Appends one JSONL line to the audit log file.
   * Sanitizes args before writing.
   * No-op when logger is disabled.
   */
  async log(entry: AuditEntry): Promise<void> {
    if (!this.enabled) return;

    const operation = this.writeQueue.then(() => this.write(entry));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async write(entry: AuditEntry): Promise<void> {
    const sanitizedError = entry.error === undefined ? undefined : sanitizeError(entry.error);

    const sanitized: AuditEntry = {
      timestamp: sanitizeString(entry.timestamp),
      tool: sanitizeString(entry.tool),
      ...(entry.accountId !== undefined ? { accountId: sanitizeString(entry.accountId) } : {}),
      args: this.sanitizeArgs(entry.args),
      success: entry.success,
      durationMs: entry.durationMs,
      ...(sanitizedError !== undefined ? { error: sanitizedError } : {}),
    };

    let line = JSON.stringify(sanitized) + '\n';
    if (Buffer.byteLength(line, 'utf8') > MAX_AUDIT_RECORD_BYTES) {
      sanitized.args = { omitted: `[audit arguments exceeded ${MAX_AUDIT_RECORD_BYTES} bytes]` };
      line = JSON.stringify(sanitized) + '\n';
    }

    await fsPromises.mkdir(path.dirname(this.logPath), { recursive: true });
    await this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
    await fsPromises.appendFile(this.logPath, line, 'utf-8');
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let currentBytes: number;
    try {
      currentBytes = (await fsPromises.stat(this.logPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (currentBytes + incomingBytes <= this.maxLogBytes) return;

    const backupPath = `${this.logPath}.1`;
    await fsPromises.rm(backupPath, { force: true });
    await fsPromises.rename(this.logPath, backupPath);
  }
}
