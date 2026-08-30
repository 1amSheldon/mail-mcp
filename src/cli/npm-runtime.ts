import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MAIL_MCP_LATEST_SPEC = '@1amsheldon/mail-mcp@latest';
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
