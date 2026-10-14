import { beforeEach, describe, it, expect, vi } from 'vitest';
import { saveCredentials, loadCredentials, removeCredentials, saveProtectedCredentials, removeZimbraCredentials, saveZimbraSessionCredentials } from './keychain.js';
import { config, DEFAULT_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE } from '../config.js';

// Mock cross-keychain if not available in environment
vi.mock('cross-keychain', () => ({
  setPassword: vi.fn(),
  getPassword: vi.fn(),
  deletePassword: vi.fn(),
  getKeyring: vi.fn(),
}));

import { setPassword, getPassword, deletePassword, getKeyring } from 'cross-keychain';

describe('keychain service', () => {
  it.each(['windows', 'macos', 'file', 'null'])('refuses main-password storage through %s fallback', async id => {
    const save = vi.fn(); vi.mocked(getKeyring).mockResolvedValue({ id, setPassword: save, getPassword: vi.fn().mockResolvedValue(null) } as any);
    await expect(saveProtectedCredentials('z', 'private-main-password')).rejects.toThrow('protected system credential storage');
    expect(save).not.toHaveBeenCalled(); expect(setPassword).not.toHaveBeenCalled();
  });
  it.each(['native-windows', 'native-macos', 'native-linux', 'secret-service'])('uses the inspected protected backend %s directly', async id => {
    const save = vi.fn(); vi.mocked(getKeyring).mockResolvedValue({ id, setPassword: save, getPassword: vi.fn().mockResolvedValue(null) } as any);
    await saveProtectedCredentials('z', 'private-main-password');
    expect(save).toHaveBeenCalledWith(DEFAULT_KEYCHAIN_SERVICE, 'z', 'private-main-password');
    expect(setPassword).not.toHaveBeenCalled();
  });
  const accountId = 'test-account';
  const secret = 'test-password';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves credentials', async () => {
    await saveCredentials(accountId, secret);
    expect(setPassword).toHaveBeenCalledWith(DEFAULT_KEYCHAIN_SERVICE, accountId, secret);
  });

  it('loads credentials', async () => {
    (getPassword as any).mockResolvedValue(secret);
    const result = await loadCredentials(accountId);
    expect(result).toBe(secret);
    expect(getPassword).toHaveBeenCalledWith(DEFAULT_KEYCHAIN_SERVICE, accountId);
    expect(getPassword).toHaveBeenCalledTimes(1);
  });

  it('reads legacy credentials without copying them', async () => {
    (getPassword as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(secret);

    const result = await loadCredentials(accountId);

    expect(result).toBe(secret);
    expect(getPassword).toHaveBeenNthCalledWith(1, DEFAULT_KEYCHAIN_SERVICE, accountId);
    expect(getPassword).toHaveBeenNthCalledWith(2, LEGACY_KEYCHAIN_SERVICE, accountId);
    expect(setPassword).not.toHaveBeenCalled();
  });

  it('removes credentials', async () => {
    await removeCredentials(accountId);
    expect(deletePassword).toHaveBeenCalledOnce();
    expect(deletePassword).toHaveBeenCalledWith(DEFAULT_KEYCHAIN_SERVICE, accountId);
  });

  function backendFixture() {
    const values = new Map([[DEFAULT_KEYCHAIN_SERVICE, 'current-password'], [LEGACY_KEYCHAIN_SERVICE, 'legacy-password']]);
    const backend = {
      id: 'native-windows',
      getPassword: vi.fn(async (service: string) => values.get(service) ?? null),
      setPassword: vi.fn(async (service: string, _id: string, value: string) => { values.set(service, value); }),
      deletePassword: vi.fn(async (service: string) => { values.delete(service); }),
    };
    vi.mocked(getKeyring).mockResolvedValue(backend as any);
    return { backend, values };
  }

  it('removes both reachable Zimbra entries, legacy first, and verifies absence', async () => {
    const { backend, values } = backendFixture();
    await removeZimbraCredentials(accountId);
    expect(values.size).toBe(0);
    expect(backend.deletePassword.mock.calls.map(call => call[0])).toEqual([LEGACY_KEYCHAIN_SERVICE, DEFAULT_KEYCHAIN_SERVICE]);
    expect(backend.getPassword).toHaveBeenCalledTimes(4);
  });

  it('detects a no-op/false deletion and retains current credentials', async () => {
    const { backend, values } = backendFixture();
    backend.deletePassword.mockImplementation(async () => false as any);
    await expect(removeZimbraCredentials(accountId)).rejects.toThrow('Cannot verify removal');
    expect(values.get(DEFAULT_KEYCHAIN_SERVICE)).toBe('current-password');
    expect(backend.deletePassword).toHaveBeenCalledTimes(1);
  });

  it('detects silent failure deleting the current entry after legacy cleanup succeeds', async () => {
    const { backend, values } = backendFixture();
    backend.deletePassword.mockImplementation(async service => {
      if (service === LEGACY_KEYCHAIN_SERVICE) values.delete(service);
    });
    await expect(removeZimbraCredentials(accountId)).rejects.toThrow('Cannot verify removal');
    expect(values.has(LEGACY_KEYCHAIN_SERVICE)).toBe(false);
    expect(values.get(DEFAULT_KEYCHAIN_SERVICE)).toBe('current-password');
  });

  it.each(['read', 'delete'])('sanitizes %s failures without removing the current credential', async operation => {
    const { backend, values } = backendFixture();
    if (operation === 'read') backend.getPassword.mockRejectedValueOnce(new Error('sensitive backend data'));
    else backend.deletePassword.mockRejectedValueOnce(new Error('sensitive backend data'));
    await expect(removeZimbraCredentials(accountId)).rejects.toThrow('Cannot verify removal of Zimbra credentials; account configuration was retained.');
    expect(values.get(DEFAULT_KEYCHAIN_SERVICE)).toBe('current-password');
  });

  it.each([saveProtectedCredentials, saveZimbraSessionCredentials])('clears legacy saved-password state when replacing a Zimbra credential', async save => {
    const { values } = backendFixture();
    await save(accountId, 'session-without-password');
    expect(values.get(DEFAULT_KEYCHAIN_SERVICE)).toBe('session-without-password');
    expect(values.has(LEGACY_KEYCHAIN_SERVICE)).toBe(false);
  });

  it.each([saveProtectedCredentials, saveZimbraSessionCredentials])('does not claim replacement succeeded when legacy cleanup fails', async save => {
    const { backend, values } = backendFixture();
    backend.deletePassword.mockImplementation(async () => undefined);
    await expect(save(accountId, 'session-without-password')).rejects.toThrow('legacy');
    expect(values.get(DEFAULT_KEYCHAIN_SERVICE)).toBe('session-without-password');
    expect(values.has(LEGACY_KEYCHAIN_SERVICE)).toBe(true);
  });

  it('does not touch legacy credentials outside the configured fallback namespace', async () => {
    const { backend, values } = backendFixture();
    const original = config.serviceName;
    try {
      config.serviceName = 'custom-service';
      values.set(config.serviceName, 'custom-password');
      await removeZimbraCredentials(accountId);
      expect(values.get(LEGACY_KEYCHAIN_SERVICE)).toBe('legacy-password');
      expect(backend.deletePassword.mock.calls.map(call => call[0])).toEqual(['custom-service']);
    } finally { config.serviceName = original; }
  });
});
