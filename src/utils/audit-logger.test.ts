import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger, type AuditEntry } from './audit-logger.js';

function tmpPath(): string {
  return path.join(os.tmpdir(), `audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
}

describe('AuditLogger.sanitizeArgs', () => {
  it('passes through non-sensitive fields unchanged', () => {
    const logger = new AuditLogger(tmpPath());
    const result = logger.sanitizeArgs({ accountId: 'acc1', folder: 'INBOX', uid: '42' });
    expect(result).toEqual({ accountId: 'acc1', folder: 'INBOX', uid: '42' });
  });

  it('strips top-level password field', () => {
    const logger = new AuditLogger(tmpPath());
    const result = logger.sanitizeArgs({ accountId: 'acc1', password: 'secret123' });
    expect(result).not.toHaveProperty('password');
    expect(result).toHaveProperty('accountId', 'acc1');
  });

  it('strips top-level refreshToken field', () => {
    const logger = new AuditLogger(tmpPath());
    const result = logger.sanitizeArgs({ refreshToken: 'tok_abc', clientId: 'cid' });
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('strips top-level clientSecret field', () => {
    const logger = new AuditLogger(tmpPath());
    const result = logger.sanitizeArgs({ clientSecret: 'cs_abc', clientId: 'cid' });
    expect(result).not.toHaveProperty('clientSecret');
  });

  it('strips fields matching sensitive pattern case-insensitively', () => {
    const logger = new AuditLogger(tmpPath());
    const result = logger.sanitizeArgs({ Password: 'x', TOKEN: 'y', apiKey: 'z', subject: 'hello' });
    expect(result).not.toHaveProperty('Password');
    expect(result).not.toHaveProperty('TOKEN');
    expect(result).not.toHaveProperty('apiKey');
    expect(result).toHaveProperty('subject', 'hello');
  });

  it('does not mutate the original args object', () => {
    const logger = new AuditLogger(tmpPath());
    const original = { password: 'secret', accountId: 'acc1' };
    logger.sanitizeArgs(original);
    expect(original).toHaveProperty('password', 'secret');
  });
});

describe('AuditLogger.log (enabled)', () => {
  let logPath: string;
  let logger: AuditLogger;

  beforeEach(() => {
    logPath = tmpPath();
    logger = new AuditLogger(logPath, true);
  });

  afterEach(() => {
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
  });

  it('creates the log file on first write', async () => {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      tool: 'list_accounts',
      args: {},
      success: true,
      durationMs: 5,
    };
    await logger.log(entry);
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it('writes valid JSON line to file', async () => {
    const entry: AuditEntry = {
      timestamp: '2026-01-01T00:00:00Z',
      tool: 'list_emails',
      accountId: 'acc1',
      args: { accountId: 'acc1', folder: 'INBOX' },
      success: true,
      durationMs: 42,
    };
    await logger.log(entry);
    const content = fs.readFileSync(logPath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.tool).toBe('list_emails');
    expect(parsed.accountId).toBe('acc1');
    expect(parsed.success).toBe(true);
    expect(parsed.durationMs).toBe(42);
  });

  it('each call appends a separate line', async () => {
    const entry1: AuditEntry = { timestamp: '2026-01-01T00:00:00Z', tool: 'tool_a', args: {}, success: true, durationMs: 1 };
    const entry2: AuditEntry = { timestamp: '2026-01-01T00:00:01Z', tool: 'tool_b', args: {}, success: false, durationMs: 2, error: 'oops' };
    await logger.log(entry1);
    await logger.log(entry2);
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).tool).toBe('tool_a');
    expect(JSON.parse(lines[1]).tool).toBe('tool_b');
    expect(JSON.parse(lines[1]).error).toBe('oops');
  });

  it('sanitizes sensitive fields before writing', async () => {
    const entry: AuditEntry = {
      timestamp: '2026-01-01T00:00:00Z',
      tool: 'register_oauth2_account',
      args: { accountId: 'acc1', clientSecret: 'cs_SENSITIVE', refreshToken: 'rt_SENSITIVE' },
      success: true,
      durationMs: 10,
    };
    await logger.log(entry);
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).not.toContain('cs_SENSITIVE');
    expect(content).not.toContain('rt_SENSITIVE');
    expect(content).toContain('acc1');
  });

  it('includes error field when success=false', async () => {
    const entry: AuditEntry = {
      timestamp: '2026-01-01T00:00:00Z',
      tool: 'send_email',
      args: {},
      success: false,
      durationMs: 3,
      error: 'SMTP connection refused',
    };
    await logger.log(entry);
    const parsed = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('SMTP connection refused');
  });
});

describe('AuditLogger.log (disabled)', () => {
  it('is a no-op when enabled=false', async () => {
    const logPath = tmpPath();
    const logger = new AuditLogger(logPath, false);
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      tool: 'list_accounts',
      args: {},
      success: true,
      durationMs: 1,
    };
    await logger.log(entry);
    expect(fs.existsSync(logPath)).toBe(false);
  });
});
