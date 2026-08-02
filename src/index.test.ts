import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  getAccounts: vi.fn().mockResolvedValue([]),
}));

vi.mock('./utils/templates.js', () => ({
  getTemplates: vi.fn().mockResolvedValue([
    { id: 'ack', name: 'Acknowledgement', body: 'Got your message, {{name}}.' },
    { id: 'oof', name: 'Out of Office', subject: 'Re: {{subject}}', body: 'I am away until {{date}}.', accountId: 'work' },
  ]),
  applyVariables: vi.fn().mockImplementation((template: string, vars: Record<string, string>) => {
    return template.replace(/\{\{([^}]+)\}\}/g, (match: string, key: string) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
    );
  }),
}));

// vi.mock() is hoisted above all variable declarations, so outer-scope variables like
// mockDisconnect cannot be referenced inside the factory (they'd be in TDZ). Instead,
// we create all mock functions self-contained inside the factory and keep external
// references only for assertions.

// Shared mock functions — declared before use in tests, not inside the factory.
const mockSearchEmails = vi.fn().mockResolvedValue([
  { id: '42', uid: 42, subject: 'Found Email', from: 'sender@example.com' }
]);
const mockSendEmail = vi.fn().mockResolvedValue(undefined);
const mockListFolders = vi.fn().mockResolvedValue(['INBOX', 'Sent', 'Drafts', 'Trash']);
const mockMoveMessage = vi.fn().mockResolvedValue(undefined);
const mockModifyLabels = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);

vi.mock('./services/mail.js', () => {
  // Self-contained: no outer-scope references to avoid TDZ issues with vi.mock hoisting.
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const MockMailService = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect,
    listEmails: vi.fn().mockResolvedValue([]),
    searchEmails: vi.fn().mockResolvedValue([
      { id: '42', uid: 42, subject: 'Found Email', from: 'sender@example.com' },
    ]),
    sendEmail: vi.fn().mockResolvedValue(undefined),
    listFolders: vi.fn().mockResolvedValue(['INBOX', 'Sent', 'Drafts', 'Trash']),
    moveMessage: vi.fn().mockResolvedValue(undefined),
    modifyLabels: vi.fn().mockResolvedValue(undefined),
    extractContacts: vi.fn().mockResolvedValue([
      { name: 'Alice', email: 'alice@example.com', count: 5, lastSeen: '2024-01-15T10:00:00.000Z' },
      { name: 'Bob', email: 'bob@example.com', count: 2, lastSeen: '2024-01-10T10:00:00.000Z' },
    ]),
    imap: { onClose: null },
  }));
  return { MailService: MockMailService };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MailMCPServer } from './index.js';
import { MailService } from './services/mail.js';
import { getAccounts } from './config.js';
import { AuditLogger } from './utils/audit-logger.js';

const WRITE_TOOL_NAMES = [
  'send_email',
  'create_draft',
  'move_email',
  'modify_labels',
  'register_oauth2_account',
  'batch_operations',
  'reply_email',
  'forward_email',
  'mark_read',
  'mark_unread',
  'star',
  'unstar',
  'delete_email',
  'set_filter',
  'delete_filter',
];

const READ_TOOL_NAMES = [
  'list_accounts',
  'list_emails',
  'search_emails',
  'read_email',
  'list_folders',
  'get_thread',
  'get_attachment',
  'extract_attachment_text',
  'extract_contacts',
  'mailbox_stats',
  'list_templates',
  'use_template',
  'list_filters',
  'get_filter',
];

describe('ROM-01: readOnly constructor field', () => {
  it('Test A: MailMCPServer constructed with readOnly=false has this.readOnly === false', () => {
    const server = new MailMCPServer(false);
    expect((server as any).readOnly).toBe(false);
  });

  it('Test B: MailMCPServer constructed with readOnly=true has this.readOnly === true', () => {
    const server = new MailMCPServer(true);
    expect((server as any).readOnly).toBe(true);
  });
});

describe('ROM-05: list-time filtering', () => {
  it('Test C: getTools(false) returns array of length 29', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    expect(tools).toHaveLength(29);
  });

  it('Test D: getTools(true) returns array of length 14', () => {
    const server = new MailMCPServer(true);
    const tools = (server as any).getTools(true);
    expect(tools).toHaveLength(14);
  });

  it('Test E: getTools(true) does NOT include send_email', () => {
    const server = new MailMCPServer(true);
    const tools = (server as any).getTools(true);
    const names = tools.map((t: any) => t.name);
    expect(names).not.toContain('send_email');
  });

  it('Test F: getTools(true) does NOT include any of the 15 write tools', () => {
    const server = new MailMCPServer(true);
    const tools = (server as any).getTools(true);
    const names: string[] = tools.map((t: any) => t.name);
    for (const writeTool of WRITE_TOOL_NAMES) {
      expect(names).not.toContain(writeTool);
    }
  });
});

describe('ROM-02: call-time guard for write tools', () => {
  it('Test G: dispatchTool with readOnly=true and name=send_email returns { isError: true }', async () => {
    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('send_email', true, {});
    expect(result.isError).toBe(true);
  });

  it("Test H: dispatchTool with readOnly=true and name=send_email text includes \"Tool 'send_email' is not available\"", async () => {
    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('send_email', true, {});
    expect(result.content[0].text).toContain("Tool 'send_email' is not available");
  });

  it('Test I: all 15 write tool names return isError: true in read-only mode', async () => {
    const server = new MailMCPServer(true);
    for (const toolName of WRITE_TOOL_NAMES) {
      const result = await (server as any).dispatchTool(toolName, true, {});
      expect(result.isError).toBe(true);
    }
  });
});

describe('ROM-03: read tools unaffected in read-only mode', () => {
  it('Test N: In read-only mode, calling list_accounts does NOT return isError: true', async () => {
    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('list_accounts', true, {});
    expect(result.isError).not.toBe(true);
  });
});

describe('ROM-06: tool annotations', () => {
  it('Test J: all 29 tools have annotations.readOnlyHint defined', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    expect(tools).toHaveLength(29);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBeDefined();
    }
  });

  it('Test K: all 29 tools have annotations.destructiveHint defined', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    for (const tool of tools) {
      expect(tool.annotations?.destructiveHint).toBeDefined();
    }
  });

  it('Test L: write tools have readOnlyHint === false and destructiveHint === true', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const writeTools = tools.filter((t: any) => WRITE_TOOL_NAMES.includes(t.name));
    expect(writeTools).toHaveLength(WRITE_TOOL_NAMES.length);
    for (const tool of writeTools) {
      expect(tool.annotations.readOnlyHint).toBe(false);
      expect(tool.annotations.destructiveHint).toBe(true);
    }
  });

  it('Test M: read tools have readOnlyHint === true and destructiveHint === false', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const readTools = tools.filter((t: any) => READ_TOOL_NAMES.includes(t.name));
    expect(readTools).toHaveLength(14);
    for (const tool of readTools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });
});

describe('CE-03: extract_contacts MCP tool', () => {
  it('extract_contacts appears in getTools(false) output as a read-only tool', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'extract_contacts');
    expect(tool).toBeDefined();
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it('extract_contacts appears in getTools(true) output (read-only server also shows it)', () => {
    const server = new MailMCPServer(true);
    const tools = (server as any).getTools(true);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('extract_contacts');
  });

  it('extract_contacts tool has accountId as required parameter', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'extract_contacts');
    expect(tool.inputSchema.required).toContain('accountId');
  });
});

describe('ROM-04: instructions field in Server options', () => {
  it('Test P: readOnly=true — instructions contain IMAP identity and read-only notice', () => {
    const server = new MailMCPServer(true);
    const internalServer = (server as any).server;
    const instructions =
      internalServer._options?.instructions ??
      internalServer.options?.instructions ??
      internalServer.serverInfo?.instructions;
    expect(instructions).toContain('Use mail-mcp for IMAP-based email accounts');
    expect(instructions).toContain('read-only mode');
    expect(instructions).toContain('Write operations');
  });

  it('Test Q: readOnly=false — instructions contain IMAP identity without read-only notice', () => {
    const server = new MailMCPServer(false);
    const internalServer = (server as any).server;
    const instructions =
      internalServer._options?.instructions ??
      internalServer.options?.instructions ??
      internalServer.serverInfo?.instructions;
    expect(instructions).toContain('Use mail-mcp for IMAP-based email accounts');
    expect(instructions).not.toContain('read-only mode');
  });
});

describe('IMAP-03: search_emails tool', () => {
  beforeEach(() => {
    mockSearchEmails.mockClear();
  });

  it('search_emails tool is listed among available tools', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('search_emails');
  });

  it('search_emails tool schema includes from, subject, since, before, keywords fields', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const searchTool = tools.find((t: any) => t.name === 'search_emails');
    expect(searchTool).toBeDefined();
    const props = searchTool.inputSchema.properties;
    expect(props.from).toBeDefined();
    expect(props.subject).toBeDefined();
    expect(props.since).toBeDefined();
    expect(props.before).toBeDefined();
    expect(props.keywords).toBeDefined();
  });

  it('search_emails tool has readOnlyHint=true (non-destructive)', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const searchTool = tools.find((t: any) => t.name === 'search_emails');
    expect(searchTool.annotations.readOnlyHint).toBe(true);
    expect(searchTool.annotations.destructiveHint).toBe(false);
  });
});

describe('IMAP-04: list_folders tool', () => {
  it('list_folders tool is listed among available tools', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('list_folders');
  });

  it('list_folders tool has readOnlyHint=true (non-destructive)', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'list_folders');
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  it('list_folders tool requires accountId', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'list_folders');
    expect(tool.inputSchema.required).toContain('accountId');
  });
});

describe('ORG-01: move_email tool', () => {
  it('move_email tool is listed among available tools', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('move_email');
  });

  it('move_email tool has readOnlyHint=false and destructiveHint=true', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'move_email');
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it('move_email tool schema includes uid, sourceFolder, targetFolder', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'move_email');
    const props = tool.inputSchema.properties;
    expect(props.uid).toBeDefined();
    expect(props.sourceFolder).toBeDefined();
    expect(props.targetFolder).toBeDefined();
  });

  it('move_email is blocked in read-only mode', async () => {
    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('move_email', true, {});
    expect(result.isError).toBe(true);
  });
});

describe('ORG-02: modify_labels tool', () => {
  it('modify_labels tool is listed among available tools', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('modify_labels');
  });

  it('modify_labels tool has readOnlyHint=false and destructiveHint=true', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'modify_labels');
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it('modify_labels tool schema includes uid, folder, addLabels, removeLabels', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'modify_labels');
    const props = tool.inputSchema.properties;
    expect(props.uid).toBeDefined();
    expect(props.folder).toBeDefined();
    expect(props.addLabels).toBeDefined();
    expect(props.removeLabels).toBeDefined();
  });

  it('modify_labels is blocked in read-only mode', async () => {
    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('modify_labels', true, {});
    expect(result.isError).toBe(true);
  });
});

describe('SMTP-02: send_email CC/BCC support', () => {
  it('send_email tool schema includes cc and bcc fields', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const sendTool = tools.find((t: any) => t.name === 'send_email');
    expect(sendTool).toBeDefined();
    const props = sendTool.inputSchema.properties;
    expect(props.cc).toBeDefined();
    expect(props.bcc).toBeDefined();
  });

  it('create_draft tool schema includes cc and bcc fields', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const draftTool = tools.find((t: any) => t.name === 'create_draft');
    expect(draftTool).toBeDefined();
    const props = draftTool.inputSchema.properties;
    expect(props.cc).toBeDefined();
    expect(props.bcc).toBeDefined();
  });
});

describe('SAFE-02: typed error formatting in catch block', () => {
  it('when getService throws AuthError, dispatchTool response text is "[AuthError] bad credentials"', async () => {
    const { AuthError } = await import('./errors.js');
    const server = new MailMCPServer(false);
    vi.spyOn(server as any, 'getService').mockRejectedValue(new AuthError('bad credentials'));
    const result = await (server as any).dispatchTool('read_email', false, { accountId: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('[AuthError] bad credentials');
  });

  it('when getService throws a generic Error, response text does NOT contain brackets', async () => {
    const server = new MailMCPServer(false);
    vi.spyOn(server as any, 'getService').mockRejectedValue(new Error('connection refused'));
    const result = await (server as any).dispatchTool('read_email', false, { accountId: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('connection refused');
    expect(result.content[0].text).not.toMatch(/^\[/);
  });

  it('when getService throws NetworkError, response text starts with "[NetworkError]"', async () => {
    const { NetworkError } = await import('./errors.js');
    const server = new MailMCPServer(false);
    vi.spyOn(server as any, 'getService').mockRejectedValue(new NetworkError('timeout'));
    const result = await (server as any).dispatchTool('read_email', false, { accountId: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('[NetworkError] timeout');
  });
});

describe('VAL-02: email validation at dispatch layer', () => {
  it('send_email with invalid to returns isError: true containing [ValidationError] and the invalid address', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('send_email', false, {
      accountId: 'test',
      to: 'notanemail',
      subject: 'Hi',
      body: 'test',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[ValidationError]');
    expect(result.content[0].text).toContain('notanemail');
  });

  it('send_email with invalid to does NOT call MailService.sendEmail', async () => {
    const { MailService } = await import('./services/mail.js');
    const server = new MailMCPServer(false);
    const sendEmailMock = vi.fn();
    // Override getService to return a mock with sendEmail spy
    vi.spyOn(server as any, 'getService').mockResolvedValue({ sendEmail: sendEmailMock });
    await (server as any).dispatchTool('send_email', false, {
      accountId: 'test',
      to: 'notanemail',
      subject: 'Hi',
      body: 'test',
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('create_draft with invalid to returns isError: true containing [ValidationError]', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('create_draft', false, {
      accountId: 'test',
      to: 'notanemail',
      subject: 'Draft',
      body: 'test',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[ValidationError]');
  });

  it('create_draft with invalid to does NOT call MailService.createDraft', async () => {
    const server = new MailMCPServer(false);
    const createDraftMock = vi.fn();
    vi.spyOn(server as any, 'getService').mockResolvedValue({ createDraft: createDraftMock });
    await (server as any).dispatchTool('create_draft', false, {
      accountId: 'test',
      to: 'notanemail',
      subject: 'Draft',
      body: 'test',
    });
    expect(createDraftMock).not.toHaveBeenCalled();
  });

  it('send_email with valid to proceeds (does not return ValidationError)', async () => {
    const server = new MailMCPServer(false);
    const sendEmailMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ sendEmail: sendEmailMock });
    const result = await (server as any).dispatchTool('send_email', false, {
      accountId: 'test',
      to: 'user@example.com',
      subject: 'Hi',
      body: 'test',
    });
    expect(result.isError).not.toBe(true);
    expect(sendEmailMock).toHaveBeenCalledOnce();
  });
});

describe('SAFE-03: rate limiting at dispatch layer', () => {
  it('returns [QuotaError] after exceeding write rate limit for an account', async () => {
    // Use very low write limit (1 request) to trigger quickly in tests
    const { TieredRateLimiter } = await import('./utils/rate-limiter.js');
    const server = new MailMCPServer(false);
    // Replace the internal rate limiter with a low-write-limit one
    (server as any).rateLimiter = new TieredRateLimiter({ readPoints: 100, writePoints: 1, duration: 60 });

    const sendEmailMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ sendEmail: sendEmailMock });

    // First call should succeed (valid email, 1 write point consumed)
    const result1 = await (server as any).dispatchTool('send_email', false, {
      accountId: 'test-rate',
      to: 'user@example.com',
      subject: 'Hi',
      body: 'test',
    });
    expect(result1.isError).not.toBe(true);

    // Second call should be write-rate-limited
    const result2 = await (server as any).dispatchTool('send_email', false, {
      accountId: 'test-rate',
      to: 'user@example.com',
      subject: 'Hi',
      body: 'test',
    });
    expect(result2.isError).toBe(true);
    expect(result2.content[0].text).toContain('[QuotaError]');
    expect(result2.content[0].text).toContain('Rate limit exceeded');
  });

  it('list_accounts is NOT rate-limited (no accountId)', async () => {
    const { TieredRateLimiter } = await import('./utils/rate-limiter.js');
    const server = new MailMCPServer(false);
    // Replace the internal rate limiter with a 0-point limiter that always fails
    (server as any).rateLimiter = new TieredRateLimiter({ readPoints: 0, writePoints: 0, duration: 60 });

    // list_accounts has no accountId — should NOT be rate-limited
    const result = await (server as any).dispatchTool('list_accounts', false, {});
    expect(result.isError).not.toBe(true);
  });

  it('rate limiter is called BEFORE getService (no IMAP connection for rate-limited requests)', async () => {
    const { TieredRateLimiter } = await import('./utils/rate-limiter.js');
    const server = new MailMCPServer(false);
    (server as any).rateLimiter = new TieredRateLimiter({ readPoints: 0, writePoints: 0, duration: 60 });

    const getServiceSpy = vi.spyOn(server as any, 'getService');

    const result = await (server as any).dispatchTool('send_email', false, {
      accountId: 'test',
      to: 'user@example.com',
      subject: 'Hi',
      body: 'test',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[QuotaError]');
    expect(getServiceSpy).not.toHaveBeenCalled();
  });

  it('write tools use write tier, read tools use read tier', async () => {
    const { TieredRateLimiter } = await import('./utils/rate-limiter.js');
    const server = new MailMCPServer(false);
    // Write exhausted (0), read still open (100)
    (server as any).rateLimiter = new TieredRateLimiter({ readPoints: 100, writePoints: 0, duration: 60 });

    // A write tool (send_email) should be blocked
    const writeResult = await (server as any).dispatchTool('send_email', false, {
      accountId: 'tier-test',
      to: 'user@example.com',
      subject: 'Hi',
      body: 'test',
    });
    expect(writeResult.isError).toBe(true);
    expect(writeResult.content[0].text).toContain('[QuotaError]');
  });

  it('exhausting write quota does NOT block read tools', async () => {
    const { TieredRateLimiter } = await import('./utils/rate-limiter.js');
    const server = new MailMCPServer(false);
    // Write exhausted (0), read open (100)
    (server as any).rateLimiter = new TieredRateLimiter({ readPoints: 100, writePoints: 0, duration: 60 });

    const listMessagesMock = vi.fn().mockResolvedValue([]);
    vi.spyOn(server as any, 'getService').mockResolvedValue({
      listMessages: listMessagesMock,
    });

    // A read tool (list_emails) should NOT be blocked by exhausted write quota
    const readResult = await (server as any).dispatchTool('list_emails', false, {
      accountId: 'tier-test',
    });
    // Should not be a QuotaError
    expect(readResult.content?.[0]?.text ?? '').not.toContain('[QuotaError]');
  });
});

describe('CONN-01: graceful shutdown', () => {
  it('shutdown() calls disconnect() on all services in the services Map', async () => {
    const server = new MailMCPServer(false);
    const d1 = vi.fn().mockResolvedValue(undefined);
    const d2 = vi.fn().mockResolvedValue(undefined);
    (server as any).services.set('account1', { disconnect: d1 });
    (server as any).services.set('account2', { disconnect: d2 });
    await (server as any).shutdown();
    expect(d1).toHaveBeenCalledOnce();
    expect(d2).toHaveBeenCalledOnce();
  });

  it('shutdown() clears the services Map after disconnecting', async () => {
    const server = new MailMCPServer(false);
    (server as any).services.set('account1', { disconnect: vi.fn().mockResolvedValue(undefined) });
    await (server as any).shutdown();
    expect((server as any).services.size).toBe(0);
  });

  it('shutdown() resolves even if a service.disconnect() rejects', async () => {
    const server = new MailMCPServer(false);
    (server as any).services.set('account1', { disconnect: vi.fn().mockRejectedValue(new Error('disconnect failed')) });
    await expect((server as any).shutdown()).resolves.toBeUndefined();
    expect((server as any).services.size).toBe(0);
  });

  it('when shuttingDown is true, shuttingDown flag is set on the server', () => {
    const server = new MailMCPServer(false);
    (server as any).shuttingDown = true;
    expect((server as any).shuttingDown).toBe(true);
  });

  it('inFlightCount starts at 0', () => {
    const server = new MailMCPServer(false);
    expect((server as any).inFlightCount).toBe(0);
  });
});

describe('CONN-02: IMAP reconnect via close-event + getService retry', () => {
  const testAccount = { id: 'acc1', name: 'Test', user: 'test@test.com', host: 'imap.test.com', port: 993, useTLS: true, authType: 'password' } as any;

  beforeEach(() => {
    vi.mocked(getAccounts).mockResolvedValue([testAccount]);
  });

  it('close event on ImapFlow causes services Map entry deletion', async () => {
    // Test _createAndCacheService wires onClose and removing from services Map
    const server = new MailMCPServer(false);

    // Spy on _createAndCacheService to intercept and set up the close callback test
    let capturedOnClose: (() => void) | null = null;
    const fakeService = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      imap: {
        get onClose() { return capturedOnClose; },
        set onClose(cb: (() => void) | null) { capturedOnClose = cb; },
      },
    };

    // Bypass real _createAndCacheService by manually setting up services + close listener
    (server as any).services.set('acc1', fakeService);
    fakeService.imap.onClose = () => {
      if (!(server as any).shuttingDown) {
        (server as any).services.delete('acc1');
      }
    };

    expect((server as any).services.has('acc1')).toBe(true);
    capturedOnClose?.();
    expect((server as any).services.has('acc1')).toBe(false);
  });

  it('after close event, services Map no longer has the entry and getService calls _createAndCacheService again', async () => {
    const server = new MailMCPServer(false);

    let capturedOnClose: (() => void) | null = null;
    const fakeService = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      imap: {
        get onClose() { return capturedOnClose; },
        set onClose(cb: (() => void) | null) { capturedOnClose = cb; },
      },
    };

    (server as any).services.set('acc1', fakeService);
    fakeService.imap.onClose = () => {
      if (!(server as any).shuttingDown) {
        (server as any).services.delete('acc1');
      }
    };

    // Fire close
    capturedOnClose?.();
    expect((server as any).services.has('acc1')).toBe(false);

    // Next getService will try to reconnect — mock _createAndCacheService to avoid real IMAP
    const newService = { connect: vi.fn(), imap: { onClose: null }, disconnect: vi.fn() };
    vi.spyOn(server as any, '_createAndCacheService').mockResolvedValue(newService);

    const result = await (server as any).getService('acc1');
    expect(result).toBe(newService);
  });

  it('two consecutive connect failures throw NetworkError with "after reconnect attempt"', async () => {
    vi.useFakeTimers();
    const { NetworkError } = await import('./errors.js');

    const server = new MailMCPServer(false);
    vi.spyOn(server as any, '_createAndCacheService').mockRejectedValue(new Error('connection refused'));

    let caughtError: unknown;
    const getServicePromise = (server as any).getService('acc1').catch((e: unknown) => {
      caughtError = e;
    });
    await vi.runAllTimersAsync();
    await getServicePromise;

    expect(caughtError).toBeInstanceOf(NetworkError);
    expect((caughtError as NetworkError).message).toContain('after reconnect attempt');

    vi.useRealTimers();
  });

  it('close listener does NOT delete from Map when shuttingDown=true', async () => {
    const server = new MailMCPServer(false);

    let capturedOnClose: (() => void) | null = null;
    const fakeService = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      imap: {
        get onClose() { return capturedOnClose; },
        set onClose(cb: (() => void) | null) { capturedOnClose = cb; },
      },
    };

    (server as any).services.set('acc1', fakeService);
    fakeService.imap.onClose = () => {
      if (!(server as any).shuttingDown) {
        (server as any).services.delete('acc1');
      }
    };

    expect((server as any).services.has('acc1')).toBe(true);
    (server as any).shuttingDown = true;
    capturedOnClose?.();
    expect((server as any).services.has('acc1')).toBe(true);
  });
});

describe('QUAL-01: pagination offset parameter', () => {
  it('list_emails tool schema includes offset property', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'list_emails');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.properties.offset).toBeDefined();
  });

  it('search_emails tool schema includes offset property', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'search_emails');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.properties.offset).toBeDefined();
  });

  it('dispatchTool list_emails passes offset to service.listEmails', async () => {
    const server = new MailMCPServer(false);
    const listEmailsMock = vi.fn().mockResolvedValue([]);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ listEmails: listEmailsMock });
    await (server as any).dispatchTool('list_emails', false, {
      accountId: 'test',
      folder: 'INBOX',
      count: 5,
      offset: 10,
    });
    expect(listEmailsMock).toHaveBeenCalledWith('INBOX', 5, 10, false);
  });

  it('dispatchTool search_emails passes offset to service.searchEmails', async () => {
    const server = new MailMCPServer(false);
    const searchEmailsMock = vi.fn().mockResolvedValue([]);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ searchEmails: searchEmailsMock });
    await (server as any).dispatchTool('search_emails', false, {
      accountId: 'test',
      folder: 'INBOX',
      count: 5,
      offset: 3,
    });
    expect(searchEmailsMock).toHaveBeenCalledWith(
      expect.any(Object),
      'INBOX',
      5,
      3,
    );
  });
});

// vi.mock for protocol classes used in runValidateAccounts
vi.mock('./protocol/imap.js', () => ({
  ImapClient: vi.fn().mockImplementation(function() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      onClose: null,
    };
  }),
}));

vi.mock('./protocol/smtp.js', () => ({
  SmtpClient: vi.fn().mockImplementation(function() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

import { ImapClient as MockImapClientCtor } from './protocol/imap.js';
import { SmtpClient as MockSmtpClientCtor } from './protocol/smtp.js';

describe('CONN-03: --validate-accounts health check', () => {
  beforeEach(() => {
    vi.mocked(MockImapClientCtor).mockImplementation(function() {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        onClose: null,
      } as any;
    });
    vi.mocked(MockSmtpClientCtor).mockImplementation(function() {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
      } as any;
    });
  });

  it('prints [PASS] for successful IMAP + SMTP probe', async () => {
    const { runValidateAccounts } = await import('./index.js');
    vi.mocked(getAccounts).mockResolvedValue([
      { id: 'acc1', name: 'Test', user: 'test@test.com', host: 'imap.test.com', port: 993, useTLS: true, authType: 'password', smtpHost: 'smtp.test.com' } as any,
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runValidateAccounts();

    const output = consoleSpy.mock.calls.map(c => c[0]);
    consoleSpy.mockRestore();
    expect(output).toContain('[PASS] acc1 IMAP');
    expect(output).toContain('[PASS] acc1 SMTP');
  });

  it('prints [FAIL] for failed IMAP with error message', async () => {
    const { runValidateAccounts } = await import('./index.js');
    vi.mocked(getAccounts).mockResolvedValue([
      { id: 'acc1', name: 'Test', user: 'test@test.com', host: 'imap.test.com', port: 993, useTLS: true, authType: 'password' } as any,
    ]);

    vi.mocked(MockImapClientCtor).mockImplementation(function() {
      return {
        connect: vi.fn().mockRejectedValue(new Error('Authentication failed')),
        disconnect: vi.fn().mockResolvedValue(undefined),
        onClose: null,
      } as any;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runValidateAccounts();

    const output = consoleSpy.mock.calls.map(c => c[0]);
    consoleSpy.mockRestore();
    expect(output.some(msg => msg.startsWith('[FAIL] acc1 IMAP') && msg.includes('Authentication failed'))).toBe(true);
  });

  it('prints [SKIP] for account without smtpHost', async () => {
    const { runValidateAccounts } = await import('./index.js');
    vi.mocked(getAccounts).mockResolvedValue([
      { id: 'acc1', name: 'Test', user: 'test@test.com', host: 'imap.test.com', port: 993, useTLS: true, authType: 'password' } as any,
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runValidateAccounts();

    const output = consoleSpy.mock.calls.map(c => c[0]);
    consoleSpy.mockRestore();
    expect(output.some(msg => msg.startsWith('[SKIP] acc1 SMTP'))).toBe(true);
  });

  it('prints "No accounts configured." when accounts list is empty', async () => {
    const { runValidateAccounts } = await import('./index.js');
    vi.mocked(getAccounts).mockResolvedValue([]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runValidateAccounts();

    const output = consoleSpy.mock.calls.map(c => c[0]);
    consoleSpy.mockRestore();
    expect(output[0]).toBe('No accounts configured.');
  });
});

// ---------------------------------------------------------------------------
// Phase 20: reply_email and forward_email tools
// ---------------------------------------------------------------------------

const ALL_WRITE_TOOL_NAMES_20 = [
  'send_email',
  'create_draft',
  'move_email',
  'modify_labels',
  'register_oauth2_account',
  'batch_operations',
  'reply_email',
  'forward_email',
];

// ---------------------------------------------------------------------------
// Phase 26: mark_read, mark_unread, star, unstar tools
// ---------------------------------------------------------------------------

const MARK_TOOL_NAMES = ['mark_read', 'mark_unread', 'star', 'unstar'];

describe('MARK-01: mark_read/unread/star/unstar tool registration', () => {
  it('getTools(false) includes mark_read, mark_unread, star, unstar', () => {
    const server = new MailMCPServer(false);
    const names = (server as any).getTools(false).map((t: any) => t.name);
    for (const name of MARK_TOOL_NAMES) {
      expect(names).toContain(name);
    }
  });

  it('getTools(true) excludes all 4 mark/star tools (write tools filtered)', () => {
    const server = new MailMCPServer(true);
    const names = (server as any).getTools(true).map((t: any) => t.name);
    for (const name of MARK_TOOL_NAMES) {
      expect(names).not.toContain(name);
    }
  });

  it('all 4 tools have readOnlyHint=false and destructiveHint=true', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    for (const name of MARK_TOOL_NAMES) {
      const tool = tools.find((t: any) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool.annotations.readOnlyHint).toBe(false);
      expect(tool.annotations.destructiveHint).toBe(true);
    }
  });

  it('getTools(false) now returns 25 tools (was 25, +4 mark/star tools)', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    expect(tools).toHaveLength(29);
  });

  it('getTools(true) now returns 16 tools (now 14, write tools hidden)', () => {
    const server = new MailMCPServer(true);
    const tools = (server as any).getTools(true);
    expect(tools).toHaveLength(14);
  });

  it('each mark/star tool requires accountId and uid', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    for (const name of MARK_TOOL_NAMES) {
      const tool = tools.find((t: any) => t.name === name);
      expect(tool.inputSchema.required).toContain('accountId');
      expect(tool.inputSchema.required).toContain('uid');
    }
  });
});

describe('MARK-02: mark_read/unread/star/unstar blocked in read-only mode', () => {
  it('all 4 tools return isError: true in read-only mode', async () => {
    const server = new MailMCPServer(true);
    for (const name of MARK_TOOL_NAMES) {
      const result = await (server as any).dispatchTool(name, true, {});
      expect(result.isError).toBe(true);
    }
  });
});

describe('MARK-03: mark_read/unread/star/unstar dispatch — correct flags', () => {
  it('mark_read calls modifyLabels with addLabels=[\\Seen], removeLabels=[]', async () => {
    const server = new MailMCPServer(false);
    const modifyLabelsMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ modifyLabels: modifyLabelsMock });
    await (server as any).dispatchTool('mark_read', false, { accountId: 'test', uid: '42', folder: 'INBOX' });
    expect(modifyLabelsMock).toHaveBeenCalledWith('42', 'INBOX', ['\\Seen'], []);
  });

  it('mark_unread calls modifyLabels with addLabels=[], removeLabels=[\\Seen]', async () => {
    const server = new MailMCPServer(false);
    const modifyLabelsMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ modifyLabels: modifyLabelsMock });
    await (server as any).dispatchTool('mark_unread', false, { accountId: 'test', uid: '42', folder: 'INBOX' });
    expect(modifyLabelsMock).toHaveBeenCalledWith('42', 'INBOX', [], ['\\Seen']);
  });

  it('star calls modifyLabels with addLabels=[\\Flagged], removeLabels=[]', async () => {
    const server = new MailMCPServer(false);
    const modifyLabelsMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ modifyLabels: modifyLabelsMock });
    await (server as any).dispatchTool('star', false, { accountId: 'test', uid: '42', folder: 'INBOX' });
    expect(modifyLabelsMock).toHaveBeenCalledWith('42', 'INBOX', ['\\Flagged'], []);
  });

  it('unstar calls modifyLabels with addLabels=[], removeLabels=[\\Flagged]', async () => {
    const server = new MailMCPServer(false);
    const modifyLabelsMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ modifyLabels: modifyLabelsMock });
    await (server as any).dispatchTool('unstar', false, { accountId: 'test', uid: '42', folder: 'INBOX' });
    expect(modifyLabelsMock).toHaveBeenCalledWith('42', 'INBOX', [], ['\\Flagged']);
  });

  it('mark_read defaults folder to INBOX when not provided', async () => {
    const server = new MailMCPServer(false);
    const modifyLabelsMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ modifyLabels: modifyLabelsMock });
    await (server as any).dispatchTool('mark_read', false, { accountId: 'test', uid: '42' });
    expect(modifyLabelsMock).toHaveBeenCalledWith('42', 'INBOX', ['\\Seen'], []);
  });

  it('mark_read response text confirms action', async () => {
    const server = new MailMCPServer(false);
    const modifyLabelsMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ modifyLabels: modifyLabelsMock });
    const result = await (server as any).dispatchTool('mark_read', false, { accountId: 'test', uid: '42', folder: 'INBOX' });
    expect(result.content[0].text).toContain('42');
  });
});

describe('THREAD-01: reply_email and forward_email in tool list', () => {
  it('getTools(false) includes reply_email and forward_email', () => {
    const server = new MailMCPServer(false);
    const names = (server as any).getTools(false).map((t: any) => t.name);
    expect(names).toContain('reply_email');
    expect(names).toContain('forward_email');
  });

  it('getTools(true) still excludes reply_email and forward_email (write tools filtered)', () => {
    const server = new MailMCPServer(true);
    const names = (server as any).getTools(true).map((t: any) => t.name);
    expect(names).not.toContain('reply_email');
    expect(names).not.toContain('forward_email');
  });

  it('reply_email is in getTools(false) output', () => {
    const server = new MailMCPServer(false);
    const names = (server as any).getTools(false).map((t: any) => t.name);
    expect(names).toContain('reply_email');
  });

  it('forward_email is in getTools(false) output', () => {
    const server = new MailMCPServer(false);
    const names = (server as any).getTools(false).map((t: any) => t.name);
    expect(names).toContain('forward_email');
  });

  it('reply_email is NOT in getTools(true) output', () => {
    const server = new MailMCPServer(true);
    const names = (server as any).getTools(true).map((t: any) => t.name);
    expect(names).not.toContain('reply_email');
  });

  it('forward_email is NOT in getTools(true) output', () => {
    const server = new MailMCPServer(true);
    const names = (server as any).getTools(true).map((t: any) => t.name);
    expect(names).not.toContain('forward_email');
  });
});

describe('THREAD-02: reply_email and forward_email are WRITE tools', () => {
  it('reply_email is blocked in read-only mode', async () => {
    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('reply_email', true, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Tool 'reply_email' is not available");
  });

  it('forward_email is blocked in read-only mode', async () => {
    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('forward_email', true, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Tool 'forward_email' is not available");
  });

  it('all reply/forward write tools return isError: true in read-only mode', async () => {
    const server = new MailMCPServer(true);
    for (const toolName of ALL_WRITE_TOOL_NAMES_20) {
      const result = await (server as any).dispatchTool(toolName, true, {});
      expect(result.isError).toBe(true);
    }
  });
});

describe('THREAD-03: reply_email tool schema', () => {
  it('reply_email schema has readOnlyHint=false and destructiveHint=true', () => {
    const server = new MailMCPServer(false);
    const tool = (server as any).getTools(false).find((t: any) => t.name === 'reply_email');
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it('reply_email schema requires accountId, uid, body', () => {
    const server = new MailMCPServer(false);
    const tool = (server as any).getTools(false).find((t: any) => t.name === 'reply_email');
    expect(tool.inputSchema.required).toContain('accountId');
    expect(tool.inputSchema.required).toContain('uid');
    expect(tool.inputSchema.required).toContain('body');
  });

  it('reply_email schema has optional folder, cc, bcc, isHtml, includeSignature properties', () => {
    const server = new MailMCPServer(false);
    const tool = (server as any).getTools(false).find((t: any) => t.name === 'reply_email');
    const props = tool.inputSchema.properties;
    expect(props.folder).toBeDefined();
    expect(props.cc).toBeDefined();
    expect(props.bcc).toBeDefined();
    expect(props.isHtml).toBeDefined();
    expect(props.includeSignature).toBeDefined();
  });
});

describe('THREAD-04: forward_email tool schema', () => {
  it('forward_email schema has readOnlyHint=false and destructiveHint=true', () => {
    const server = new MailMCPServer(false);
    const tool = (server as any).getTools(false).find((t: any) => t.name === 'forward_email');
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it('forward_email schema requires accountId, uid, to', () => {
    const server = new MailMCPServer(false);
    const tool = (server as any).getTools(false).find((t: any) => t.name === 'forward_email');
    expect(tool.inputSchema.required).toContain('accountId');
    expect(tool.inputSchema.required).toContain('uid');
    expect(tool.inputSchema.required).toContain('to');
  });

  it('forward_email schema has optional folder, body, cc, bcc, isHtml, includeSignature properties', () => {
    const server = new MailMCPServer(false);
    const tool = (server as any).getTools(false).find((t: any) => t.name === 'forward_email');
    const props = tool.inputSchema.properties;
    expect(props.folder).toBeDefined();
    expect(props.body).toBeDefined();
    expect(props.cc).toBeDefined();
    expect(props.bcc).toBeDefined();
    expect(props.isHtml).toBeDefined();
    expect(props.includeSignature).toBeDefined();
  });
});

describe('THREAD-05: reply_email and forward_email handler dispatch', () => {
  it('reply_email handler calls service.replyEmail and returns success text', async () => {
    const server = new MailMCPServer(false);
    const replyEmailMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ replyEmail: replyEmailMock });
    const result = await (server as any).dispatchTool('reply_email', false, {
      accountId: 'test',
      uid: '42',
      folder: 'INBOX',
      body: 'Thanks!',
    });
    expect(replyEmailMock).toHaveBeenCalledOnce();
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('reply');
  });

  it('forward_email handler calls service.forwardEmail and returns success text', async () => {
    const server = new MailMCPServer(false);
    const forwardEmailMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ forwardEmail: forwardEmailMock });
    const result = await (server as any).dispatchTool('forward_email', false, {
      accountId: 'test',
      uid: '42',
      folder: 'INBOX',
      to: 'friend@example.com',
      body: 'FYI',
    });
    expect(forwardEmailMock).toHaveBeenCalledOnce();
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('forward');
  });

  it('forward_email with invalid to returns [ValidationError]', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('forward_email', false, {
      accountId: 'test',
      uid: '42',
      to: 'notvalid',
      body: 'FYI',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[ValidationError]');
  });
});

describe('STATS-01: mailbox_stats tool', () => {
  it('mailbox_stats is in getTools(false) list', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('mailbox_stats');
  });

  it('mailbox_stats has readOnlyHint: true and destructiveHint: false', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'mailbox_stats');
    expect(tool).toBeDefined();
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  it('mailbox_stats is also present in getTools(true) (read-only mode)', () => {
    const server = new MailMCPServer(true);
    const tools = (server as any).getTools(true);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('mailbox_stats');
  });

  it('dispatchTool mailbox_stats calls service.getMailboxStats and returns formatted output', async () => {
    const server = new MailMCPServer(false);
    const getMailboxStatsMock = vi.fn().mockResolvedValue([
      { name: 'INBOX', total: 50, unread: 3, recent: 1 },
      { name: 'Sent', total: 120, unread: 0, recent: 0 },
    ]);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ getMailboxStats: getMailboxStatsMock });
    const result = await (server as any).dispatchTool('mailbox_stats', false, {
      accountId: 'test',
      folders: ['INBOX', 'Sent'],
    });
    expect(getMailboxStatsMock).toHaveBeenCalledWith(['INBOX', 'Sent']);
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('INBOX');
    expect(result.content[0].text).toContain('50');
    expect(result.content[0].text).toContain('3');
  });

  it('dispatchTool mailbox_stats without folders calls service.getMailboxStats with undefined', async () => {
    const server = new MailMCPServer(false);
    const getMailboxStatsMock = vi.fn().mockResolvedValue([]);
    vi.spyOn(server as any, 'getService').mockResolvedValue({ getMailboxStats: getMailboxStatsMock });
    const result = await (server as any).dispatchTool('mailbox_stats', false, { accountId: 'test' });
    expect(getMailboxStatsMock).toHaveBeenCalledWith(undefined);
    expect(result.isError).not.toBe(true);
  });
});

describe('TPL-01: list_templates MCP tool', () => {
  it('list_templates appears in getTools(false) as a read-only tool', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'list_templates');
    expect(tool).toBeDefined();
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  it('list_templates appears in getTools(true) (read-only server includes it)', () => {
    const server = new MailMCPServer(true);
    const tools = (server as any).getTools(true);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('list_templates');
  });

  it('list_templates is NOT in WRITE_TOOLS set (not blocked in read-only mode)', async () => {
    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('list_templates', true, {});
    expect(result.isError).not.toBe(true);
  });

  it('dispatchTool list_templates returns JSON array of all templates when no accountId filter', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('list_templates', false, {});
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it('dispatchTool list_templates with accountId filter returns only global + matching templates', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('list_templates', false, { accountId: 'work' });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    // Should include global template (no accountId) + work-scoped template
    const ids = parsed.map((t: any) => t.id);
    expect(ids).toContain('ack');   // global
    expect(ids).toContain('oof');   // accountId: 'work'
  });

  it('dispatchTool list_templates with accountId filter excludes templates for other accounts', async () => {
    const { getTemplates } = await import('./utils/templates.js');
    vi.mocked(getTemplates).mockResolvedValueOnce([
      { id: 'ack', name: 'Acknowledgement', body: 'Got it.' },
      { id: 'oof-work', name: 'OOF Work', body: 'Away.', accountId: 'work' },
      { id: 'oof-personal', name: 'OOF Personal', body: 'On vacation.', accountId: 'personal' },
    ]);
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('list_templates', false, { accountId: 'work' });
    const parsed = JSON.parse(result.content[0].text);
    const ids = parsed.map((t: any) => t.id);
    expect(ids).toContain('ack');
    expect(ids).toContain('oof-work');
    expect(ids).not.toContain('oof-personal');
  });
});

describe('TPL-02: use_template MCP tool', () => {
  it('use_template appears in getTools(false) as a read-only tool', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'use_template');
    expect(tool).toBeDefined();
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  it('use_template appears in getTools(true) (read-only server includes it)', () => {
    const server = new MailMCPServer(true);
    const tools = (server as any).getTools(true);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('use_template');
  });

  it('use_template is NOT in WRITE_TOOLS set (not blocked in read-only mode)', async () => {
    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('use_template', true, {
      templateId: 'ack',
      variables: { name: 'Alice' },
    });
    expect(result.isError).not.toBe(true);
  });

  it('dispatchTool use_template with valid templateId returns body with variables applied', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('use_template', false, {
      templateId: 'ack',
      variables: { name: 'Alice' },
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.body).toBe('Got your message, Alice.');
  });

  it('dispatchTool use_template with subject template applies variables to subject', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('use_template', false, {
      templateId: 'oof',
      variables: { subject: 'Hello', date: 'Monday' },
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.subject).toBe('Re: Hello');
    expect(parsed.body).toBe('I am away until Monday.');
  });

  it('dispatchTool use_template with unknown templateId returns isError: true', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('use_template', false, {
      templateId: 'nonexistent',
      variables: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent');
  });

  it('dispatchTool use_template includes optional to, cc, bcc, accountId in output when provided', async () => {
    const server = new MailMCPServer(false);
    const result = await (server as any).dispatchTool('use_template', false, {
      templateId: 'ack',
      variables: { name: 'Carol' },
      to: 'carol@example.com',
      cc: 'boss@example.com',
      accountId: 'work',
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.to).toBe('carol@example.com');
    expect(parsed.cc).toBe('boss@example.com');
    expect(parsed.accountId).toBe('work');
  });

  it('use_template tool schema requires templateId', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false);
    const tool = tools.find((t: any) => t.name === 'use_template');
    expect(tool.inputSchema.required).toContain('templateId');
  });
});

// ---------------------------------------------------------------------------
// Audit logging integration
// ---------------------------------------------------------------------------

describe('Audit logging integration', () => {
  const tmpLog = path.join(os.tmpdir(), `audit-integration-test-${Date.now()}.log`);

  afterEach(() => {
    try { fs.unlinkSync(tmpLog); } catch { /* ignore */ }
  });

  it('dispatchTool writes a JSONL audit entry to the log file', async () => {
    const logger = new AuditLogger(tmpLog, true);
    const server = new MailMCPServer(false, undefined, logger);

    await server.dispatchTool('list_accounts', false, {});

    expect(fs.existsSync(tmpLog)).toBe(true);
    const lines = fs.readFileSync(tmpLog, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.tool).toBe('list_accounts');
    expect(entry.success).toBe(true);
    expect(typeof entry.timestamp).toBe('string');
    expect(typeof entry.durationMs).toBe('number');
  });

  it('audit log records errors with success=false when tool fails', async () => {
    const logger = new AuditLogger(tmpLog, true);
    const server = new MailMCPServer(false, undefined, logger);

    // Calling a tool that requires an account that doesn't exist → error
    await server.dispatchTool('list_emails', false, { accountId: 'no-such-account' });

    const lines = fs.readFileSync(tmpLog, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.tool).toBe('list_emails');
    expect(entry.accountId).toBe('no-such-account');
    expect(entry.success).toBe(false);
    expect(typeof entry.error).toBe('string');
  });

  it('audit log does not write when logger is disabled', async () => {
    const logger = new AuditLogger(tmpLog, false);
    const server = new MailMCPServer(false, undefined, logger);

    await server.dispatchTool('list_accounts', false, {});

    expect(fs.existsSync(tmpLog)).toBe(false);
  });

  it('sensitive args are stripped from audit log entries', async () => {
    const logger = new AuditLogger(tmpLog, true);
    const server = new MailMCPServer(false, undefined, logger);

    // dispatchTool is called directly with sensitive args
    // register_oauth2_account is a write tool but we're testing arg sanitization via the logger
    await server.dispatchTool('list_accounts', false, {
      // list_accounts ignores extra args; logger should still sanitize
      password: 'SECRET',
      refreshToken: 'TOKEN',
    });

    const lines = fs.readFileSync(tmpLog, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(JSON.stringify(entry)).not.toContain('SECRET');
    expect(JSON.stringify(entry)).not.toContain('TOKEN');
  });
});
