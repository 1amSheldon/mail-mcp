import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';

export interface ClaudeInstallResult {
  configPath: string;
  backupPath?: string;
  changed: boolean;
}

export function getClaudeConfigPath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'win32') {
    if (!environment.APPDATA) {
      throw new Error('APPDATA is not set; cannot locate the Claude Desktop config');
    }
    return win32.join(environment.APPDATA, 'Claude', 'claude_desktop_config.json');
  }
  throw new Error('Claude Desktop installation is supported on macOS and Windows');
}

/**
 * Writes or updates the Claude Desktop MCP server config to include mail-mcp.
 *
 * @param configPath - Absolute path to claude_desktop_config.json
 * @param command - Executable used to start mail-mcp
 * @param args - Arguments passed to the executable
 * @throws {Error} If the existing config file contains malformed JSON
 */
export async function installClaude(
  configPath: string,
  command: string,
  args: readonly string[] = [],
): Promise<ClaudeInstallResult> {
  await mkdir(dirname(configPath), { recursive: true });

  let config: Record<string, unknown> = {};
  let source = '';
  let fileExists = false;
  try {
    source = await readFile(configPath, 'utf8');
    fileExists = true;
    try {
      const parsed = JSON.parse(source) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('root value must be an object');
      }
      config = parsed as Record<string, unknown>;
    } catch {
      throw new Error(
        `Malformed JSON in existing config at ${configPath}. Please fix or delete the file and try again.`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }
  (config.mcpServers as Record<string, unknown>).mail = {
    command,
    ...(args.length > 0 ? { args: [...args] } : {}),
  };

  const updated = `${JSON.stringify(config, null, 2)}\n`;
  if (updated === source) {
    return { configPath, changed: false };
  }

  let backupPath: string | undefined;
  if (fileExists) {
    backupPath = `${configPath}.mail-mcp.bak`;
    await copyFile(configPath, backupPath);
  }

  await writeFile(configPath, updated, 'utf8');

  return { configPath, backupPath, changed: true };
}
