import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;

export interface HostedMcpSession {
  connect(transport: StreamableHTTPServerTransport): Promise<void>;
  shutdown(): Promise<void>;
}

export interface HttpHostOptions {
  host: string;
  port: number;
  bearerToken: string;
  createSession: () => HostedMcpSession;
  shutdownSharedResources?: () => Promise<void>;
  sessionIdleTimeoutMs?: number;
  maxSessions?: number;
}

export interface HttpHostController {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

interface ActiveSession {
  id?: string;
  transport: StreamableHTTPServerTransport;
  server: HostedMcpSession;
  closePromise?: Promise<void>;
  activeRequests: number;
  lastUsedAt: number;
}

function json(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, statusCode: number, message: string): void {
  json(res, statusCode, {
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

function hasValidBearer(req: IncomingMessage, bearerToken: string): boolean {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return false;
  }

  const supplied = Buffer.from(authorization.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(bearerToken, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sessionIdFrom(req: IncomingMessage): string | undefined {
  const value = req.headers['mcp-session-id'];
  return Array.isArray(value) ? value[0] : value;
}

function formatUrlHost(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host;
  return host.includes(':') ? `[${host}]` : host;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error('REQUEST_TOO_LARGE');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function respondToBodyError(res: ServerResponse, error: unknown): void {
  if (error instanceof Error && error.message === 'REQUEST_TOO_LARGE') {
    rpcError(res, 413, 'Request body is too large');
    return;
  }
  rpcError(res, 400, 'Invalid JSON body');
}

export async function startHttpHost(options: HttpHostOptions): Promise<HttpHostController> {
  if (!options.bearerToken) {
    throw new Error('HTTP bearer token is required');
  }
  if (
    options.sessionIdleTimeoutMs !== undefined &&
    (!Number.isFinite(options.sessionIdleTimeoutMs) || options.sessionIdleTimeoutMs <= 0)
  ) {
    throw new Error('HTTP session idle timeout must be greater than zero');
  }
  if (
    options.maxSessions !== undefined &&
    (!Number.isInteger(options.maxSessions) || options.maxSessions <= 0)
  ) {
    throw new Error('HTTP max sessions must be a positive integer');
  }

  const sessions = new Map<string, ActiveSession>();
  const startedAt = new Date().toISOString();
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const urlHost = formatUrlHost(options.host);
  let shuttingDown = false;
  let closePromise: Promise<void> | undefined;

  const closeSession = (record: ActiveSession): Promise<void> => {
    if (record.closePromise) return record.closePromise;

    record.closePromise = (async () => {
      if (record.id) sessions.delete(record.id);
      record.transport.onclose = undefined;
      await Promise.allSettled([
        record.server.shutdown(),
        record.transport.close(),
      ]);
    })();
    return record.closePromise;
  };

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - sessionIdleTimeoutMs;
    for (const record of sessions.values()) {
      if (record.activeRequests === 0 && record.lastUsedAt < cutoff) {
        void closeSession(record);
      }
    }
  }, Math.min(sessionIdleTimeoutMs, 60_000));
  cleanupTimer.unref();

  const httpServer = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', `http://${urlHost}`).pathname;

    if (pathname === '/health' && req.method === 'GET') {
      json(res, shuttingDown ? 503 : 200, {
        status: shuttingDown ? 'stopping' : 'ok',
        activeSessions: sessions.size,
        startedAt,
      });
      return;
    }

    if (pathname !== '/mcp') {
      json(res, 404, { error: 'Not found' });
      return;
    }

    if (!hasValidBearer(req, options.bearerToken)) {
      res.setHeader('www-authenticate', 'Bearer');
      rpcError(res, 401, 'Unauthorized');
      return;
    }

    if (shuttingDown) {
      rpcError(res, 503, 'Server is shutting down');
      return;
    }

    try {
      const id = sessionIdFrom(req);
      let record = id ? sessions.get(id) : undefined;

      if (!record && req.method === 'POST' && !id) {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          respondToBodyError(res, error);
          return;
        }

        if (!isInitializeRequest(body)) {
          rpcError(res, 400, 'Missing MCP session or initialize request');
          return;
        }

        if (sessions.size >= maxSessions) {
          const oldestIdle = Array.from(sessions.values())
            .filter(session => session.activeRequests === 0)
            .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
          if (!oldestIdle) {
            rpcError(res, 503, 'Too many active MCP sessions');
            return;
          }
          await closeSession(oldestIdle);
        }

        const mcpServer = options.createSession();
        const sessionId = randomUUID();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
        });
        record = {
          id: sessionId,
          transport,
          server: mcpServer,
          activeRequests: 1,
          lastUsedAt: Date.now(),
        };
        sessions.set(sessionId, record);
        transport.onclose = () => {
          void closeSession(record!);
        };

        try {
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, body);
        } catch (error) {
          await closeSession(record);
          throw error;
        } finally {
          record.activeRequests--;
          record.lastUsedAt = Date.now();
        }
        return;
      }

      if (!record) {
        rpcError(res, id ? 404 : 400, id ? 'Unknown MCP session' : 'Missing MCP session');
        return;
      }

      if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
        res.setHeader('allow', 'GET, POST, DELETE');
        rpcError(res, 405, 'Method not allowed');
        return;
      }

      record.activeRequests++;
      record.lastUsedAt = Date.now();
      try {
        let body: unknown;
        if (req.method === 'POST') {
          try {
            body = await readJsonBody(req);
          } catch (error) {
            respondToBodyError(res, error);
            return;
          }
        }
        await record.transport.handleRequest(req, res, body);
      } finally {
        record.activeRequests--;
        record.lastUsedAt = Date.now();
      }
    } catch (error) {
      console.error('[HTTP MCP Error]', error instanceof Error ? error.message : String(error));
      rpcError(res, 500, 'Internal server error');
    }
  });

  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 60_000;
  httpServer.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(options.port, options.host);
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not determine HTTP listener address');
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    shuttingDown = true;
    closePromise = (async () => {
      clearInterval(cleanupTimer);

      await Promise.allSettled(Array.from(sessions.values()).map(closeSession));
      await options.shutdownSharedResources?.();

      await new Promise<void>(resolve => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
    })();
    return closePromise;
  };

  return {
    host: options.host,
    port: address.port,
    url: `http://${urlHost}:${address.port}/mcp`,
    close,
  };
}
