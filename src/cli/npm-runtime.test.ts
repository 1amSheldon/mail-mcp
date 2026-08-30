import { describe, expect, it } from 'vitest';
import {
  buildMailMcpNpxArgs,
  MAIL_MCP_LATEST_SPEC,
  NPX_RESOLUTION_ARGS,
} from './npm-runtime.js';

describe('mail-mcp npm runtime command', () => {
  it('checks npm for the latest release before starting', () => {
    expect(buildMailMcpNpxArgs(['--confirm', '--audit-log'])).toEqual([
      '-y',
      '--prefer-online',
      '@1amsheldon/mail-mcp@latest',
      '--confirm',
      '--audit-log',
    ]);
  });

  it('keeps the exported update contract stable', () => {
    expect(MAIL_MCP_LATEST_SPEC).toBe('@1amsheldon/mail-mcp@latest');
    expect(NPX_RESOLUTION_ARGS).toEqual(['-y', '--prefer-online']);
  });
});
