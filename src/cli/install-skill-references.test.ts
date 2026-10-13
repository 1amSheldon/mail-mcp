import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installCodexBundle, installCodexSkill } from './install-codex.js';

describe('portable skill installation', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'mail-skill-refs-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('installs byte-identical references and rolls back the whole new bundle', async () => {
    const bundle = await installCodexBundle(join(home, 'config.toml'), home, { transport: 'stdio', npxArgs: ['mail-mcp'] });
    const source = new URL('../../skills/mail-mcp/references/', import.meta.url);
    for (const name of await readdir(source)) {
      expect(await readFile(join(home, 'skills/mail-mcp/references', name))).toEqual(await readFile(new URL(name, source)));
    }
    await bundle.rollback();
    expect(await readdir(join(home, 'skills/mail-mcp/references'))).toEqual([]);
    await expect(readFile(bundle.skill.skillPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves customized references by default and backs them up on explicit replacement', async () => {
    await installCodexSkill(home);
    const reference = join(home, 'skills/mail-mcp/references/zimbra.md');
    await writeFile(reference, 'local instructions\n');
    expect((await installCodexSkill(home)).changed).toBe(false);
    expect(await readFile(reference, 'utf8')).toBe('local instructions\n');
    const changed = await installCodexSkill(home, { replaceExisting: true });
    expect(await readFile(`${reference}.mail-mcp.bak`, 'utf8')).toBe('local instructions\n');
    await changed.rollback?.();
    expect(await readFile(reference, 'utf8')).toBe('local instructions\n');
  });

  it('does not traverse a references junction even during explicit replacement', async () => {
    const outside = join(home, 'shared');
    const folder = join(home, 'skills/mail-mcp');
    await mkdir(outside); await mkdir(folder, { recursive: true });
    await writeFile(join(outside, 'zimbra.md'), 'external');
    await symlink(outside, join(folder, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(await installCodexSkill(home, { replaceExisting: true })).toMatchObject({ changed: false, skipped: expect.stringContaining('linked') });
      expect(await readFile(join(outside, 'zimbra.md'), 'utf8')).toBe('external');
    } finally { await unlink(join(folder, 'references')); }
  });

  it('preserves edits made after installation instead of erasing them in rollback', async () => {
    const installed = await installCodexSkill(home);
    await writeFile(installed.skillPath, 'new user work');
    await expect(installed.rollback?.()).rejects.toThrow('preserved a changed file');
    expect(await readFile(installed.skillPath, 'utf8')).toBe('new user work');
  });

  it('removes newly installed references when config validation fails', async () => {
    await writeFile(join(home, 'config.toml'), '[broken');
    await expect(installCodexBundle(join(home, 'config.toml'), home, { transport: 'stdio', npxArgs: ['mail-mcp'] })).rejects.toThrow();
    expect(await readdir(join(home, 'skills/mail-mcp/references'))).toEqual([]);
  });
});
