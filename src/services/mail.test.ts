import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockImapConnect = vi.fn().mockResolvedValue(undefined);
const mockImapAppendMessage = vi.fn().mockResolvedValue(undefined);
const mockSmtpConnect = vi.fn().mockResolvedValue(undefined);
const mockSmtpSend = vi.fn().mockResolvedValue({ messageId: 'test' });
const mockFetchAttachmentSize = vi.fn();
const mockFetchMessageBody = vi.fn();
const mockGetMailboxStatus = vi.fn().mockResolvedValue([
  { name: 'INBOX', total: 100, unread: 5, recent: 2 },
  { name: 'Sent', total: 200, unread: 0, recent: 0 },
]);
const mockListFolders = vi.fn().mockResolvedValue(['INBOX', 'Sent', 'Drafts']);
const mockScanSenderEnvelopes = vi.fn().mockResolvedValue([]);

vi.mock('../protocol/imap.js', () => {
  return {
    ImapClient: vi.fn(function () {
      return {
        connect: mockImapConnect,
        appendMessage: mockImapAppendMessage,
        fetchAttachmentSize: mockFetchAttachmentSize,
        fetchMessageBody: mockFetchMessageBody,
        getMailboxStatus: mockGetMailboxStatus,
        listFolders: mockListFolders,
        scanSenderEnvelopes: mockScanSenderEnvelopes,
      };
    }),
  };
});

vi.mock('../protocol/smtp.js', () => {
  return {
    SmtpClient: vi.fn(function () {
      return { connect: mockSmtpConnect, send: mockSmtpSend };
    }),
  };
});

import { MailService, applySignature } from './mail.js';

describe('MailService SMTP connection behavior', () => {
  beforeEach(() => {
    mockImapConnect.mockClear();
    mockSmtpConnect.mockClear();
    mockSmtpSend.mockClear();
    mockFetchAttachmentSize.mockClear();
    mockFetchMessageBody.mockClear();
    mockGetMailboxStatus.mockClear();
    mockListFolders.mockClear();
    mockScanSenderEnvelopes.mockClear();
  });

  it('connect() does NOT call smtpClient.connect() eagerly', async () => {
    const account = { id: 'test', name: 'Test', user: 'test@example.com', imap: {} as any, smtp: {} as any };
    const service = new MailService(account, false);
    await service.connect();
    expect(mockSmtpConnect).not.toHaveBeenCalled();
  });

  it('connect() does NOT call smtpClient.connect() when readOnly=true', async () => {
    const account = { id: 'test', name: 'Test', user: 'test@example.com', imap: {} as any, smtp: {} as any };
    const service = new MailService(account, true);
    await service.connect();
    expect(mockSmtpConnect).not.toHaveBeenCalled();
  });

  it('SMTP connects lazily on first sendEmail', async () => {
    const account = { id: 'test', name: 'Test', user: 'test@example.com', imap: {} as any, smtp: {} as any };
    const service = new MailService(account, false);
    await service.connect();
    expect(mockSmtpConnect).not.toHaveBeenCalled();
    await service.sendEmail('to@test.com', 'subject', 'body');
    expect(mockSmtpConnect).toHaveBeenCalledTimes(1);
  });
});

describe('MailService attachment size guard', () => {
  const account = { id: 'test', name: 'Test', user: 'test@example.com', imap: {} as any, smtp: {} as any };

  beforeEach(() => {
    mockFetchAttachmentSize.mockClear();
    mockFetchMessageBody.mockClear();
  });

  it('throws ValidationError when fetchAttachmentSize returns size exceeding 50MB', async () => {
    const SIXTY_MB = 60 * 1024 * 1024;
    mockFetchAttachmentSize.mockResolvedValue(SIXTY_MB);
    const service = new MailService(account, false);
    await service.connect();
    await expect(service.downloadAttachment('1', 'bigfile.pdf')).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining('bigfile.pdf'),
      })
    );
    await expect(service.downloadAttachment('1', 'bigfile.pdf')).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining('MB'),
      })
    );
    await expect(service.downloadAttachment('1', 'bigfile.pdf')).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining('limit'),
      })
    );
    expect(mockFetchMessageBody).not.toHaveBeenCalled();
  });

  it('throws ValidationError with code ValidationError when size exceeds limit', async () => {
    const SIXTY_MB = 60 * 1024 * 1024;
    mockFetchAttachmentSize.mockResolvedValue(SIXTY_MB);
    const { ValidationError } = await import('../errors.js');
    const service = new MailService(account, false);
    await service.connect();
    await expect(service.downloadAttachment('1', 'bigfile.pdf')).rejects.toBeInstanceOf(ValidationError);
  });

  it('proceeds to fetchMessageBody when size <= 50MB', async () => {
    const TEN_MB = 10 * 1024 * 1024;
    mockFetchAttachmentSize.mockResolvedValue(TEN_MB);
    mockFetchMessageBody.mockResolvedValue({
      attachments: [{ filename: 'small.pdf', content: Buffer.from('data'), contentType: 'application/pdf', size: TEN_MB }],
    });
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.downloadAttachment('1', 'small.pdf');
    expect(mockFetchMessageBody).toHaveBeenCalledOnce();
    expect(result.contentType).toBe('application/pdf');
  });

  it('proceeds to fetchMessageBody when fetchAttachmentSize returns null (BODYSTRUCTURE unavailable)', async () => {
    mockFetchAttachmentSize.mockResolvedValue(null);
    mockFetchMessageBody.mockResolvedValue({
      attachments: [{ filename: 'file.txt', content: Buffer.from('hello'), contentType: 'text/plain', size: 5 }],
    });
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.downloadAttachment('1', 'file.txt');
    expect(mockFetchMessageBody).toHaveBeenCalledOnce();
    expect(result.contentType).toBe('text/plain');
  });
});

// ---------------------------------------------------------------------------
// applySignature pure helper tests
// ---------------------------------------------------------------------------

describe('applySignature helper', () => {
  it('returns body unchanged when signature is undefined and includeSignature is true', () => {
    expect(applySignature('Hello', undefined, false, true)).toBe('Hello');
  });

  it('returns body unchanged when signature is undefined and includeSignature is false', () => {
    expect(applySignature('Hello', undefined, false, false)).toBe('Hello');
  });

  it('returns body unchanged when includeSignature is false even if signature is set', () => {
    expect(applySignature('Hello', 'Best', false, false)).toBe('Hello');
  });

  it('appends plain text signature with RFC 3676 separator when includeSignature is true', () => {
    expect(applySignature('Hello', 'Best', false, true)).toBe('Hello\n-- \nBest');
  });

  it('appends HTML-wrapped signature when body is HTML and includeSignature is true', () => {
    expect(applySignature('<p>Hello</p>', 'Best', true, true)).toBe(
      '<p>Hello</p><br><br><p style="white-space: pre-line">-- \nBest</p>'
    );
  });

  it('returns HTML body unchanged when includeSignature is false even if signature is set', () => {
    expect(applySignature('<p>Hello</p>', 'Best', true, false)).toBe('<p>Hello</p>');
  });
});

// ---------------------------------------------------------------------------
// sendEmail with signature tests
// ---------------------------------------------------------------------------

describe('MailService sendEmail with signature', () => {
  const baseAccount = { id: 'test', name: 'Test', user: 'test@example.com', authType: 'login' as const, host: 'imap.example.com', port: 993, useTLS: true };

  beforeEach(() => {
    mockSmtpConnect.mockClear();
    mockSmtpSend.mockClear();
  });

  it('appends signature to body when account has signature and includeSignature is true (default)', async () => {
    const account = { ...baseAccount, signature: 'Best regards,\nAlice' };
    const service = new MailService(account, false);
    await service.connect();
    await service.sendEmail('to@example.com', 'Hi', 'Hello there');
    expect(mockSmtpSend).toHaveBeenCalledWith(
      'to@example.com',
      'Hi',
      'Hello there\n-- \nBest regards,\nAlice',
      false,
      undefined,
      undefined
    );
  });

  it('does not append signature when includeSignature is false', async () => {
    const account = { ...baseAccount, signature: 'Best regards,\nAlice' };
    const service = new MailService(account, false);
    await service.connect();
    await service.sendEmail('to@example.com', 'Hi', 'Hello there', false, undefined, undefined, false);
    expect(mockSmtpSend).toHaveBeenCalledWith(
      'to@example.com',
      'Hi',
      'Hello there',
      false,
      undefined,
      undefined
    );
  });

  it('does not append signature when account has no signature', async () => {
    const account = { ...baseAccount };
    const service = new MailService(account, false);
    await service.connect();
    await service.sendEmail('to@example.com', 'Hi', 'Hello there');
    expect(mockSmtpSend).toHaveBeenCalledWith(
      'to@example.com',
      'Hi',
      'Hello there',
      false,
      undefined,
      undefined
    );
  });
});

// ---------------------------------------------------------------------------
// createDraft with signature tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// readEmail List-Unsubscribe header extraction tests
// ---------------------------------------------------------------------------

describe('readEmail List-Unsubscribe header extraction', () => {
  const account = { id: 'test', name: 'Test', user: 'test@example.com', imap: {} as any, smtp: {} as any };

  beforeEach(() => {
    mockFetchMessageBody.mockClear();
  });

  function makeParsedMail(headers: Record<string, string>, extra: Partial<any> = {}): any {
    const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      from: { text: 'sender@example.com' },
      to: { text: 'recipient@example.com' },
      subject: 'Test Email',
      date: new Date('2026-01-01T00:00:00Z'),
      text: 'Hello world',
      headers: map,
      attachments: [],
      ...extra,
    };
  }

  it('outputs Unsubscribe https line when List-Unsubscribe contains an https URL', async () => {
    mockFetchMessageBody.mockResolvedValue(
      makeParsedMail({ 'list-unsubscribe': '<https://example.com/unsub?token=abc>' })
    );
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.readEmail('1');
    expect(result).toContain('**Unsubscribe:** https://example.com/unsub?token=abc');
  });

  it('outputs Unsubscribe mailto line when List-Unsubscribe contains a mailto URL', async () => {
    mockFetchMessageBody.mockResolvedValue(
      makeParsedMail({ 'list-unsubscribe': '<mailto:unsub@list.example.com>' })
    );
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.readEmail('1');
    expect(result).toContain('**Unsubscribe (mailto):** unsub@list.example.com');
  });

  it('outputs both https and mailto lines when List-Unsubscribe contains both', async () => {
    mockFetchMessageBody.mockResolvedValue(
      makeParsedMail({
        'list-unsubscribe': '<mailto:unsub@list.example.com>, <https://example.com/unsub?token=xyz>',
      })
    );
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.readEmail('1');
    expect(result).toContain('**Unsubscribe:** https://example.com/unsub?token=xyz');
    expect(result).toContain('**Unsubscribe (mailto):** unsub@list.example.com');
  });

  it('does not output any Unsubscribe line when List-Unsubscribe header is absent', async () => {
    mockFetchMessageBody.mockResolvedValue(makeParsedMail({}));
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.readEmail('1');
    expect(result).not.toContain('Unsubscribe');
  });

  it('outputs one-click line when List-Unsubscribe-Post is present', async () => {
    mockFetchMessageBody.mockResolvedValue(
      makeParsedMail({
        'list-unsubscribe': '<https://example.com/unsub>',
        'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
      })
    );
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.readEmail('1');
    expect(result).toContain('**Unsubscribe:** https://example.com/unsub');
    expect(result).toContain('**Unsubscribe (one-click):** yes');
  });
});

// ---------------------------------------------------------------------------
// replyEmail tests
// ---------------------------------------------------------------------------

describe('MailService replyEmail', () => {
  const baseAccount = {
    id: 'test',
    name: 'Test',
    user: 'reply-sender@example.com',
    authType: 'login' as const,
    host: 'imap.example.com',
    port: 993,
    useTLS: true,
  };

  beforeEach(() => {
    mockSmtpConnect.mockClear();
    mockSmtpSend.mockClear();
    mockImapAppendMessage.mockClear();
    mockFetchMessageBody.mockClear();
  });

  function makeOriginalMail(overrides: Partial<any> = {}): any {
    const headersMap = new Map<string, string>();
    headersMap.set('message-id', '<original-123@example.com>');
    return {
      messageId: '<original-123@example.com>',
      from: { value: [{ address: 'original-sender@example.com' }], text: 'original-sender@example.com' },
      to: { text: 'reply-sender@example.com' },
      subject: 'Original Subject',
      date: new Date('2026-01-01T00:00:00Z'),
      text: 'Original body text',
      headers: headersMap,
      attachments: [],
      ...overrides,
    };
  }

  it('fetches the original message body', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.replyEmail('42', 'INBOX', 'My reply');
    expect(mockFetchMessageBody).toHaveBeenCalledWith('42', 'INBOX');
  });

  it('sends to the original sender address', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.replyEmail('42', 'INBOX', 'My reply');
    expect(mockSmtpSend.mock.calls[0][0]).toBe('original-sender@example.com');
  });

  it('prepends "Re: " to subject when not already present', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.replyEmail('42', 'INBOX', 'My reply');
    expect(mockSmtpSend.mock.calls[0][1]).toBe('Re: Original Subject');
  });

  it('does not double-prepend "Re: " when subject already starts with "Re: "', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail({ subject: 'Re: Original Subject' }));
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.replyEmail('42', 'INBOX', 'My reply');
    expect(mockSmtpSend.mock.calls[0][1]).toBe('Re: Original Subject');
  });

  it('sets In-Reply-To header to original Message-ID', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.replyEmail('42', 'INBOX', 'My reply');
    // extraHeaders is 7th argument to send()
    const extraHeaders = mockSmtpSend.mock.calls[0][6];
    expect(extraHeaders['In-Reply-To']).toBe('<original-123@example.com>');
  });

  it('sets References header to original Message-ID when no prior references', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.replyEmail('42', 'INBOX', 'My reply');
    const extraHeaders = mockSmtpSend.mock.calls[0][6];
    expect(extraHeaders['References']).toBe('<original-123@example.com>');
  });

  it('appends original Message-ID to existing references chain', async () => {
    const headersMap = new Map<string, string>();
    headersMap.set('message-id', '<msg-2@example.com>');
    headersMap.set('references', '<msg-1@example.com>');
    const mail = makeOriginalMail({ messageId: '<msg-2@example.com>', headers: headersMap });
    mockFetchMessageBody.mockResolvedValue(mail);
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.replyEmail('42', 'INBOX', 'My reply');
    const extraHeaders = mockSmtpSend.mock.calls[0][6];
    expect(extraHeaders['References']).toBe('<msg-1@example.com> <msg-2@example.com>');
  });

  it('appends message to Sent folder via IMAP', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.replyEmail('42', 'INBOX', 'My reply');
    expect(mockImapAppendMessage).toHaveBeenCalledWith('Sent', expect.any(String), ['\\Seen']);
  });

  it('applies signature when account has one and includeSignature is true', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const account = { ...baseAccount, signature: 'Best, Me' };
    const service = new MailService(account, false);
    await service.connect();
    await service.replyEmail('42', 'INBOX', 'My reply');
    // body passed to send (3rd arg) should contain signature
    expect(mockSmtpSend.mock.calls[0][2]).toContain('My reply\n-- \nBest, Me');
  });

  it('does not append signature when includeSignature is false', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const account = { ...baseAccount, signature: 'Best, Me' };
    const service = new MailService(account, false);
    await service.connect();
    await service.replyEmail('42', 'INBOX', 'My reply', false, undefined, undefined, false);
    expect(mockSmtpSend.mock.calls[0][2]).toBe('My reply');
  });

  it('handles missing messageId gracefully — sends without threading headers', async () => {
    const headersMap = new Map<string, string>();
    const mail = makeOriginalMail({ messageId: undefined, headers: headersMap });
    mockFetchMessageBody.mockResolvedValue(mail);
    const service = new MailService(baseAccount, false);
    await service.connect();
    await expect(service.replyEmail('42', 'INBOX', 'My reply')).resolves.not.toThrow();
    // extraHeaders should be empty or absent
    const extraHeaders = mockSmtpSend.mock.calls[0][6];
    expect(extraHeaders === undefined || Object.keys(extraHeaders).length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// forwardEmail tests
// ---------------------------------------------------------------------------

describe('MailService forwardEmail', () => {
  const baseAccount = {
    id: 'test',
    name: 'Test',
    user: 'forwarder@example.com',
    authType: 'login' as const,
    host: 'imap.example.com',
    port: 993,
    useTLS: true,
  };

  beforeEach(() => {
    mockSmtpConnect.mockClear();
    mockSmtpSend.mockClear();
    mockImapAppendMessage.mockClear();
    mockFetchMessageBody.mockClear();
  });

  function makeOriginalMail(overrides: Partial<any> = {}): any {
    const headersMap = new Map<string, string>();
    headersMap.set('message-id', '<orig@example.com>');
    return {
      messageId: '<orig@example.com>',
      from: { value: [{ address: 'author@example.com' }], text: 'author@example.com' },
      to: { text: 'forwarder@example.com' },
      subject: 'Original Subject',
      date: new Date('2026-01-15T10:00:00Z'),
      text: 'Original message content.',
      headers: headersMap,
      attachments: [],
      ...overrides,
    };
  }

  it('sends to the specified "to" address', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.forwardEmail('42', 'INBOX', 'friend@example.com', 'FYI');
    expect(mockSmtpSend.mock.calls[0][0]).toBe('friend@example.com');
  });

  it('prepends "Fwd: " to subject when not already present', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.forwardEmail('42', 'INBOX', 'friend@example.com', 'FYI');
    expect(mockSmtpSend.mock.calls[0][1]).toBe('Fwd: Original Subject');
  });

  it('does not double-prepend "Fwd: " when subject already starts with "Fwd: "', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail({ subject: 'Fwd: Original Subject' }));
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.forwardEmail('42', 'INBOX', 'friend@example.com', 'FYI');
    expect(mockSmtpSend.mock.calls[0][1]).toBe('Fwd: Original Subject');
  });

  it('includes "--- Forwarded message ---" separator in body', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.forwardEmail('42', 'INBOX', 'friend@example.com', 'FYI');
    const sentBody: string = mockSmtpSend.mock.calls[0][2];
    expect(sentBody).toContain('--- Forwarded message ---');
  });

  it('includes original message body in forwarded content', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.forwardEmail('42', 'INBOX', 'friend@example.com', 'FYI');
    const sentBody: string = mockSmtpSend.mock.calls[0][2];
    expect(sentBody).toContain('Original message content.');
  });

  it('includes user preamble before forwarded block', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.forwardEmail('42', 'INBOX', 'friend@example.com', 'Check this out!');
    const sentBody: string = mockSmtpSend.mock.calls[0][2];
    expect(sentBody).toContain('Check this out!');
    // preamble should appear before the forwarded block
    const preambleIdx = sentBody.indexOf('Check this out!');
    const forwardIdx = sentBody.indexOf('--- Forwarded message ---');
    expect(preambleIdx).toBeLessThan(forwardIdx);
  });

  it('does not set In-Reply-To or References headers (forwards break thread chain)', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.forwardEmail('42', 'INBOX', 'friend@example.com', '');
    // extraHeaders (7th arg) should be absent or empty
    const extraHeaders = mockSmtpSend.mock.calls[0][6];
    const hasThreadingHeaders =
      extraHeaders &&
      (extraHeaders['In-Reply-To'] || extraHeaders['References']);
    expect(hasThreadingHeaders).toBeFalsy();
  });

  it('saves to Sent folder via IMAP append', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const service = new MailService(baseAccount, false);
    await service.connect();
    await service.forwardEmail('42', 'INBOX', 'friend@example.com', '');
    expect(mockImapAppendMessage).toHaveBeenCalledWith('Sent', expect.any(String), ['\\Seen']);
  });

  it('applies signature when account has one and includeSignature is true', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const account = { ...baseAccount, signature: 'Cheers' };
    const service = new MailService(account, false);
    await service.connect();
    await service.forwardEmail('42', 'INBOX', 'friend@example.com', 'FYI');
    const sentBody: string = mockSmtpSend.mock.calls[0][2];
    expect(sentBody).toContain('-- \nCheers');
  });

  it('does not append signature when includeSignature is false', async () => {
    mockFetchMessageBody.mockResolvedValue(makeOriginalMail());
    const account = { ...baseAccount, signature: 'Cheers' };
    const service = new MailService(account, false);
    await service.connect();
    await service.forwardEmail('42', 'INBOX', 'friend@example.com', 'FYI', false, undefined, undefined, false);
    const sentBody: string = mockSmtpSend.mock.calls[0][2];
    expect(sentBody).not.toContain('Cheers');
  });
});

// ---------------------------------------------------------------------------
// extractContacts tests (CE-02)
// ---------------------------------------------------------------------------

describe('MailService extractContacts', () => {
  const account = {
    id: 'test',
    name: 'Test',
    user: 'test@example.com',
    authType: 'login' as const,
    host: 'imap.example.com',
    port: 993,
    useTLS: true,
  };

  beforeEach(() => {
    mockScanSenderEnvelopes.mockClear();
  });

  it('returns empty array when scanSenderEnvelopes returns no messages', async () => {
    mockScanSenderEnvelopes.mockResolvedValue([]);
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.extractContacts();
    expect(result).toEqual([]);
  });

  it('groups messages from the same email address and increments count', async () => {
    const date1 = new Date('2024-01-10T10:00:00Z');
    const date2 = new Date('2024-01-15T10:00:00Z');
    mockScanSenderEnvelopes.mockResolvedValue([
      { name: 'Alice', email: 'alice@example.com', date: date1 },
      { name: 'Alice', email: 'alice@example.com', date: date2 },
      { name: 'Bob', email: 'bob@example.com', date: date1 },
    ]);
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.extractContacts();
    const alice = result.find(c => c.email === 'alice@example.com');
    expect(alice?.count).toBe(2);
    const bob = result.find(c => c.email === 'bob@example.com');
    expect(bob?.count).toBe(1);
  });

  it('returns contacts sorted by count descending', async () => {
    const date = new Date('2024-01-10T10:00:00Z');
    mockScanSenderEnvelopes.mockResolvedValue([
      { name: 'Bob', email: 'bob@example.com', date },
      { name: 'Alice', email: 'alice@example.com', date },
      { name: 'Alice', email: 'alice@example.com', date },
      { name: 'Alice', email: 'alice@example.com', date },
      { name: 'Bob', email: 'bob@example.com', date },
      { name: 'Carol', email: 'carol@example.com', date },
    ]);
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.extractContacts();
    expect(result[0].email).toBe('alice@example.com');
    expect(result[0].count).toBe(3);
    expect(result[1].email).toBe('bob@example.com');
    expect(result[1].count).toBe(2);
    expect(result[2].email).toBe('carol@example.com');
    expect(result[2].count).toBe(1);
  });

  it('uses the display name from the most recent message', async () => {
    mockScanSenderEnvelopes.mockResolvedValue([
      { name: 'Old Name', email: 'alice@example.com', date: new Date('2024-01-01T00:00:00Z') },
      { name: 'Alice Smith', email: 'alice@example.com', date: new Date('2024-01-15T00:00:00Z') },
    ]);
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.extractContacts();
    expect(result[0].name).toBe('Alice Smith');
  });

  it('sets lastSeen to ISO-8601 string of the most recent message date', async () => {
    const latestDate = new Date('2024-02-01T12:00:00Z');
    mockScanSenderEnvelopes.mockResolvedValue([
      { name: 'Alice', email: 'alice@example.com', date: new Date('2024-01-01T00:00:00Z') },
      { name: 'Alice', email: 'alice@example.com', date: latestDate },
    ]);
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.extractContacts();
    expect(result[0].lastSeen).toBe(latestDate.toISOString());
  });

  it('caps results to 50 unique contacts', async () => {
    // Generate 60 unique senders, each with 1 message
    const envelopes = Array.from({ length: 60 }, (_, i) => ({
      name: `User ${i}`,
      email: `user${i}@example.com`,
      date: new Date('2024-01-01T00:00:00Z'),
    }));
    mockScanSenderEnvelopes.mockResolvedValue(envelopes);
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.extractContacts();
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('passes folder and count to scanSenderEnvelopes', async () => {
    mockScanSenderEnvelopes.mockResolvedValue([]);
    const service = new MailService(account, false);
    await service.connect();
    await service.extractContacts('Sent', 200);
    expect(mockScanSenderEnvelopes).toHaveBeenCalledWith('Sent', 200);
  });
});

describe('MailService createDraft with signature', () => {
  const baseAccount = { id: 'test', name: 'Test', user: 'test@example.com', authType: 'login' as const, host: 'imap.example.com', port: 993, useTLS: true };

  beforeEach(() => {
    mockImapAppendMessage.mockClear();
  });

  it('appends signature to draft body when account has signature and includeSignature is true (default)', async () => {
    const account = { ...baseAccount, signature: 'Regards' };
    const service = new MailService(account, false);
    await service.connect();
    await service.createDraft('to@example.com', 'Draft', 'Body text');
    expect(mockImapAppendMessage).toHaveBeenCalledOnce();
    const rawMessage: string = mockImapAppendMessage.mock.calls[0][1];
    // body ends with \r\n after joining, then effectiveBody appended — check signature present
    expect(rawMessage).toContain('Body text\n-- \nRegards');
  });

  it('does not append signature to draft when includeSignature is false', async () => {
    const account = { ...baseAccount, signature: 'Regards' };
    const service = new MailService(account, false);
    await service.connect();
    await service.createDraft('to@example.com', 'Draft', 'Body text', false, undefined, undefined, false);
    expect(mockImapAppendMessage).toHaveBeenCalledOnce();
    const rawMessage: string = mockImapAppendMessage.mock.calls[0][1];
    expect(rawMessage).not.toContain('-- \n');
    expect(rawMessage).toContain('Body text');
  });
});

describe('STATS-01: MailService.getMailboxStats', () => {
  const account = { id: 'test', name: 'Test', user: 'test@example.com', imap: {} as any, smtp: {} as any };

  beforeEach(() => {
    mockGetMailboxStatus.mockClear();
    mockListFolders.mockClear();
    mockGetMailboxStatus.mockResolvedValue([
      { name: 'INBOX', total: 100, unread: 5, recent: 2 },
      { name: 'Sent', total: 200, unread: 0, recent: 0 },
    ]);
    mockListFolders.mockResolvedValue(['INBOX', 'Sent', 'Drafts']);
  });

  it('calls getMailboxStatus with provided folders', async () => {
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.getMailboxStats(['INBOX', 'Sent']);
    expect(mockGetMailboxStatus).toHaveBeenCalledWith(['INBOX', 'Sent']);
    expect(result).toHaveLength(2);
  });

  it('calls listFolders then getMailboxStatus with all folders when no folders provided', async () => {
    const service = new MailService(account, false);
    await service.connect();
    mockGetMailboxStatus.mockResolvedValue([
      { name: 'INBOX', total: 100, unread: 5, recent: 2 },
      { name: 'Sent', total: 200, unread: 0, recent: 0 },
      { name: 'Drafts', total: 3, unread: 3, recent: 0 },
    ]);
    await service.getMailboxStats();
    expect(mockListFolders).toHaveBeenCalledOnce();
    expect(mockGetMailboxStatus).toHaveBeenCalledWith(['INBOX', 'Sent', 'Drafts']);
  });

  it('calls listFolders when empty array provided', async () => {
    const service = new MailService(account, false);
    await service.connect();
    await service.getMailboxStats([]);
    expect(mockListFolders).toHaveBeenCalledOnce();
  });

  it('returns status results from ImapClient', async () => {
    const service = new MailService(account, false);
    await service.connect();
    const result = await service.getMailboxStats(['INBOX', 'Sent']);
    expect(result[0]).toMatchObject({ name: 'INBOX', total: 100, unread: 5, recent: 2 });
    expect(result[1]).toMatchObject({ name: 'Sent', total: 200, unread: 0, recent: 0 });
  });
});
