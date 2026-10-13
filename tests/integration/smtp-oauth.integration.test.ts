import { expect, it, vi } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
const tokenStore = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/security/oauth2.js', () => ({ getValidAccessToken: tokenStore.get }));
import { SmtpClient } from '../../src/protocol/smtp.js';

it('uses current tokens on real SMTP connections and renews a rejected token once', async () => {
  let storedToken = 'first-token';
  let acceptedToken = storedToken;
  const authTokens: string[] = [];
  let delivered = 0;
  tokenStore.get.mockImplementation(async (_account: string, renew: boolean) => {
    if (renew) storedToken = acceptedToken;
    return storedToken;
  });
  const server = new SMTPServer({
    secure: false, disabledCommands: ['STARTTLS'], authMethods: ['XOAUTH2'], allowInsecureAuth: true,
    onAuth(auth, _session, callback) {
      authTokens.push(auth.accessToken ?? '');
      callback(null, auth.accessToken === acceptedToken
        ? { user: auth.username } : { data: { status: '401', schemes: 'bearer' } });
    },
    onData(stream, _session, callback) {
      stream.resume();
      stream.on('end', () => { delivered++; callback(); });
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = ((server as unknown as { server: import('node:net').Server }).server.address() as AddressInfo).port;
  const client = new SmtpClient({ id: 'oauth-fixture', name: 'Fixture', user: 'from@example.test',
    host: '127.0.0.1', port: 993, smtpPort: port, smtpSecurity: 'plain', authType: 'oauth2', useTLS: true });
  try {
    await client.connect();
    storedToken = acceptedToken = 'second-token';
    await client.sendMessage({ to: 'to@example.test', subject: 'First', text: 'Body' });
    acceptedToken = 'third-token';
    await client.sendMessage({ to: 'to@example.test', subject: 'Second', text: 'Body' });
    expect(authTokens).toEqual(['first-token', 'second-token', 'second-token', 'third-token']);
    expect(tokenStore.get).toHaveBeenLastCalledWith('oauth-fixture', true);
    expect(delivered).toBe(2);
  } finally {
    client.disconnect();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
