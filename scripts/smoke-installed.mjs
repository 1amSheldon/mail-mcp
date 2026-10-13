import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { buildMailMcpNpxArgs, prepareMailMcpNpxRuntime } from '../dist/cli/npm-runtime.js';

// Exercise the actual generated npx command, including npm's package symlink.
// Initialize/list tools only: no accounts or mailbox contents are requested.
if (!process.env.npm_execpath) throw new Error('Run through npm run smoke:installed');
const home = await mkdtemp(join(tmpdir(), 'mail-mcp-install-smoke-'));
await prepareMailMcpNpxRuntime(home);
const client = new Client({ name: 'installed-fork-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(dirname(process.env.npm_execpath), 'npx-cli.js'), ...buildMailMcpNpxArgs(['--read-only'], home)],
  stderr: 'pipe',
});
transport.stderr?.on('data', chunk => process.stderr.write(chunk));
try {
  await client.connect(transport, { timeout: 30_000 });
  const expected = createRequire(import.meta.url)('../package.json').version;
  if (client.getServerVersion()?.version !== expected) throw new Error('Installed command selected another package version');
  const result = await client.listTools();
  if (!result.tools.some(tool => tool.name === 'mail_query')) throw new Error('Installed fork has no mail_query tool');
  console.log(JSON.stringify({ status: 'ok', mode: 'generated-npx-command', version: expected, tools: result.tools.length }));
} finally {
  await client.close();
  await rm(home, { recursive: true, force: true });
}
