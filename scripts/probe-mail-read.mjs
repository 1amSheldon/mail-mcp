import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MAIL_MCP_URL ?? 'http://127.0.0.1:8765/mcp';
const token = process.env.MAIL_MCP_BEARER_TOKEN;
if (!token) throw new Error('MAIL_MCP_BEARER_TOKEN is not set');

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'mail-mcp-read-probe', version: '1.0.0' });

function textFrom(result) {
  return result.content.find(item => item.type === 'text')?.text ?? '';
}

try {
  await client.connect(transport);

  const accountsResult = await client.callTool({ name: 'list_accounts', arguments: {} });
  const accounts = JSON.parse(textFrom(accountsResult));
  const accountId = process.env.MAIL_MCP_ACCOUNT_ID ?? accounts[0]?.id;
  if (!accountId) throw new Error('No mail account is configured');

  const foldersResult = await client.callTool({
    name: 'mail_query',
    arguments: { accountId, operation: 'listFolders', input: {} },
  });
  const folders = JSON.parse(textFrom(foldersResult));

  const probeSubject = process.env.MAIL_MCP_PROBE_SUBJECT;
  const messagesResult = await client.callTool(probeSubject
    ? {
        name: 'mail_query',
        arguments: {
          accountId,
          operation: 'searchMessages',
          input: { folder: 'INBOX', limit: 20, subject: probeSubject },
        },
      }
    : {
        name: 'mail_query',
        arguments: {
          accountId,
          operation: 'listMessages',
          input: { folder: 'INBOX', limit: 20, headerOnly: true },
        },
      });
  const messagePage = JSON.parse(textFrom(messagesResult));
  const messages = messagePage.items;

  let fullRead = false;
  let attachmentRead = false;
  let attachmentBytes = 0;

  for (const message of messages) {
    const readResult = await client.callTool({
      name: 'mail_query',
      arguments: { accountId, operation: 'readMessage', input: { locator: message.locator } },
    });
    const mailText = textFrom(readResult);
    fullRead = fullRead || mailText.length > 0;

    const attachmentSection = mailText.split('**Attachments:**')[1] ?? '';
    const attachmentLine = attachmentSection
      .split(/\r?\n/)
      .find(line => line.startsWith('- ') && line.includes(' ('));
    if (!attachmentLine) continue;

    const filename = attachmentLine.slice(2, attachmentLine.lastIndexOf(' ('));
    const attachmentResult = await client.callTool({
      name: 'mail_query',
      arguments: {
        accountId,
        operation: 'getAttachment',
        input: { locator: message.locator, filename },
      },
    });
    const resource = attachmentResult.content.find(item => item.type === 'resource');
    if (resource?.resource?.blob) {
      attachmentRead = true;
      attachmentBytes = Buffer.from(resource.resource.blob, 'base64').length;
    }
    break;
  }

  process.stdout.write(JSON.stringify({
    status: 'ok',
    accountCount: accounts.length,
    folderCount: folders.length,
    messageHeadersRead: messages.length,
    fullRead,
    attachmentRead,
    attachmentBytes,
  }));
} finally {
  await transport.terminateSession().catch(() => {});
  await client.close().catch(() => {});
}
