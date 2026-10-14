import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
const expected = createRequire(import.meta.url)('../package.json').version;
const npmEnvironment = {
  ...getDefaultEnvironment(),
  npm_config_cache: join(home, 'npm-cache'),
  npm_config_userconfig: join(home, 'unused.npmrc'),
};
const npxCli = join(dirname(process.env.npm_execpath), 'npx-cli.js');
try {
  const packed = await promisify(execFile)(process.execPath, [
    process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', home,
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true });
  const tarball = join(home, JSON.parse(packed.stdout)[0].filename);
  await prepareMailMcpNpxRuntime(home);
  // Cold dependency downloads are package preparation, not MCP initialization.
  // Use a fresh cache and the same generated command outside the checkout for
  // both phases. The protocol still has its own unchanged 30-second deadline.
  const preparationStarted = performance.now();
  console.log('Preparing the packed package in a fresh npm cache (120-second limit).');
  const prepared = await promisify(execFile)(process.execPath, [
    npxCli, ...buildMailMcpNpxArgs(['--version'], home, tarball),
  ], { cwd: home, env: npmEnvironment, windowsHide: true, timeout: 120_000 });
  if (prepared.stdout.trim() !== expected) throw new Error('Package preparation selected another version');
  const preparationMs = Math.round(performance.now() - preparationStarted);
  console.log(`Packed package prepared in ${preparationMs} ms; starting the 30-second MCP initialization check.`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [npxCli,
      ...buildMailMcpNpxArgs(['--read-only'], home, tarball)],
    cwd: home,
    env: npmEnvironment,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => process.stderr.write(chunk));
  const initializationStarted = performance.now();
  await client.connect(transport, { timeout: 30_000 });
  const initializationMs = Math.round(performance.now() - initializationStarted);
  if (client.getServerVersion()?.version !== expected) throw new Error('Installed command selected another package version');
  const result = await client.listTools();
  if (!result.tools.some(tool => tool.name === 'mail_query')) throw new Error('Installed package has no mail_query tool');
  console.log(JSON.stringify({ status: 'ok', mode: 'generated-npx-command', version: expected,
    tools: result.tools.length, freshCache: true, preparationMs, initializationMs }));
} finally {
  await client.close();
  await rm(home, { recursive: true, force: true });
}
