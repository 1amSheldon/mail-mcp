import { vi, describe, it, expect } from 'vitest';

vi.mock('./config.js', () => ({
  getAccounts: vi.fn().mockResolvedValue([]),
}));

vi.mock('./utils/templates.js', () => ({
  getTemplates: vi.fn().mockResolvedValue([]),
  applyVariables: vi.fn().mockImplementation((template: string, vars: Record<string, string>) => {
    return template.replace(/\{\{([^}]+)\}\}/g, (_match: string, key: string) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : _match
    );
  }),
}));

vi.mock('./services/mail.js', () => {
  const MockMailService = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listEmails: vi.fn().mockResolvedValue([]),
    searchEmails: vi.fn().mockResolvedValue([]),
    sendEmail: vi.fn().mockResolvedValue(undefined),
    listFolders: vi.fn().mockResolvedValue([]),
    moveMessage: vi.fn().mockResolvedValue(undefined),
    modifyLabels: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    extractContacts: vi.fn().mockResolvedValue([]),
    imap: { onClose: null },
  }));
  return { MailService: MockMailService };
});

import { MailMCPServer } from './index.js';

const ALL_WRITE_TOOL_NAMES = [
  'send_email',
  'create_draft',
  'move_email',
  'modify_labels',
  'register_oauth2_account',
  'batch_operations',
  'reply_email',
  'forward_email',
  'delete_email',
  'mark_read',
  'mark_unread',
  'star',
  'unstar',
  'set_filter',
  'delete_filter',
];

const ALL_READ_TOOL_NAMES = [
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

describe('AL-01: getTools() with allowedTools=["send_email"] returns read tools + only send_email', () => {
  it('includes all 14 read tools', () => {
    const server = new MailMCPServer(false, new Set(['send_email']));
    const tools = (server as any).getTools(false, new Set(['send_email']));
    const names: string[] = tools.map((t: any) => t.name);
    for (const readTool of ALL_READ_TOOL_NAMES) {
      expect(names).toContain(readTool);
    }
  });

  it('includes send_email', () => {
    const server = new MailMCPServer(false, new Set(['send_email']));
    const tools = (server as any).getTools(false, new Set(['send_email']));
    const names: string[] = tools.map((t: any) => t.name);
    expect(names).toContain('send_email');
  });

  it('does NOT include other write tools', () => {
    const server = new MailMCPServer(false, new Set(['send_email']));
    const tools = (server as any).getTools(false, new Set(['send_email']));
    const names: string[] = tools.map((t: any) => t.name);
    const otherWriteTools = ALL_WRITE_TOOL_NAMES.filter(t => t !== 'send_email');
    for (const writeTool of otherWriteTools) {
      expect(names).not.toContain(writeTool);
    }
  });

  it('returns exactly 15 tools (14 read + 1 write)', () => {
    const server = new MailMCPServer(false, new Set(['send_email']));
    const tools = (server as any).getTools(false, new Set(['send_email']));
    expect(tools).toHaveLength(15);
  });
});

describe('AL-02: getTools() with allowedTools=["send_email", "create_draft"] returns read + those 2', () => {
  it('returns exactly 16 tools (14 read + 2 write)', () => {
    const server = new MailMCPServer(false, new Set(['send_email', 'create_draft']));
    const tools = (server as any).getTools(false, new Set(['send_email', 'create_draft']));
    expect(tools).toHaveLength(16);
  });

  it('includes send_email and create_draft', () => {
    const server = new MailMCPServer(false, new Set(['send_email', 'create_draft']));
    const tools = (server as any).getTools(false, new Set(['send_email', 'create_draft']));
    const names: string[] = tools.map((t: any) => t.name);
    expect(names).toContain('send_email');
    expect(names).toContain('create_draft');
  });

  it('does NOT include delete_email or move_email', () => {
    const server = new MailMCPServer(false, new Set(['send_email', 'create_draft']));
    const tools = (server as any).getTools(false, new Set(['send_email', 'create_draft']));
    const names: string[] = tools.map((t: any) => t.name);
    expect(names).not.toContain('delete_email');
    expect(names).not.toContain('move_email');
  });
});

describe('AL-03: getTools() with empty allowedTools set returns only read tools', () => {
  it('returns exactly 14 tools', () => {
    const server = new MailMCPServer(false, new Set<string>());
    const tools = (server as any).getTools(false, new Set<string>());
    expect(tools).toHaveLength(14);
  });

  it('contains no write tools', () => {
    const server = new MailMCPServer(false, new Set<string>());
    const tools = (server as any).getTools(false, new Set<string>());
    const names: string[] = tools.map((t: any) => t.name);
    for (const writeTool of ALL_WRITE_TOOL_NAMES) {
      expect(names).not.toContain(writeTool);
    }
  });
});

describe('AL-04: dispatchTool() with allowedTools=["send_email"] allows send_email', () => {
  it('send_email dispatches without isError when in allowedTools', async () => {
    const server = new MailMCPServer(false, new Set(['send_email']));
    // send_email needs accountId — mock service handles it, but we check it doesn't get blocked by the allow-list guard
    // We need to ensure the guard passes; the actual dispatch may fail for other reasons (no account)
    // but it should NOT fail with the allow-list message
    const result = await (server as any).dispatchTool('send_email', false, {
      accountId: 'test',
      to: 'a@b.com',
      subject: 'hi',
      body: 'hello',
    }, new Set(['send_email']));
    // Should NOT have the allow-list error message
    expect(result.content?.[0]?.text).not.toContain('not in the allowed tools list');
  });
});

describe('AL-05: dispatchTool() with allowedTools=["send_email"] blocks delete_email', () => {
  it('delete_email returns isError: true when not in allowedTools', async () => {
    const server = new MailMCPServer(false, new Set(['send_email']));
    const result = await (server as any).dispatchTool('delete_email', false, {
      accountId: 'test',
      uid: '42',
    }, new Set(['send_email']));
    expect(result.isError).toBe(true);
  });

  it('delete_email error message mentions "not in the allowed tools list"', async () => {
    const server = new MailMCPServer(false, new Set(['send_email']));
    const result = await (server as any).dispatchTool('delete_email', false, {
      accountId: 'test',
      uid: '42',
    }, new Set(['send_email']));
    expect(result.content[0].text).toContain('not in the allowed tools list');
  });
});

describe('AL-06: dispatchTool() with allowedTools=["send_email"] blocks move_email', () => {
  it('move_email returns isError: true when not in allowedTools', async () => {
    const server = new MailMCPServer(false, new Set(['send_email']));
    const result = await (server as any).dispatchTool('move_email', false, {
      accountId: 'test',
      uid: '42',
      sourceFolder: 'INBOX',
      targetFolder: 'Trash',
    }, new Set(['send_email']));
    expect(result.isError).toBe(true);
  });
});

describe('AL-07: Constructor with readOnly=true and allowedTools set throws', () => {
  it('throws an error when both readOnly=true and allowedTools is provided', () => {
    expect(() => new MailMCPServer(true, new Set(['send_email']))).toThrow();
  });

  it('error message mentions mutual exclusivity', () => {
    expect(() => new MailMCPServer(true, new Set(['send_email']))).toThrow(/mutually exclusive|cannot.*both|--read-only.*--allow-tools|--allow-tools.*--read-only/i);
  });
});

describe('AL-08: Backward compatibility — no allowedTools returns all 29 tools', () => {
  it('getTools() without allowedTools (undefined) and readOnly=false returns 29 tools', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false, undefined);
    expect(tools).toHaveLength(29);
  });

  it('getTools() without allowedTools returns all write tools', () => {
    const server = new MailMCPServer(false);
    const tools = (server as any).getTools(false, undefined);
    const names: string[] = tools.map((t: any) => t.name);
    for (const writeTool of ALL_WRITE_TOOL_NAMES) {
      expect(names).toContain(writeTool);
    }
  });
});

describe('AL-09: Server instructions mention allowed tools when allowedTools is set', () => {
  it('instructions contain "allow-listed" or "allowed tools" when allowedTools provided', () => {
    const server = new MailMCPServer(false, new Set(['send_email']));
    const internalServer = (server as any).server;
    const instructions =
      internalServer._options?.instructions ??
      internalServer.options?.instructions ??
      internalServer.serverInfo?.instructions;
    expect(instructions).toMatch(/allow-listed|allowed tools|send_email/i);
  });
});

describe('AL-10: dispatchTool() error messages are distinct for allow-list vs read-only', () => {
  it('allow-list blocked message does NOT say "read-only mode"', async () => {
    const server = new MailMCPServer(false, new Set(['send_email']));
    const result = await (server as any).dispatchTool('delete_email', false, {
      accountId: 'test',
      uid: '42',
    }, new Set(['send_email']));
    expect(result.content[0].text).not.toContain('read-only mode');
  });

  it('read-only blocked message says "read-only mode"', async () => {
    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('send_email', true, {});
    expect(result.content[0].text).toContain('read-only mode');
  });
});
