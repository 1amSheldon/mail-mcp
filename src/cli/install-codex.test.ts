import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import {
  buildCodexHttpServerSection,
  installCodex,
  installCodexHttp,
  upsertCodexServer,
} from './install-codex.js';
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
    expect(parse(await readFile(configPath, 'utf8'))).toMatchObject({
      mcp_servers: {
        mail: {
          command: 'npx',
          args: buildMailMcpNpxArgs(runtimeArgs, tempDir),
        },
      },
    });
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

  it('installs a shared authenticated HTTP server without writing the token', async () => {
    await mkdir(join(tempDir, '.codex'), { recursive: true });
    const source = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.mail]',
      'command = "npx"',
      'args = ["-y", "@1amsheldon/mail-mcp@1.5.5"]',
      '',
    ].join('\n');
    await writeFile(configPath, source, 'utf8');

    const result = await installCodexHttp(configPath, {
      url: 'http://127.0.0.1:8765/mcp',
      bearerTokenEnvVar: 'MAIL_MCP_BEARER_TOKEN',
    });

    const parsed = parse(await readFile(configPath, 'utf8'));
    expect(parsed).toMatchObject({
      model: 'gpt-5',
      mcp_servers: {
        mail: {
          url: 'http://127.0.0.1:8765/mcp',
          bearer_token_env_var: 'MAIL_MCP_BEARER_TOKEN',
          enabled: true,
          required: true,
          startup_timeout_sec: 15,
          tool_timeout_sec: 300,
        },
      },
    });
    expect(JSON.stringify(parsed)).not.toContain('command');
    expect(JSON.stringify(parsed)).not.toContain('actual-secret');
    expect(await readFile(result.backupPath!, 'utf8')).toBe(source);
  });

  it('rejects unsafe HTTP config values', () => {
    expect(() => buildCodexHttpServerSection({
      url: 'file:///tmp/mail-mcp.sock',
      bearerTokenEnvVar: 'MAIL_MCP_BEARER_TOKEN',
    })).toThrow('Invalid Codex MCP server URL');
    expect(() => buildCodexHttpServerSection({
      url: 'http://127.0.0.1:8765/mcp',
      bearerTokenEnvVar: 'MAIL-MCP-TOKEN',
    })).toThrow('Invalid bearer token environment variable');
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
