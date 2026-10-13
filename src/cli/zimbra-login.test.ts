import { describe, expect, it, vi } from 'vitest';
import { loginZimbraAccount } from './zimbra-login.js';
import type { ZimbraClient } from '../providers/zimbra/client.js';
import { ZimbraError, ZimbraAuthChallenge } from '../providers/zimbra/session.js';
import type { ZimbraLoginStore } from '../providers/zimbra/login-state.js';
import type { ZimbraConfiguredAccount } from '../providers/account-types.js';

const account: ZimbraConfiguredAccount = { id: 'z', name: 'Z', backend: 'zimbra', user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const session = { kind: 'zimbra-session-v1' as const, authToken: 'session', endpoint: account.endpoint, user: account.user, expiresAt: Date.now() + 60000 };

describe('Local Zimbra login', () => {
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
