import { describe, it, expect } from 'vitest';
import { createServer } from 'node:tls';
import { readFileSync } from 'node:fs';
import { SieveClient } from '../../src/protocol/sieve.js';

// Public, test-only key. Never reuse these credentials outside the loopback test.
const key = readFileSync(new URL('../fixtures/sieve-test-key.pem', import.meta.url));
const cert = readFileSync(new URL('../fixtures/sieve-test-cert.pem', import.meta.url));

describe('ManageSieve TLS verification', () => {
  it('rejects an untrusted CA and a hostname mismatch before authentication, but accepts the trusted host', async () => {
    const received: string[] = [];
    const server = createServer({ key, cert }, socket => {
      socket.write('OK\r\n');
      socket.on('data', data => { received.push(data.toString()); socket.write('OK\r\n'); });
      socket.on('error', () => {});
    });
    server.on('tlsClientError', () => {});
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(new SieveClient('localhost', port, 'synthetic-user', 'synthetic-password').connect()).rejects.toThrow();
      await expect(new SieveClient('127.0.0.1', port, 'synthetic-user', 'synthetic-password', { ca: cert }).connect()).rejects.toThrow();
      expect(received).toEqual([]);
      const trusted = new SieveClient('localhost', port, 'synthetic-user', 'synthetic-password', { ca: cert });
      await trusted.connect();
      expect(received[0]).toMatch(/^AUTHENTICATE/);
      await trusted.disconnect();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
