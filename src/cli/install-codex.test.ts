import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCodex, upsertCodexServer } from './install-codex.js';
import { buildMailMcpNpxArgs } from './npm-runtime.js';

describe('installCodex', () => {
  let tempDir: string;
  let configPath: string;
  const runtimeArgs = ['--confirm', '--audit-log', '--redact'];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'install-codex-test-'));
    configPath = join(tempDir, '.codex', 'config.toml');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a Codex config that checks for the latest npm release', async () => {
    const result = await installCodex(
      configPath,
      buildMailMcpNpxArgs(runtimeArgs, tempDir)
    );

    expect(result).toEqual({ configPath, changed: true });
    expect(await readFile(configPath, 'utf8')).toContain(
      `args = ["-y", "--prefer-online", "--prefix", "${tempDir.replace(/\\/g, '\\\\')}\\\\.cache\\\\mail-mcp\\\\npm-runtime", "--package=@1amsheldon/mail-mcp@latest", "mail-mcp", "--confirm", "--audit-log", "--redact"]`
    );
  });

  it('replaces only the mail server section and keeps a backup', async () => {
    const source = [
      '# existing settings',
      'model = "gpt-5"',
      '',
      '[mcp_servers.mail]',
      'command = "npx"',
      'args = ["-y", "@1amsheldon/mail-mcp@1.5.3", "--confirm"]',
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
      buildMailMcpNpxArgs(['--read-only', '--audit-log', '--redact'], tempDir)
    );

    const updated = await readFile(configPath, 'utf8');
    expect(updated).toContain('model = "gpt-5"');
    expect(updated).toContain('[mcp_servers.context7]');
    expect(updated).not.toContain('@1amsheldon/mail-mcp@1.5.3');
    expect(updated).not.toContain('OLD_VALUE');
    expect(updated).toContain('@1amsheldon/mail-mcp@latest');
    expect(updated).toContain('--prefer-online');
    expect(await readFile(result.backupPath!, 'utf8')).toBe(source);
  });

  it('handles a quoted mail table name', () => {
    const source = '[mcp_servers."mail"]\r\ncommand = "old"\r\n\r\n[features]\r\nfoo = true\r\n';
    const updated = upsertCodexServer(source, buildMailMcpNpxArgs(['--confirm'], tempDir));

    expect(updated).not.toContain('command = "old"');
    expect(updated).toContain('[features]\r\nfoo = true');
    expect(updated).toContain('[mcp_servers.mail]\r\ncommand = "npx"');
  });

  it('does not rewrite an unchanged config', async () => {
    const npxArgs = buildMailMcpNpxArgs(['--confirm'], tempDir);
    await installCodex(configPath, npxArgs);
    const result = await installCodex(configPath, npxArgs);

    expect(result).toEqual({ configPath, changed: false });
  });

  it('refuses to overwrite malformed TOML', async () => {
    const source = '[mcp_servers.mail\ncommand = "broken"\n';
    await mkdir(join(tempDir, '.codex'), { recursive: true });
    await writeFile(configPath, source, 'utf8');

    await expect(
      installCodex(configPath, buildMailMcpNpxArgs(['--confirm'], tempDir))
    ).rejects.toThrow(/Invalid existing Codex config/);
    expect(await readFile(configPath, 'utf8')).toBe(source);
  });
});
