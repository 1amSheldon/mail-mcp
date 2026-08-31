/**
 * Integration tests for SIEVE filter tools in MailMCPServer.
 * Tests cover: list_filters, get_filter, set_filter, delete_filter
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockListScripts = vi.fn().mockResolvedValue([
  { name: 'spam-filter', active: true },
  { name: 'vacation', active: false },
]);
const mockGetScript = vi.fn().mockResolvedValue('require ["fileinto"];\nfileinto "Spam";\n');
const mockPutScript = vi.fn().mockResolvedValue(undefined);
const mockDeleteScript = vi.fn().mockResolvedValue(undefined);

vi.mock('./protocol/sieve.js', () => {
  const SieveClient = vi.fn(function (this: any) {
    this.connect = mockConnect;
    this.disconnect = mockDisconnect;
    this.listScripts = mockListScripts;
    this.getScript = mockGetScript;
    this.putScript = mockPutScript;
    this.deleteScript = mockDeleteScript;
  });
  return { SieveClient };
});

vi.mock('./config.js', () => ({
  getAccounts: vi.fn().mockResolvedValue([
    {
      id: 'work',
      name: 'Work',
      host: 'mail.example.com',
      port: 993,
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      user: 'user@example.com',
      authType: 'login',
      useTLS: true,
      manageSievePort: 4190,
    },
  ]),
  getConfiguredAccounts: vi.fn().mockResolvedValue([
    {
      id: 'work',
      name: 'Work',
      host: 'mail.example.com',
      port: 993,
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      user: 'user@example.com',
      authType: 'login',
      useTLS: true,
      manageSievePort: 4190,
    },
  ]),
}));

vi.mock('./security/keychain.js', () => ({
  loadCredentials: vi.fn().mockResolvedValue('testpassword'),
}));

vi.mock('./utils/templates.js', () => ({
  getTemplates: vi.fn().mockResolvedValue([]),
  applyVariables: vi.fn(),
}));

vi.mock('./services/mail.js', () => {
  const MockMailService = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    imap: { onClose: null },
  }));
  return { MailService: MockMailService };
});

import { MailMCPServer } from './index.js';
import { SieveClient } from './protocol/sieve.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SIEVE-01: tool registration', () => {
  it('advertises all filter operations through the two routers', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const query = tools.find((tool: any) => tool.name === 'mail_query');
    const mutate = tools.find((tool: any) => tool.name === 'mail_mutate');
    expect(query.inputSchema.properties.operation.enum).toEqual(expect.arrayContaining([
      'listFilters', 'getFilter',
    ]));
    expect(mutate.inputSchema.properties.operation.enum).toEqual(expect.arrayContaining([
      'setFilter', 'deleteFilter',
    ]));
    expect(query.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(mutate.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

describe('SIEVE-03: read-only mode filtering', () => {
  it('mail_query is available and mail_mutate is absent', () => {
    const server = new MailMCPServer(true);
    const tools = (server as any).getTools(true);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('mail_query');
    expect(names).not.toContain('mail_mutate');
  });

  it('set_filter returns isError: true in read-only mode via dispatchTool', async () => {
    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('set_filter', true, {});
    expect(result.isError).toBe(true);
  });

  it('delete_filter returns isError: true in read-only mode via dispatchTool', async () => {
    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('delete_filter', true, {});
    expect(result.isError).toBe(true);
  });
});

describe('SIEVE-04: dispatchTool handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);
    mockListScripts.mockResolvedValue([
      { name: 'spam-filter', active: true },
      { name: 'vacation', active: false },
    ]);
    mockGetScript.mockResolvedValue('require ["fileinto"];\nfileinto "Spam";\n');
    mockPutScript.mockResolvedValue(undefined);
    mockDeleteScript.mockResolvedValue(undefined);
  });

  it('list_filters: calls SieveClient.listScripts and returns JSON', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('list_filters', false, { accountId: 'work' });

    expect(result.isError).not.toBe(true);
    const scripts = JSON.parse(result.content[0].text);
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toEqual({ name: 'spam-filter', active: true });
    expect(scripts[1]).toEqual({ name: 'vacation', active: false });
    expect(mockListScripts).toHaveBeenCalledOnce();
    expect(mockDisconnect).toHaveBeenCalledOnce();
  });

  it('get_filter: calls SieveClient.getScript and returns content', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('get_filter', false, {
      accountId: 'work',
      name: 'spam-filter',
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toBe('require ["fileinto"];\nfileinto "Spam";\n');
    expect(mockGetScript).toHaveBeenCalledWith('spam-filter');
    expect(mockDisconnect).toHaveBeenCalledOnce();
  });

  it('set_filter: calls SieveClient.putScript and returns success message', async () => {
    const server = new MailMCPServer(false);
    const scriptContent = 'require ["fileinto"];\nfileinto "Junk";\n';
    const result = await (server as any).dispatchTool('set_filter', false, {
      accountId: 'work',
      name: 'junk-filter',
      content: scriptContent,
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('junk-filter');
    expect(result.content[0].text).toContain('saved');
    expect(mockPutScript).toHaveBeenCalledWith('junk-filter', scriptContent);
    expect(mockDisconnect).toHaveBeenCalledOnce();
  });

  it('delete_filter: calls SieveClient.deleteScript and returns success message', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('delete_filter', false, {
      accountId: 'work',
      name: 'old-filter',
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('old-filter');
    expect(result.content[0].text).toContain('deleted');
    expect(mockDeleteScript).toHaveBeenCalledWith('old-filter');
    expect(mockDisconnect).toHaveBeenCalledOnce();
  });

  it('disconnect is called even when listScripts throws', async () => {
    mockListScripts.mockRejectedValue(new Error('SIEVE error'));
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('list_filters', false, { accountId: 'work' });

    expect(result.isError).toBe(true);
    expect(mockDisconnect).toHaveBeenCalledOnce();
  });

  it('list_filters: account not found returns isError: true', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('list_filters', false, { accountId: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});

describe('SIEVE-05: SieveClient constructor args', () => {
  it('SieveClient is created with host, manageSievePort, user, password', async () => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockListScripts.mockResolvedValue([]);

    const server = new MailMCPServer(false);
    await (server as any).dispatchTool('list_filters', false, { accountId: 'work' });

    expect(SieveClient).toHaveBeenCalledWith('mail.example.com', 4190, 'user@example.com', 'testpassword');
  });
});
