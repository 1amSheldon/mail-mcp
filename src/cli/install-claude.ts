import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Writes or updates the Claude Desktop MCP server config to include mail-mcp.
 *
 * @param configPath - Absolute path to claude_desktop_config.json
 * @param binaryPath - Absolute path to the mail-mcp binary
 * @returns The configPath that was written
 * @throws {Error} If the existing config file contains malformed JSON
 */
export async function installClaude(configPath: string, binaryPath: string): Promise<string> {
  // Ensure parent directory exists
  await mkdir(dirname(configPath), { recursive: true });

  // Read existing config or start fresh
  let config: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, 'utf8');
    try {
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Malformed JSON in existing config at ${configPath}. Please fix or delete the file and try again.`
      );
    }
  } catch (err) {
    // Re-throw JSON parse errors
    if (err instanceof Error && /malformed|Malformed/.test(err.message)) {
      throw err;
    }
    // File not found or unreadable — start with empty config
    config = {};
  }

  // Merge: ensure mcpServers exists and set mail entry
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  (config.mcpServers as Record<string, unknown>).mail = { command: binaryPath };

  // Write back with 2-space indentation
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  return configPath;
}
