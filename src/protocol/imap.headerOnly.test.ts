import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImapClient } from './imap.js';
import type { EmailAccount } from '../types/index.js';

// Minimal stub account
const stubAccount: EmailAccount = {
  id: 'test',
  name: 'Test Account',
  user: 'test@example.com',
  host: 'imap.example.com',
  port: 993,
  useTLS: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  authType: 'password',
};

/**
 * Build a fake ImapFlow message object with a given bodyParts map.
 */
function makeMsg(textContent: string | null = 'Hello world body') {
  const bodyParts = new Map<string, Buffer>();
  if (textContent !== null) {
    bodyParts.set('TEXT', Buffer.from(textContent, 'utf-8'));
  }
  return {
    uid: 42,
    envelope: {
      subject: 'Test Subject',
      from: [{ address: 'sender@example.com' }],
      date: new Date('2024-01-01T00:00:00Z'),
    },
    flags: new Set(['\\Seen']),
    internalDate: new Date('2024-01-01T00:00:00Z'),
    bodyParts,
    threadId: undefined,
  };
}

/**
 * Create a mock ImapFlow client with a controllable fetch() async generator.
 */
function makeMockFlow(messages: ReturnType<typeof makeMsg>[]) {
  const lock = { release: vi.fn() };

  async function* fetchGen() {
    for (const msg of messages) {
      yield msg;
    }
  }

  const flow: any = {
    usable: true,
    mailbox: { exists: 50 },
    getMailboxLock: vi.fn().mockResolvedValue(lock),
    fetch: vi.fn().mockImplementation(() => fetchGen()),
    logout: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  };

  return { flow, lock };
}

describe('ImapClient.listMessages — headerOnly flag', () => {
  let client: ImapClient;
  let mockFlow: any;
  let mockLock: any;

  beforeEach(() => {
    client = new ImapClient(stubAccount);
  });

  async function setupClient(messages: ReturnType<typeof makeMsg>[]) {
    const { flow, lock } = makeMockFlow(messages);
    mockFlow = flow;
    mockLock = lock;
    // Inject mock directly into the private field
    (client as any).client = mockFlow;
  }

  it('headerOnly=false (default): fetch options include bodyParts TEXT and snippet is populated', async () => {
    const msg = makeMsg('Hello this is the body text');
    await setupClient([msg]);

    const results = await client.listMessages('INBOX', 10, 0, false);

    expect(mockFlow.fetch).toHaveBeenCalledOnce();
    const [, fetchOptions] = mockFlow.fetch.mock.calls[0];
    expect(fetchOptions).toHaveProperty('bodyParts');
    expect(fetchOptions.bodyParts).toContain('TEXT');

    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBeTruthy();
    expect(results[0].snippet).toContain('Hello');
  });

  it('headerOnly=true: fetch options do NOT include bodyParts and snippet is empty string', async () => {
    // When headerOnly=true, ImapClient should not request bodyParts at all
    // The mock message has bodyParts but they should not be accessed
    const msg = makeMsg('Body that should not appear');
    await setupClient([msg]);

    const results = await client.listMessages('INBOX', 10, 0, true);

    expect(mockFlow.fetch).toHaveBeenCalledOnce();
    const [, fetchOptions] = mockFlow.fetch.mock.calls[0];
    expect(fetchOptions).not.toHaveProperty('bodyParts');

    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBe('');
  });

  it('backward compat: calling with 3 args works like headerOnly=false', async () => {
    const msg = makeMsg('Some body text here');
    await setupClient([msg]);

    // Call without 4th arg — should default to headerOnly=false
    const results = await client.listMessages('INBOX', 10, 0);

    expect(mockFlow.fetch).toHaveBeenCalledOnce();
    const [, fetchOptions] = mockFlow.fetch.mock.calls[0];
    expect(fetchOptions).toHaveProperty('bodyParts');
    expect(fetchOptions.bodyParts).toContain('TEXT');

    expect(results).toHaveLength(1);
    // snippet should be populated
    expect(results[0].snippet).toBeTruthy();
  });

  it('headerOnly=true: returns correct metadata fields (subject, from, date, uid)', async () => {
    const msg = makeMsg(null); // no body content provided
    await setupClient([msg]);

    const results = await client.listMessages('INBOX', 10, 0, true);

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.uid).toBe(42);
    expect(result.id).toBe('42');
    expect(result.subject).toBe('Test Subject');
    expect(result.from).toBe('sender@example.com');
    expect(result.date).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(result.snippet).toBe('');
  });

  it('headerOnly=false: snippet is empty string when bodyParts returns no TEXT', async () => {
    // bodyParts map exists but TEXT is not in it
    const msg = makeMsg(null);
    await setupClient([msg]);

    const results = await client.listMessages('INBOX', 10, 0, false);

    expect(results).toHaveLength(1);
    // snippet should gracefully be '' when no TEXT part
    expect(results[0].snippet).toBe('');
  });
});
