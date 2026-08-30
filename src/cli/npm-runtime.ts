export const MAIL_MCP_LATEST_SPEC = '@1amsheldon/mail-mcp@latest';
export const NPX_RESOLUTION_ARGS = ['-y', '--prefer-online'] as const;

export function buildMailMcpNpxArgs(runtimeArgs: readonly string[]): string[] {
  return [...NPX_RESOLUTION_ARGS, MAIL_MCP_LATEST_SPEC, ...runtimeArgs];
}
