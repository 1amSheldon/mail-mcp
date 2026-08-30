import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMailMcpNpxArgs,
  getMailMcpNpxPrefix,
  MAIL_MCP_LATEST_SPEC,
  NPX_RESOLUTION_ARGS,
  prepareMailMcpNpxRuntime,
} from './npm-runtime.js';

describe('mail-mcp npm runtime command', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
  });

  it('checks npm for the latest release before starting', () => {
    const home = 'C:\\Users\\test';
    expect(buildMailMcpNpxArgs(['--confirm', '--audit-log'], home)).toEqual([
      '-y',
      '--prefer-online',
      '--prefix',
      getMailMcpNpxPrefix(home),
      '--package=@1amsheldon/mail-mcp@latest',
      'mail-mcp',
      '--confirm',
      '--audit-log',
    ]);
  });

  it('keeps the exported update contract stable', () => {
    expect(MAIL_MCP_LATEST_SPEC).toBe('@1amsheldon/mail-mcp@latest');
    expect(NPX_RESOLUTION_ARGS).toEqual(['-y', '--prefer-online']);
  });

  it('creates the isolated npm prefix before the client uses it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mail-mcp-npx-home-'));
    tempDirs.push(home);

    const prefix = await prepareMailMcpNpxRuntime(home);

    expect(prefix).toBe(getMailMcpNpxPrefix(home));
    expect((await stat(prefix)).isDirectory()).toBe(true);
  });
});
