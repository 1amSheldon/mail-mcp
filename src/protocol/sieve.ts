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
import { isIP } from 'node:net';

export interface SieveScript {
  name: string;
  active: boolean;
}

const CONNECTION_TIMEOUT_MS = 10_000;
interface SieveResponse { raw: Buffer; terminal: string; text: string }

export class SieveClient {
  private socket: tls.TLSSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private failure?: Error;
  /** Resolvers waiting for the next complete response */
  private waiters: Array<{ resolve: (response: SieveResponse) => void; reject: (error: Error) => void }> = [];

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly user: string,
    private readonly password: string,
    private readonly options: { ca?: tls.ConnectionOptions['ca']; timeoutMs?: number } = {},
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.failure = undefined;
    this.buffer = Buffer.alloc(0);
    try {
      await this._tlsConnect();
      // Read server greeting
      await this._readResponse();
      // Authenticate
      await this._authenticate();
    } catch (error) {
      this._fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.socket) return;
    try {
      this._send('LOGOUT\r\n');
      await this._readResponse();
    } catch {
      // Ignore errors during logout
    } finally {
      this.socket?.destroy();
      this.socket = null;
      this.buffer = Buffer.alloc(0);
      this._fail(new Error('ManageSieve disconnected'));
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
        const error = new Error(
          'ManageSieve not supported by this server (connection timeout). ' +
          'SIEVE filters require ManageSieve (RFC 5804), typically available on ' +
          'self-hosted servers but not on Gmail or Outlook.'
        );
        reject(error);
        this._fail(error);
      }, this.options.timeoutMs ?? CONNECTION_TIMEOUT_MS);

      const sock = tls.connect(
        {
          host: this.host,
          port: this.port,
          rejectUnauthorized: true,
          servername: isIP(this.host) ? undefined : this.host,
          ...(this.options.ca ? { ca: this.options.ca } : {}),
        },
        () => {
          clearTimeout(timer);
          resolve();
        }
      );

      // Accumulate incoming data into our buffer
      sock.on('data', (chunk: string | Buffer) => {
        this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (this.buffer.length > 16 * 1024 * 1024) {
          this._fail(new Error('ManageSieve response exceeds 16 MiB'));
          return;
        }
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
        this._fail(err);
      });

      sock.on('close', () => {
        clearTimeout(timer);
        const error = new Error('ManageSieve connection closed');
        reject(error);
        this._fail(error);
      });
      this.socket = sock;
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
    if (this.failure) throw this.failure;
    if (!this.socket || this.socket.destroyed) {
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
  private _readResponse(): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._fail(new Error('ManageSieve response timeout')), this.options.timeoutMs ?? CONNECTION_TIMEOUT_MS);
      const waiter = (response: SieveResponse) => {
        clearTimeout(timer);
        if (response.terminal === 'NO' || response.terminal === 'BYE') {
          reject(new Error(response.text || `ManageSieve error: ${response.terminal}`));
        } else {
          resolve(response.raw);
        }
      };

      // Try immediately in case data is already buffered
      const result = this._tryConsumeResponse();
      if (result !== null) {
        waiter(result);
      } else {
        this.waiters.push({ resolve: waiter, reject: error => { clearTimeout(timer); reject(error); } });
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
      waiter.resolve(result);
    }
  }

  /**
   * Attempt to consume a complete response from the buffer.
   * A response ends with a line starting with OK, NO, or BYE.
   * May contain literal strings: {N}\r\n followed by N bytes.
   * Returns null if the response is not yet complete.
   */
  private _tryConsumeResponse(): SieveResponse | null {
    let pos = 0;
    let logicalText = '';
    let terminal = '';
    let continuing = false;
    const buf = this.buffer;
    while (pos < buf.length) {
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd === -1) return null;
      const segment = buf.subarray(pos, lineEnd).toString('utf8');
      if (!continuing) terminal = segment.match(/^(OK|NO|BYE)(?:\s|$)/i)?.[1].toUpperCase() ?? '';
      const next = lineEnd + 2;
      // Literals can follow a status token or another string, not only occupy
      // a whole line. Their embedded CRLF and status words are opaque payload.
      const literal = segment.match(/(?:^| )\{(\d+)\+?\}$/);
      if (literal) {
        const length = Number(literal[1]);
        if (!Number.isSafeInteger(length) || length > 16 * 1024 * 1024) {
          this._fail(new Error('ManageSieve literal exceeds 16 MiB'));
          return null;
        }
        if (next + length > buf.length) return null;
        logicalText += segment.slice(0, literal.index) + buf.subarray(next, next + length).toString('utf8');
        pos = next + length;
        continuing = true;
        continue;
      }
      logicalText += segment;
      if (terminal) {
        const raw = buf.subarray(0, next);
        this.buffer = buf.subarray(next);
        return { raw, terminal, text: logicalText };
      }
      pos = next;
      logicalText = '';
      continuing = false;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Private — response parsers
  // ---------------------------------------------------------------------------

  private _parseScriptList(response: Buffer): SieveScript[] {
    const scripts: SieveScript[] = [];
    let position = 0;
    while (position < response.length) {
      if (/^OK(?:[ (\r]|$)/i.test(response.toString('utf8', position, position + 4))) break;
      const token = this._parseString(response, position);
      const end = response.indexOf('\r\n', token.end);
      if (end < 0) throw new Error('Unexpected LISTSCRIPTS response format');
      const suffix = response.toString('utf8', token.end, end).trim();
      if (suffix && suffix.toUpperCase() !== 'ACTIVE') throw new Error('Unexpected LISTSCRIPTS marker');
      scripts.push({ name: token.value, active: Boolean(suffix) });
      position = end + 2;
    }
    return scripts;
  }

  private _parseLiteralContent(response: Buffer): string {
    const token = this._parseString(response, 0);
    if (response.toString('ascii', token.end, token.end + 2) !== '\r\n') throw new Error('Unexpected GETSCRIPT response format');
    return token.value;
  }

  private _parseString(response: Buffer, start: number): { value: string; end: number } {
    if (response[start] === 0x22) {
      const bytes: number[] = [];
      for (let position = start + 1; position < response.length; position++) {
        let byte = response[position];
        if (byte === 0x22) return { value: Buffer.from(bytes).toString('utf8'), end: position + 1 };
        if (byte === 0x5c) {
          byte = response[++position];
          if (byte !== 0x22 && byte !== 0x5c) throw new Error('Invalid ManageSieve quoted escape');
        }
        if (byte === 0 || byte === 10 || byte === 13) throw new Error('Invalid ManageSieve quoted string');
        bytes.push(byte);
      }
    } else if (response[start] === 0x7b) {
      const lineEnd = response.indexOf('\r\n', start);
      if (lineEnd >= 0) {
        const match = /^\{(\d+)\+?\}$/.exec(response.toString('ascii', start, lineEnd));
        if (match) {
          const length = Number(match[1]);
          const end = lineEnd + 2 + length;
          if (Number.isSafeInteger(length) && length <= 16 * 1024 * 1024 && end <= response.length) {
            return { value: response.toString('utf8', lineEnd + 2, end), end };
          }
        }
      }
    }
    throw new Error('Unexpected ManageSieve string response format');
  }

  private _quoteString(s: string): string {
    if (/[\r\n\0]/.test(s)) throw new Error('Invalid ManageSieve script name');
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  private _fail(error: Error): void {
    this.failure ??= error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
  }
}
