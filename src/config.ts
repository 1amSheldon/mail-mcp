import { z } from 'zod';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { FSWatcher } from 'node:fs';
import { watchFileChanges } from './utils/file-watcher.js';

export const ACCOUNTS_PATH = path.join(os.homedir(), '.config', 'mail-mcp', 'accounts.json');
export const AUDIT_LOG_PATH = path.join(os.homedir(), '.config', 'mail-mcp', 'audit.log');
export const DEFAULT_KEYCHAIN_SERVICE = 'com.1amsheldon.mail-mcp';
export const LEGACY_KEYCHAIN_SERVICE = 'ch.honest-magic.config.mail-server';

const configSchema = z.object({
  serviceName: z.string().default(DEFAULT_KEYCHAIN_SERVICE),
  logLevel: z.string().default('info'),
});

export const config = configSchema.parse({
  serviceName: process.env.SERVICE_NAME,
  logLevel: process.env.LOG_LEVEL,
});

// ---------------------------------------------------------------------------
// Account schema and type
// ---------------------------------------------------------------------------

const portSchema = z.number().int().min(1).max(65535);

export const emailAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  host: z.string().min(1),
  port: portSchema,
  smtpHost: z.string().min(1).optional(),
  smtpPort: portSchema.optional(),
  user: z.string().min(1),
  authType: z.enum(['login', 'oauth2']),
  useTLS: z.boolean(),
  signature: z.string().optional(),
  manageSievePort: portSchema.optional(),
  allowedRecipients: z.array(z.string()).optional(),
  sentFolder: z.string().min(1).optional(),
});

export type EmailAccount = z.infer<typeof emailAccountSchema>;

// ---------------------------------------------------------------------------
// In-memory cache with fs.watch invalidation
// ---------------------------------------------------------------------------

let cachedAccounts: EmailAccount[] | null = null;
let accountsWatcher: FSWatcher | undefined;

function startWatcher(): void {
  if (accountsWatcher) return;
  accountsWatcher = watchFileChanges(
    ACCOUNTS_PATH,
    () => {
      cachedAccounts = null;
    },
    () => {
      accountsWatcher = undefined;
    },
  );
}

/** @internal Exposed for testing only. */
export function resetConfigCache(): void {
  accountsWatcher?.close();
  accountsWatcher = undefined;
  cachedAccounts = null;
}

// ---------------------------------------------------------------------------
// Internal disk loader with per-item safeParse
// ---------------------------------------------------------------------------

async function loadAccountsFromDisk(): Promise<EmailAccount[]> {
  const raw = await fsPromises.readFile(ACCOUNTS_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    console.error('accounts.json must be an array');
    return [];
  }

  const valid: EmailAccount[] = [];
  for (const item of parsed) {
    const result = emailAccountSchema.safeParse(item);
    if (result.success) {
      valid.push(result.data);
    } else {
      const id = typeof item?.id === 'string' ? item.id : '(unknown)';
      const fields = result.error.issues.map((i) => i.path.join('.') || 'root').join(', ');
      console.error(`accounts.json: account "${id}" skipped; invalid fields: ${fields}`);
    }
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads account definitions from ~/.config/mail-mcp/accounts.json.
 * Results are cached in memory; the cache is invalidated when the file changes.
 * Returns an empty array if the file does not exist or cannot be parsed.
 */
export async function getAccounts(): Promise<EmailAccount[]> {
  if (cachedAccounts !== null) return cachedAccounts;
  startWatcher();
  try {
    const loaded = await loadAccountsFromDisk();
    cachedAccounts = loaded;
    startWatcher();
    return loaded;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Unable to load accounts.json: ${message}`);
    }
    return [];
  }
}

/**
 * Writes account definitions to ~/.config/mail-mcp/accounts.json.
 * Creates the directory if it does not exist.
 * Synchronous and CLI-only; used by `accounts add/remove`.
 * The fs.watch callback will invalidate the cache after this write.
 */
export function saveAccounts(accounts: EmailAccount[]): void {
  const validated = z.array(emailAccountSchema).parse(accounts);
  const configPath = ACCOUNTS_PATH;
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(validated, null, 2), 'utf-8');
  cachedAccounts = validated;
  startWatcher();
}
