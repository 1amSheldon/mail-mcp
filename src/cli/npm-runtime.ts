import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fork distribution is deliberately local until a reviewed release channel exists.
export const FORK_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const FORK_ENTRYPOINT = join(FORK_ROOT, 'dist', 'index.js');
export const MAIL_MCP_LATEST_SPEC = `file:${FORK_ROOT}`;
export const NPX_RESOLUTION_ARGS = ['-y', '--prefer-online'] as const;

export function getMailMcpNpxPrefix(home: string = homedir()): string {
  return join(home, '.cache', 'mail-mcp', 'npm-runtime');
}

export async function prepareMailMcpNpxRuntime(home: string = homedir()): Promise<string> {
  const prefix = getMailMcpNpxPrefix(home);
  await mkdir(prefix, { recursive: true });
  return prefix;
}

export function buildMailMcpNpxArgs(
  runtimeArgs: readonly string[],
  home: string = homedir()
): string[] {
  return [
    ...NPX_RESOLUTION_ARGS,
    '--prefix',
    getMailMcpNpxPrefix(home),
    `--package=${MAIL_MCP_LATEST_SPEC}`,
    'mail-mcp',
    ...runtimeArgs,
  ];
}
