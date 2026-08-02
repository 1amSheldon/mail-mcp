import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

export interface AuditEntry {
  timestamp: string;
  tool: string;
  accountId?: string;
  args: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Pattern matching sensitive top-level arg field names that must be redacted.
 * Matches: password, refreshToken, clientSecret, token, secret, key, auth
 * (and case variants — the regex is applied case-insensitively)
 */
const SENSITIVE_FIELD_PATTERN = /password|refreshtoken|clientsecret|token|secret|key|auth/i;

export class AuditLogger {
  constructor(
    private readonly logPath: string,
    private readonly enabled: boolean = true,
  ) {}

  /**
   * Returns a shallow copy of args with sensitive top-level fields removed.
   * Does not mutate the original object.
   */
  sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (!SENSITIVE_FIELD_PATTERN.test(k)) {
        result[k] = v;
      }
    }
    return result;
  }

  /**
   * Appends one JSONL line to the audit log file.
   * Sanitizes args before writing.
   * No-op when logger is disabled.
   */
  async log(entry: AuditEntry): Promise<void> {
    if (!this.enabled) return;

    const sanitized: AuditEntry = {
      ...entry,
      args: this.sanitizeArgs(entry.args),
    };

    const line = JSON.stringify(sanitized) + '\n';

    // Ensure parent directory exists
    await fsPromises.mkdir(path.dirname(this.logPath), { recursive: true });
    await fsPromises.appendFile(this.logPath, line, 'utf-8');
  }
}
