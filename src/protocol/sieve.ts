/**
 * SieveClient — ManageSieve protocol client (RFC 5804)
 *
 * Manages server-side SIEVE email filter scripts via a raw TLS connection
 * to the ManageSieve daemon (default port 4190).
 *
 * Supported operations:
 *   connect()                    — TLS connect + PLAIN SASL auth
 *   disconnect()                 — LOGOUT + socket teardown
 *   listScripts()                — list all scripts with active marker
 *   getScript(name)              — retrieve script content
 *   putScript(name, content)     — create or replace a script
 *   deleteScript(name)           — delete a named script
 *
 * NOTE: Many providers (Gmail, Outlook) do NOT support ManageSieve.
 * Connection errors produce an informative "not supported" message.
 */

import * as tls from 'node:tls';
import { EventEmitter } from 'node:events';

export interface SieveScript {
  name: string;
  active: boolean;
}

const CONNECTION_TIMEOUT_MS = 10_000;

export class SieveClient {
  private socket: (tls.TLSSocket & EventEmitter) | null = null;
  private buffer = '';
  /** Resolvers waiting for the next complete response */
  private waiters: Array<(buf: string) => void> = [];

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly user: string,
    private readonly password: string,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    await this._tlsConnect();
    // Read server greeting
    await this._readResponse();
    // Authenticate
    await this._authenticate();
  }

  async disconnect(): Promise<void> {
    if (!this.socket) return;
    try {
      this._send('LOGOUT\r\n');
      await this._readResponse();
    } catch {
      // Ignore errors during logout
    } finally {
      this.socket.destroy();
      this.socket = null;
      this.buffer = '';
      this.waiters = [];
    }
  }

  async listScripts(): Promise<SieveScript[]> {
    this._assertConnected();
    this._send('LISTSCRIPTS\r\n');
    const response = await this._readResponse();
    return this._parseScriptList(response);
  }

  async getScript(name: string): Promise<string> {
    this._assertConnected();
    this._send(`GETSCRIPT ${this._quoteString(name)}\r\n`);
    const response = await this._readResponse();
    return this._parseLiteralContent(response);
  }

  async putScript(name: string, content: string): Promise<void> {
    this._assertConnected();
    const bytes = Buffer.byteLength(content, 'utf-8');
    // Non-synchronizing literal: {N+} means server should not send a continuation
    const cmd = `PUTSCRIPT ${this._quoteString(name)} {${bytes}+}\r\n${content}\r\n`;
    this._send(cmd);
    await this._readResponse();
  }

  async deleteScript(name: string): Promise<void> {
    this._assertConnected();
    this._send(`DELETESCRIPT ${this._quoteString(name)}\r\n`);
    await this._readResponse();
  }

  // ---------------------------------------------------------------------------
  // Private — connection
  // ---------------------------------------------------------------------------

  private _tlsConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          'ManageSieve not supported by this server (connection timeout). ' +
          'SIEVE filters require ManageSieve (RFC 5804), typically available on ' +
          'self-hosted servers but not on Gmail or Outlook.'
        ));
      }, CONNECTION_TIMEOUT_MS);

      const sock = tls.connect(
        {
          host: this.host,
          port: this.port,
          rejectUnauthorized: false, // self-signed certs common on self-hosted servers
        },
        () => {
          clearTimeout(timer);
          resolve();
        }
      );

      // Accumulate incoming data into our buffer
      sock.on('data', (chunk: string | Buffer) => {
        this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        this._drainWaiters();
      });

      sock.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const code = err.code ?? '';
        if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
          reject(new Error(
            `ManageSieve not supported by this server (${err.message}). ` +
            'SIEVE filters require ManageSieve (RFC 5804), typically available on ' +
            'self-hosted servers but not on Gmail or Outlook.'
          ));
        } else {
          reject(err);
        }
      });

      this.socket = sock as unknown as (tls.TLSSocket & EventEmitter);
    });
  }

  private async _authenticate(): Promise<void> {
    // PLAIN SASL: \0username\0password → base64
    const plain = `\0${this.user}\0${this.password}`;
    const encoded = Buffer.from(plain).toString('base64');
    this._send(`AUTHENTICATE "PLAIN" "${encoded}"\r\n`);
    await this._readResponse();
  }

  // ---------------------------------------------------------------------------
  // Private — I/O
  // ---------------------------------------------------------------------------

  private _assertConnected(): void {
    if (!this.socket) {
      throw new Error('SieveClient: not connected. Call connect() first.');
    }
  }

  private _send(data: string): void {
    this.socket!.write(data);
  }

  /**
   * Resolves when a complete response is available in the buffer.
   * Throws on NO or BYE responses.
   */
  private _readResponse(): Promise<string> {
    return new Promise((resolve, reject) => {
      const waiter = (full: string) => {
        const termMatch = full.match(/^(OK|NO|BYE)[^\r\n]*/im);
        if (!termMatch) {
          resolve(full);
          return;
        }
        const terminal = termMatch[1].toUpperCase();
        if (terminal === 'NO' || terminal === 'BYE') {
          // Extract message from last line
          const lines = full.trimEnd().split('\r\n');
          const lastLine = lines[lines.length - 1];
          const msgMatch = lastLine.match(/^(?:NO|BYE)\s+"?([^"]*)"?/i);
          const msg = msgMatch?.[1] ?? lastLine;
          reject(new Error(msg || `ManageSieve error: ${terminal}`));
        } else {
          resolve(full);
        }
      };

      // Try immediately in case data is already buffered
      const result = this._tryConsumeResponse();
      if (result !== null) {
        waiter(result);
      } else {
        this.waiters.push(waiter);
      }
    });
  }

  /**
   * Called whenever new data arrives. Checks if a complete response is ready
   * and resolves the oldest waiter if so.
   */
  private _drainWaiters(): void {
    while (this.waiters.length > 0) {
      const result = this._tryConsumeResponse();
      if (result === null) break;
      const waiter = this.waiters.shift()!;
      waiter(result);
    }
  }

  /**
   * Attempt to consume a complete response from the buffer.
   * A response ends with a line starting with OK, NO, or BYE.
   * May contain literal strings: {N}\r\n followed by N bytes.
   * Returns null if the response is not yet complete.
   */
  private _tryConsumeResponse(): string | null {
    let pos = 0;
    const buf = this.buffer;

    while (pos < buf.length) {
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd === -1) {
        // Incomplete line
        return null;
      }

      const line = buf.slice(pos, lineEnd);
      const nextPos = lineEnd + 2;

      // Check for literal string: {N} or {N+}
      const literalMatch = line.match(/^\{(\d+)\+?\}$/);
      if (literalMatch) {
        const byteCount = parseInt(literalMatch[1], 10);
        if (nextPos + byteCount > buf.length) {
          // Literal not fully received yet
          return null;
        }
        // Skip past the literal data
        pos = nextPos + byteCount;
        continue;
      }

      // Check for terminal lines
      const termMatch = line.match(/^(OK|NO|BYE)(?:\s|$)/i);
      if (termMatch) {
        const consumed = nextPos;
        const full = buf.slice(0, consumed);
        this.buffer = buf.slice(consumed);
        return full;
      }

      pos = nextPos;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Private — response parsers
  // ---------------------------------------------------------------------------

  private _parseScriptList(response: string): SieveScript[] {
    const scripts: SieveScript[] = [];
    const lines = response.split('\r\n');
    for (const line of lines) {
      // Lines: "scriptname" ACTIVE  or  "scriptname"
      const match = line.match(/^"([^"]+)"(\s+ACTIVE)?/i);
      if (match) {
        scripts.push({
          name: match[1],
          active: Boolean(match[2]),
        });
      }
    }
    return scripts;
  }

  private _parseLiteralContent(response: string): string {
    // Response: {N}\r\n<N bytes>\r\nOK\r\n
    const literalMatch = response.match(/^\{(\d+)\}\r\n/);
    if (!literalMatch) {
      throw new Error('Unexpected GETSCRIPT response format');
    }
    const byteCount = parseInt(literalMatch[1], 10);
    const contentStart = literalMatch[0].length;
    return response.slice(contentStart, contentStart + byteCount);
  }

  private _quoteString(s: string): string {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
}
