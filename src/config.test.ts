import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock node:fs/promises for readFile
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const atomicWrite = vi.hoisted(() => ({
  writeTextFileAtomicSync: vi.fn(),
}));

vi.mock('./utils/atomic-write.js', () => atomicWrite);

// Mock node:fs for watch, existsSync, and mkdirSync
vi.mock('node:fs', () => ({
  watch: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
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

    const withOutOfRangePort = emailAccountSchema.safeParse({
      ...VALID_ACCOUNT,
      smtpPort: 65536,
    });
    expect(withOutOfRangePort.success).toBe(false);
  });
});

describe('getAccounts (async with cache)', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    mockedOs.homedir.mockReturnValue('/home/testuser');
    mockedFs.watch.mockImplementation(() => ({ close: vi.fn(), once: vi.fn() }) as any);

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

  it('reports malformed JSON instead of silently hiding the config error', async () => {
    mockedFsPromises.readFile.mockResolvedValue('{not-json' as any);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { getAccounts } = await import('./config.js');
    const result = await getAccounts();

    expect(result).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unable to load accounts.json')
    );
    consoleErrorSpy.mockRestore();
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

  it('getConfiguredAccounts loads provider accounts while getAccounts returns only IMAP/SMTP', async () => {
    const appleAccount = {
      id: 'local-mail',
      name: 'Apple Mail',
      backend: 'apple-mail',
      nativeAccountName: 'iCloud',
    };
    mockedFsPromises.readFile.mockResolvedValue(
      JSON.stringify([VALID_ACCOUNT, appleAccount]) as any
    );

    const { getAccounts, getConfiguredAccounts } = await import('./config.js');
    const configured = await getConfiguredAccounts();
    const legacy = await getAccounts();

    expect(configured).toEqual([VALID_ACCOUNT, appleAccount]);
    expect(legacy).toEqual([VALID_ACCOUNT]);
    expect(mockedFsPromises.readFile).toHaveBeenCalledTimes(1);
  });

  it('skips duplicate account IDs loaded from disk', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedFsPromises.readFile.mockResolvedValue(
      JSON.stringify([VALID_ACCOUNT, { ...VALID_ACCOUNT, name: 'Duplicate' }]) as any
    );

    const { getAccounts } = await import('./config.js');
    const result = await getAccounts();

    expect(result).toEqual([VALID_ACCOUNT]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'accounts.json: duplicate account ID "work" skipped'
    );
    consoleErrorSpy.mockRestore();
  });

  it('skips duplicate IDs across different account backends', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedFsPromises.readFile.mockResolvedValue(JSON.stringify([
      VALID_ACCOUNT,
      { id: 'work', name: 'Apple Mail', backend: 'apple-mail' },
    ]) as any);

    const { getConfiguredAccounts } = await import('./config.js');
    const result = await getConfiguredAccounts();

    expect(result).toEqual([VALID_ACCOUNT]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'accounts.json: duplicate account ID "work" skipped'
    );
    consoleErrorSpy.mockRestore();
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
      return { close: vi.fn(), once: vi.fn() } as any;
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

  it('retries the watcher after the config directory appears', async () => {
    mockedFs.watch
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      })
      .mockImplementationOnce(() => ({ close: vi.fn(), once: vi.fn() }) as any);
    mockedFsPromises.readFile.mockResolvedValue(JSON.stringify([VALID_ACCOUNT]) as any);

    const { getAccounts } = await import('./config.js');
    await getAccounts();

    expect(mockedFs.watch).toHaveBeenCalledTimes(2);
  });
});

describe('saveAccounts', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    mockedFs.watch.mockImplementation(() => ({ close: vi.fn(), once: vi.fn() }) as any);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const { resetConfigCache } = await import('./config.js');
    resetConfigCache();
  });

  it('rejects invalid account data before writing the file', async () => {
    const { saveAccounts } = await import('./config.js');

    expect(() => saveAccounts([{ ...VALID_ACCOUNT, port: 70000 }])).toThrow();
    expect(atomicWrite.writeTextFileAtomicSync).not.toHaveBeenCalled();
  });

  it('rejects duplicate account IDs before writing the file', async () => {
    const { saveAccounts } = await import('./config.js');

    expect(() => saveAccounts([VALID_ACCOUNT, { ...VALID_ACCOUNT }])).toThrow(
      'Duplicate account ID(s): work'
    );
    expect(atomicWrite.writeTextFileAtomicSync).not.toHaveBeenCalled();
  });

  it('writes validated account data atomically', async () => {
    const { saveAccounts, ACCOUNTS_PATH } = await import('./config.js');

    saveAccounts([VALID_ACCOUNT]);

    expect(atomicWrite.writeTextFileAtomicSync).toHaveBeenCalledWith(
      ACCOUNTS_PATH,
      `${JSON.stringify([VALID_ACCOUNT], null, 2)}\n`
    );
  });

  it('preserves provider accounts when replacing the legacy IMAP/SMTP subset', async () => {
    const providerAccount = {
      id: 'graph',
      name: 'Microsoft 365',
      backend: 'microsoft-graph',
      user: 'user@example.com',
    };
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([{ ...VALID_ACCOUNT, id: 'old-imap' }, providerAccount])
    );

    const { saveAccounts, ACCOUNTS_PATH } = await import('./config.js');
    saveAccounts([VALID_ACCOUNT]);

    expect(atomicWrite.writeTextFileAtomicSync).toHaveBeenCalledWith(
      ACCOUNTS_PATH,
      expect.any(String)
    );
    const written = atomicWrite.writeTextFileAtomicSync.mock.calls[0][1];
    expect(JSON.parse(written)).toEqual([providerAccount, VALID_ACCOUNT]);
  });

  it('rejects an incoming IMAP/SMTP ID that collides with a retained provider account', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([{
      id: 'work',
      name: 'Native Mail',
      backend: 'apple-mail',
    }]));

    const { saveAccounts } = await import('./config.js');

    expect(() => saveAccounts([VALID_ACCOUNT])).toThrow('Duplicate account ID(s): work');
    expect(atomicWrite.writeTextFileAtomicSync).not.toHaveBeenCalled();
  });
});

describe('saveConfiguredAccounts', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    mockedFs.watch.mockImplementation(() => ({ close: vi.fn(), once: vi.fn() }) as any);
    const { resetConfigCache } = await import('./config.js');
    resetConfigCache();
  });

  it('writes a full mixed-backend replacement', async () => {
    const accounts = [
      VALID_ACCOUNT,
      { id: 'mailtrap', name: 'Mailtrap', backend: 'mailtrap' as const, accountId: '42' },
    ];
    const { saveConfiguredAccounts, ACCOUNTS_PATH } = await import('./config.js');

    saveConfiguredAccounts(accounts);

    expect(atomicWrite.writeTextFileAtomicSync).toHaveBeenCalledWith(
      ACCOUNTS_PATH,
      expect.any(String)
    );
    const written = atomicWrite.writeTextFileAtomicSync.mock.calls[0][1];
    expect(JSON.parse(written)).toEqual(accounts);
  });

  it('rejects duplicate IDs across different backends', async () => {
    const { saveConfiguredAccounts } = await import('./config.js');

    expect(() => saveConfiguredAccounts([
      VALID_ACCOUNT,
      { id: 'work', name: 'Apple Mail', backend: 'apple-mail' },
    ])).toThrow('Duplicate account ID(s): work');
    expect(atomicWrite.writeTextFileAtomicSync).not.toHaveBeenCalled();
  });
});
