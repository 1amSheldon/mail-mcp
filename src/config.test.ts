import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock node:fs/promises for readFile
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

// Mock node:fs for watch, existsSync, mkdirSync, writeFileSync
vi.mock('node:fs', () => ({
  watch: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn().mockReturnValue('/home/testuser'),
}));

import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';

const mockedFsPromises = vi.mocked(fsPromises);
const mockedFs = vi.mocked(fs);
const mockedOs = vi.mocked(os);

const VALID_ACCOUNT = {
  id: 'work',
  name: 'Work Email',
  host: 'imap.example.com',
  port: 993,
  user: 'you@example.com',
  authType: 'login' as const,
  useTLS: true,
};

describe('emailAccountSchema', () => {
  it('valid account object parses without error and returns all fields', async () => {
    const { emailAccountSchema } = await import('./config.js');
    const result = emailAccountSchema.safeParse(VALID_ACCOUNT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('work');
      expect(result.data.host).toBe('imap.example.com');
      expect(result.data.port).toBe(993);
    }
  });

  it('account missing required id field fails with error referencing id', async () => {
    const { emailAccountSchema } = await import('./config.js');
    const noId = { ...VALID_ACCOUNT } as Partial<typeof VALID_ACCOUNT>;
    delete noId.id;
    const result = emailAccountSchema.safeParse(noId);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('id');
    }
  });

  it('account with invalid authType value fails with error referencing authType', async () => {
    const { emailAccountSchema } = await import('./config.js');
    const result = emailAccountSchema.safeParse({ ...VALID_ACCOUNT, authType: 'basic' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('authType');
    }
  });

  it('account with signature string parses successfully and preserves the value', async () => {
    const { emailAccountSchema } = await import('./config.js');
    const result = emailAccountSchema.safeParse({ ...VALID_ACCOUNT, signature: 'Best, Alice' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.signature).toBe('Best, Alice');
    }
  });

  it('account with signature: undefined parses successfully', async () => {
    const { emailAccountSchema } = await import('./config.js');
    const result = emailAccountSchema.safeParse({ ...VALID_ACCOUNT, signature: undefined });
    expect(result.success).toBe(true);
  });

  it('account without signature field parses successfully and produces signature === undefined', async () => {
    const { emailAccountSchema } = await import('./config.js');
    const result = emailAccountSchema.safeParse(VALID_ACCOUNT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.signature).toBeUndefined();
    }
  });

  it('validates smtpPort as optional positive integer', async () => {
    const { emailAccountSchema } = await import('./config.js');

    // Without smtpPort — should succeed
    const withoutPort = emailAccountSchema.safeParse(VALID_ACCOUNT);
    expect(withoutPort.success).toBe(true);

    // With valid smtpPort — should succeed
    const withPort = emailAccountSchema.safeParse({ ...VALID_ACCOUNT, smtpPort: 587 });
    expect(withPort.success).toBe(true);

    // With invalid smtpPort (negative) — should fail
    const withBadPort = emailAccountSchema.safeParse({ ...VALID_ACCOUNT, smtpPort: -1 });
    expect(withBadPort.success).toBe(false);
  });
});

describe('getAccounts (async with cache)', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    mockedOs.homedir.mockReturnValue('/home/testuser');
    mockedFs.watch.mockImplementation(() => ({ close: vi.fn() }) as any);

    // Re-import config module with fresh state for each test by resetting cache
    const { resetConfigCache } = await import('./config.js');
    resetConfigCache();
  });

  it('returns empty array when file does not exist', async () => {
    const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockedFsPromises.readFile.mockRejectedValue(error);

    const { getAccounts } = await import('./config.js');
    const result = await getAccounts();
    expect(result).toEqual([]);
  });

  it('one invalid account in array does not prevent valid accounts from loading — returns only valid ones', async () => {
    const invalidAccount = { id: 123, name: 'Bad' }; // missing many required fields
    mockedFsPromises.readFile.mockResolvedValue(
      JSON.stringify([VALID_ACCOUNT, invalidAccount]) as any
    );

    const { getAccounts } = await import('./config.js');
    const result = await getAccounts();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('work');
  });

  it('error message for invalid account includes the account ID', async () => {
    const invalidAccount = { id: 'bad-account', name: '' }; // name is empty string — fails min(1)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedFsPromises.readFile.mockResolvedValue(
      JSON.stringify([invalidAccount]) as any
    );

    const { getAccounts } = await import('./config.js');
    await getAccounts();

    expect(consoleErrorSpy).toHaveBeenCalled();
    const allMessages = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(allMessages).toContain('bad-account');
    consoleErrorSpy.mockRestore();
  });

  it('error message for invalid account with no id uses "(unknown)"', async () => {
    const invalidAccount = { name: 'No ID Account' }; // no id field
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedFsPromises.readFile.mockResolvedValue(
      JSON.stringify([invalidAccount]) as any
    );

    const { getAccounts } = await import('./config.js');
    await getAccounts();

    expect(consoleErrorSpy).toHaveBeenCalled();
    const allMessages = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(allMessages).toContain('(unknown)');
    consoleErrorSpy.mockRestore();
  });

  it('second call to getAccounts() returns cached result without re-reading disk', async () => {
    mockedFsPromises.readFile.mockResolvedValue(JSON.stringify([VALID_ACCOUNT]) as any);

    const { getAccounts } = await import('./config.js');
    await getAccounts();
    await getAccounts();

    // readFile should only be called once (second call uses cache)
    expect(mockedFsPromises.readFile).toHaveBeenCalledTimes(1);
  });

  it('after cache invalidation via fs.watch callback, next getAccounts() re-reads disk', async () => {
    mockedFsPromises.readFile.mockResolvedValue(JSON.stringify([VALID_ACCOUNT]) as any);

    let watchCallback: (() => void) | undefined;
    mockedFs.watch.mockImplementation((_path: any, cb: any) => {
      watchCallback = cb;
      return { close: vi.fn() } as any;
    });

    const { getAccounts } = await import('./config.js');

    // First call — populates cache, starts watcher
    await getAccounts();
    expect(mockedFsPromises.readFile).toHaveBeenCalledTimes(1);

    // Simulate file change — triggers cache invalidation
    expect(watchCallback).toBeDefined();
    watchCallback!();

    // Second call after invalidation — should re-read disk
    await getAccounts();
    expect(mockedFsPromises.readFile).toHaveBeenCalledTimes(2);
  });
});
