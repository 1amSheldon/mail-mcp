import type { GetPromptResult, Prompt, ReadResourceResult, Resource } from '@modelcontextprotocol/sdk/types.js';

export const MAIL_AGENT_GUIDE_URI = 'mail://agent-guide';
export const MAIL_AGENT_GUIDE_PROMPT_NAME = 'mail_agent_workflow';

export const MAIL_SERVER_INSTRUCTIONS = `Call list_accounts first. Use mail_query for reads and mail_mutate for writes. Read mail://agent-guide for operation names and input rules. Preserve cursors and message locators. Respect read-only, allowlist, and confirmation gates. Never retry smtp_outcome_unknown automatically.`;

export const MAIL_AGENT_GUIDE = `# Mail MCP agent workflow

The server has three tools:

- \`list_accounts\` discovers configured backends and capabilities.
- \`mail_query\` performs every read operation.
- \`mail_mutate\` performs every write operation.

For either router, put \`accountId\` and \`operation\` at the top level and operation-specific fields inside \`input\`. Provider operations are prefixed with \`apple.\`, \`microsoft.\`, or \`mailtrap.\`.

## Workflow

1. Discover first. Call \`list_accounts\` and inspect the selected account's backend and capabilities before choosing an operation.
2. Browse incrementally. For IMAP/SMTP, use \`listFolders\`, then \`listMessages\` or \`searchMessages\` with a bounded \`limit\`. For Apple Mail, use \`apple.listMailboxes\` and Apple-prefixed message operations. Microsoft and Mailtrap expose provider resources rather than a universal folder list. Start without a cursor, then pass the returned \`nextCursor\` unchanged until the result has no \`nextCursor\`.
3. Read each target message before replying, forwarding, moving, deleting, changing flags, or fetching attachments.
4. Prefer a draft when send intent, recipients, or final wording is unclear. Ask the user to review it.
5. Respect read-only mode, write allowlists, and confirmation IDs. Never bypass a server gate.
6. Never automatically retry \`smtp_outcome_unknown\`. The server may have accepted the first submission.
7. After SMTP acceptance, use \`verifySentMessage\` with the returned Message-ID. A missing Sent copy does not prove non-delivery.
8. Inspect attachment metadata before fetching. Enforce size and path limits, never execute content, and expose data only when requested.
9. Explain capability boundaries. IMAP reads mailboxes, SMTP sends, ManageSieve manages server filters, OAuth depends on the provider, and native or API adapters add backend-specific operations. Never invent unsupported parity.

## Read operations

Use \`mail_query\` with one of these operations:

- Messages: \`listMessages\`, \`searchMessages\`, \`readMessage\`, \`getRawMessage\`, \`getThread\`, \`verifySentMessage\`.
- Mailboxes and analysis: \`listFolders\`, \`mailboxStats\`, \`extractContacts\`.
- Attachments: \`getAttachment\`, \`extractAttachmentText\`.
- Local templates: \`listTemplates\`, \`renderTemplate\`; these two do not require \`accountId\`.
- ManageSieve: \`listFilters\`, \`getFilter\`.
- Apple Mail: \`apple.listAccounts\`, \`apple.listMailboxes\`, \`apple.listMessages\`, \`apple.searchMessages\`, \`apple.readMessage\`, \`apple.getRawSource\`, \`apple.listRules\`.
- Microsoft: \`microsoft.getMessage\`, \`microsoft.findByInternetMessageId\`, and \`microsoft.getThread\` for Graph; \`microsoft.getMessage\` and \`microsoft.searchMessages\` for EWS.
- Mailtrap: \`mailtrap.templates\`, \`mailtrap.sandbox\`, \`mailtrap.email_logs\`, \`mailtrap.stats\`, \`mailtrap.inbound\`, \`mailtrap.domains\`, \`mailtrap.suppressions\`, \`mailtrap.webhooks\`, \`mailtrap.contacts\`, \`mailtrap.contact_lists\`, \`mailtrap.contact_fields\`, \`mailtrap.contact_imports\`, \`mailtrap.contact_exports\`, \`mailtrap.campaigns\`, \`mailtrap.accounts\`.

## Write operations

Use \`mail_mutate\` with one of these operations:

- Compose: \`sendMessage\`, \`createDraft\`, \`reply\`, \`replyAll\`, \`forward\`.
- Messages: \`copyMessage\`, \`moveMessage\`, \`modifyLabels\`, \`batchMessages\`, \`moveToTrash\`, \`permanentlyDelete\`, \`markRead\`, \`markUnread\`, \`star\`, \`unstar\`.
- Mailboxes and setup: \`createMailbox\`, \`renameMailbox\`, \`deleteMailbox\`, \`registerOAuth2\`.
- ManageSieve: \`setFilter\`, \`deleteFilter\`.
- Apple Mail: \`apple.compose\`, \`apple.createDraft\`, \`apple.reply\`, \`apple.replyAll\`, \`apple.forward\`, message, mailbox, and rule mutation operations advertised by the schema.
- Microsoft: \`microsoft.sendMessage\`, \`microsoft.reply\`.
- Mailtrap: \`mailtrap.send\` plus the resource mutation operations advertised by the schema.

## Common input shapes

List messages with \`{ "folder": "INBOX", "limit": 25 }\`. Continue with the returned cursor. Read or mutate a message using its returned \`locator\`; do not rebuild locators. Send with \`{ "to": "user@example.com", "subject": "Subject", "body": "Body" }\`. Attachments, recipient lists, filters, and provider requests use the fields described by the selected account's capabilities and validation errors.`;

export const MAIL_AGENT_GUIDE_RESOURCE: Resource = {
  uri: MAIL_AGENT_GUIDE_URI,
  name: 'mail_agent_guide',
  title: 'Mail MCP agent workflow',
  description: 'Client-neutral rules for safe, capability-aware mail operations.',
  mimeType: 'text/markdown',
};

export const MAIL_AGENT_GUIDE_PROMPT: Prompt = {
  name: MAIL_AGENT_GUIDE_PROMPT_NAME,
  title: 'Mail MCP agent workflow',
  description: 'Apply the safe mail workflow before reading or changing mailbox data.',
};

export function readMailAgentGuideResource(uri: string): ReadResourceResult | undefined {
  if (uri !== MAIL_AGENT_GUIDE_URI) return undefined;

  return {
    contents: [{
      uri: MAIL_AGENT_GUIDE_URI,
      mimeType: 'text/markdown',
      text: MAIL_AGENT_GUIDE,
    }],
  };
}

export function getMailAgentGuidePrompt(name: string): GetPromptResult | undefined {
  if (name !== MAIL_AGENT_GUIDE_PROMPT_NAME) return undefined;

  return {
    description: MAIL_AGENT_GUIDE_PROMPT.description,
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: MAIL_AGENT_GUIDE,
      },
    }],
  };
}
