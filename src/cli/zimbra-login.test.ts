import { describe, expect, it, vi } from 'vitest';
import { loginZimbraAccount } from './zimbra-login.js';
import type { ZimbraClient } from '../providers/zimbra/client.js';
import { ZimbraError } from '../providers/zimbra/session.js';
import type { ZimbraConfiguredAccount } from '../providers/account-types.js';

const account: ZimbraConfiguredAccount = { id: 'z', name: 'Z', backend: 'zimbra', user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const session = { kind: 'zimbra-session-v1' as const, authToken: 'session', endpoint: account.endpoint, user: account.user, expiresAt: Date.now() + 60000 };

describe('Local Zimbra login', () => {
  it('stores only a completed session after a 2FA challenge', async () => {
    const authenticate = vi.fn().mockRejectedValueOnce(new ZimbraError('TWO_FACTOR_REQUIRED', '2FA')).mockResolvedValueOnce(session);
    const disconnect = vi.fn(); const save = vi.fn();
    const prompt = { secret: vi.fn().mockResolvedValueOnce('main-pass').mockResolvedValueOnce('123456'), question: vi.fn().mockResolvedValue('n'), close: vi.fn() };
    await loginZimbraAccount(account, prompt, { client: { authenticate, disconnect } as unknown as ZimbraClient, save });
    expect(authenticate.mock.calls).toEqual([['main-pass'], ['main-pass', '123456', undefined]]);
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
