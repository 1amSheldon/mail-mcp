import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ImapClient } from '../../src/protocol/imap.js';
import type { EmailAccount } from '../../src/types/index.js';

vi.mock('../../src/security/keychain.js', () => ({
  loadCredentials: vi.fn(() => Promise.resolve(process.env.TEST_IMAP_PASS)),
  saveCredentials: vi.fn(() => Promise.resolve()),
  removeCredentials: vi.fn(() => Promise.resolve()),
}));

const hasImapCredentials = Boolean(process.env.TEST_IMAP_HOST);

describe.skipIf(!hasImapCredentials)('IMAP operations (requires TEST_IMAP_HOST)', () => {
  let client: ImapClient;

  beforeAll(async () => {
    const account: EmailAccount = {
      id: 'test-imap-account',
      name: 'Integration Test Account',
      host: process.env.TEST_IMAP_HOST!,
      port: parseInt(process.env.TEST_IMAP_PORT ?? '993', 10),
      user: process.env.TEST_IMAP_USER!,
      authType: 'login',
      useTLS: true,
    };
    client = new ImapClient(account);
    await client.connect();
  });

  afterAll(async () => {
    if (client) {
      await client.disconnect();
    }
  });

  it('lists mailboxes from server', async () => {
    const folders = await client.listFolders();
    expect(Array.isArray(folders)).toBe(true);
    expect(folders.length).toBeGreaterThan(0);
    const hasInbox = folders.some(f => f.toUpperCase() === 'INBOX');
    expect(hasInbox).toBe(true);
  }, 15000);

  it('lists messages from INBOX', async () => {
    const messages = await client.listMessages('INBOX', 10, 0);
    expect(Array.isArray(messages)).toBe(true);
    if (messages.length > 0) {
      expect(typeof messages[0].uid).toBe('number');
    }
  }, 15000);

  it('search returns results for broad query', async () => {
    const results = await client.searchMessages({ since: new Date('2000-01-01') }, 'INBOX', 10, 0);
    expect(Array.isArray(results)).toBe(true);
  }, 15000);
});
