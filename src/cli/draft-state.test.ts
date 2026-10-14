import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { migrateDraftStateFromSnapshot, handleDraftStateCommand } from './draft-state.js';
import { encodeMessageLocator } from '../domain/message-locator.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const account = { id: 'legacy', name: 'Legacy', host: 'imap.example.test', port: 993, user: 'me@example.test', authType: 'login', useTLS: true };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'draft-migration-')); roots.push(root);
  const current = join(root, 'accounts.json');
  const previous = join(root, 'accounts-before-upgrade.json');
  await writeFile(current, JSON.stringify([account]));
  await writeFile(previous, JSON.stringify([account]));
  const file = join(root, createHash('sha256').update(account.id).digest('hex') + '.json');
  const locator = encodeMessageLocator({ accountId: account.id, mailbox: 'Drafts', uidValidity: '42', uid: 1 });
  const original = JSON.stringify({ records: [{ draftId: 'legacy-draft', locator, aliases: [locator], messageIds: ['<original@example.test>'], attempt: { status: 'sending' } }] }, null, 4) + '\n';
  await writeFile(file, original);
  return { root, current, previous, file, original, options: { accountsPath: current, stateRoot: root } };
}

describe('draft-state migration CLI', () => {
  it('previews, backs up, and binds a retained pre-upgrade snapshot with the same mailbox', async () => {
    const f = await fixture();
    expect(await migrateDraftStateFromSnapshot(account.id, f.previous, { ...f.options, dryRun: true })).toMatchObject({ status: 'would_migrate', records: 1 });
    expect(await readFile(f.file, 'utf8')).toBe(f.original);
    expect((await readdir(f.root)).filter(name => name.endsWith('.bak'))).toEqual([]);
    const result = await migrateDraftStateFromSnapshot(account.id, f.previous, f.options);
    expect(result.status).toBe('migrated');
    expect(await readFile(result.backup!, 'utf8')).toBe(f.original);
    expect(JSON.parse(await readFile(f.file, 'utf8')).records).toEqual(JSON.parse(f.original).records);
  });

  it.each(['changed', 'duplicate', 'missing', 'provider', 'invalid'] as const)('refuses %s snapshot evidence without state changes', async kind => {
    const f = await fixture();
    const evidence = kind === 'changed' ? [{ ...account, host: 'other.example.test' }]
      : kind === 'duplicate' ? [account, account]
      : kind === 'missing' ? []
      : kind === 'provider' ? [{ id: account.id, name: 'Zimbra', backend: 'zimbra', user: account.user, endpoint: 'https://mail.example.test/service/soap' }]
      : { records: [] };
    await writeFile(f.previous, JSON.stringify(evidence));
    await expect(migrateDraftStateFromSnapshot(account.id, f.previous, f.options)).rejects.toThrow();
    expect(await readFile(f.file, 'utf8')).toBe(f.original);
    expect((await readdir(f.root)).filter(name => name.endsWith('.bak'))).toEqual([]);
  });

  it('refuses an ambiguous current config and the current file passed as historical evidence', async () => {
    const f = await fixture();
    await expect(migrateDraftStateFromSnapshot(account.id, f.current, f.options)).rejects.toThrow('not the current accounts file');
    await writeFile(f.current, JSON.stringify([account, account]));
    await expect(migrateDraftStateFromSnapshot(account.id, f.previous, f.options)).rejects.toThrow('exactly one');
    expect(await readFile(f.file, 'utf8')).toBe(f.original);
  });

  it('does not create state when no legacy records exist', async () => {
    const f = await fixture();
    await rm(f.file);
    expect(await migrateDraftStateFromSnapshot(account.id, f.previous, f.options)).toEqual({ status: 'missing', records: 0 });
    expect(await readdir(f.root)).toEqual(['accounts-before-upgrade.json', 'accounts.json']);
  });

  it('rejects missing, duplicate, and unknown CLI arguments before reading any config', async () => {
    expect(await handleDraftStateCommand(['accounts', 'list'])).toBe(false);
    for (const args of [[], ['--account', 'legacy'], ['--account', 'legacy', '--account', 'other'], ['--unknown', 'x'], ['--dry-run', '--dry-run']]) {
      await expect(handleDraftStateCommand(['draft-state', 'migrate', ...args])).rejects.toThrow('Usage:');
    }
  });
});
