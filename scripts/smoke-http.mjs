import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MailMCPServer } from '../dist/index.js';
import { startHttpHost } from '../dist/http-host.js';
import { MailMCPRuntimeState } from '../dist/runtime-state.js';

const token = randomBytes(32).toString('base64url');
const runtimeState = new MailMCPRuntimeState();
const host = await startHttpHost({
  host: '127.0.0.1',
  port: 0,
  bearerToken: token,
  createSession: () => new MailMCPServer(false, undefined, undefined, true, true, runtimeState),
  shutdownSharedResources: () => runtimeState.shutdown(),
});

const transport = new StreamableHTTPClientTransport(new URL(host.url), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'mail-mcp-http-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const result = await client.listTools();
  const health = await fetch(host.url.replace('/mcp', '/health')).then(response => response.json());
  process.stdout.write(JSON.stringify({
    status: 'ok',
    transport: 'streamable-http',
    toolCount: result.tools.length,
    activeSessions: health.activeSessions,
  }));
} finally {
  await transport.terminateSession().catch(() => {});
  await client.close().catch(() => {});
  await host.close();
}
