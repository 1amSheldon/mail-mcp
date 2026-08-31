import { beforeEach, describe, expect, it, vi } from 'vitest';

const imap = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  getMailboxIdentity: vi.fn().mockImplementation(async (path: string) => ({
    path,
    uidValidity: path === 'Archive' ? '456' : '123',
  })),
  listMessages: vi.fn().mockResolvedValue([]),
  searchMessages: vi.fn().mockResolvedValue([]),
  listMessageUids: vi.fn().mockResolvedValue([]),
  searchMessageUids: vi.fn().mockResolvedValue([]),
  fetchMessagesByUids: vi.fn().mockResolvedValue([]),
  fetchThreadMessages: vi.fn().mockResolvedValue([]),
  fetchMessageBody: vi.fn(),
  fetchRawMessage: vi.fn(),
  appendMessage: vi.fn().mockResolvedValue({ uid: 90 }),
  findSpecialUseFolder: vi.fn().mockResolvedValue(undefined),
  listFolders: vi.fn().mockResolvedValue(['INBOX', 'Sent', 'Drafts', '\u041a\u043e\u0440\u0437\u0438\u043d\u0430']),
  listMailboxMetadata: vi.fn().mockResolvedValue([]),
  createMailbox: vi.fn(),
  renameMailbox: vi.fn(),
  deleteMailbox: vi.fn(),
  copyMessage: vi.fn(),
  batchMoveMessages: vi.fn().mockResolvedValue(undefined),
  batchCopyMessages: vi.fn().mockResolvedValue({ destination: 'Archive', uidMap: {} }),
  batchModifyLabels: vi.fn().mockResolvedValue(undefined),
  moveMessage: vi.fn().mockResolvedValue(undefined),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  modifyLabels: vi.fn().mockResolvedValue(undefined),
};

const smtp = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue({
    messageId: '<sent@example.com>',
    accepted: ['recipient@example.com'],
    rejected: [],
    rawMessage: Buffer.from('Message-ID: <sent@example.com>\r\n\r\nBody'),
  }),
};

vi.mock('../protocol/imap.js', () => ({
  ImapClient: vi.fn(function () { return imap; }),
}));

vi.mock('../protocol/smtp.js', () => {
  class MockSmtpSendError extends Error {
    constructor(message: string, public readonly messageId: string) {
      super(message);
    }
  }
  class MockSmtpRecipientRejectedError extends Error {
    constructor(
      message: string,
      public readonly messageId: string,
      public readonly rejected: string[]
    ) {
      super(message);
    }
  }
  return {
    SmtpClient: vi.fn(function () { return smtp; }),
    SmtpSendError: MockSmtpSendError,
    SmtpRecipientRejectedError: MockSmtpRecipientRejectedError,
  };
});

import { encodeMessageLocator } from '../domain/message-locator.js';
import { MailService } from './mail.js';

const baseAccount = {
  id: 'account-1',
  name: 'Account',
  host: 'imap.example.com',
  port: 993,
  smtpHost: 'smtp.example.com',
  smtpPort: 465,
  user: 'me@example.com',
  authType: 'login' as const,
  useTLS: true,
};

function locator(mailbox = 'INBOX', uid = 7): string {
  return encodeMessageLocator({
    accountId: baseAccount.id,
    mailbox,
    uidValidity: mailbox === 'Archive' ? '456' : '123',
    uid,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  imap.getMailboxIdentity.mockImplementation(async (path: string) => ({
    path,
    uidValidity: path === 'Archive' ? '456' : '123',
  }));
  imap.listMessages.mockResolvedValue([]);
  imap.searchMessages.mockResolvedValue([]);
  imap.listMessageUids.mockResolvedValue([]);
  imap.searchMessageUids.mockResolvedValue([]);
  imap.fetchMessagesByUids.mockResolvedValue([]);
  imap.fetchThreadMessages.mockResolvedValue([]);
  imap.findSpecialUseFolder.mockResolvedValue(undefined);
  imap.listFolders.mockResolvedValue(['INBOX', 'Sent', 'Drafts', '\u041a\u043e\u0440\u0437\u0438\u043d\u0430']);
  imap.moveMessage.mockResolvedValue(undefined);
  imap.batchMoveMessages.mockResolvedValue(undefined);
  imap.batchCopyMessages.mockResolvedValue({ destination: 'Archive', uidMap: {} });
  imap.batchModifyLabels.mockResolvedValue(undefined);
  imap.modifyLabels.mockResolvedValue(undefined);
  imap.appendMessage.mockResolvedValue({ uid: 90 });
  smtp.connect.mockResolvedValue(undefined);
  smtp.sendMessage.mockResolvedValue({
    messageId: '<sent@example.com>',
    accepted: ['recipient@example.com'],
    rejected: [],
    rawMessage: Buffer.from('Message-ID: <sent@example.com>\r\n\r\nBody'),
  });
});

describe('MailService cursor and locator contracts', () => {
  it('continues from an immutable snapshot and returns stable message locators', async () => {
    imap.listMessageUids.mockResolvedValue([3, 2, 1]);
    imap.fetchMessagesByUids.mockImplementation(async (uids: number[]) => uids.map(uid => ({
      id: String(uid),
      uid,
      subject: ['One', 'Two', 'Three'][uid - 1],
    })));
    const service = new MailService(baseAccount);

    const first = await service.listEmailsPage({ limit: 2, headerOnly: true });
    const second = await service.listEmailsPage({ limit: 2, headerOnly: true, cursor: first.nextCursor! });

    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.id).toBe(first.items[0]?.locator);
    expect(first.items[0]?.locator).toMatch(/^imap:v1:/);
    expect(second.items.map(item => item.uid)).toEqual([1]);
    expect(imap.listMessageUids).toHaveBeenCalledTimes(1);
    expect(imap.fetchMessagesByUids).toHaveBeenCalledTimes(2);
  });

  it('rejects a cursor reused for another mailbox', async () => {
    imap.listMessageUids.mockResolvedValue([2, 1]);
    imap.fetchMessagesByUids.mockImplementation(async (uids: number[]) => (
      uids.map(uid => ({ id: String(uid), uid }))
    ));
    const service = new MailService(baseAccount);
    const first = await service.listEmailsPage({ folder: 'INBOX', limit: 1 });

    await expect(service.listEmailsPage({
      folder: 'Archive',
      limit: 1,
      cursor: first.nextCursor!,
    })).rejects.toThrow('does not match this query');
  });

  it('returns raw RFC822 bytes as a bounded structured base64 result', async () => {
    const raw = Buffer.from('From: sender@example.com\r\n\r\nHello');
    imap.fetchRawMessage.mockResolvedValue(raw);
    const service = new MailService(baseAccount);

    await expect(service.readRawEmail(locator(), 1024)).resolves.toEqual({
      locator: locator(),
      mediaType: 'message/rfc822',
      transferEncoding: 'base64',
      size: raw.length,
      contentBase64: raw.toString('base64'),
    });
    expect(imap.fetchRawMessage).toHaveBeenCalledWith('7', 'INBOX', 1024);
  });
});

describe('MailService redaction on standard reads', () => {
  it('redacts list and search metadata without changing stable identifiers', async () => {
    imap.listMessageUids.mockResolvedValue([7]);
    imap.searchMessageUids.mockResolvedValue([7]);
    imap.fetchMessagesByUids.mockResolvedValue([{
      id: '7',
      uid: 7,
      subject: 'password: hunter2',
      from: 'Card 4111 1111 1111 1111',
      snippet: 'SSN: 123-45-6789',
      threadId: 'thread-unchanged',
    }]);
    const service = new MailService(baseAccount, true);

    const listed = await service.listEmailsPage({ limit: 1 });
    const searched = await service.searchEmailsPage({ subject: 'invoice' }, { limit: 1 });

    for (const message of [listed.items[0], searched.items[0]]) {
      expect(message).toMatchObject({
        uid: 7,
        subject: 'password: [REDACTED]',
        from: 'Card [REDACTED CC]',
        snippet: 'SSN: [REDACTED SSN]',
        threadId: 'thread-unchanged',
      });
      expect(message.id).toBe(message.locator);
      expect(message.locator).toMatch(/^imap:v1:/);
    }
  });

  it('redacts human-readable thread metadata but preserves UID and thread ID', async () => {
    imap.fetchThreadMessages.mockResolvedValue([{
      id: '8',
      uid: 8,
      subject: 'password: hunter2',
      snippet: '4111-1111-1111-1111',
      threadId: 'thread-unchanged',
    }]);
    const service = new MailService(baseAccount, true);

    await expect(service.getThread('thread-unchanged')).resolves.toEqual([{
      id: '8',
      uid: 8,
      subject: 'password: [REDACTED]',
      snippet: '[REDACTED CC]',
      threadId: 'thread-unchanged',
    }]);
  });
});

describe('MailService Sent copy policy', () => {
  it('does not append a duplicate Sent copy for Gmail in auto mode', async () => {
    const service = new MailService({
      ...baseAccount,
      host: 'imap.gmail.com',
      smtpHost: 'smtp.gmail.com',
      sentPolicy: 'auto' as const,
    });
    const result = await service.sendMessage({
      to: 'recipient@example.com',
      subject: 'Subject',
      text: 'Body',
    });

    expect(result.status).toBe('sent_provider_managed');
    expect(imap.appendMessage).not.toHaveBeenCalled();
    expect(smtp.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('appends the exact SMTP MIME bytes when policy is always', async () => {
    const rawMessage = Buffer.from('Message-ID: <exact@example.com>\r\n\r\nExact bytes');
    smtp.sendMessage.mockResolvedValueOnce({
      messageId: '<exact@example.com>',
      accepted: ['recipient@example.com'],
      rejected: [],
      rawMessage,
    });
    const service = new MailService({
      ...baseAccount,
      host: 'imap.gmail.com',
      sentPolicy: 'always' as const,
    });
    await service.sendMessage({ to: 'recipient@example.com', subject: 'Subject', text: 'Body' });

    expect(imap.appendMessage).toHaveBeenCalledWith('Sent', rawMessage, ['\\Seen']);
  });
});

describe('MailService reply all and batch safety', () => {
  it('deduplicates the account and repeated recipients and can retain original attachments', async () => {
    imap.fetchMessageBody.mockResolvedValue({
      subject: 'Original',
      messageId: '<original@example.com>',
      headers: new Map(),
      from: { value: [{ address: 'sender@example.com', name: '' }] },
      to: { value: [
        { address: 'ME@example.com', name: '' },
        { address: 'friend@example.com', name: '' },
      ] },
      cc: { value: [
        { address: 'FRIEND@example.com', name: '' },
        { address: 'other@example.com', name: '' },
      ] },
      attachments: [{
        filename: 'report.txt',
        contentType: 'text/plain',
        contentDisposition: 'attachment',
        content: Buffer.from('report'),
      }],
    });
    const service = new MailService(baseAccount);
    await service.replyAllEmail(locator(), 'Reply', { includeOriginalAttachments: true });

    expect(smtp.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: 'sender@example.com',
      cc: 'friend@example.com, other@example.com',
      threading: {
        inReplyTo: '<original@example.com>',
        references: '<original@example.com>',
      },
      attachments: [{
        contentBase64: Buffer.from('report').toString('base64'),
        filename: 'report.txt',
        contentType: 'text/plain',
        contentDisposition: 'attachment',
      }],
    }));
  });

  it('uses one IMAP bulk command and reports one result per requested item', async () => {
    const service = new MailService(baseAccount);

    const result = await service.batchOperations(
      ['1', '2', '3'],
      'INBOX',
      { type: 'label', addLabels: ['\\Seen'] }
    );

    expect(result).toEqual({
      processed: 3,
      succeeded: 3,
      failed: 0,
      items: [
        { uid: '1', success: true },
        { uid: '2', success: true },
        { uid: '3', success: true },
      ],
    });
    expect(imap.batchModifyLabels).toHaveBeenCalledWith(
      ['1', '2', '3'],
      'INBOX',
      ['\\Seen'],
      [],
    );
  });

  it('resolves cursor locators once per mailbox and keeps locator identity in results', async () => {
    const first = locator('INBOX', 1);
    const second = locator('INBOX', 2);
    const service = new MailService(baseAccount);

    const result = await service.batchLocatedOperations(
      [first, second],
      { type: 'label', addLabels: ['\\Flagged'] },
    );

    expect(imap.getMailboxIdentity).toHaveBeenCalledTimes(1);
    expect(imap.batchModifyLabels).toHaveBeenCalledWith(
      ['1', '2'],
      'INBOX',
      ['\\Flagged'],
      [],
    );
    expect(result).toEqual({
      processed: 2,
      succeeded: 2,
      failed: 0,
      items: [
        { uid: '1', locator: first, success: true },
        { uid: '2', locator: second, success: true },
      ],
    });
  });

  it('does not retry a failed bulk command whose server outcome may be unknown', async () => {
    imap.batchModifyLabels.mockRejectedValueOnce(new Error('connection lost after command'));
    const service = new MailService(baseAccount);

    const result = await service.batchOperations(
      ['1', '2'],
      'INBOX',
      { type: 'label', addLabels: ['\\Seen'] },
    );

    expect(result).toEqual({
      processed: 2,
      succeeded: 0,
      failed: 2,
      items: [
        { uid: '1', success: false, error: 'connection lost after command' },
        { uid: '2', success: false, error: 'connection lost after command' },
      ],
    });
    expect(imap.modifyLabels).not.toHaveBeenCalled();
  });
});
