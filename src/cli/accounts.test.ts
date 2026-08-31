import { vi, describe, it, expect, beforeEach } from 'vitest';

const readline = vi.hoisted(() => ({
  question: vi.fn(),
  close: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => readline),
}));

// Mock dependencies before importing the module under test
vi.mock('../config.js', () => ({
  getConfiguredAccounts: vi.fn(),
  saveConfiguredAccounts: vi.fn(),
  ACCOUNTS_PATH: '/mock/.config/mail-mcp/accounts.json',
}));

vi.mock('../security/keychain.js', () => ({
  saveCredentials: vi.fn(),
  removeCredentials: vi.fn(),
}));

import { handleAccountsCommand, inferSmtpHost } from './accounts.js';
import { getConfiguredAccounts, saveConfiguredAccounts } from '../config.js';
import { removeCredentials, saveCredentials } from '../security/keychain.js';

const mockedGetAccounts = vi.mocked(getConfiguredAccounts);
const mockedSaveAccounts = vi.mocked(saveConfiguredAccounts);
const mockedRemoveCredentials = vi.mocked(removeCredentials);
const mockedSaveCredentials = vi.mocked(saveCredentials);

const TEST_ACCOUNT = {
  id: 'work',
  name: 'Work Email',
  host: 'imap.example.com',
  port: 993,
  user: 'you@example.com',
  authType: 'login' as const,
  useTLS: true,
};

describe('inferSmtpHost', () => {
  it('replaces an IMAP hostname prefix', () => {
    expect(inferSmtpHost('imap.gmail.com')).toBe('smtp.gmail.com');
    expect(inferSmtpHost('IMAP.example.com')).toBe('smtp.example.com');
  });

  it('does not rewrite imap text in the middle of a hostname', () => {
    expect(inferSmtpHost('mail.imaple.example')).toBe('');
  });
});

describe('handleAccountsCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Make process.exit throw so tests can catch it
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  describe('routing', () => {
    it('returns false for empty args (not an accounts command)', async () => {
      const result = await handleAccountsCommand([]);
      expect(result).toBe(false);
    });

    it('returns false for --read-only flag', async () => {
      const result = await handleAccountsCommand(['--read-only']);
      expect(result).toBe(false);
    });

    it('returns false for unrelated subcommands', async () => {
      const result = await handleAccountsCommand(['serve', '--port', '8080']);
      expect(result).toBe(false);
    });

    it('returns true for accounts list', async () => {
      mockedGetAccounts.mockReturnValue([]);
      const result = await handleAccountsCommand(['accounts', 'list']);
      expect(result).toBe(true);
    });

    it('returns true for accounts remove', async () => {
      mockedGetAccounts.mockReturnValue([TEST_ACCOUNT]);
      mockedRemoveCredentials.mockResolvedValue(undefined);
      const result = await handleAccountsCommand(['accounts', 'remove', 'work']);
      expect(result).toBe(true);
    });

    it('prints usage and exits for unknown subcommand', async () => {
      await expect(handleAccountsCommand(['accounts', 'unknown'])).rejects.toThrow(
        'process.exit(1)'
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        'Usage: mail-mcp accounts <add|list|remove>'
      );
    });

    it('prints usage and exits when no subcommand is given', async () => {
      await expect(handleAccountsCommand(['accounts'])).rejects.toThrow('process.exit(1)');
      expect(consoleSpy).toHaveBeenCalledWith(
        'Usage: mail-mcp accounts <add|list|remove>'
      );
    });
  });

  describe('accounts add', () => {
    it('validates the OAuth2 endpoint before asking for or storing secrets', async () => {
      mockedGetAccounts.mockReturnValue([]);
      mockedSaveCredentials.mockResolvedValue(undefined);
      readline.question
        .mockResolvedValueOnce('graph')
        .mockResolvedValueOnce('Graph account')
        .mockResolvedValueOnce('3')
        .mockResolvedValueOnce('user@example.com')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('http://accounts.example.test/token')
        .mockResolvedValueOnce('https://login.example.test/token')
        .mockResolvedValueOnce('client-id')
        .mockResolvedValueOnce('client-secret')
        .mockResolvedValueOnce('refresh-token');

      await expect(handleAccountsCommand(['accounts', 'add'])).resolves.toBe(true);

      const prompts = readline.question.mock.calls.map(([query]) => query);
      expect(prompts.filter((query) => query === 'OAuth2 token endpoint: ')).toHaveLength(2);
      expect(prompts.indexOf('OAuth2 token endpoint: '))
        .toBeLessThan(prompts.indexOf('OAuth2 client secret: '));
      expect(consoleSpy).toHaveBeenCalledWith(
        '  OAuth2 token endpoint must use HTTPS, except for loopback HTTP development endpoints.',
      );
      expect(mockedSaveCredentials).toHaveBeenCalledWith('graph', JSON.stringify({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
        tokenEndpoint: 'https://login.example.test/token',
      }));
      expect(mockedSaveAccounts).toHaveBeenCalledWith([{
        id: 'graph',
        name: 'Graph account',
        backend: 'microsoft-graph',
        user: 'user@example.com',
      }]);
      expect(readline.close).toHaveBeenCalledOnce();
    });
  });

  describe('accounts list', () => {
    it('prints "No accounts configured." when no accounts exist', async () => {
      mockedGetAccounts.mockReturnValue([]);
      await handleAccountsCommand(['accounts', 'list']);
      expect(consoleSpy).toHaveBeenCalledWith('No accounts configured.');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('/mock/.config/mail-mcp/accounts.json')
      );
    });

    it('prints account details in table format when accounts exist', async () => {
      mockedGetAccounts.mockReturnValue([TEST_ACCOUNT]);
      await handleAccountsCommand(['accounts', 'list']);
      // Should have printed a header, divider, and one data row
      expect(consoleSpy).toHaveBeenCalledTimes(3);
      // The row should contain the account id, name, host, and user
      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(allOutput).toContain('work');
      expect(allOutput).toContain('Work Email');
      expect(allOutput).toContain('imap.example.com');
      expect(allOutput).toContain('you@example.com');
    });
  });

  describe('accounts remove', () => {
    it('prints usage and exits with code 1 when no id given', async () => {
      await expect(handleAccountsCommand(['accounts', 'remove'])).rejects.toThrow(
        'process.exit(1)'
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Usage: mail-mcp accounts remove <id>'
      );
    });

    it('removes account from JSON and keychain when id is valid', async () => {
      mockedGetAccounts.mockReturnValue([TEST_ACCOUNT]);
      mockedRemoveCredentials.mockResolvedValue(undefined);

      await handleAccountsCommand(['accounts', 'remove', 'work']);

      expect(mockedSaveAccounts).toHaveBeenCalledWith([]);
      expect(mockedRemoveCredentials).toHaveBeenCalledWith('work');
      expect(consoleSpy).toHaveBeenCalledWith("Account 'work' removed.");
    });

    it('prints error and exits with code 1 when id is unknown', async () => {
      mockedGetAccounts.mockReturnValue([TEST_ACCOUNT]);

      await expect(
        handleAccountsCommand(['accounts', 'remove', 'nonexistent'])
      ).rejects.toThrow('process.exit(1)');

      expect(consoleErrorSpy).toHaveBeenCalledWith("Account 'nonexistent' not found.");
      expect(mockedSaveAccounts).not.toHaveBeenCalled();
    });

    it('warns but does not fail when keychain entry is missing', async () => {
      mockedGetAccounts.mockReturnValue([TEST_ACCOUNT]);
      mockedRemoveCredentials.mockRejectedValue(new Error('not found'));

      await handleAccountsCommand(['accounts', 'remove', 'work']);

      expect(mockedSaveAccounts).toHaveBeenCalledWith([]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Warning: could not remove keychain entry for 'work'")
      );
      expect(consoleSpy).toHaveBeenCalledWith("Account 'work' removed.");
    });
  });
});
