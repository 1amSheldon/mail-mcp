import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveCredentials: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', () => ({
  AUDIT_LOG_PATH: 'audit-test.log',
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'test', name: 'Test', user: 'test@example.com' },
  ]),
  getConfiguredAccounts: vi.fn().mockResolvedValue([
    { id: 'test', name: 'Test', user: 'test@example.com' },
  ]),
}));

vi.mock('./security/keychain.js', () => ({
  saveCredentials: mocks.saveCredentials,
  loadCredentials: vi.fn().mockResolvedValue('test-secret'),
}));

import { MailMCPServer } from './index.js';

function fakeService() {
  return {
    readEmail: vi.fn().mockResolvedValue('mail body'),
    readRawEmail: vi.fn().mockResolvedValue({
      locator: 'imap:v1:test',
      mediaType: 'message/rfc822',
      transferEncoding: 'base64',
      size: 3,
      contentBase64: Buffer.from('raw').toString('base64'),
    }),
    listMailboxMetadata: vi.fn().mockResolvedValue([{ path: 'INBOX' }, { path: 'Sent' }]),
    createMailbox: vi.fn().mockResolvedValue({ path: 'Projects', created: true }),
    renameMailbox: vi.fn().mockResolvedValue({ path: 'Projects', newPath: 'Archive/Projects' }),
    deleteMailbox: vi.fn().mockResolvedValue({ path: 'Archive/Projects' }),
    copyEmail: vi.fn().mockResolvedValue({ sourceLocator: 'imap:v1:test', destination: 'Archive' }),
    getThread: vi.fn().mockResolvedValue([{ uid: 1 }]),
    downloadAttachment: vi.fn().mockResolvedValue({
      content: Buffer.from('attachment'),
      contentType: 'text/plain',
    }),
    extractAttachmentText: vi.fn().mockResolvedValue('attachment text'),
    downloadLocatedAttachment: vi.fn().mockResolvedValue({
      content: Buffer.from('attachment'),
      contentType: 'text/plain',
    }),
    extractLocatedAttachmentText: vi.fn().mockResolvedValue('attachment text'),
    extractContacts: vi.fn().mockResolvedValue([{ email: 'a@example.com' }]),
    moveMessage: vi.fn().mockResolvedValue(undefined),
    invalidateBodyCache: vi.fn(),
    modifyLabels: vi.fn().mockResolvedValue(undefined),
    modifyLocatedLabels: vi.fn().mockResolvedValue(undefined),
    batchOperations: vi.fn().mockResolvedValue({ processed: 2 }),
    batchLocatedOperations: vi.fn().mockResolvedValue({ processed: 2 }),
    permanentlyDeleteEmail: vi.fn().mockResolvedValue(undefined),
    replyAllEmail: vi.fn().mockResolvedValue({
      status: 'sent_and_saved',
      smtpAccepted: true,
      accepted: ['a@example.com'],
      rejected: [],
      sentFolderSaved: true,
      retrySafe: false,
      nextAction: 'Do not resend this message.',
    }),
    replyLocatedEmail: vi.fn().mockResolvedValue({
      status: 'sent_and_saved',
      smtpAccepted: true,
      accepted: ['a@example.com'],
      rejected: [],
      sentFolderSaved: true,
      retrySafe: false,
      nextAction: 'Do not resend this message.',
    }),
    forwardLocatedEmail: vi.fn().mockResolvedValue({
      status: 'sent_and_saved',
      smtpAccepted: true,
      accepted: ['a@example.com'],
      rejected: [],
      sentFolderSaved: true,
      retrySafe: false,
      nextAction: 'Do not resend this message.',
    }),
    createDraft: vi.fn().mockResolvedValue(undefined),
    createDraftMessage: vi.fn().mockResolvedValue({
      folder: 'Localized Drafts',
      uid: 42,
      uidValidity: '7',
      locator: 'imap:v1:test-draft',
    }),
  };
}

describe('Recovered MCP dispatch handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['read_email', { accountId: 'test', uid: '1' }],
    ['list_folders', { accountId: 'test' }],
    ['get_raw_email', { accountId: 'test', locator: 'imap:v1:test' }],
    ['create_mailbox', { accountId: 'test', path: 'Projects' }],
    ['rename_mailbox', { accountId: 'test', path: 'Projects', newPath: 'Archive/Projects' }],
    ['delete_mailbox', { accountId: 'test', path: 'Archive/Projects' }],
    ['copy_email', { accountId: 'test', locator: 'imap:v1:test', targetFolder: 'Archive' }],
    ['get_thread', { accountId: 'test', threadId: 'thread-1' }],
    ['get_attachment', { accountId: 'test', uid: '1', filename: 'file.txt' }],
    ['extract_attachment_text', { accountId: 'test', uid: '1', filename: 'file.txt' }],
    ['get_attachment', { accountId: 'test', locator: 'imap:v1:test', filename: 'file.txt' }],
    ['extract_attachment_text', { accountId: 'test', locator: 'imap:v1:test', filename: 'file.txt' }],
    ['extract_contacts', { accountId: 'test' }],
    ['move_email', { accountId: 'test', uid: '1', sourceFolder: 'INBOX', targetFolder: 'Archive' }],
    ['modify_labels', { accountId: 'test', uid: '1', folder: 'INBOX', addLabels: ['\\Seen'] }],
    ['modify_labels', { accountId: 'test', locator: 'imap:v1:test', addLabels: ['\\Seen'] }],
    ['batch_operations', { accountId: 'test', uids: ['1', '2'], folder: 'INBOX', action: 'delete' }],
    ['batch_operations', { accountId: 'test', locators: ['imap:v1:test'], action: 'delete' }],
    ['permanently_delete_email', { accountId: 'test', uid: '1', folder: 'Trash' }],
    ['reply_all_email', { accountId: 'test', locator: 'imap:v1:test', body: 'Thanks' }],
    ['reply_email', { accountId: 'test', locator: 'imap:v1:test', body: 'Thanks' }],
    ['forward_email', { accountId: 'test', locator: 'imap:v1:test', to: 'a@example.com' }],
    ['mark_read', { accountId: 'test', locator: 'imap:v1:test' }],
    ['mark_unread', { accountId: 'test', locator: 'imap:v1:test' }],
    ['star', { accountId: 'test', locator: 'imap:v1:test' }],
    ['unstar', { accountId: 'test', locator: 'imap:v1:test' }],
  ])('%s executes a real handler instead of MethodNotFound', async (toolName, args) => {
    const server = new MailMCPServer(false);
    vi.spyOn(server as any, 'getService').mockResolvedValue(fakeService());

    const result = await (server as any).dispatchTool(toolName, false, args);

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text ?? '').not.toContain('Tool not found');
    await server.shutdown();
  });

  it('register_oauth2_account stores credentials for an existing account', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('register_oauth2_account', false, {
      accountId: 'test',
      clientId: 'client',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      tokenEndpoint: 'https://example.com/token',
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.saveCredentials).toHaveBeenCalledOnce();
    await server.shutdown();
  });

  it('register_oauth2_account rejects a remote plaintext token endpoint before saving credentials', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('register_oauth2_account', false, {
      accountId: 'test',
      clientId: 'client',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      tokenEndpoint: 'http://oauth.example.com/token',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HTTPS');
    expect(mocks.saveCredentials).not.toHaveBeenCalled();
    await server.shutdown();
  });

  it('create_draft forwards includeSignature to MailService', async () => {
    const service = fakeService();
    const server = new MailMCPServer(false);
    vi.spyOn(server as any, 'getService').mockResolvedValue(service);

    const result = await (server as any).dispatchTool('create_draft', false, {
      accountId: 'test',
      to: 'recipient@example.com',
      subject: 'Subject',
      body: 'Body',
      includeSignature: false,
    });

    expect(result.isError).not.toBe(true);
    expect(service.createDraftMessage).toHaveBeenCalledWith({
      to: 'recipient@example.com',
      subject: 'Subject',
      text: 'Body',
      includeSignature: false,
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      folder: 'Localized Drafts',
      locator: 'imap:v1:test-draft',
    });
    await server.shutdown();
  });
});
