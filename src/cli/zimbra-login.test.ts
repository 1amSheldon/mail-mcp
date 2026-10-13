import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginZimbraAccount } from './zimbra-login.js';
import type { ZimbraClient } from '../providers/zimbra/client.js';
import { ZimbraError, ZimbraAuthChallenge } from '../providers/zimbra/session.js';
import { ZimbraLoginStore } from '../providers/zimbra/login-state.js';
import type { ZimbraConfiguredAccount } from '../providers/account-types.js';

const account: ZimbraConfiguredAccount = { id: 'z', name: 'Z', backend: 'zimbra', user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const session = { kind: 'zimbra-session-v1' as const, authToken: 'session', endpoint: account.endpoint, user: account.user, expiresAt: Date.now() + 60000 };

describe('Local Zimbra login', () => {
  it.each([false, true])('tries fresh local OTP once after saved trust is rejected (fresh login fails=%s)', async fails => {
    const oldTrust = { token: 'revoked-token', deviceId: 'old-device', expiresAt: Date.now() + 86400000 };
    const freshTrust = { ...oldTrust, token: 'fresh-token', deviceId: 'fresh-device' };
    const failure = new ZimbraError('AUTH_FAILED', 'Authentication rejected');
    const authenticateWithDevice = vi.fn().mockRejectedValueOnce(failure);
    if (fails) authenticateWithDevice.mockRejectedValueOnce(failure);
    else authenticateWithDevice.mockResolvedValueOnce({ session, trustedDevice: freshTrust });
    const replace = vi.fn(); const disconnect = vi.fn();
    const store = { lock: async (fn: () => Promise<void>) => fn(), replace,
      read: vi.fn().mockResolvedValue({ kind: 'zimbra-login-v2', session, trustedDevice: oldTrust }) } as unknown as ZimbraLoginStore;
    const prompt = { secret: vi.fn().mockResolvedValueOnce('typed-password').mockResolvedValueOnce('123456'), question: vi.fn().mockResolvedValue('n'), close: vi.fn() };
    const login = loginZimbraAccount(account, prompt, { trustedDevice: true, store, client: { authenticateWithDevice, disconnect } as unknown as ZimbraClient });
    if (fails) {
      await expect(login).rejects.toBe(failure);
      expect(replace).not.toHaveBeenCalled(); expect(prompt.question).not.toHaveBeenCalled();
    } else {
      await login;
      expect(replace).toHaveBeenCalledWith({ session, trustedDevice: freshTrust }, undefined);
    }
    expect(authenticateWithDevice.mock.calls).toEqual([
      ['typed-password', undefined, { trustedDevice: oldTrust }],
      ['typed-password', '123456', { register: true }],
    ]);
    expect(prompt.secret).toHaveBeenCalledTimes(2); expect(disconnect).toHaveBeenCalledOnce();
  });
  it.each(['absent', 'expired', 'network failure'])('does not retry authentication for %s trust', async scenario => {
    const trustedDevice = { token: 'old-token', deviceId: 'old-device', expiresAt: scenario === 'expired' ? 1 : Date.now() + 86400000 };
    const failure = new ZimbraError(scenario === 'network failure' ? 'PROVIDER_ERROR' : 'AUTH_FAILED', 'Login failed');
    const authenticateWithDevice = vi.fn().mockRejectedValue(failure); const replace = vi.fn();
    const store = { lock: async (fn: () => Promise<void>) => fn(), replace,
      read: vi.fn().mockResolvedValue(scenario === 'absent' ? undefined : { kind: 'zimbra-login-v2', session, trustedDevice }) } as unknown as ZimbraLoginStore;
    const prompt = { secret: vi.fn().mockResolvedValue('typed-password'), question: vi.fn(), close: vi.fn() };
    await expect(loginZimbraAccount(account, prompt, { trustedDevice: true, store, client: { authenticateWithDevice, disconnect: vi.fn() } as unknown as ZimbraClient })).rejects.toBe(failure);
    expect(authenticateWithDevice).toHaveBeenCalledOnce(); expect(prompt.secret).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled(); expect(prompt.question).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    // Interactive-flow tests must never acquire locks in the real user profile.
    vi.spyOn(ZimbraLoginStore.prototype, 'lock').mockImplementation(async action => action());
  });
  afterEach(() => vi.restoreAllMocks());
  it.each([
    ['malformed JSON', '{broken'],
    ['invalid schema', JSON.stringify({ kind: 'zimbra-login-v2' })],
    ['another endpoint', JSON.stringify({ ...session, endpoint: 'https://other.example.test/service/soap' })],
    ['another user', JSON.stringify({ ...session, user: 'other@example.test' })],
  ])('repairs %s using fresh local authentication without reusing stored trust', async (_name, raw) => {
    const save = vi.fn().mockResolvedValue(undefined);
    const store = new ZimbraLoginStore(account, { load: vi.fn().mockResolvedValue(raw), save });
    const trust = { token: 'fresh-trust', deviceId: 'fresh-device', expiresAt: Date.now() + 86400000 };
    const authenticateWithDevice = vi.fn().mockRejectedValueOnce(new ZimbraAuthChallenge(true))
      .mockResolvedValueOnce({ session, trustedDevice: trust });
    const prompt = { secret: vi.fn().mockResolvedValueOnce('fresh-password').mockResolvedValueOnce('123456'), question: vi.fn().mockResolvedValue('n'), close: vi.fn() };
    await loginZimbraAccount(account, prompt, { trustedDevice: true, store, client: { authenticateWithDevice, disconnect: vi.fn() } as unknown as ZimbraClient });
    expect(authenticateWithDevice.mock.calls).toEqual([
      ['fresh-password', undefined, { register: true }],
      ['fresh-password', '123456', { register: true }],
    ]);
    expect(JSON.parse(save.mock.calls[0][1])).toEqual({ kind: 'zimbra-login-v2', session, trustedDevice: trust });
    expect(JSON.stringify(save.mock.calls)).not.toMatch(/fresh-password|123456/);
  });
  it.each([new Error('keychain unavailable'), new ZimbraError('AUTH_REQUIRED', 'Protected backend unavailable')])('does not hide operational storage failures during local recovery (%s)', async error => {
    const save = vi.fn();
    const store = new ZimbraLoginStore(account, { load: vi.fn().mockRejectedValue(error), save });
    const authenticateWithDevice = vi.fn(); const disconnect = vi.fn();
    const prompt = { secret: vi.fn().mockResolvedValue('fresh-password'), question: vi.fn(), close: vi.fn() };
    await expect(loginZimbraAccount(account, prompt, { trustedDevice: true, store, client: { authenticateWithDevice, disconnect } as unknown as ZimbraClient })).rejects.toBe(error);
    expect(authenticateWithDevice).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it.each(['n', 'y'])('stores the main password only after explicit trusted-device consent (%s)', async consent => {
    const trust = { token: 'trust', deviceId: 'device', expiresAt: Date.now() + 86400000 };
    const authenticateWithDevice = vi.fn().mockRejectedValueOnce(new ZimbraAuthChallenge(true)).mockResolvedValueOnce({ session, trustedDevice: trust });
    const replace = vi.fn(); const read = vi.fn().mockResolvedValue(undefined);
    const store = { lock: async (fn: () => Promise<void>) => fn(), replace, read } as unknown as ZimbraLoginStore;
    const prompt = { secret: vi.fn().mockResolvedValueOnce('main-pass').mockResolvedValueOnce('123456'), question: vi.fn().mockResolvedValue(consent), close: vi.fn() };
    await loginZimbraAccount(account, prompt, { trustedDevice: true, store, client: { authenticateWithDevice, disconnect: vi.fn() } as unknown as ZimbraClient });
    expect(replace).toHaveBeenCalledWith({ session, trustedDevice: trust }, consent === 'y' ? 'main-pass' : undefined);
    expect(JSON.stringify(replace.mock.calls)).not.toContain('123456');
    expect(authenticateWithDevice.mock.calls).toEqual([['main-pass', undefined, { register: true }], ['main-pass', '123456', { register: true }]]);
  });
  it('does not offer password storage if the server disables trusted devices', async () => {
    const authenticateWithDevice = vi.fn().mockRejectedValueOnce(new ZimbraAuthChallenge(false)).mockResolvedValueOnce({ session });
    const replace = vi.fn();
    const store = { lock: async (fn: () => Promise<void>) => fn(), replace, read: vi.fn().mockResolvedValue(undefined) } as unknown as ZimbraLoginStore;
    const prompt = { secret: vi.fn().mockResolvedValueOnce('main-pass').mockResolvedValueOnce('123456'), question: vi.fn(), close: vi.fn() };
    await loginZimbraAccount(account, prompt, { trustedDevice: true, store, client: { authenticateWithDevice, disconnect: vi.fn() } as unknown as ZimbraClient });
    expect(prompt.question).not.toHaveBeenCalled(); expect(replace).toHaveBeenCalledWith({ session }, undefined);
    expect(authenticateWithDevice.mock.calls[1]).toEqual(['main-pass', '123456', undefined]);
  });
  it.each(['n', 'y'])('stores only a completed session after a 2FA challenge (backup=%s)', async backup => {
    const authenticate = vi.fn().mockRejectedValueOnce(new ZimbraError('TWO_FACTOR_REQUIRED', '2FA')).mockResolvedValueOnce(session);
    const disconnect = vi.fn(); const save = vi.fn();
    const prompt = { secret: vi.fn().mockResolvedValueOnce('main-pass').mockResolvedValueOnce('123456'), question: vi.fn().mockResolvedValue(backup), close: vi.fn() };
    await loginZimbraAccount(account, prompt, { client: { authenticate, disconnect } as unknown as ZimbraClient, save });
    expect(authenticate.mock.calls).toEqual([['main-pass'], ['main-pass', '123456']]);
    expect(save).toHaveBeenCalledWith('z', session);
    expect(JSON.stringify(save.mock.calls)).not.toMatch(/main-pass|123456/);
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it('keeps the old stored session untouched when authentication fails', async () => {
    const authenticate = vi.fn().mockRejectedValue(new ZimbraError('AUTH_FAILED', 'failed'));
    const save = vi.fn(); const disconnect = vi.fn();
    await expect(loginZimbraAccount(account, { secret: vi.fn().mockResolvedValue('wrong'), question: vi.fn(), close: vi.fn() },
      { client: { authenticate, disconnect } as unknown as ZimbraClient, save })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(save).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalledOnce();
  });
});
