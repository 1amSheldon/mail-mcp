import { describe, it, expect, vi } from 'vitest';
import { saveCredentials, loadCredentials, removeCredentials } from './keychain.js';

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

  it('saves credentials', async () => {
    await saveCredentials(accountId, secret);
    expect(setPassword).toHaveBeenCalledWith(expect.any(String), accountId, secret);
  });

  it('loads credentials', async () => {
    (getPassword as any).mockResolvedValue(secret);
    const result = await loadCredentials(accountId);
    expect(result).toBe(secret);
    expect(getPassword).toHaveBeenCalledWith(expect.any(String), accountId);
  });

  it('removes credentials', async () => {
    await removeCredentials(accountId);
    expect(deletePassword).toHaveBeenCalledWith(expect.any(String), accountId);
  });
});
