import { readFile, realpath } from 'node:fs/promises';
import { ACCOUNTS_PATH } from '../config.js';
import { emailAccountSchema, type EmailAccount } from '../providers/account-types.js';
import { DraftStore, type DraftMigrationResult } from '../services/drafts.js';

const usage = 'Usage: mail-mcp draft-state migrate --account ID --previous-accounts PATH [--dry-run]';

async function readAccount(file: string, id: string, label: string): Promise<EmailAccount> {
  let value: unknown;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error(`Cannot read ${label} accounts snapshot; retain the draft state and inspect the supplied path.`); }
  if (!Array.isArray(value)) throw new Error(`${label} accounts snapshot must be an array.`);
  const matches = value.filter(item => typeof item === 'object' && item !== null && item.id === id);
  if (matches.length !== 1) throw new Error(`${label} accounts snapshot must contain exactly one definition for the selected account id.`);
  const account = emailAccountSchema.safeParse(matches[0]);
  if (!account.success) throw new Error(`${label} account must be a valid IMAP/SMTP definition; refusing to guess its mailbox identity.`);
  return account.data;
}

/** Local-only migration: reads config files and changes draft persistence, never accesses a mailbox or credentials. */
export async function migrateDraftStateFromSnapshot(
  accountId: string,
  previousAccountsPath: string,
  options: { dryRun?: boolean; accountsPath?: string; stateRoot?: string } = {},
): Promise<DraftMigrationResult> {
  const accountsPath = options.accountsPath ?? ACCOUNTS_PATH;
  if (await realpath(accountsPath) === await realpath(previousAccountsPath)) {
    throw new Error('Supply a retained pre-upgrade accounts.json snapshot, not the current accounts file.');
  }
  const account = await readAccount(accountsPath, accountId, 'Current');
  const previousAccount = await readAccount(previousAccountsPath, accountId, 'Previous');
  return new DraftStore(accountId, options.stateRoot).migrateLegacy(account, previousAccount, options.dryRun);
}

export async function handleDraftStateCommand(args: string[]): Promise<boolean> {
  if (args[0] !== 'draft-state') return false;
  if (args[1] !== 'migrate') throw new Error(usage);
  let accountId: string | undefined;
  let previousAccountsPath: string | undefined;
  let dryRun = false;
  for (let index = 2; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--dry-run' && !dryRun) { dryRun = true; continue; }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(usage);
    if (flag === '--account' && accountId === undefined) accountId = value;
    else if (flag === '--previous-accounts' && previousAccountsPath === undefined) previousAccountsPath = value;
    else throw new Error(usage);
    index++;
  }
  if (!accountId || !previousAccountsPath) throw new Error(usage);
  const result = await migrateDraftStateFromSnapshot(accountId, previousAccountsPath, { dryRun });
  console.log(JSON.stringify(result, null, 2));
  return true;
}
