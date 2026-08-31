import { z } from 'zod';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { FSWatcher } from 'node:fs';
import { watchFileChanges } from './utils/file-watcher.js';
import { writeTextFileAtomicSync } from './utils/atomic-write.js';
import {
  configuredAccountSchema,
  emailAccountSchema,
  isImapSmtpAccount,
} from './providers/account-types.js';
import type { ConfiguredAccount, EmailAccount } from './providers/account-types.js';

export {
  ACCOUNT_BACKEND_CAPABILITIES,
  appleMailAccountSchema,
  configuredAccountSchema,
  emailAccountSchema,
  ewsAccountSchema,
  getAccountCapabilities,
  imapSmtpAccountSchema,
  isAppleMailAccount,
  isEwsAccount,
  isImapSmtpAccount,
  isMailtrapAccount,
  isMicrosoftGraphAccount,
  legacyEmailAccountSchema,
  mailtrapAccountSchema,
  microsoftGraphAccountSchema,
} from './providers/account-types.js';
export type {
  AccountBackend,
  AccountCapabilityDescriptor,
  AppleMailConfiguredAccount,
  ConfiguredAccount,
  EmailAccount,
  EwsConfiguredAccount,
  ImapSmtpAccount,
  LegacyEmailAccount,
  MailtrapConfiguredAccount,
  MicrosoftGraphConfiguredAccount,
} from './providers/account-types.js';

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

// ---------------------------------------------------------------------------
// In-memory cache with fs.watch invalidation
// ---------------------------------------------------------------------------

let cachedAccounts: ConfiguredAccount[] | null = null;
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

function parseConfiguredAccounts(raw: string): ConfiguredAccount[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    console.error('accounts.json must be an array');
    return [];
  }

  const valid: ConfiguredAccount[] = [];
  const seenIds = new Set<string>();
  for (const item of parsed) {
    const result = configuredAccountSchema.safeParse(item);
    if (result.success) {
      if (seenIds.has(result.data.id)) {
        console.error(`accounts.json: duplicate account ID "${result.data.id}" skipped`);
        continue;
      }
      seenIds.add(result.data.id);
      valid.push(result.data);
    } else {
      const id = typeof item?.id === 'string' ? item.id : '(unknown)';
      const fields = result.error.issues.map((i) => i.path.join('.') || 'root').join(', ');
      console.error(`accounts.json: account "${id}" skipped; invalid fields: ${fields}`);
    }
  }
  return valid;
}

async function loadAccountsFromDisk(): Promise<ConfiguredAccount[]> {
  const raw = await fsPromises.readFile(ACCOUNTS_PATH, 'utf-8');
  return parseConfiguredAccounts(raw);
}

function loadAccountsFromDiskSync(): ConfiguredAccount[] {
  const raw = fs.readFileSync(ACCOUNTS_PATH, 'utf-8');
  return parseConfiguredAccounts(raw);
}

function assertUniqueAccountIds(accounts: readonly ConfiguredAccount[]): void {
  const duplicateIds = accounts
    .map(account => account.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`Duplicate account ID(s): ${[...new Set(duplicateIds)].join(', ')}`);
  }
}

function writeAccounts(accounts: ConfiguredAccount[]): void {
  const dir = path.dirname(ACCOUNTS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  writeTextFileAtomicSync(ACCOUNTS_PATH, `${JSON.stringify(accounts, null, 2)}\n`);
  cachedAccounts = accounts;
  startWatcher();
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
  return (await getConfiguredAccounts()).filter(isImapSmtpAccount);
}

/**
 * Reads every supported account definition from accounts.json.
 * Item-level validation failures are logged and isolated from valid accounts.
 */
export async function getConfiguredAccounts(): Promise<ConfiguredAccount[]> {
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
  let existing: ConfiguredAccount[];
  if (cachedAccounts !== null) {
    existing = cachedAccounts;
  } else {
    try {
      existing = loadAccountsFromDiskSync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        existing = [];
      } else {
        throw error;
      }
    }
  }
  const retainedProviders = existing.filter(account => !isImapSmtpAccount(account));
  const combined = [...retainedProviders, ...validated];
  assertUniqueAccountIds(combined);
  writeAccounts(combined);
}

/**
 * Replaces accounts.json with a validated set containing any supported backend.
 */
export function saveConfiguredAccounts(accounts: ConfiguredAccount[]): void {
  const validated = z.array(configuredAccountSchema).parse(accounts);
  assertUniqueAccountIds(validated);
  writeAccounts(validated);
}
