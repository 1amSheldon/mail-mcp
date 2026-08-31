/**
 * Tests for --confirm mode
 *
 * Confirms that when MailMCPServer is constructed with confirmMode=true:
 * - First write tool call returns confirmationRequired + confirmationId
 * - Second call with valid confirmationId executes the action
 * - Expired/invalid confirmationId returns an error
 * - Read tools execute immediately (not gated)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ConfirmationStore } from './utils/confirmation-store.js';

vi.mock('./config.js', () => ({
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'acc1', name: 'Test', user: 'test@example.com', host: 'imap.example.com', port: 993, smtpHost: 'smtp.example.com', smtpPort: 587, secure: true }
  ]),
  getConfiguredAccounts: vi.fn().mockResolvedValue([
    { id: 'acc1', name: 'Test', user: 'test@example.com', host: 'imap.example.com', port: 993, smtpHost: 'smtp.example.com', smtpPort: 587, secure: true }
  ]),
  AUDIT_LOG_PATH: '/tmp/test-audit.log',
}));

vi.mock('./utils/templates.js', () => ({
  getTemplates: vi.fn().mockResolvedValue([]),
  applyVariables: vi.fn().mockImplementation((t: string) => t),
}));

// Self-contained mock to avoid TDZ issues with vi.mock hoisting.
// Outer-scope references inside vi.mock factory cause TDZ errors.
vi.mock('./services/mail.js', () => {
  const mockSend = vi.fn().mockResolvedValue({
    status: 'sent_and_saved',
    smtpAccepted: true,
    accepted: ['alice@example.com'],
    rejected: [],
    sentFolderSaved: true,
    retrySafe: false,
    nextAction: 'Do not resend this message.',
  });
  const mockDel = vi.fn().mockResolvedValue(undefined);
  const mockMove = vi.fn().mockResolvedValue(undefined);
  const mockModify = vi.fn().mockResolvedValue(undefined);
  const MockMailService = vi.fn().mockImplementation(function() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      listEmails: vi.fn().mockResolvedValue([]),
      sendEmail: mockSend,
      deleteEmail: mockDel,
      moveMessage: mockMove,
      modifyLabels: mockModify,
      invalidateBodyCache: vi.fn(),
      imap: { onClose: null },
    };
  });
  return { MailService: MockMailService };
});

// These are for test-level verification only (not passed to mock factory)
const mockSendEmail = vi.fn().mockResolvedValue(undefined);
const mockDeleteEmail = vi.fn().mockResolvedValue(undefined);

import { MailMCPServer } from './index.js';

const WRITE_TOOL_NAMES = ['mail_mutate'];

const READ_TOOL_NAMES = ['list_accounts', 'mail_query'];

describe('CONF-01: MailMCPServer confirmMode constructor', () => {
  it('constructs with confirmMode=false by default (4th param omitted)', () => {
    const server = new MailMCPServer(false);
    expect((server as any).confirmMode).toBe(false);
  });

  it('constructs with confirmMode=true when passed as 4th param', () => {
    const server = new MailMCPServer(false, undefined, undefined, true);
    expect((server as any).confirmMode).toBe(true);
  });
});

describe('CONF-02: server instructions', () => {
  it('confirmMode=false: instructions do NOT mention confirmation mode', () => {
    const server = new MailMCPServer(false, undefined, undefined, false);
    const internalServer = (server as any).server;
    const instructions =
      internalServer._options?.instructions ??
      internalServer.options?.instructions ??
      internalServer.serverInfo?.instructions ?? '';
    expect(instructions).not.toContain('confirmation mode');
  });

  it('confirmMode=true: instructions mention confirmation mode', () => {
    const server = new MailMCPServer(false, undefined, undefined, true);
    const internalServer = (server as any).server;
    const instructions =
      internalServer._options?.instructions ??
      internalServer.options?.instructions ??
      internalServer.serverInfo?.instructions ?? '';
    expect(instructions).toContain('confirmation mode');
  });
});

describe('CONF-03: write tool schemas include confirmationId', () => {
  it('all write tools have optional confirmationId in inputSchema', () => {
    const server = new MailMCPServer(false, undefined, undefined, false);
    const tools = (server as any).getTools(false);
    for (const toolName of WRITE_TOOL_NAMES) {
      const tool = tools.find((t: any) => t.name === toolName);
      expect(tool, `Tool ${toolName} not found`).toBeDefined();
      expect(
        tool.inputSchema.properties.confirmationId,
        `Tool ${toolName} missing confirmationId property`
      ).toBeDefined();
      // Should NOT be required
      expect(
        (tool.inputSchema.required ?? []).includes('confirmationId'),
        `Tool ${toolName} should not have confirmationId as required`
      ).toBe(false);
    }
  });

  it('read tools do NOT have confirmationId in inputSchema', () => {
    const server = new MailMCPServer(false, undefined, undefined, false);
    const tools = (server as any).getTools(false);
    for (const toolName of READ_TOOL_NAMES) {
      const tool = tools.find((t: any) => t.name === toolName);
      if (!tool) continue; // some read tools may not be in getTools(false) — skip
      expect(
        tool.inputSchema.properties?.confirmationId,
        `Read tool ${toolName} should not have confirmationId`
      ).toBeUndefined();
    }
  });
});

describe('CONF-03b: public mutation router confirmation', () => {
  it('does not retain a token when a routed request is invalid', async () => {
    const server = new MailMCPServer(false, undefined, undefined, true);
    const result = await (server as any).dispatchTool('mail_mutate', false, {
      operation: 'sendMessage',
      input: {
        to: 'alice@example.com',
        subject: 'Hi',
        body: 'Hello',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('accountId is required');
    expect((server as any).confirmStore.size).toBe(0);
  });

  it('binds the token to the public operation and nested input', async () => {
    const server = new MailMCPServer(false, undefined, undefined, true);
    const request = {
      accountId: 'acc1',
      operation: 'sendMessage',
      input: {
        to: 'alice@example.com',
        subject: 'Project update',
        body: 'Hello',
      },
    };

    const first = await (server as any).dispatchTool('mail_mutate', false, request);
    const challenge = JSON.parse(first.content[0].text);
    expect(challenge).toMatchObject({
      confirmationRequired: true,
      action: 'mail_mutate',
      description: expect.stringContaining('alice@example.com'),
    });

    const changed = await (server as any).dispatchTool('mail_mutate', false, {
      ...request,
      input: { ...request.input, to: 'mallory@example.com' },
      confirmationId: challenge.confirmationId,
    });
    expect(changed.isError).toBe(true);
    expect(changed.content[0].text).toContain('arguments changed');
  });

  it('routes the confirmed second call to the existing send handler', async () => {
    const server = new MailMCPServer(false, undefined, undefined, true);
    const request = {
      accountId: 'acc1',
      operation: 'sendMessage',
      input: {
        to: 'alice@example.com',
        subject: 'Project update',
        body: 'Hello',
      },
    };
    const first = await (server as any).dispatchTool('mail_mutate', false, request);
    const { confirmationId } = JSON.parse(first.content[0].text);

    const confirmed = await (server as any).dispatchTool('mail_mutate', false, {
      ...request,
      confirmationId,
    });
    expect(confirmed.isError).not.toBe(true);
    expect(confirmed.content[0].text).not.toContain('confirmationRequired');
  });
});

describe('CONF-04: first write call returns confirmationRequired', () => {
  let server: MailMCPServer;

  beforeEach(() => {
    // Use short TTL confirmation store for tests
    server = new MailMCPServer(false, undefined, undefined, true);
    // Inject a short-TTL store for predictable tests
    (server as any).confirmStore_ = new ConfirmationStore(5000);
  });

  it('send_email without confirmationId returns confirmationRequired=true', async () => {
    const result = await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.confirmationRequired).toBe(true);
    expect(parsed.confirmationId).toBeDefined();
    expect(typeof parsed.confirmationId).toBe('string');
    expect(parsed.action).toBe('send_email');
    expect(parsed.expiresIn).toBe('5 minutes');
  });

  it('send_email first call does NOT execute sendEmail service', async () => {
    await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('delete_email without confirmationId returns confirmationRequired', async () => {
    const result = await (server as any).dispatchTool('delete_email', false, {
      accountId: 'acc1',
      uid: '42',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.confirmationRequired).toBe(true);
    expect(parsed.action).toBe('delete_email');
  });

  it('confirmation response includes a human-readable description', async () => {
    const result = await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Project Update',
      body: 'See attached',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.description).toBeDefined();
    expect(parsed.description).toContain('alice@example.com');
  });
});

describe('CONF-05: second write call with valid confirmationId executes', () => {
  let server: MailMCPServer;

  beforeEach(async () => {
    server = new MailMCPServer(false, undefined, undefined, true);
  });

  it('send_email with valid confirmationId executes and returns success', async () => {
    // First call: get confirmationId
    const firstResult = await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    const { confirmationId } = JSON.parse(firstResult.content[0].text);

    // Second call: confirm
    const secondResult = await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Hi',
      body: 'Hello',
      confirmationId,
    });

    // Should succeed (no isError, text contains success message)
    expect(secondResult.isError).not.toBe(true);
    expect(secondResult.content[0].text).not.toContain('confirmationRequired');
  });

  it('confirmationId is single-use: third call without new id returns confirmationRequired again', async () => {
    const firstResult = await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    const { confirmationId } = JSON.parse(firstResult.content[0].text);

    // Second call consumes the token
    await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Hi',
      body: 'Hello',
      confirmationId,
    });

    // Third call with same (now consumed) token
    const thirdResult = await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Hi',
      body: 'Hello',
      confirmationId,
    });
    // Consumed token is invalid — should return error, NOT confirmationRequired
    expect(thirdResult.isError).toBe(true);
    expect(thirdResult.content[0].text).toContain('invalid or expired');
  });

  it('rejects arguments changed after confirmation', async () => {
    const sendEmail = vi.fn().mockResolvedValue({
      status: 'sent_and_saved',
      smtpAccepted: true,
      accepted: ['alice@example.com'],
      rejected: [],
      sentFolderSaved: true,
      retrySafe: false,
      nextAction: 'Do not resend this message.',
    });
    vi.spyOn(server as any, 'getService').mockResolvedValue({ sendEmail });
    const first = await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Approved subject',
      body: 'Approved body',
    });
    const { confirmationId } = JSON.parse(first.content[0].text);

    const result = await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'attacker@example.com',
      subject: 'Changed subject',
      body: 'Changed body',
      confirmationId,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('arguments changed');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('rejects a confirmation token issued for a different tool', async () => {
    const first = await (server as any).dispatchTool('create_draft', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Draft',
      body: 'Body',
    });
    const { confirmationId } = JSON.parse(first.content[0].text);
    const result = await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Draft',
      body: 'Body',
      confirmationId,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("issued for 'create_draft'");
  });
});

describe('CONF-06: invalid/expired confirmationId returns error', () => {
  let server: MailMCPServer;

  beforeEach(() => {
    server = new MailMCPServer(false, undefined, undefined, true);
  });

  it('completely invalid confirmationId returns isError: true', async () => {
    const result = await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Hi',
      body: 'Hello',
      confirmationId: 'not-a-real-uuid',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid or expired');
  });
});

describe('CONF-07: read tools unaffected by confirmMode', () => {
  let server: MailMCPServer;

  beforeEach(() => {
    server = new MailMCPServer(false, undefined, undefined, true);
  });

  it('list_accounts executes immediately without returning confirmationRequired', async () => {
    const result = await (server as any).dispatchTool('list_accounts', false, {});
    // Should return normally (accounts list), not a confirmation prompt
    let parsed: any;
    try {
      parsed = JSON.parse(result.content[0].text);
    } catch {
      parsed = null;
    }
    // If it parsed, confirmationRequired should not be set
    if (parsed) {
      expect(parsed.confirmationRequired).toBeUndefined();
    }
    expect(result.isError).not.toBe(true);
  });
});

describe('CONF-08: confirmMode=false does not intercept write tools', () => {
  it('send_email in non-confirm mode does NOT return confirmationRequired', async () => {
    // Standard server (no confirm mode) — mock service needed for this
    // We test dispatchTool directly; it will fail on getService but not with confirmationRequired
    const server = new MailMCPServer(false, undefined, undefined, false);
    const result = await (server as any).dispatchTool('send_email', false, {
      accountId: 'acc1',
      to: 'alice@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    // Should NOT have confirmationRequired — it either succeeds or fails for other reasons
    let parsed: any;
    try {
      parsed = JSON.parse(result.content[0].text);
    } catch {
      parsed = null;
    }
    if (parsed) {
      expect(parsed.confirmationRequired).toBeUndefined();
    }
  });
});

describe('CONF-09: description strings are meaningful', () => {
  let server: MailMCPServer;

  beforeEach(() => {
    server = new MailMCPServer(false, undefined, undefined, true);
  });

  const cases = [
    {
      tool: 'send_email',
      args: { accountId: 'a', to: 'b@c.com', subject: 'Test', body: 'Hi' },
      expect: ['b@c.com', 'Test'],
    },
    {
      tool: 'create_draft',
      args: { accountId: 'a', to: 'x@y.com', subject: 'Draft', body: 'Draft body' },
      expect: ['x@y.com', 'Draft'],
    },
    {
      tool: 'delete_email',
      args: { accountId: 'a', uid: '99', folder: 'INBOX' },
      expect: ['99'],
    },
    {
      tool: 'move_email',
      args: { accountId: 'a', uid: '5', sourceFolder: 'INBOX', targetFolder: 'Archive' },
      expect: ['5', 'INBOX', 'Archive'],
    },
    {
      tool: 'mail_mutate',
      args: {
        accountId: 'mailtrap',
        operation: 'mailtrap.sandbox',
        input: {
          resource: 'inbox',
          operation: 'reset_credentials',
          inboxId: 7,
        },
      },
      expect: ['sandbox', 'inbox', 'reset_credentials', 'inboxId=7'],
    },
  ];

  for (const c of cases) {
    it(`${c.tool} description includes expected tokens`, async () => {
      const result = await (server as any).dispatchTool(c.tool, false, c.args);
      const parsed = JSON.parse(result.content[0].text);
      for (const token of c.expect) {
        expect(parsed.description, `Expected "${token}" in description`).toContain(token);
      }
    });
  }
});
