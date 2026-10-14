import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZimbraLoginStore, withZimbraLoginLock } from './login-state.js';
import type { ZimbraSession } from './session.js';
import { ZimbraClient } from './client.js';

const account = { id: 'z', name: 'Z', backend: 'zimbra' as const, endpoint: 'https://mail.example.test/service/soap', user: 'me@example.test' };
const session = (expiresAt = Date.now() + 60000): ZimbraSession => ({ kind: 'zimbra-session-v1', endpoint: account.endpoint, user: account.user, authToken: 'session-secret', expiresAt });
const device = () => ({ token: 'trust-secret', deviceId: 'device', expiresAt: Date.now() + 86400000 });
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(initial: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'zimbra-login-')); dirs.push(dir);
  let raw: string | null = initial === null ? null : JSON.stringify(initial);
  const storage = { load: vi.fn(async () => raw), save: vi.fn(async (_id: string, value: string) => { raw = value; }) };
  return { login: new ZimbraLoginStore(account, storage, dir), second: new ZimbraLoginStore(account, storage, dir), storage, dir, value: () => raw ? JSON.parse(raw) : null };
}
const automatic = () => ({ kind: 'zimbra-login-v2', session: session(1), trustedDevice: device(), automaticLogin: { password: 'main-secret', blocked: false } });

describe('Zimbra protected automatic login state', () => {
  it('authenticates before dispatch and never replays a mail write whose response was lost', async () => {
    const f = await fixture(automatic());
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Body: { AuthResponse: { authToken: { _content: 'new-session' }, lifetime: 60000 } } })))
      .mockRejectedValueOnce(new Error('response lost'));
    const client: ZimbraClient = new ZimbraClient(account, { fetch, sessionProvider: () => f.login.session((password, trustedDevice) => client.authenticateWithDevice(password, undefined, { trustedDevice })) });
    await expect(client.executeWrite('deleteTag', { tagId: '7' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(fetch).toHaveBeenCalledTimes(2);
    const auth = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(auth.Body.AuthRequest).toMatchObject({ password: { _content: 'main-secret' }, trustedToken: { _content: 'trust-secret' } });
    const mutation = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(mutation.Body).toHaveProperty('TagActionRequest');
    expect(JSON.stringify(mutation)).not.toMatch(/main-secret|trust-secret/);
    expect(f.value().session.authToken).toBe('new-session');
  });
  it('uses existing legacy sessions without authentication and rejects expired legacy sessions', async () => {
    const f = await fixture(session()); const auth = vi.fn();
    expect(await f.login.session(auth)).toEqual(f.value()); expect(auth).not.toHaveBeenCalled();
    const expired = await fixture(session(1));
    await expect(expired.login.session(auth)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); expect(auth).not.toHaveBeenCalled();
  });
  it('serializes two independent callers and reloads the first persisted replacement', async () => {
    const f = await fixture(automatic());
    const auth = vi.fn(async () => {
      expect(f.value().automaticLogin.blocked).toBe(true);
      const files = await readdir(f.dir); expect(files).toHaveLength(1);
      expect(await readFile(join(f.dir, files[0]), 'utf8')).not.toMatch(/main-secret|trust-secret|session-secret/);
      return { session: session(), trustedDevice: device() };
    });
    const [a, b] = await Promise.all([f.login.session(auth), f.second.session(auth)]);
    expect(a).toEqual(b); expect(auth).toHaveBeenCalledOnce();
    expect(f.value().automaticLogin).toEqual({ password: 'main-secret', blocked: false });
    expect(await readdir(f.dir)).toEqual([]);
  });
  it.each(['authentication rejected', 'network error', 'second factor required'])('persists a blocked attempt after %s, including restart', async message => {
    const f = await fixture(automatic()); const auth = vi.fn().mockRejectedValue(new Error(message + ' main-secret'));
    await expect(f.login.session(auth)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(f.second.session(auth)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(auth).toHaveBeenCalledOnce(); expect(f.value().automaticLogin.blocked).toBe(true);
    expect(JSON.stringify(await f.login.status())).not.toMatch(/main-secret|trust-secret|session-secret/);
  });
  it('never sends the saved password when trust has expired or the attempt is blocked', async () => {
    for (const state of [{ ...automatic(), trustedDevice: { ...device(), expiresAt: 1 } }, { ...automatic(), automaticLogin: { password: 'main-secret', blocked: true } }]) {
      const f = await fixture(state); const auth = vi.fn();
      await expect(f.login.session(auth)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); expect(auth).not.toHaveBeenCalled();
    }
  });
  it('requires durable attempt persistence before authentication', async () => {
    const f = await fixture(automatic()); f.storage.save.mockRejectedValueOnce(new Error('store locked main-secret'));
    const auth = vi.fn(); await expect(f.login.session(auth)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' }); expect(auth).not.toHaveBeenCalled();
  });
  it('rejects another account or endpoint before sending credentials', async () => {
    for (const change of [{ user: 'other@example.test' }, { endpoint: 'https://other.test/service/soap' }]) {
      const f = await fixture({ ...automatic(), session: { ...session(1), ...change } }); const auth = vi.fn();
      await expect(f.login.session(auth)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); expect(auth).not.toHaveBeenCalled();
    }
  });
  it('disables automatic login without losing the current session or trust', async () => {
    const state = { ...automatic(), session: session() }; const f = await fixture(state);
    await f.login.disableAutomaticLogin();
    expect(f.value()).toEqual({ kind: state.kind, session: state.session, trustedDevice: state.trustedDevice });
    expect(await f.login.status()).toMatchObject({ automaticLogin: 'disabled', status: 'session_available' });
  });
  it('does not authenticate while inspecting an expired session', async () => {
    const f = await fixture(automatic());
    expect(await f.login.status()).toMatchObject({ automaticLogin: 'enabled', status: 'session_expired', remoteVerified: false });
    expect(f.storage.save).not.toHaveBeenCalled();
  });
  it('cannot enable saved-password login without server-issued trust', async () => {
    const f = await fixture(null);
    await expect(f.login.replace({ session: session() }, 'main-secret')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(f.storage.save).not.toHaveBeenCalled();
  });
  it('does not steal an existing lock and cleans its own lock after failure', async () => {
    const f = await fixture(null);
    await withZimbraLoginLock(account.id, async () => {
      await expect(withZimbraLoginLock(account.id, async () => undefined, f.dir, 0)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    }, f.dir);
    await expect(withZimbraLoginLock(account.id, async () => { throw new Error('failure'); }, f.dir)).rejects.toThrow('failure');
    expect(await readdir(f.dir)).toEqual([]);
  });
});
