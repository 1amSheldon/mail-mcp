import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ accounts: [{ id: 'z', name: 'Zimbra', backend: 'zimbra', user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' }], credential: vi.fn() }));
vi.mock('./config.js', () => ({
  AUDIT_LOG_PATH: 'audit-test.log',
  getAccounts: vi.fn(async () => []),
  getConfiguredAccounts: vi.fn(async () => mocks.accounts),
}));
vi.mock('./security/keychain.js', () => ({ loadCredentials: mocks.credential, saveCredentials: vi.fn(), removeCredentials: vi.fn() }));
import { MailMCPServer } from './index.js';

const args = { accountId: 'z', operation: 'zimbra.createDraft', input: { to: ['a@example.test'], subject: 'Draft', body: 'Test' } };
function readJSON(result: Awaited<ReturnType<MailMCPServer['dispatchTool']>>) { return JSON.parse(result.content[0].text as string); }
describe('Zimbra MCP router gates', () => {
  beforeEach(() => {
    mocks.credential.mockResolvedValue(JSON.stringify({ kind: 'zimbra-session-v1', endpoint: mocks.accounts[0].endpoint, user: mocks.accounts[0].user, authToken: 'secret-token', expiresAt: Date.now() + 60000 }));
  });
  it('blocks writes in read-only mode before loading credentials or accessing the network', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const server = new MailMCPServer(true);
    const result = await server.dispatchTool('mail_mutate', true, args);
    expect(result.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
    await server.shutdown(); vi.unstubAllGlobals();
  });
  it('blocks unrelated allowlists and advertises only allowed Zimbra writes', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const server = new MailMCPServer(false, new Set(['zimbra.addTag']));
    const result = await server.dispatchTool('mail_mutate', false, args);
    expect(result.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
    const tools = server.getTools(false, new Set(['zimbra.addTag']));
    const mutation = tools.find(t => t.name === 'mail_mutate')!;
    expect(mutation.inputSchema.properties!.operation).toMatchObject({ enum: ['zimbra.addTag'] });
    await server.shutdown(); vi.unstubAllGlobals();
  });
  it('requires argument-bound confirmation before native SaveDraft', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ Body: { SaveDraftResponse: { m: [{ id: '7' }] } } })));
    vi.stubGlobal('fetch', fetch);
    const server = new MailMCPServer(false, undefined, undefined, true);
    const first = readJSON(await server.dispatchTool('mail_mutate', false, args));
    expect(first.confirmationRequired).toBe(true); expect(fetch).not.toHaveBeenCalled();
    expect(first.description).toContain('Zimbra createDraft for account z');
    expect(first.description).toContain('to=["a@example.test"]');
    expect(first.description).toContain('subject="Draft"');
    expect(first.description).not.toContain('Test');
    const result = await server.dispatchTool('mail_mutate', false, { ...args, confirmationId: first.confirmationId });
    expect(result.isError).not.toBe(true); expect(readJSON(result).draftId).toBe('7');
    expect(fetch).toHaveBeenCalledTimes(1);
    await server.shutdown(); vi.unstubAllGlobals();
  });
  it('returns an actionable safe error when the session is missing', async () => {
    mocks.credential.mockResolvedValue(null);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const server = new MailMCPServer(false);
    const result = await server.dispatchTool('mail_query', false, { accountId: 'z', operation: 'zimbra.listFolders', input: {} });
    expect(result.isError).toBe(true); expect(readJSON(result)).toMatchObject({ status: 'auth_required', retrySafe: true });
    expect(fetch).not.toHaveBeenCalled();
    await server.shutdown(); vi.unstubAllGlobals();
  });
  it('does not expose passwords or OTPs as MCP operations', async () => {
    const server = new MailMCPServer(false);
    const result = await server.dispatchTool('mail_mutate', false, { accountId: 'z', operation: 'zimbra.login', input: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown mail_mutate operation');
    await server.shutdown();
  });
  it.each([
    ['updateDraft', { draftId: '7', to: ['a@example.test'], cc: ['c@example.test'], bcc: ['b@example.test'], subject: 'Replacement', body: 'PRIVATE BODY' }, ['draftId="7"', 'to=["a@example.test"]', 'cc=["c@example.test"]', 'bcc=["b@example.test"]', 'replace draft contents']],
    ['sendDraft', { draftId: '7' }, ['draftId="7"', 'send the latest server draft']],
    ['createTag', { name: 'Urgent', color: 3 }, ['name="Urgent"', 'color=3']],
    ['deleteTag', { tagId: '8' }, ['tagId="8"']],
    ['addTag', { messageIds: ['9', '10'], tagName: 'Urgent' }, ['messageIds=["9","10"]', 'tagName="Urgent"']],
    ['removeTag', { messageIds: ['9'], tagName: 'Urgent' }, ['messageIds=["9"]', 'tagName="Urgent"']],
    ['moveMessages', { messageIds: ['9'], folderId: '11' }, ['messageIds=["9"]', 'folderId="11"']],
    ['markRead', { messageIds: ['9'], read: false }, ['messageIds=["9"]', 'mark as unread']],
    ['markRead', { messageIds: ['9'], read: true }, ['messageIds=["9"]', 'mark as read']],
    ['moveToTrash', { messageIds: ['9'] }, ['messageIds=["9"]', 'move messages to Trash']],
  ])('describes %s and its targets without fetching or exposing the body', async (operation, input, details) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const server = new MailMCPServer(false, undefined, undefined, true);
    const result = readJSON(await server.dispatchTool('mail_mutate', false, { accountId: 'z', operation: `zimbra.${operation}`, input }));
    expect(result.confirmationRequired).toBe(true);
    expect(result.description).toContain(`Zimbra ${operation} for account z`);
    for (const detail of details as string[]) expect(result.description).toContain(detail);
    expect(result.description).not.toContain('PRIVATE BODY');
    expect(fetch).not.toHaveBeenCalled();
    await server.shutdown(); vi.unstubAllGlobals();
  });
  it('marks rejected input safe to retry without performing a write', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const server = new MailMCPServer(false);
    const result = await server.dispatchTool('mail_mutate', false, { accountId: 'z', operation: 'zimbra.sendDraft', input: { draftId: 'invalid' } });
    expect(result.isError).toBe(true);
    expect(readJSON(result)).toMatchObject({ status: 'invalid_input', retrySafe: true });
    expect(fetch).not.toHaveBeenCalled();
    await server.shutdown(); vi.unstubAllGlobals();
  });
  it('never permits automatic retry after an uncertain write', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('network connection lost')); vi.stubGlobal('fetch', fetch);
    const server = new MailMCPServer(false);
    const result = await server.dispatchTool('mail_mutate', false, args);
    expect(result.isError).toBe(true);
    expect(readJSON(result)).toMatchObject({ status: 'outcome_unknown', retrySafe: false });
    expect(readJSON(result).nextAction).toContain('Never retry');
    expect(fetch).toHaveBeenCalledTimes(1);
    await server.shutdown(); vi.unstubAllGlobals();
  });
});
