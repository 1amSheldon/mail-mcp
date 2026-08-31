import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const MAIL_QUERY_OPERATIONS = [
  'listMessages', 'searchMessages', 'verifySentMessage', 'readMessage', 'listFolders',
  'getRawMessage', 'getThread', 'getAttachment', 'extractAttachmentText', 'mailboxStats',
  'extractContacts', 'listTemplates', 'renderTemplate', 'listFilters', 'getFilter',
  'apple.listAccounts', 'apple.listMailboxes', 'apple.listMessages', 'apple.searchMessages',
  'apple.readMessage', 'apple.getRawSource', 'apple.listRules',
  'microsoft.getMessage', 'microsoft.findByInternetMessageId', 'microsoft.getThread',
  'microsoft.searchMessages',
  'mailtrap.templates', 'mailtrap.sandbox', 'mailtrap.email_logs', 'mailtrap.stats',
  'mailtrap.inbound', 'mailtrap.domains', 'mailtrap.suppressions', 'mailtrap.webhooks',
  'mailtrap.contacts', 'mailtrap.contact_lists', 'mailtrap.contact_fields',
  'mailtrap.contact_imports', 'mailtrap.contact_exports', 'mailtrap.campaigns',
  'mailtrap.accounts',
] as const;

export const MAIL_MUTATION_OPERATIONS = [
  'sendMessage', 'createDraft', 'createMailbox', 'renameMailbox', 'deleteMailbox',
  'copyMessage', 'moveMessage', 'modifyLabels', 'registerOAuth2', 'batchMessages',
  'reply', 'replyAll', 'forward', 'moveToTrash', 'permanentlyDelete', 'markRead',
  'markUnread', 'star', 'unstar', 'setFilter', 'deleteFilter',
  'apple.compose', 'apple.createDraft', 'apple.reply', 'apple.replyAll', 'apple.forward',
  'apple.updateMessage', 'apple.moveMessage', 'apple.trashMessage', 'apple.createMailbox',
  'apple.renameMailbox', 'apple.deleteMailbox', 'apple.createRule', 'apple.updateRule',
  'apple.deleteRule',
  'microsoft.sendMessage', 'microsoft.reply',
  'mailtrap.send', 'mailtrap.templates', 'mailtrap.sandbox', 'mailtrap.inbound',
  'mailtrap.domains', 'mailtrap.suppressions', 'mailtrap.webhooks', 'mailtrap.contacts',
  'mailtrap.contact_lists', 'mailtrap.contact_fields', 'mailtrap.contact_imports',
  'mailtrap.contact_exports', 'mailtrap.campaigns',
] as const;

export type MailQueryOperation = (typeof MAIL_QUERY_OPERATIONS)[number];
export type MailMutationOperation = (typeof MAIL_MUTATION_OPERATIONS)[number];

const STANDARD_QUERY_ROUTES = {
  listMessages: 'list_emails',
  searchMessages: 'search_emails',
  verifySentMessage: 'verify_sent_message',
  readMessage: 'read_email',
  listFolders: 'list_folders',
  getRawMessage: 'get_raw_email',
  getThread: 'get_thread',
  getAttachment: 'get_attachment',
  extractAttachmentText: 'extract_attachment_text',
  mailboxStats: 'mailbox_stats',
  extractContacts: 'extract_contacts',
  listTemplates: 'list_templates',
  renderTemplate: 'use_template',
  listFilters: 'list_filters',
  getFilter: 'get_filter',
} as const satisfies Record<string, string>;

const STANDARD_MUTATION_ROUTES = {
  sendMessage: 'send_email',
  createDraft: 'create_draft',
  createMailbox: 'create_mailbox',
  renameMailbox: 'rename_mailbox',
  deleteMailbox: 'delete_mailbox',
  copyMessage: 'copy_email',
  moveMessage: 'move_email',
  modifyLabels: 'modify_labels',
  registerOAuth2: 'register_oauth2_account',
  batchMessages: 'batch_operations',
  reply: 'reply_email',
  replyAll: 'reply_all_email',
  forward: 'forward_email',
  moveToTrash: 'delete_email',
  permanentlyDelete: 'permanently_delete_email',
  markRead: 'mark_read',
  markUnread: 'mark_unread',
  star: 'star',
  unstar: 'unstar',
  setFilter: 'set_filter',
  deleteFilter: 'delete_filter',
} as const satisfies Record<string, string>;

const PROVIDER_WRITE_ROUTERS = new Set([
  'apple_mail_mutate', 'microsoft_mail_send', 'mailtrap_mutate',
]);

const INTERNAL_WRITE_TOOLS = new Set([
  ...Object.values(STANDARD_MUTATION_ROUTES),
  ...PROVIDER_WRITE_ROUTERS,
]);

export const WRITE_TOOL_NAMES = ['mail_mutate'] as const;
export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];
export const WRITE_TOOLS: ReadonlySet<string> = new Set(WRITE_TOOL_NAMES);
export const WRITE_SELECTORS: ReadonlySet<string> = new Set([
  ...WRITE_TOOL_NAMES,
  ...MAIL_MUTATION_OPERATIONS,
  ...INTERNAL_WRITE_TOOLS,
]);

export interface RoutedToolCall {
  name: string;
  args: Record<string, unknown>;
}

function requireRouterInput(args: Record<string, unknown>): Record<string, unknown> {
  if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) {
    throw new Error('input must be an object');
  }
  const input = args.input as Record<string, unknown>;
  for (const reserved of ['accountId', 'confirmationId']) {
    if (reserved in input) {
      throw new Error(`${reserved} belongs at the top level, not inside input`);
    }
  }
  return input;
}

function requireAccountId(args: Record<string, unknown>): string {
  if (typeof args.accountId !== 'string' || args.accountId.trim() === '') {
    throw new Error('accountId is required for this operation');
  }
  return args.accountId;
}

function providerRoute(
  operation: string,
  input: Record<string, unknown>,
  accountId: string,
  write: boolean,
): RoutedToolCall | undefined {
  const separator = operation.indexOf('.');
  if (separator < 1) return undefined;
  const provider = operation.slice(0, separator);
  const providerOperation = operation.slice(separator + 1);
  if (provider === 'apple') {
    return {
      name: write ? 'apple_mail_mutate' : 'apple_mail_query',
      args: { accountId, operation: providerOperation, input },
    };
  }
  if (provider === 'microsoft') {
    return {
      name: write ? 'microsoft_mail_send' : 'microsoft_mail_query',
      args: { accountId, operation: providerOperation, input },
    };
  }
  if (provider === 'mailtrap') {
    return {
      name: write ? 'mailtrap_mutate' : 'mailtrap_query',
      args: { accountId, action: providerOperation, input },
    };
  }
  return undefined;
}

export function routeMailToolCall(
  name: string,
  args: Record<string, unknown>,
): RoutedToolCall {
  if (name !== 'mail_query' && name !== 'mail_mutate') return { name, args };
  if (typeof args.operation !== 'string') throw new Error('operation is required');
  const input = requireRouterInput(args);

  if (name === 'mail_query') {
    if (!MAIL_QUERY_OPERATIONS.includes(args.operation as MailQueryOperation)) {
      throw new Error(`Unknown mail_query operation: ${args.operation}`);
    }
    const standardRoute = STANDARD_QUERY_ROUTES[
      args.operation as keyof typeof STANDARD_QUERY_ROUTES
    ];
    if (standardRoute) {
      const accountOptional = args.operation === 'listTemplates' || args.operation === 'renderTemplate';
      const accountIdSupplied = Object.prototype.hasOwnProperty.call(args, 'accountId');
      const suppliedAccountId = accountIdSupplied ? requireAccountId(args) : undefined;
      return {
        name: standardRoute,
        args: {
          ...input,
          ...(suppliedAccountId
            ? { accountId: suppliedAccountId }
            : accountOptional ? {} : { accountId: requireAccountId(args) }),
        },
      };
    }
    const provider = providerRoute(args.operation, input, requireAccountId(args), false);
    if (provider) return provider;
  } else {
    if (!MAIL_MUTATION_OPERATIONS.includes(args.operation as MailMutationOperation)) {
      throw new Error(`Unknown mail_mutate operation: ${args.operation}`);
    }
    const standardRoute = STANDARD_MUTATION_ROUTES[
      args.operation as keyof typeof STANDARD_MUTATION_ROUTES
    ];
    if (standardRoute) {
      return { name: standardRoute, args: { ...input, accountId: requireAccountId(args) } };
    }
    const provider = providerRoute(args.operation, input, requireAccountId(args), true);
    if (provider) return provider;
  }
  throw new Error(`Operation ${args.operation} has no dispatch route`);
}

export function isWriteTool(name: string): name is WriteToolName {
  return WRITE_TOOLS.has(name);
}

export function isWriteCall(name: string): boolean {
  return name === 'mail_mutate' || INTERNAL_WRITE_TOOLS.has(name);
}

function mutationOperationAllowed(
  operation: MailMutationOperation,
  allowed: ReadonlySet<string>,
): boolean {
  if (allowed.has('mail_mutate') || allowed.has(operation)) return true;
  const standardRoute = STANDARD_MUTATION_ROUTES[
    operation as keyof typeof STANDARD_MUTATION_ROUTES
  ];
  if (standardRoute && allowed.has(standardRoute)) return true;
  if (operation.startsWith('apple.') && allowed.has('apple_mail_mutate')) return true;
  if (operation.startsWith('microsoft.') && allowed.has('microsoft_mail_send')) return true;
  return operation.startsWith('mailtrap.') && allowed.has('mailtrap_mutate');
}

export function isWriteCallAllowed(
  name: string,
  args: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  if (name === 'mail_mutate') {
    return typeof args.operation === 'string'
      && MAIL_MUTATION_OPERATIONS.includes(args.operation as MailMutationOperation)
      && mutationOperationAllowed(args.operation as MailMutationOperation, allowed);
  }
  return allowed.has(name);
}

const LIST_ACCOUNTS_TOOL: Tool = {
  name: 'list_accounts',
  description: 'List configured mail accounts, backends, and capabilities. Call this before mail_query or mail_mutate.',
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const MAIL_QUERY_TOOL: Tool = {
  name: 'mail_query',
  description: 'Read mail through IMAP, Apple Mail, Microsoft, or Mailtrap. Choose an operation and pass its fields in input. Provider operations use apple.*, microsoft.*, or mailtrap.*. Read mail://agent-guide for input shapes.',
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: 'Configured account ID. Optional only for listTemplates and renderTemplate.' },
      operation: { type: 'string', enum: [...MAIL_QUERY_OPERATIONS] },
      input: { type: 'object', additionalProperties: true, description: 'Operation-specific arguments. Keep accountId at the top level.' },
    },
    required: ['operation', 'input'],
    additionalProperties: false,
  },
};

const MAIL_MUTATE_TOOL: Tool = {
  name: 'mail_mutate',
  description: 'Draft, send, organize, or configure mail through any supported backend. Choose an operation and pass its fields in input. Provider operations use apple.*, microsoft.*, or mailtrap.*. Read mail://agent-guide before writes.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: 'Configured account ID.' },
      operation: { type: 'string', enum: [...MAIL_MUTATION_OPERATIONS] },
      input: { type: 'object', additionalProperties: true, description: 'Operation-specific arguments. Keep accountId and confirmationId at the top level.' },
      confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when confirmation mode is enabled.' },
    },
    required: ['accountId', 'operation', 'input'],
    additionalProperties: false,
  },
};

export const TOOL_CATALOG: readonly Tool[] = [LIST_ACCOUNTS_TOOL, MAIL_QUERY_TOOL, MAIL_MUTATE_TOOL];

function filteredMutationTool(allowed: ReadonlySet<string>): Tool | undefined {
  const operations = MAIL_MUTATION_OPERATIONS.filter(operation =>
    mutationOperationAllowed(operation, allowed)
  );
  if (operations.length === 0) return undefined;
  return {
    ...MAIL_MUTATE_TOOL,
    inputSchema: {
      ...MAIL_MUTATE_TOOL.inputSchema,
      properties: {
        ...MAIL_MUTATE_TOOL.inputSchema.properties,
        operation: { type: 'string', enum: operations },
      },
    },
  };
}

export function filterToolCatalog(
  readOnly: boolean,
  allowedTools?: ReadonlySet<string>,
): Tool[] {
  const readTools = [LIST_ACCOUNTS_TOOL, MAIL_QUERY_TOOL];
  if (readOnly) return [...readTools];
  if (allowedTools === undefined) return [...TOOL_CATALOG];
  const mutate = filteredMutationTool(allowedTools);
  return mutate ? [...readTools, mutate] : [...readTools];
}
