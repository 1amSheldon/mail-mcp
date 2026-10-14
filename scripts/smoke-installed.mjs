import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildMailMcpNpxArgs, prepareMailMcpNpxRuntime } from '../dist/cli/npm-runtime.js';

// Exercise the actual generated npx command, including npm's package symlink.
// Initialize/list tools only: no accounts or mailbox contents are requested.
if (!process.env.npm_execpath) throw new Error('Run through npm run smoke:installed');
// Assert the build contract before npm can repair permissions during a cold install.
if (process.platform !== 'win32') await access(new URL('../dist/index.js', import.meta.url), constants.X_OK);
const home = await mkdtemp(join(tmpdir(), 'mail-mcp-install-smoke-'));
const client = new Client({ name: 'installed-package-smoke', version: '1' });
try {
  const packed = await promisify(execFile)(process.execPath, [
    process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', home,
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true });
  const tarball = join(home, JSON.parse(packed.stdout)[0].filename);
  await prepareMailMcpNpxRuntime(home);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dirname(process.env.npm_execpath), 'npx-cli.js'),
      ...buildMailMcpNpxArgs(['--read-only'], home, tarball)],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => process.stderr.write(chunk));
  await client.connect(transport, { timeout: 30_000 });
  const expected = createRequire(import.meta.url)('../package.json').version;
  if (client.getServerVersion()?.version !== expected) throw new Error('Installed command selected another package version');
  const result = await client.listTools();
  if (!result.tools.some(tool => tool.name === 'mail_query')) throw new Error('Installed package has no mail_query tool');
  console.log(JSON.stringify({ status: 'ok', mode: 'generated-npx-command', version: expected, tools: result.tools.length }));
} finally {
  await client.close();
  await rm(home, { recursive: true, force: true });
}
