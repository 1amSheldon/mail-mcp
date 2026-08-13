// Created by RxGroup on 13.08.2026. Copyright (c) 2026 RX Group. All rights reserved.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHttpHost, type HttpHostController } from './http-host.js';

class TestMcpSession {
  private readonly server = new Server(
    { name: 'mail-mcp-http-test', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  readonly shutdown = vi.fn(async () => {
    await this.server.close();
  });

  constructor() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{
        name: 'ping_mail',
        description: 'Test tool',
        inputSchema: { type: 'object', properties: {} },
      }],
    }));
  }

  async connect(transport: StreamableHTTPServerTransport): Promise<void> {
    await this.server.connect(transport);
  }
}

describe('Streamable HTTP host', () => {
  let host: HttpHostController | undefined;

  afterEach(async () => {
    await host?.close();
    host = undefined;
  });

  it('serves health without exposing mailbox data', async () => {
    host = await startHttpHost({
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'test-token',
      createSession: () => new TestMcpSession(),
    });

    const response = await fetch(host.url.replace('/mcp', '/health'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', activeSessions: 0 });
  });

  it('rejects MCP calls without the bearer token', async () => {
    host = await startHttpHost({
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'test-token',
      createSession: () => new TestMcpSession(),
    });

    const response = await fetch(host.url, { method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('supports authenticated MCP initialization and tool listing', async () => {
    const sessions: TestMcpSession[] = [];
    host = await startHttpHost({
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'test-token',
      createSession: () => {
        const session = new TestMcpSession();
        sessions.push(session);
        return session;
      },
    });

    const transport = new StreamableHTTPClientTransport(new URL(host.url), {
      requestInit: { headers: { authorization: 'Bearer test-token' } },
    });
    const client = new Client({ name: 'mail-mcp-http-test-client', version: '1.0.0' });

    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.map(tool => tool.name)).toContain('ping_mail');
    expect(sessions).toHaveLength(1);

    await transport.terminateSession();
    await client.close();

    const health = await fetch(host.url.replace('/mcp', '/health')).then(response => response.json());
    expect(health.activeSessions).toBe(0);
  });
});
