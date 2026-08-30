import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveCredentials: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', () => ({
  AUDIT_LOG_PATH: 'audit-test.log',
  getAccounts: vi.fn().mockResolvedValue([
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
    listFolders: vi.fn().mockResolvedValue(['INBOX', 'Sent']),
    getThread: vi.fn().mockResolvedValue([{ uid: 1 }]),
    downloadAttachment: vi.fn().mockResolvedValue({
      content: Buffer.from('attachment'),
      contentType: 'text/plain',
    }),
    extractAttachmentText: vi.fn().mockResolvedValue('attachment text'),
    extractContacts: vi.fn().mockResolvedValue([{ email: 'a@example.com' }]),
    moveMessage: vi.fn().mockResolvedValue(undefined),
    invalidateBodyCache: vi.fn(),
    modifyLabels: vi.fn().mockResolvedValue(undefined),
    batchOperations: vi.fn().mockResolvedValue({ processed: 2 }),
    createDraft: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Recovered MCP dispatch handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['read_email', { accountId: 'test', uid: '1' }],
    ['list_folders', { accountId: 'test' }],
    ['get_thread', { accountId: 'test', threadId: 'thread-1' }],
    ['get_attachment', { accountId: 'test', uid: '1', filename: 'file.txt' }],
    ['extract_attachment_text', { accountId: 'test', uid: '1', filename: 'file.txt' }],
    ['extract_contacts', { accountId: 'test' }],
    ['move_email', { accountId: 'test', uid: '1', sourceFolder: 'INBOX', targetFolder: 'Archive' }],
    ['modify_labels', { accountId: 'test', uid: '1', folder: 'INBOX', addLabels: ['\\Seen'] }],
    ['batch_operations', { accountId: 'test', uids: ['1', '2'], folder: 'INBOX', action: 'delete' }],
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
    expect(service.createDraft).toHaveBeenCalledWith(
      'recipient@example.com',
      'Subject',
      'Body',
      undefined,
      undefined,
      undefined,
      false
    );
    await server.shutdown();
  });
});
