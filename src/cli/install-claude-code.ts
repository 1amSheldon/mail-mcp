import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { writeTextFileAtomic } from '../utils/atomic-write.js';

const execFileAsync = promisify(execFile);

export const CLAUDE_CODE_MCP_SERVER_NAME = 'mail';

export interface ClaudeCodeCommand {
  executable: string;
  args: string[];
}

export interface ClaudeCodeInstallResult extends ClaudeCodeCommand {
  changed: boolean;
  skillPath: string;
  skillChanged: boolean;
  skillBackupPath?: string;
  configBackupPath?: string;
  stdout: string;
}

export interface ClaudeCodeSkillInstallResult {
  skillPath: string;
  backupPath?: string;
  changed: boolean;
}

export interface ClaudeCodeExecOptions {
  encoding: 'utf8';
  shell: false;
  windowsHide: true;
}

export type ClaudeCodeExecFile = (
  executable: string,
  args: string[],
  options: ClaudeCodeExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface ClaudeCodeInstallDependencies {
  platform?: NodeJS.Platform;
  execFile?: ClaudeCodeExecFile;
  claudeHome?: string;
  claudeConfigPath?: string;
}

function assertNpxArgs(npxArgs: readonly string[]): void {
  if (npxArgs.length === 0) {
    throw new Error('The npx argument list must not be empty.');
  }
  if (npxArgs.some((arg) => typeof arg !== 'string')) {
    throw new Error('The npx argument list must contain only strings.');
  }
}

/**
 * Builds the official Claude Code command for a user-scoped stdio MCP server.
 *
 * Native Windows needs `cmd /c` before `npx`; Unix-like systems can execute
 * `npx` directly. The returned arguments are kept separate so callers never
 * need to construct a shell command string.
 */
export function buildClaudeCodeCommand(
  npxArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ClaudeCodeCommand {
  assertNpxArgs(npxArgs);

  const runtime = platform === 'win32'
    ? ['cmd', '/c', 'npx', ...npxArgs]
    : ['npx', ...npxArgs];

  return {
    executable: 'claude',
    args: [
      'mcp',
      'add',
      CLAUDE_CODE_MCP_SERVER_NAME,
      '--scope',
      'user',
      '--',
      ...runtime,
    ],
  };
}

function defaultExecFile(
  executable: string,
  args: string[],
  options: ClaudeCodeExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(executable, args, options).then((result) => ({
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  }));
}

function getErrorDetail(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }

  const record = error as { stderr?: unknown; message?: unknown };
  if (typeof record.stderr === 'string' && record.stderr.trim() !== '') {
    return record.stderr.trim();
  }
  if (typeof record.message === 'string' && record.message.trim() !== '') {
    return record.message.trim();
  }
  return 'the Claude Code CLI returned an unknown error';
}

function isMailServerAlreadyExistsError(error: unknown): boolean {
  return /^MCP server ["']?mail["']? already exists(?: in (?:local|user|project) config)?\.?$/i
    .test(getErrorDetail(error));
}

async function writeBufferAtomic(filePath: string, content: Uint8Array): Promise<void> {
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function installClaudeCodeSkill(
  claudeHome: string = join(homedir(), '.claude'),
): Promise<ClaudeCodeSkillInstallResult> {
  const skillPath = join(claudeHome, 'skills', 'mail-mcp', 'SKILL.md');
  const bundledSkill = await readFile(
    new URL('../../skills/mail-mcp/SKILL.md', import.meta.url),
    'utf8',
  );

  let currentSkill: string | undefined;
  try {
    currentSkill = await readFile(skillPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (currentSkill === bundledSkill) {
    return { skillPath, changed: false };
  }

  await mkdir(dirname(skillPath), { recursive: true });
  let backupPath: string | undefined;
  if (currentSkill !== undefined) {
    backupPath = `${skillPath}.mail-mcp.bak`;
    await copyFile(skillPath, backupPath);
  }
  await writeTextFileAtomic(skillPath, bundledSkill);
  return { skillPath, backupPath, changed: true };
}

/**
 * Registers mail-mcp in Claude Code's user-scoped MCP configuration.
 *
 * This delegates normal persistence to Claude Code itself. For an upgrade,
 * the CLI reports that `mail` already exists; only then do we snapshot the
 * complete user config before remove/add and restore those exact bytes on any
 * later failure.
 */
export async function installClaudeCode(
  npxArgs: readonly string[],
  dependencies: ClaudeCodeInstallDependencies = {},
): Promise<ClaudeCodeInstallResult> {
  const command = buildClaudeCodeCommand(npxArgs, dependencies.platform);
  const run = dependencies.execFile ?? defaultExecFile;
  const configPath = dependencies.claudeConfigPath ?? join(homedir(), '.claude.json');
  const options: ClaudeCodeExecOptions = {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  };

  let registration: { stdout: string; stderr: string };
  let replacementSnapshot: Buffer | undefined;
  let configBackupPath: string | undefined;
  try {
    registration = await run(command.executable, command.args, options);
  } catch (error) {
    if (!isMailServerAlreadyExistsError(error)) {
      throw new Error(
        `Claude Code MCP installation failed without changing any existing registration: ${getErrorDetail(error)}`,
        { cause: error },
      );
    }

    try {
      replacementSnapshot = await readFile(configPath);
      configBackupPath = `${configPath}.mail-mcp.bak`;
      await copyFile(configPath, configBackupPath);
    } catch (snapshotError) {
      throw new Error(
        `Claude Code MCP replacement was aborted before removal because the user config could not be backed up: ${getErrorDetail(snapshotError)}`,
        { cause: snapshotError },
      );
    }

    try {
      await run(command.executable, [
        'mcp',
        'remove',
        CLAUDE_CODE_MCP_SERVER_NAME,
        '--scope',
        'user',
      ], options);
      registration = await run(command.executable, command.args, options);
    } catch (replacementError) {
      try {
        await writeBufferAtomic(configPath, replacementSnapshot);
      } catch (restoreError) {
        throw new Error(
          `Claude Code MCP replacement failed and the exact user config snapshot could not be restored: ${getErrorDetail(replacementError)}; restore failed: ${getErrorDetail(restoreError)}`,
          { cause: replacementError },
        );
      }
      throw new Error(
        `Claude Code MCP replacement failed; the exact user config snapshot was restored: ${getErrorDetail(replacementError)}`,
        { cause: replacementError },
      );
    }
  }

  let skill: ClaudeCodeSkillInstallResult;
  try {
    skill = await installClaudeCodeSkill(dependencies.claudeHome);
  } catch (error) {
    if (replacementSnapshot !== undefined) {
      try {
        await writeBufferAtomic(configPath, replacementSnapshot);
      } catch (restoreError) {
        throw new Error(
          `Claude Code skill installation failed and the exact user config snapshot could not be restored: ${getErrorDetail(error)}; restore failed: ${getErrorDetail(restoreError)}`,
          { cause: error },
        );
      }
      throw new Error(
        `Claude Code skill installation failed; the exact user config snapshot was restored: ${getErrorDetail(error)}`,
        { cause: error },
      );
    }

    try {
      await run(command.executable, [
        'mcp',
        'remove',
        CLAUDE_CODE_MCP_SERVER_NAME,
        '--scope',
        'user',
      ], options);
    } catch (rollbackError) {
      throw new Error(
        `Claude Code skill installation failed and the new MCP registration could not be rolled back: ${getErrorDetail(error)}; rollback failed: ${getErrorDetail(rollbackError)}`,
        { cause: error },
      );
    }
    throw new Error(
      `Claude Code skill installation failed; the new MCP registration was rolled back: ${getErrorDetail(error)}`,
      { cause: error },
    );
  }

  return {
    ...command,
    changed: true,
    skillPath: skill.skillPath,
    skillChanged: skill.changed,
    ...(skill.backupPath ? { skillBackupPath: skill.backupPath } : {}),
    ...(configBackupPath ? { configBackupPath } : {}),
    stdout: registration.stdout.trim(),
  };
}
