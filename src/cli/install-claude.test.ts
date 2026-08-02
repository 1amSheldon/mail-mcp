/**
 * Tests for installClaude() — Phase 34-01
 *
 * Tests cover:
 * - Creating new config file when neither dir nor file exist
 * - Creating config file when dir exists but file does not
 * - Merging into existing config that has other mcpServers
 * - Updating an existing 'mail' entry in mcpServers
 * - Throwing on malformed JSON in existing config file
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { installClaude } from './install-claude.js';

describe('installClaude', () => {
  let tmpDir: string;
  let configPath: string;
  const binaryPath = '/opt/homebrew/bin/mail-mcp';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'install-claude-test-'));
    configPath = join(tmpDir, 'claude_desktop_config.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates config file with mcpServers.mail when file does not exist', async () => {
    const writtenPath = await installClaude(configPath, binaryPath);

    expect(writtenPath).toBe(configPath);

    const { readFile } = await import('node:fs/promises');
    const contents = JSON.parse(await readFile(configPath, 'utf8'));

    expect(contents).toEqual({
      mcpServers: {
        mail: { command: binaryPath },
      },
    });
  });

  it('creates parent directory and config file when neither exist', async () => {
    const nestedConfigPath = join(tmpDir, 'nested', 'dir', 'claude_desktop_config.json');

    const writtenPath = await installClaude(nestedConfigPath, binaryPath);

    expect(writtenPath).toBe(nestedConfigPath);

    const { readFile } = await import('node:fs/promises');
    const contents = JSON.parse(await readFile(nestedConfigPath, 'utf8'));

    expect(contents.mcpServers.mail).toEqual({ command: binaryPath });
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

    await installClaude(configPath, binaryPath);

    const { readFile } = await import('node:fs/promises');
    const result = JSON.parse(await readFile(configPath, 'utf8'));

    // Other server preserved
    expect(result.mcpServers['other-server']).toEqual({
      command: '/usr/local/bin/other-server',
      args: ['--flag'],
    });

    // Mail server added
    expect(result.mcpServers.mail).toEqual({ command: binaryPath });

    // Other top-level keys preserved
    expect(result.preferences).toEqual({ sidebarMode: 'chat' });
  });

  it('updates an existing mail entry with the new binary path', async () => {
    const existingConfig = {
      mcpServers: {
        mail: { command: '/old/path/to/mail-mcp' },
      },
    };
    await writeFile(configPath, JSON.stringify(existingConfig, null, 2), 'utf8');

    await installClaude(configPath, '/new/path/to/mail-mcp');

    const { readFile } = await import('node:fs/promises');
    const result = JSON.parse(await readFile(configPath, 'utf8'));

    expect(result.mcpServers.mail).toEqual({ command: '/new/path/to/mail-mcp' });
  });

  it('writes config with 2-space indentation', async () => {
    await installClaude(configPath, binaryPath);

    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(configPath, 'utf8');

    // Should be pretty-printed with 2-space indent
    expect(raw).toContain('  "mcpServers"');
    expect(raw).toContain('    "mail"');
  });

  it('throws with a clear error message when existing config is malformed JSON', async () => {
    await writeFile(configPath, '{ invalid json !!!', 'utf8');

    await expect(installClaude(configPath, binaryPath)).rejects.toThrow(
      /malformed|invalid|parse|JSON/i
    );
  });
});
