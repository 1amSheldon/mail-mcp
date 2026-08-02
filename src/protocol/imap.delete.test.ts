import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImapClient } from './imap.js';
import { EmailAccount } from '../types/index.js';

vi.mock('../security/keychain.js', () => ({
  loadCredentials: vi.fn(() => Promise.resolve('test-password'))
}));

const mockMessageDelete = vi.fn().mockResolvedValue(undefined);
const mockGetMailboxLock = vi.fn().mockResolvedValue({ release: vi.fn() });

vi.mock('imapflow', () => {
  return {
    ImapFlow: vi.fn().mockImplementation(function () {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        once: vi.fn(),
        logout: vi.fn().mockResolvedValue(undefined),
        getMailboxLock: mockGetMailboxLock,
        messageDelete: mockMessageDelete,
      };
    }),
  };
});

const account: EmailAccount = {
  id: 'test-account',
  name: 'Test Account',
  user: 'test@example.com',
  host: 'imap.example.com',
  port: 993,
  useTLS: true,
  authType: 'password',
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpUseTLS: false,
};

describe('ImapClient.deleteMessage', () => {
  let client: ImapClient;

  beforeEach(async () => {
    mockMessageDelete.mockClear();
    mockGetMailboxLock.mockClear();
    mockGetMailboxLock.mockResolvedValue({ release: vi.fn() });
    client = new ImapClient(account);
    await client.connect();
  });

  it('calls messageDelete with the uid as a single-element sequence in uid mode', async () => {
    await client.deleteMessage('42', 'INBOX');
    expect(mockMessageDelete).toHaveBeenCalledWith('42', { uid: true });
  });

  it('opens a mailbox lock on the specified folder', async () => {
    await client.deleteMessage('42', 'Trash');
    expect(mockGetMailboxLock).toHaveBeenCalledWith('Trash');
  });

  it('throws "Not connected" when client is not connected', async () => {
    const unconnected = new ImapClient(account);
    await expect(unconnected.deleteMessage('42', 'INBOX')).rejects.toThrow('Not connected');
  });
});
