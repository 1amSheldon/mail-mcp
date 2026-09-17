// Explicitly creates/updates a self-addressed test draft; never sends mail.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
if (!process.argv.includes('--prepare') && !process.argv.includes('--check')) throw new Error('Use --prepare for writes or --check for a read-only connection check');
const token = process.env.MAIL_MCP_BEARER_TOKEN;
const accountId = process.env.MAIL_MCP_ACCOUNT_ID;
if (!token || !accountId) throw new Error('Set MAIL_MCP_BEARER_TOKEN and MAIL_MCP_ACCOUNT_ID');
const transport = new StreamableHTTPClientTransport(new URL(process.env.MAIL_MCP_URL ?? 'http://127.0.0.1:8765/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
const client = new Client({ name: 'draft-workflow-probe', version: '1.0.0' });
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content.filter(x => x.type === 'text').map(x => x.text).join('\n'));
  const text = result.content.find(x => x.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return text; }
}
async function mutate(operation, input) {
  const args = { accountId, operation, input };
  const first = await call('mail_mutate', args);
  return first.confirmationRequired ? call('mail_mutate', { ...args, confirmationId: first.confirmationId }) : first;
}
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const mutationTool = tools.find(x => x.name === 'mail_mutate');
  const operations = mutationTool?.inputSchema?.properties?.operation?.enum ?? [];
  if (!operations.includes('updateDraft') || !operations.includes('sendDraft')) throw new Error('Draft tools not registered');
  const accounts = await call('list_accounts', {});
  const account = accounts.find(x => x.id === accountId);
  if (!account?.user) throw new Error('Account not found');
  await call('mail_query', { accountId, operation: 'listFolders', input: {} });
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({ status: 'ok', serverVersion: client.getServerVersion(), accountId, draftOperationsRegistered: true, foldersRead: true }));
  } else {
    const subject = '[mail-mcp draft test] ' + new Date().toISOString();
    const draft = await mutate('createDraft', { to: account.user, subject, textBody: 'Draft workflow test. Not sent. Please edit this draft in webmail for review.', attachments: [{ filename: 'draft-test.txt', contentBase64: Buffer.from('Attachment preserved through draft update.').toString('base64'), contentType: 'text/plain' }] });
    console.log(JSON.stringify({ phase: 'created', subject, ...draft }));
    if (!draft.draftId || !draft.locator) throw new Error('Missing stable identity');
    await call('mail_query', { accountId, operation: 'readMessage', input: { locator: draft.locator } });
    const updated = await mutate('updateDraft', { draftId: draft.draftId, changes: { subject: subject + ' - ready for review' } });
    const readback = await call('mail_query', { accountId, operation: 'readMessage', input: { locator: updated.locator } });
    if (typeof readback !== 'string' || !readback.includes('draft-test.txt') || !readback.includes('ready for review')) throw new Error('Draft readback mismatch');
    console.log(JSON.stringify({ phase: 'verified', serverVersion: client.getServerVersion(), ...updated, attachmentPreserved: true, sent: false }));
  }
} finally {
  await transport.terminateSession().catch(() => {});
  await client.close().catch(() => {});
}
