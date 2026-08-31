import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  getAccounts: vi.fn().mockResolvedValue([]),
  getConfiguredAccounts: vi.fn().mockResolvedValue([]),
}));

vi.mock('./utils/templates.js', () => ({
  getTemplates: vi.fn().mockResolvedValue([]),
  applyVariables: vi.fn().mockImplementation((template: string) => template),
}));

vi.mock('./services/mail.js', () => ({
  MailService: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendEmail: vi.fn().mockResolvedValue({
      status: 'accepted',
      messageId: '<test@example.com>',
      accepted: ['user@example.com'],
      rejected: [],
    }),
    imap: { onClose: null },
  })),
}));

import { MailMCPServer, parseAllowedTools } from './index.js';

function operationEnum(server: MailMCPServer): string[] | undefined {
  const tool = (server as any).getTools(false, (server as any).allowedTools)
    .find((candidate: any) => candidate.name === 'mail_mutate');
  return tool?.inputSchema.properties.operation.enum;
}

describe('write operation allowlist', () => {
  beforeEach(() => vi.clearAllMocks());

  it('advertises only the selected mutation operations', () => {
    const server = new MailMCPServer(false, new Set(['sendMessage', 'createDraft']));

    expect(operationEnum(server)).toEqual(['sendMessage', 'createDraft']);
    expect((server as any).getTools(false, (server as any).allowedTools)
      .map((tool: any) => tool.name)).toEqual(['list_accounts', 'mail_query', 'mail_mutate']);
  });

  it('accepts legacy internal selectors for upgrade compatibility', () => {
    expect([...parseAllowedTools('send_email,move_email')!]).toEqual([
      'send_email',
      'move_email',
    ]);
    const server = new MailMCPServer(false, new Set(['send_email']));
    expect(operationEnum(server)).toEqual(['sendMessage']);
  });

  it('advertises no mutation router for an empty allowlist', () => {
    const server = new MailMCPServer(false, new Set());

    expect((server as any).getTools(false, (server as any).allowedTools)
      .map((tool: any) => tool.name)).toEqual(['list_accounts', 'mail_query']);
  });

  it('allows an selected public mutation and blocks another operation', async () => {
    const server = new MailMCPServer(false, new Set(['sendMessage']));
    const allowed = await (server as any).dispatchTool('mail_mutate', false, {
      accountId: 'test',
      operation: 'sendMessage',
      input: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
    });
    const blocked = await (server as any).dispatchTool('mail_mutate', false, {
      accountId: 'test',
      operation: 'moveToTrash',
      input: { locator: 'mail-mcp://test/INBOX/1/42' },
    });

    expect(allowed.content[0].text).not.toContain('not in the allowlist');
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toContain('not in the allowlist');
  });

  it('keeps read-only mode mutually exclusive and blocks the mutation router', async () => {
    expect(() => new MailMCPServer(true, new Set(['sendMessage']))).toThrow(/mutually exclusive/i);

    const server = new MailMCPServer(true);
    const result = await (server as any).dispatchTool('mail_mutate', true, {
      accountId: 'test',
      operation: 'sendMessage',
      input: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('read-only mode');
  });

  it('advertises all three public tools when no allowlist is configured', () => {
    const server = new MailMCPServer(false);
    expect((server as any).getTools(false).map((tool: any) => tool.name)).toEqual([
      'list_accounts',
      'mail_query',
      'mail_mutate',
    ]);
  });

  it('describes active write selectors in server instructions', () => {
    const server = new MailMCPServer(false, new Set(['sendMessage']));
    const internalServer = (server as any).server;
    const instructions = internalServer._options?.instructions
      ?? internalServer.options?.instructions
      ?? internalServer.serverInfo?.instructions;

    expect(instructions).toMatch(/allow-listed write selectors/i);
    expect(instructions).toContain('sendMessage');
  });
});
