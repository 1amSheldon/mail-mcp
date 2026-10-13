import { copyFile, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { writeTextFileAtomic } from '../utils/atomic-write.js';

export const CODEX_MCP_SERVER_NAME = 'mail';

export interface CodexInstallResult {
  configPath: string;
  backupPath?: string;
  changed: boolean;
}

export interface CodexSkillInstallResult {
  skillPath: string;
  backupPath?: string;
  changed: boolean;
  skipped?: string;
}

export interface CodexHttpServerOptions {
  url: string;
  bearerTokenEnvVar: string;
}

export type CodexBundleServer =
  | {
      transport: 'stdio';
      skipSkill?: boolean;
      npxArgs: readonly string[];
      serverName?: string;
    }
  | {
      transport: 'http';
      skipSkill?: boolean;
      options: CodexHttpServerOptions;
      serverName?: string;
    };

export interface CodexBundleInstallResult {
  config: CodexInstallResult;
  skill: CodexSkillInstallResult;
  rollback: () => Promise<void>;
}

interface TextFileSnapshot {
  path: string;
  content?: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function serverTable(line: string, serverName: string): boolean | undefined {
  if (!/^\s*\[/.test(line)) return undefined;
  try {
    // Let the TOML parser interpret quoted keys, escapes and table arrays.
    const parsed = parse(`${line}\n__mail_mcp_table_marker = true`);
    return Object.hasOwn((parsed.mcp_servers ?? {}) as object, serverName);
  } catch {
    return undefined;
  }
}

function advanceStringState(line: string, state: string | undefined): string | undefined {
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (!state) {
      if (character === '#') break;
      if (character !== '"' && character !== "'") continue;
      state = line.slice(index, index + 3) === character.repeat(3) ? character.repeat(3) : character;
      index += state.length - 1;
    } else {
      if (state[0] === '"' && character === '\\') { index++; continue; }
      if (state.length === 1 && character === state) { state = undefined; continue; }
      if (state.length === 3 && line.slice(index, index + 3) === state) {
        // TOML allows one or two literal quote characters immediately before
        // the closing delimiter (runs of four or five quotes).
        while (line[index + 1] === state[0]) index++;
        state = undefined;
      }
    }
  }
  return state;
}

function withoutTarget(source: string, serverName: string): unknown {
  const result = parse(source.replace(/^\uFEFF/, ''));
  const servers = result.mcp_servers;
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    delete (servers as Record<string, unknown>)[serverName];
    if (Object.keys(servers).length === 0) delete result.mcp_servers;
  }
  return result;
}

export function buildCodexServerSection(
  npxArgs: readonly string[],
  serverName: string = CODEX_MCP_SERVER_NAME
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(serverName)) {
    throw new Error(`Invalid Codex MCP server name: ${serverName}`);
  }
  if (npxArgs.length === 0) {
    throw new Error('The npx argument list must not be empty.');
  }

  const args = npxArgs.map(tomlString).join(', ');
  return [
    `[mcp_servers.${serverName}]`,
    'command = "npx"',
    `args = [${args}]`,
    'enabled = true',
    'startup_timeout_sec = 30.0',
    'tool_timeout_sec = 300.0',
  ].join('\n');
}

export function buildCodexHttpServerSection(
  options: CodexHttpServerOptions,
  serverName: string = CODEX_MCP_SERVER_NAME
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(serverName)) {
    throw new Error(`Invalid Codex MCP server name: ${serverName}`);
  }
  const url = new URL(options.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid Codex MCP server URL: ${options.url}`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.bearerTokenEnvVar)) {
    throw new Error(`Invalid bearer token environment variable: ${options.bearerTokenEnvVar}`);
  }

  return [
    `[mcp_servers.${serverName}]`,
    `url = ${tomlString(url.toString())}`,
    `bearer_token_env_var = ${tomlString(options.bearerTokenEnvVar)}`,
    'enabled = true',
    'required = true',
    'startup_timeout_sec = 15.0',
    'tool_timeout_sec = 300.0',
  ].join('\n');
}

function upsertCodexServerSection(
  source: string,
  section: string,
  serverName: string
): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const kept: string[] = [];
  let skippingTarget = false;
  let stringState: string | undefined;
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';

  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const header = stringState ? undefined : serverTable(line, serverName);
    if (header !== undefined) {
      skippingTarget = header;
    }
    stringState = advanceStringState(line, stringState);
    if (!skippingTarget) {
      kept.push(line);
    }
  }

  const base = kept.join(newline).trimEnd();
  const normalizedSection = section.replace(/\n/g, newline);
  const updated = `${bom}${base}${base === '' ? '' : `${newline}${newline}`}${normalizedSection}${newline}`;
  if (!isDeepStrictEqual(withoutTarget(source, serverName), withoutTarget(updated, serverName))) {
    throw new Error('Refusing to change Codex settings outside the requested MCP server.');
  }
  return updated;
}

export function upsertCodexServer(
  source: string,
  npxArgs: readonly string[],
  serverName: string = CODEX_MCP_SERVER_NAME
): string {
  return upsertCodexServerSection(
    source,
    buildCodexServerSection(npxArgs, serverName),
    serverName
  );
}

export function upsertCodexHttpServer(
  source: string,
  options: CodexHttpServerOptions,
  serverName: string = CODEX_MCP_SERVER_NAME
): string {
  return upsertCodexServerSection(
    source,
    buildCodexHttpServerSection(options, serverName),
    serverName
  );
}

async function installCodexSection(
  configPath: string,
  section: string,
  serverName: string
): Promise<CodexInstallResult> {
  await mkdir(dirname(configPath), { recursive: true });

  let source = '';
  let fileExists = false;
  try {
    source = await readFile(configPath, 'utf8');
    fileExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (source.trim() !== '') {
    try {
      parse(source.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new Error(`Invalid existing Codex config at ${configPath}: ${(error as Error).message}`);
    }
  }

  const updated = upsertCodexServerSection(source, section, serverName);
  try {
    parse(updated.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Generated Codex config is invalid: ${(error as Error).message}`);
  }
  if (updated === source) {
    return { configPath, changed: false };
  }

  let backupPath: string | undefined;
  if (fileExists) {
    backupPath = `${configPath}.mail-mcp.bak`;
    await copyFile(configPath, backupPath);
  }

  await writeTextFileAtomic(configPath, updated);
  return { configPath, backupPath, changed: true };
}

export async function installCodex(
  configPath: string,
  npxArgs: readonly string[],
  serverName: string = CODEX_MCP_SERVER_NAME
): Promise<CodexInstallResult> {
  return installCodexSection(
    configPath,
    buildCodexServerSection(npxArgs, serverName),
    serverName
  );
}

export async function installCodexHttp(
  configPath: string,
  options: CodexHttpServerOptions,
  serverName: string = CODEX_MCP_SERVER_NAME
): Promise<CodexInstallResult> {
  return installCodexSection(
    configPath,
    buildCodexHttpServerSection(options, serverName),
    serverName
  );
}

export async function installCodexSkill(codexHome: string, options: { skip?: boolean; replaceExisting?: boolean } = {}): Promise<CodexSkillInstallResult> {
  const skillPath = getCodexSkillPath(codexHome);
  if (options.skip) return { skillPath, changed: false, skipped: 'Skill installation disabled' };
  // Check every managed path component, including dangling links. Never follow
  // a junction into a separately managed skill repository during installation.
  for (const path of [join(codexHome, 'skills'), dirname(skillPath), skillPath]) {
    try {
      if ((await lstat(path)).isSymbolicLink()) return { skillPath, changed: false, skipped: 'Externally managed linked skill' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const bundledSkill = await readFile(
    new URL('../../skills/mail-mcp/SKILL.md', import.meta.url),
    'utf8'
  );

  let currentSkill: string | undefined;
  try {
    currentSkill = await readFile(skillPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (currentSkill === bundledSkill) {
    return { skillPath, changed: false };
  }
  if (currentSkill !== undefined && !options.replaceExisting) {
    return { skillPath, changed: false, skipped: 'Existing skill preserved; update it through its source repository or explicitly replace it' };
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

export function getCodexSkillPath(codexHome: string): string {
  return join(codexHome, 'skills', 'mail-mcp', 'SKILL.md');
}

async function snapshotTextFile(path: string): Promise<TextFileSnapshot> {
  try {
    return { path, content: await readFile(path, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path };
    }
    throw error;
  }
}

async function restoreTextFile(snapshot: TextFileSnapshot): Promise<void> {
  if (snapshot.content === undefined) {
    await rm(snapshot.path, { force: true });
    return;
  }
  await writeTextFileAtomic(snapshot.path, snapshot.content);
}

async function restoreCodexBundle(snapshots: readonly TextFileSnapshot[]): Promise<void> {
  const failures: Error[] = [];
  for (const snapshot of snapshots) {
    try {
      await restoreTextFile(snapshot);
    } catch (error) {
      failures.push(error as Error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to restore the previous Codex installation');
  }
}

export async function installCodexBundle(
  configPath: string,
  codexHome: string,
  server: CodexBundleServer
): Promise<CodexBundleInstallResult> {
  const skillPath = getCodexSkillPath(codexHome);
  const snapshots = await Promise.all([
    configPath,
    `${configPath}.mail-mcp.bak`,
  ].map(snapshotTextFile));

  const rollback = () => restoreCodexBundle(snapshots);

  try {
    const skill = await installCodexSkill(codexHome, { skip: server.skipSkill });
    // Default policy creates only absent skills. Existing/linked/skipped files
    // are never read for rollback or written by it.
    if (skill.changed) snapshots.push({ path: skillPath });
    const config = server.transport === 'http'
      ? await installCodexHttp(configPath, server.options, server.serverName)
      : await installCodex(configPath, server.npxArgs, server.serverName);

    return {
      config,
      skill,
      rollback,
    };
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error as Error, rollbackError as Error],
        'Codex installation failed and the previous files could not be fully restored'
      );
    }
    throw error;
  }
}
