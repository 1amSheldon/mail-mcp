// Copyright (c) RX Group

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCodex, upsertCodexServer } from './install-codex.js';

describe('installCodex', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'install-codex-test-'));
    configPath = join(tempDir, '.codex', 'config.toml');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a Codex config with a pinned npm package', async () => {
    const result = await installCodex(
      configPath,
      '@1amsheldon/mail-mcp@1.5.0',
      ['--confirm', '--audit-log', '--redact']
    );

    expect(result).toEqual({ configPath, changed: true });
    expect(await readFile(configPath, 'utf8')).toContain(
      'args = ["-y", "@1amsheldon/mail-mcp@1.5.0", "--confirm", "--audit-log", "--redact"]'
    );
  });

  it('replaces only the mail server section and keeps a backup', async () => {
    const source = [
      '# existing settings',
      'model = "gpt-5"',
      '',
      '[mcp_servers.mail]',
      'command = "node"',
      'args = ["old.js"]',
      '',
      '[mcp_servers.mail.env]',
      'OLD_VALUE = "kept only in backup"',
      '',
      '[mcp_servers.context7]',
      'command = "npx"',
      'args = ["-y", "@upstash/context7-mcp"]',
      '',
    ].join('\n');
    await mkdir(join(tempDir, '.codex'), { recursive: true });
    await writeFile(configPath, source, 'utf8');

    const result = await installCodex(
      configPath,
      '@1amsheldon/mail-mcp@1.5.0',
      ['--read-only', '--audit-log', '--redact']
    );

    const updated = await readFile(configPath, 'utf8');
    expect(updated).toContain('model = "gpt-5"');
    expect(updated).toContain('[mcp_servers.context7]');
    expect(updated).not.toContain('old.js');
    expect(updated).not.toContain('OLD_VALUE');
    expect(await readFile(result.backupPath!, 'utf8')).toBe(source);
  });

  it('handles a quoted mail table name', () => {
    const source = '[mcp_servers."mail"]\r\ncommand = "old"\r\n\r\n[features]\r\nfoo = true\r\n';
    const updated = upsertCodexServer(source, '@1amsheldon/mail-mcp@1.5.0', ['--confirm']);

    expect(updated).not.toContain('command = "old"');
    expect(updated).toContain('[features]\r\nfoo = true');
    expect(updated).toContain('[mcp_servers.mail]\r\ncommand = "npx"');
  });

  it('does not rewrite an unchanged config', async () => {
    await installCodex(configPath, '@1amsheldon/mail-mcp@1.5.0', ['--confirm']);
    const result = await installCodex(configPath, '@1amsheldon/mail-mcp@1.5.0', ['--confirm']);

    expect(result).toEqual({ configPath, changed: false });
  });

  it('refuses to overwrite malformed TOML', async () => {
    const source = '[mcp_servers.mail\ncommand = "broken"\n';
    await mkdir(join(tempDir, '.codex'), { recursive: true });
    await writeFile(configPath, source, 'utf8');

    await expect(
      installCodex(configPath, '@1amsheldon/mail-mcp@1.5.0', ['--confirm'])
    ).rejects.toThrow(/Invalid existing Codex config/);
    expect(await readFile(configPath, 'utf8')).toBe(source);
  });
});
