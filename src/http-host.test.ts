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
      serverVersion: '1.2.3',
      createSession: () => new TestMcpSession(),
    });

    const response = await fetch(host.url.replace('/mcp', '/health'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      service: 'mail-mcp',
      version: '1.2.3',
      activeSessions: 0,
    });
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

  it('recovers POST requests whose session was lost after a service restart', async () => {
    host = await startHttpHost({
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'test-token',
      recoverUnknownSessions: true,
      createSession: () => new TestMcpSession(),
    });

    const headers = {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    };
    const initialized = await fetch(host.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'restart-recovery-test', version: '1.0.0' },
        },
      }),
    });
    const oldSessionId = initialized.headers.get('mcp-session-id');
    expect(oldSessionId).toBeTruthy();
    await initialized.body?.cancel();

    const port = host.port;
    await host.close();
    host = await startHttpHost({
      host: '127.0.0.1',
      port,
      bearerToken: 'test-token',
      recoverUnknownSessions: true,
      createSession: () => new TestMcpSession(),
    });

    const recovered = await fetch(host.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': oldSessionId! },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toContain('ping_mail');

    const staleStream = await fetch(host.url, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        authorization: 'Bearer test-token',
        'mcp-protocol-version': '2025-11-25',
        'mcp-session-id': oldSessionId!,
      },
    });
    expect(staleStream.status).toBe(405);
    await staleStream.body?.cancel();

    const health = await fetch(host.url.replace('/mcp', '/health')).then(response => response.json());
    expect(health.activeSessions).toBe(0);
  });

  it('returns 400 for malformed JSON on an existing session', async () => {
    host = await startHttpHost({
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'test-token',
      createSession: () => new TestMcpSession(),
    });

    const headers = {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    };
    const initialized = await fetch(host.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'invalid-json-test', version: '1.0.0' },
        },
      }),
    });
    const sessionId = initialized.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const response = await fetch(host.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId! },
      body: '{',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: 'Invalid JSON body' },
    });
  });

  it('does not evict a session while reading an active request body', async () => {
    host = await startHttpHost({
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'test-token',
      maxSessions: 1,
      createSession: () => new TestMcpSession(),
    });

    const headers = {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    };
    const initializeBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'active-body-test', version: '1.0.0' },
      },
    });
    const initialized = await fetch(host.url, {
      method: 'POST',
      headers,
      body: initializeBody,
    });
    const sessionId = initialized.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const abortController = new AbortController();
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
    });
    const stalledRequest = fetch(host.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId! },
      body: stalledBody,
      duplex: 'half',
      signal: abortController.signal,
    } as RequestInit & { duplex: 'half' }).catch(() => undefined);

    await new Promise(resolve => setTimeout(resolve, 50));
    const secondInitialize = await fetch(host.url, {
      method: 'POST',
      headers,
      body: initializeBody,
    });

    expect(secondInitialize.status).toBe(503);
    expect(await secondInitialize.json()).toMatchObject({
      error: { message: 'Too many active MCP sessions' },
    });

    abortController.abort();
    await stalledRequest;
  });

  it('brackets an IPv6 bind address in generated URLs', async () => {
    host = await startHttpHost({
      host: '::1',
      port: 0,
      bearerToken: 'test-token',
      createSession: () => new TestMcpSession(),
    });

    expect(host.url).toMatch(/^http:\/\/\[::1\]:\d+\/mcp$/);
    const response = await fetch(host.url.replace('/mcp', '/health'));
    expect(response.status).toBe(200);
  });

  it('reserves capacity while an MCP session is initializing', async () => {
    let releaseConnect!: () => void;
    let markConnectStarted!: () => void;
    const connectGate = new Promise<void>(resolve => { releaseConnect = resolve; });
    const connectStarted = new Promise<void>(resolve => { markConnectStarted = resolve; });

    host = await startHttpHost({
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'test-token',
      maxSessions: 1,
      createSession: () => {
        const session = new TestMcpSession();
        return {
          connect: async transport => {
            markConnectStarted();
            await connectGate;
            await session.connect(transport);
          },
          shutdown: () => session.shutdown(),
        };
      },
    });

    const initialize = () => fetch(host!.url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'capacity-test', version: '1.0.0' },
        },
      }),
    });

    const first = initialize();
    await connectStarted;
    const second = await initialize();
    expect(second.status).toBe(503);
    expect(await second.json()).toMatchObject({
      error: { message: 'Too many active MCP sessions' },
    });

    releaseConnect();
    expect((await first).status).toBe(200);
  });

  it('rejects invalid session lifecycle options', async () => {
    const baseOptions = {
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'test-token',
      createSession: () => new TestMcpSession(),
    };

    await expect(startHttpHost({ ...baseOptions, sessionIdleTimeoutMs: 0 })).rejects.toThrow(
      'idle timeout must be greater than zero'
    );
    await expect(startHttpHost({ ...baseOptions, maxSessions: 1.5 })).rejects.toThrow(
      'max sessions must be a positive integer'
    );
  });

  it('makes concurrent close calls wait for the same shutdown', async () => {
    let releaseShutdown!: () => void;
    let markShutdownStarted!: () => void;
    const shutdownGate = new Promise<void>(resolve => { releaseShutdown = resolve; });
    const shutdownStarted = new Promise<void>(resolve => { markShutdownStarted = resolve; });
    const shutdownSharedResources = vi.fn(async () => {
      markShutdownStarted();
      await shutdownGate;
    });

    host = await startHttpHost({
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'test-token',
      createSession: () => new TestMcpSession(),
      shutdownSharedResources,
    });

    const firstClose = host.close();
    await shutdownStarted;
    let secondCloseFinished = false;
    const secondClose = host.close().then(() => { secondCloseFinished = true; });
    await Promise.resolve();

    expect(secondCloseFinished).toBe(false);
    expect(shutdownSharedResources).toHaveBeenCalledOnce();

    releaseShutdown();
    await Promise.all([firstClose, secondClose]);
    expect(secondCloseFinished).toBe(true);
  });

  it('drains an in-flight request before shutting down its session', async () => {
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

    const headers = {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    };
    const initialized = await fetch(host.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'shutdown-drain-test', version: '1.0.0' },
        },
      }),
    });
    const sessionId = initialized.headers.get('mcp-session-id');
    const abortController = new AbortController();
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
    });
    const stalledRequest = fetch(host.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId! },
      body: stalledBody,
      duplex: 'half',
      signal: abortController.signal,
    } as RequestInit & { duplex: 'half' }).catch(() => undefined);

    await new Promise(resolve => setTimeout(resolve, 50));
    let closeFinished = false;
    const closePromise = host.close().then(() => { closeFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(closeFinished).toBe(false);
    expect(sessions[0].shutdown).not.toHaveBeenCalled();

    abortController.abort();
    await stalledRequest;
    await closePromise;
    expect(sessions[0].shutdown).toHaveBeenCalledOnce();
  });
});
