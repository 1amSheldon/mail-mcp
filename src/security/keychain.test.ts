import { beforeEach, describe, it, expect, vi } from 'vitest';
import { saveCredentials, loadCredentials, removeCredentials, saveProtectedCredentials } from './keychain.js';
import { DEFAULT_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE } from '../config.js';

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
    const save = vi.fn(); vi.mocked(getKeyring).mockResolvedValue({ id, setPassword: save } as any);
    await expect(saveProtectedCredentials('z', 'private-main-password')).rejects.toThrow('protected native credential backend');
    expect(save).not.toHaveBeenCalled(); expect(setPassword).not.toHaveBeenCalled();
  });
  it.each(['native-windows', 'native-macos', 'native-linux', 'secret-service'])('uses the inspected protected backend %s directly', async id => {
    const save = vi.fn(); vi.mocked(getKeyring).mockResolvedValue({ id, setPassword: save } as any);
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
});
