import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildClaudeCodeCommand,
  CLAUDE_CODE_MCP_SERVER_NAME,
  installClaudeCode,
  installClaudeCodeSkill,
} from './install-claude-code.js';

const npxArgs = [
  '-y',
  '--prefer-online',
  '--prefix',
  'C:\\Users\\me\\.cache\\mail-mcp\\npm-runtime',
  '--package=@1amsheldon/mail-mcp@latest',
  'mail-mcp',
  '--confirm',
  '--audit-log',
  '--redact',
];

describe('Claude Code installer', () => {
  let tempDir: string;
  let claudeHome: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'install-claude-code-test-'));
    claudeHome = join(tempDir, '.claude');
    configPath = join(tempDir, '.claude.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('builds a user-scoped Unix stdio command without shell joining', () => {
    expect(buildClaudeCodeCommand(npxArgs, 'linux')).toEqual({
      executable: 'claude',
      args: [
        'mcp',
        'add',
        CLAUDE_CODE_MCP_SERVER_NAME,
        '--scope',
        'user',
        '--',
        'npx',
        ...npxArgs,
      ],
    });
  });

  it('wraps npx with cmd /c on native Windows', () => {
    expect(buildClaudeCodeCommand(npxArgs, 'win32')).toEqual({
      executable: 'claude',
      args: [
        'mcp',
        'add',
        CLAUDE_CODE_MCP_SERVER_NAME,
        '--scope',
        'user',
        '--',
        'cmd',
        '/c',
        'npx',
        ...npxArgs,
      ],
    });
  });

  it('executes the command through an injected execFile and returns stdout', async () => {
    const execFile = vi.fn(async () => ({ stdout: 'Added MCP server mail\n', stderr: '' }));

    const result = await installClaudeCode(npxArgs, {
      platform: 'linux',
      execFile,
      claudeHome,
    });

    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      'claude',
      [
        'mcp',
        'add',
        'mail',
        '--scope',
        'user',
        '--',
        'npx',
        ...npxArgs,
      ],
      { encoding: 'utf8', shell: false, windowsHide: true },
    );
    expect(result).toEqual({
      executable: 'claude',
      args: [
        'mcp',
        'add',
        'mail',
        '--scope',
        'user',
        '--',
        'npx',
        ...npxArgs,
      ],
      changed: true,
      skillPath: join(claudeHome, 'skills', 'mail-mcp', 'SKILL.md'),
      skillChanged: true,
      stdout: 'Added MCP server mail',
    });
    expect(await readFile(result.skillPath, 'utf8')).toContain('name: mail-mcp');
  });

  it('uses the Windows wrapper when executing on native Windows', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));

    await installClaudeCode(npxArgs, { platform: 'win32', execFile, claudeHome });

    expect(execFile).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--', 'cmd', '/c', 'npx']),
      { encoding: 'utf8', shell: false, windowsHide: true },
    );
  });

  it('rejects an empty runtime command before invoking Claude Code', async () => {
    const execFile = vi.fn();

    await expect(installClaudeCode([], { execFile, claudeHome })).rejects.toThrow(
      'The npx argument list must not be empty',
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it('replaces a duplicate registration after backing up the exact user config', async () => {
    const original = Buffer.from('\ufeff{\r\n  "mcpServers": {"mail": {"command": "old"}}\r\n}\r\n');
    const updated = Buffer.from('{"mcpServers":{"mail":{"command":"new"}}}\n');
    await writeFile(configPath, original);
    const execFile = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('exit code 1'), {
        stderr: 'MCP server mail already exists in user config\n',
      }))
      .mockImplementationOnce(async () => {
        await writeFile(configPath, '{"mcpServers":{}}\n');
        return { stdout: 'Removed MCP server mail\n', stderr: '' };
      })
      .mockImplementationOnce(async () => {
        await writeFile(configPath, updated);
        return { stdout: 'Added MCP server mail\n', stderr: '' };
      });

    const result = await installClaudeCode(npxArgs, {
      execFile,
      claudeHome,
      claudeConfigPath: configPath,
    });

    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'claude',
      ['mcp', 'remove', 'mail', '--scope', 'user'],
      { encoding: 'utf8', shell: false, windowsHide: true },
    );
    expect(await readFile(configPath)).toEqual(updated);
    expect(result.configBackupPath).toBe(`${configPath}.mail-mcp.bak`);
    expect(await readFile(result.configBackupPath!)).toEqual(original);
  });

  it('restores the exact user config when replacement add fails', async () => {
    const original = Buffer.from('\ufeff{\r\n  "mcpServers": {"mail": {"args": ["old value"]}}\r\n}\r\n');
    await writeFile(configPath, original);
    const execFile = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('exit code 1'), {
        stderr: 'MCP server mail already exists in local config\n',
      }))
      .mockImplementationOnce(async () => {
        await writeFile(configPath, '{"mcpServers":{}}\n');
        return { stdout: 'Removed MCP server mail\n', stderr: '' };
      })
      .mockImplementationOnce(async () => {
        await writeFile(configPath, '{"partial":true}\n');
        throw Object.assign(new Error('exit code 1'), { stderr: 'add failed\n' });
      });

    await expect(installClaudeCode(npxArgs, {
      execFile,
      claudeHome,
      claudeConfigPath: configPath,
    })).rejects.toThrow('replacement failed; the exact user config snapshot was restored');
    expect(await readFile(configPath)).toEqual(original);
    expect(await readFile(`${configPath}.mail-mcp.bak`)).toEqual(original);
  });

  it('leaves the user config untouched on a non-duplicate add failure', async () => {
    const original = Buffer.from('{\r\n  "mcpServers": {}\r\n}\r\n');
    await writeFile(configPath, original);
    const execFile = vi.fn().mockRejectedValueOnce(Object.assign(new Error('exit code 1'), {
      stderr: 'Claude Code is not installed\n',
    }));

    await expect(installClaudeCode(npxArgs, {
      execFile,
      claudeHome,
      claudeConfigPath: configPath,
    })).rejects.toThrow('failed without changing any existing registration');
    expect(execFile).toHaveBeenCalledOnce();
    expect(await readFile(configPath)).toEqual(original);
    await expect(readFile(`${configPath}.mail-mcp.bak`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('installs and updates the bundled Claude skill with an exact backup', async () => {
    const first = await installClaudeCodeSkill(claudeHome);
    const bundled = await readFile(first.skillPath, 'utf8');
    expect(first).toEqual({
      skillPath: join(claudeHome, 'skills', 'mail-mcp', 'SKILL.md'),
      changed: true,
    });
    expect(bundled).toContain('name: mail-mcp');

    expect(await installClaudeCodeSkill(claudeHome)).toEqual({
      skillPath: first.skillPath,
      changed: false,
    });

    await writeFile(first.skillPath, 'local Claude instruction\n', 'utf8');
    const updated = await installClaudeCodeSkill(claudeHome);
    expect(await readFile(updated.backupPath!, 'utf8')).toBe('local Claude instruction\n');
    expect(await readFile(updated.skillPath, 'utf8')).toBe(bundled);
  });

  it('removes the newly added MCP registration when skill installation fails', async () => {
    const blockedHome = join(tempDir, 'blocked-home');
    await writeFile(blockedHome, 'not a directory', 'utf8');
    const execFile = vi.fn()
      .mockResolvedValueOnce({ stdout: 'Added MCP server mail\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Removed MCP server mail\n', stderr: '' });

    await expect(installClaudeCode(npxArgs, { execFile, claudeHome: blockedHome }))
      .rejects.toThrow('Claude Code skill installation failed; the new MCP registration was rolled back');
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'claude',
      ['mcp', 'remove', 'mail', '--scope', 'user'],
      { encoding: 'utf8', shell: false, windowsHide: true },
    );
  });

  it('reports a partial install when MCP rollback also fails', async () => {
    const blockedHome = join(tempDir, 'blocked-home');
    await writeFile(blockedHome, 'not a directory', 'utf8');
    const execFile = vi.fn()
      .mockResolvedValueOnce({ stdout: 'Added MCP server mail\n', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('exit code 1'), {
        stderr: 'remove failed\n',
      }));

    await expect(installClaudeCode(npxArgs, { execFile, claudeHome: blockedHome }))
      .rejects.toThrow('new MCP registration could not be rolled back');
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('restores the exact replacement snapshot when skill installation fails', async () => {
    const blockedHome = join(tempDir, 'blocked-home');
    await writeFile(blockedHome, 'not a directory', 'utf8');
    const original = Buffer.from('\ufeff{\r\n  "mcpServers": {"mail": {"command": "old"}}\r\n}\r\n');
    await writeFile(configPath, original);
    const execFile = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('exit code 1'), {
        stderr: 'MCP server mail already exists in project config\n',
      }))
      .mockImplementationOnce(async () => {
        await writeFile(configPath, '{"mcpServers":{}}\n');
        return { stdout: 'Removed MCP server mail\n', stderr: '' };
      })
      .mockImplementationOnce(async () => {
        await writeFile(configPath, '{"mcpServers":{"mail":{"command":"new"}}}\n');
        return { stdout: 'Added MCP server mail\n', stderr: '' };
      });

    await expect(installClaudeCode(npxArgs, {
      execFile,
      claudeHome: blockedHome,
      claudeConfigPath: configPath,
    })).rejects.toThrow('skill installation failed; the exact user config snapshot was restored');
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(await readFile(configPath)).toEqual(original);
    expect(await readFile(`${configPath}.mail-mcp.bak`)).toEqual(original);
  });
});
