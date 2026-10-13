import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImapClient, MAX_SNIPPET_BYTES } from './imap.js';
import type { EmailAccount } from '../config.js';

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

describe('ImapClient.fetchMessagesByUids headerOnly flag', () => {
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

    const results = await client.fetchMessagesByUids([42], 'INBOX', false);

    expect(mockFlow.fetch).toHaveBeenCalledOnce();
    const [, fetchOptions] = mockFlow.fetch.mock.calls[0];
    expect(fetchOptions).toHaveProperty('bodyParts');
    expect(fetchOptions.bodyParts).toEqual([{ key: 'TEXT', start: 0, maxLength: MAX_SNIPPET_BYTES }]);

    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBeTruthy();
    expect(results[0].snippet).toContain('Hello');
  });

  it('headerOnly=true: fetch options do NOT include bodyParts and snippet is empty string', async () => {
    // When headerOnly=true, ImapClient should not request bodyParts at all
    // The mock message has bodyParts but they should not be accessed
    const msg = makeMsg('Body that should not appear');
    await setupClient([msg]);

    const results = await client.fetchMessagesByUids([42], 'INBOX', true);

    expect(mockFlow.fetch).toHaveBeenCalledOnce();
    const [, fetchOptions] = mockFlow.fetch.mock.calls[0];
    expect(fetchOptions).not.toHaveProperty('bodyParts');

    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBe('');
  });

  it('defaults headerOnly to false when omitted', async () => {
    const msg = makeMsg('Some body text here');
    await setupClient([msg]);

    const results = await client.fetchMessagesByUids([42], 'INBOX');

    expect(mockFlow.fetch).toHaveBeenCalledOnce();
    const [, fetchOptions] = mockFlow.fetch.mock.calls[0];
    expect(fetchOptions).toHaveProperty('bodyParts');
    expect(fetchOptions.bodyParts).toEqual([{ key: 'TEXT', start: 0, maxLength: MAX_SNIPPET_BYTES }]);

    expect(results).toHaveLength(1);
    // snippet should be populated
    expect(results[0].snippet).toBeTruthy();
  });

  it('headerOnly=true: returns correct metadata fields (subject, from, date, uid)', async () => {
    const msg = makeMsg(null); // no body content provided
    await setupClient([msg]);

    const results = await client.fetchMessagesByUids([42], 'INBOX', true);

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

    const results = await client.fetchMessagesByUids([42], 'INBOX', false);

    expect(results).toHaveLength(1);
    // snippet should gracefully be '' when no TEXT part
    expect(results[0].snippet).toBe('');
  });

  it.each([
    ['base64', 'SGVsbG8gd29ybGQ=', 'Hello world'],
    ['quoted-printable', 'Hello=20world', 'Hello world'],
  ])('decodes %s previews using MIME headers', async (encoding, body, expected) => {
    const msg = { ...makeMsg(body), headers: Buffer.from(`Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: ${encoding}\r\n`) };
    await setupClient([msg]);
    expect((await client.fetchMessagesByUids([42]))[0].snippet).toBe(expected);
  });

  it('limits a multipart preview without fetching the large attachment after its text', async () => {
    const msg = { ...makeMsg('--x\r\nContent-Type: text/plain\r\n\r\nSmall preview\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n' + 'A'.repeat(MAX_SNIPPET_BYTES)),
      headers: Buffer.from('Content-Type: multipart/mixed; boundary=x\r\n') };
    await setupClient([msg]);
    expect((await client.fetchMessagesByUids([42]))[0].snippet).toBe('Small preview');
    expect(mockFlow.fetch.mock.calls[0][1].bodyParts[0].maxLength).toBe(MAX_SNIPPET_BYTES);
  });
});
