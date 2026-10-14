import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('../../security/keychain.js', () => ({ loadCredentials: mocks.load, saveZimbraSessionCredentials: mocks.save }));
import { readZimbraSession, saveZimbraSession } from './session.js';
const account = { id: 'z', name: 'Zimbra', backend: 'zimbra' as const, endpoint: 'https://mail.example.test/service/soap', user: 'me@example.test' };
const session = () => ({ kind: 'zimbra-session-v1' as const, endpoint: account.endpoint, user: account.user, expiresAt: Date.now() + 60000, authToken: 'secret' });
describe('Zimbra persisted sessions', () => {
  it('loads the latest login on every operation without restarting the runtime', async () => {
    mocks.load.mockResolvedValueOnce(JSON.stringify(session())).mockResolvedValueOnce(JSON.stringify({ ...session(), authToken: 'new-session' }));
    expect((await readZimbraSession(account)).authToken).toBe('secret');
    expect((await readZimbraSession(account)).authToken).toBe('new-session');
  });
  it.each([null, 'bad JSON', JSON.stringify({ ...session(), user: 'other' }), JSON.stringify({ ...session(), expiresAt: 1 }), JSON.stringify({ ...session(), password: 'extra' })])('rejects missing, mismatched, expired or secret-bearing sessions', async raw => {
    mocks.load.mockResolvedValue(raw);
    await expect(readZimbraSession(account)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('stores sessions in the existing credential store only', async () => {
    const value = session(); await saveZimbraSession(account.id, value);
    expect(mocks.save.mock.calls[0][0]).toBe('z');
    expect(JSON.parse(mocks.save.mock.calls[0][1])).toEqual(value);
  });
});
