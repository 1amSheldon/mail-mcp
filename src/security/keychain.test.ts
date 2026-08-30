import { beforeEach, describe, it, expect, vi } from 'vitest';
import { saveCredentials, loadCredentials, removeCredentials } from './keychain.js';
import { DEFAULT_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE } from '../config.js';

// Mock cross-keychain if not available in environment
vi.mock('cross-keychain', () => ({
  setPassword: vi.fn(),
  getPassword: vi.fn(),
  deletePassword: vi.fn(),
}));

import { setPassword, getPassword, deletePassword } from 'cross-keychain';

describe('keychain service', () => {
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
