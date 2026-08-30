import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse } from 'smol-toml';
import { writeTextFileAtomic } from '../utils/atomic-write.js';

export const CODEX_MCP_SERVER_NAME = 'mail';

export interface CodexInstallResult {
  configPath: string;
  backupPath?: string;
  changed: boolean;
}

export interface CodexHttpServerOptions {
  url: string;
  bearerTokenEnvVar: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tableName(line: string): string | undefined {
  const match = line.match(/^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*(?:#.*)?$/);
  return match?.[1].replace(/\s*\.\s*/g, '.');
}

function isServerTable(name: string, serverName: string): boolean {
  const roots = [
    `mcp_servers.${serverName}`,
    `mcp_servers."${serverName}"`,
    `mcp_servers.'${serverName}'`,
  ];
  return roots.some((root) => name === root || name.startsWith(`${root}.`));
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

  for (const line of source.split(/\r?\n/)) {
    const header = tableName(line);
    if (header !== undefined) {
      skippingTarget = isServerTable(header, serverName);
    }
    if (!skippingTarget) {
      kept.push(line);
    }
  }

  const base = kept.join(newline).trimEnd();
  const normalizedSection = section.replace(/\n/g, newline);
  return `${base}${base === '' ? '' : `${newline}${newline}`}${normalizedSection}${newline}`;
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
      parse(source);
    } catch (error) {
      throw new Error(`Invalid existing Codex config at ${configPath}: ${(error as Error).message}`);
    }
  }

  const updated = upsertCodexServerSection(source, section, serverName);
  try {
    parse(updated);
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
