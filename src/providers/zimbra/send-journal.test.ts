import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncDirectory } from '../../utils/directory-sync.js';
import { ZimbraSendJournal } from './send-journal.js';

vi.mock('../../utils/directory-sync.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../utils/directory-sync.js')>(),
  syncDirectory: vi.fn(),
}));
let directory: string;
beforeEach(async () => { vi.mocked(syncDirectory).mockReset(); directory = await mkdtemp(join(tmpdir(), 'zimbra-journal-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('send journal dispatch barrier', () => {
  it('does not release a claim until its directory flush completes', async () => {
    const journal = new ZimbraSendJournal('scope', directory);
    let release!: () => void;
    let entered!: () => void;
    const flushing = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(syncDirectory).mockImplementationOnce(async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    });
    let ready = false;
    const begin = journal.begin('1', Buffer.from('mail')).then(value => { ready = true; return value; });
    await flushing;
    expect(ready).toBe(false);
    release(); await begin;
    expect(ready).toBe(true);
  });
  it('fails before dispatch if directory sync fails and retains the exclusive claim', async () => {
    const journal = new ZimbraSendJournal('scope', directory);
    vi.mocked(syncDirectory).mockRejectedValueOnce(new Error('disk error'));
    await expect(journal.begin('1', Buffer.from('mail'))).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await expect(journal.begin('1', Buffer.from('mail'))).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  });
  it('reports uncertain status when directory sync after atomic replacement fails', async () => {
    const journal = new ZimbraSendJournal('scope', directory);
    const record = await journal.begin('1', Buffer.from('mail'));
    vi.mocked(syncDirectory).mockRejectedValueOnce(new Error('disk error'));
    await expect(journal.save({ ...record, status: 'accepted' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(await journal.read('1')).toMatchObject({ attemptId: record.attemptId });
  });
});
