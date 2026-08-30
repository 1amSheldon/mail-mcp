import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getClaudeConfigPath, installClaude } from './install-claude.js';
import { buildMailMcpNpxArgs } from './npm-runtime.js';

describe('installClaude', () => {
  let tmpDir: string;
  let configPath: string;
  const runtimeArgs = buildMailMcpNpxArgs(['--confirm', '--audit-log', '--redact']);

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'install-claude-test-'));
    configPath = join(tmpDir, 'claude_desktop_config.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates config file with mcpServers.mail when file does not exist', async () => {
    const result = await installClaude(configPath, 'npx', runtimeArgs);

    expect(result).toEqual({ configPath, changed: true });

    const { readFile } = await import('node:fs/promises');
    const contents = JSON.parse(await readFile(configPath, 'utf8'));

    expect(contents).toEqual({
      mcpServers: {
        mail: { command: 'npx', args: runtimeArgs },
      },
    });
  });

  it('creates parent directory and config file when neither exist', async () => {
    const nestedConfigPath = join(tmpDir, 'nested', 'dir', 'claude_desktop_config.json');

    const result = await installClaude(nestedConfigPath, 'npx', runtimeArgs);

    expect(result).toEqual({ configPath: nestedConfigPath, changed: true });

    const { readFile } = await import('node:fs/promises');
    const contents = JSON.parse(await readFile(nestedConfigPath, 'utf8'));

    expect(contents.mcpServers.mail).toEqual({ command: 'npx', args: runtimeArgs });
  });

  it('merges into existing config preserving other mcpServers entries', async () => {
    const existingConfig = {
      mcpServers: {
        'other-server': {
          command: '/usr/local/bin/other-server',
          args: ['--flag'],
        },
      },
      preferences: {
        sidebarMode: 'chat',
      },
    };
    await writeFile(configPath, JSON.stringify(existingConfig, null, 2), 'utf8');

    await installClaude(configPath, 'npx', runtimeArgs);

    const { readFile } = await import('node:fs/promises');
    const result = JSON.parse(await readFile(configPath, 'utf8'));

    // Other server preserved
    expect(result.mcpServers['other-server']).toEqual({
      command: '/usr/local/bin/other-server',
      args: ['--flag'],
    });

    // Mail server added
    expect(result.mcpServers.mail).toEqual({ command: 'npx', args: runtimeArgs });

    // Other top-level keys preserved
    expect(result.preferences).toEqual({ sidebarMode: 'chat' });
  });

  it('updates an existing mail entry and creates a backup', async () => {
    const existingConfig = {
      mcpServers: {
        mail: {
          command: 'npx',
          args: ['-y', '@1amsheldon/mail-mcp@1.5.3', '--confirm'],
        },
      },
    };
    await writeFile(configPath, JSON.stringify(existingConfig, null, 2), 'utf8');

    const installResult = await installClaude(configPath, 'npx', runtimeArgs);

    const { readFile } = await import('node:fs/promises');
    const result = JSON.parse(await readFile(configPath, 'utf8'));

    expect(result.mcpServers.mail).toEqual({ command: 'npx', args: runtimeArgs });
    expect(installResult.backupPath).toBe(`${configPath}.mail-mcp.bak`);

    const backup = JSON.parse(await readFile(installResult.backupPath!, 'utf8'));
    expect(backup.mcpServers.mail.args).toContain('@1amsheldon/mail-mcp@1.5.3');
    expect(result.mcpServers.mail.args).toContain('--package=@1amsheldon/mail-mcp@latest');
    expect(result.mcpServers.mail.args).toContain('--prefer-online');
  });

  it('writes config with 2-space indentation', async () => {
    await installClaude(configPath, 'npx', runtimeArgs);

    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(configPath, 'utf8');

    // Should be pretty-printed with 2-space indent
    expect(raw).toContain('  "mcpServers"');
    expect(raw).toContain('    "mail"');
  });

  it('throws with a clear error message when existing config is malformed JSON', async () => {
    await writeFile(configPath, '{ invalid json !!!', 'utf8');

    await expect(installClaude(configPath, 'npx', runtimeArgs)).rejects.toThrow(
      /malformed|invalid|parse|JSON/i
    );
  });

  it('rejects a non-object root config', async () => {
    await writeFile(configPath, '[]', 'utf8');

    await expect(installClaude(configPath, 'npx', runtimeArgs)).rejects.toThrow(
      /Malformed JSON/
    );
  });

  it('preserves the file when mcpServers is not an object', async () => {
    const source = JSON.stringify({ mcpServers: 'invalid', keep: true }, null, 2);
    await writeFile(configPath, source, 'utf8');

    await expect(installClaude(configPath, 'npx', runtimeArgs)).rejects.toThrow(
      /Invalid mcpServers value/
    );

    const { readFile } = await import('node:fs/promises');
    expect(await readFile(configPath, 'utf8')).toBe(source);
  });

  it('does not rewrite an identical config', async () => {
    await installClaude(configPath, 'npx', runtimeArgs);
    const result = await installClaude(configPath, 'npx', runtimeArgs);

    expect(result).toEqual({ configPath, changed: false });
  });
});

describe('getClaudeConfigPath', () => {
  it('uses APPDATA on Windows', () => {
    expect(getClaudeConfigPath('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me'))
      .toBe('C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
  });

  it('uses Application Support on macOS', () => {
    expect(getClaudeConfigPath('darwin', {}, '/Users/me'))
      .toBe('/Users/me/Library/Application Support/Claude/claude_desktop_config.json');
  });

  it('rejects unsupported platforms', () => {
    expect(() => getClaudeConfigPath('linux', {}, '/home/me')).toThrow(
      'supported on macOS and Windows'
    );
  });
});
