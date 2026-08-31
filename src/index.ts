#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getAccounts, getConfiguredAccounts } from './config.js';
import { handleAccountsCommand } from './cli/accounts.js';
import { getClaudeConfigPath, installClaude } from './cli/install-claude.js';
import { installClaudeCode } from './cli/install-claude-code.js';
import { installCodexBundle } from './cli/install-codex.js';
import {
  buildMailMcpNpxArgs,
  MAIL_MCP_LATEST_SPEC,
  prepareMailMcpNpxRuntime,
} from './cli/npm-runtime.js';
import { MailService } from './services/mail.js';
import type { MailSendMessage, SendDeliveryResult } from './services/mail.js';
import { MailMCPError, NetworkError } from './errors.js';
import { TieredRateLimiter } from './utils/rate-limiter.js';
import { ImapClient } from './protocol/imap.js';
import { SmtpClient } from './protocol/smtp.js';
import { validateEmailAddresses, validateRecipients } from './utils/validation.js';
import { getTemplates, applyVariables } from './utils/templates.js';
import { SieveClient } from './protocol/sieve.js';
import { AuditLogger } from './utils/audit-logger.js';
import { ConfirmationStore, confirmationArgsHash } from './utils/confirmation-store.js';
import { AUDIT_LOG_PATH } from './config.js';
import { MailMCPRuntimeState } from './runtime-state.js';
import { startHttpHost } from './http-host.js';
import { startAutoUpdateMonitor, type AutoUpdateMonitor } from './auto-update.js';
import {
  HTTP_BEARER_TOKEN_ENV,
  installWindowsHttpService,
  SHARED_HTTP_HOST,
  SHARED_HTTP_PORT,
} from './cli/windows-service.js';
import {
  filterToolCatalog,
  isWriteCall,
  isWriteCallAllowed,
  routeMailToolCall,
  WRITE_SELECTORS,
} from './mcp/tool-catalog.js';
import { getAccountCapabilities } from './providers/account-types.js';
import {
  ProviderRuntime,
  ProviderRuntimeError,
  type AppleReadOperation,
  type AppleWriteOperation,
  type MicrosoftReadOperation,
  type MicrosoftWriteOperation,
} from './providers/runtime.js';
import type { MailtrapAction } from './providers/mailtrap/types.js';
import { AppleMailError } from './providers/apple-mail/errors.js';
import { MailtrapHttpError } from './providers/mailtrap/client.js';
import { MicrosoftProviderError } from './providers/microsoft/common.js';
import type { OutgoingAttachment } from './domain/outgoing-message.js';
import { validateOAuth2TokenEndpoint } from './security/oauth2.js';
import {
  getMailAgentGuidePrompt,
  MAIL_SERVER_INSTRUCTIONS,
  MAIL_AGENT_GUIDE_PROMPT,
  MAIL_AGENT_GUIDE_RESOURCE,
  readMailAgentGuideResource,
} from './mcp/agent-guide.js';

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = (require('../package.json') as { version: string }).version;

export function parseCliArgs(args: string[]) {
  return parseArgs({
    args,
    options: {
      'read-only': { type: 'boolean', default: false },
      'allow-tools': { type: 'string' },
      'confirm': { type: 'boolean', default: false },
      'audit-log': { type: 'boolean', default: false },
      'redact': { type: 'boolean', default: false },
      'http': { type: 'boolean', default: false },
      'host': { type: 'string', default: '127.0.0.1' },
      'port': { type: 'string', default: '8765' },
      'bearer-token-env': { type: 'string', default: 'MAIL_MCP_BEARER_TOKEN' },
      'validate-accounts': { type: 'boolean', default: false },
      'install-claude': { type: 'boolean', default: false },
      'install-claude-code': { type: 'boolean', default: false },
      'install-codex': { type: 'boolean', default: false },
      'install-codex-stdio': { type: 'boolean', default: false },
      'auto-update-seconds': { type: 'string' },
      'version': { type: 'boolean', default: false },
      'help': { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }).values;
}

export function parseAllowedTools(raw: string | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined;

  const allowedTools = new Set(raw.split(',').map(tool => tool.trim()).filter(Boolean));
  const unknownTools = [...allowedTools].filter(tool => !WRITE_SELECTORS.has(tool));
  if (unknownTools.length > 0) {
    throw new Error(
      `Unknown write selector(s): ${unknownTools.join(', ')}. Available write selectors: ${[...WRITE_SELECTORS].join(', ')}.`
    );
  }
  return allowedTools;
}

function formatDeliveryResult(result: SendDeliveryResult) {
  const isError = result.status === 'smtp_rejected' ||
    result.status === 'smtp_connection_failed' ||
    result.status === 'smtp_outcome_unknown';
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function outgoingMessageFromArgs(args: Record<string, unknown>): MailSendMessage {
  const body = args.body as string | undefined;
  const isHtml = args.isHtml === true;
  const text = (args.textBody as string | undefined) ?? (!isHtml ? body : undefined);
  const html = (args.htmlBody as string | undefined) ?? (isHtml ? body : undefined);
  return {
    to: args.to as string,
    subject: args.subject as string,
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
    ...(args.cc ? { cc: args.cc as string } : {}),
    ...(args.bcc ? { bcc: args.bcc as string } : {}),
    ...(args.replyTo ? { replyTo: args.replyTo as string } : {}),
    ...(args.from ? { from: args.from as string } : {}),
    ...(Array.isArray(args.attachments)
      ? { attachments: args.attachments as OutgoingAttachment[] }
      : {}),
    includeSignature: args.includeSignature !== false,
  };
}

function usesExtendedOutgoingArgs(args: Record<string, unknown>): boolean {
  return args.textBody !== undefined
    || args.htmlBody !== undefined
    || args.replyTo !== undefined
    || args.from !== undefined
    || args.attachments !== undefined;
}

function formatProviderResult(result: unknown, uri: string) {
  if (result instanceof Uint8Array) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ bytes: result.byteLength, mediaType: 'application/octet-stream' }, null, 2),
        },
        {
          type: 'resource' as const,
          resource: {
            uri,
            mimeType: 'application/octet-stream',
            blob: Buffer.from(result).toString('base64'),
          },
        },
      ],
    };
  }
  return {
    content: [{
      type: 'text' as const,
      text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
    }],
  };
}

function providerErrorMessage(error: unknown): string {
  if (error instanceof ProviderRuntimeError) {
    return `[${error.code}] ${error.message}`;
  }
  if (error instanceof AppleMailError) {
    const safeMessage = error.code === 'EXECUTION_FAILED'
      ? 'Apple Mail automation failed. Check Mail.app state and macOS Automation permissions.'
      : error.message;
    return `[${error.code}] ${safeMessage}`;
  }
  if (error instanceof MicrosoftProviderError) {
    const metadata = [
      error.status !== undefined ? `HTTP ${error.status}` : undefined,
      error.requestId ? `request ${error.requestId}` : undefined,
    ].filter(Boolean).join(', ');
    if (error.kind === 'validation' || error.kind === 'invalid_response') {
      return `[${error.provider}:${error.kind}] ${error.message}`;
    }
    return `[${error.provider}:${error.kind}] Provider request failed${metadata ? ` (${metadata})` : ''}.`;
  }
  if (error instanceof MailtrapHttpError) {
    return `[mailtrap${error.status ? `:${error.status}` : ''}] ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build a human-readable description of a write tool action for the confirmation prompt.
 */
function buildConfirmationDescription(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'mail_mutate') {
    const routed = routeMailToolCall(toolName, args);
    return buildConfirmationDescription(routed.name, routed.args);
  }
  const uid = args.uid as string | undefined;
  const folder = (args.folder as string | undefined) || 'INBOX';
  switch (toolName) {
    case 'send_email':
      return `Send email to ${args.to as string} with subject '${args.subject as string}'`;
    case 'create_draft':
      return `Save draft to ${args.to as string} with subject '${args.subject as string}'`;
    case 'reply_email':
      return args.locator
        ? `Reply to message ${args.locator as string}`
        : `Reply to email UID ${uid} in ${folder}`;
    case 'reply_all_email':
      return `Reply to all participants of message ${args.locator as string}`;
    case 'forward_email':
      return args.locator
        ? `Forward message ${args.locator as string} to ${args.to as string}`
        : `Forward email UID ${uid} to ${args.to as string}`;
    case 'delete_email':
      return args.locator
        ? `Move message ${args.locator as string} to Trash`
        : `Move email UID ${uid} from ${folder} to Trash`;
    case 'permanently_delete_email':
      return args.locator
        ? `Permanently delete message ${args.locator as string}`
        : `Permanently delete email UID ${uid} from ${folder}`;
    case 'create_mailbox':
      return `Create mailbox ${args.path as string}`;
    case 'rename_mailbox':
      return `Rename mailbox ${args.path as string} to ${args.newPath as string}`;
    case 'delete_mailbox':
      return `Delete mailbox ${args.path as string}`;
    case 'copy_email':
      return `Copy message ${args.locator as string} to ${args.targetFolder as string}`;
    case 'move_email':
      return args.locator
        ? `Move message ${args.locator as string} to ${args.targetFolder as string}`
        : `Move email UID ${uid} from ${args.sourceFolder as string} to ${args.targetFolder as string}`;
    case 'batch_operations': {
      const count = Array.isArray(args.locators)
        ? args.locators.length
        : Array.isArray(args.uids) ? args.uids.length : 0;
      return `Batch ${args.action as string} ${count} emails${Array.isArray(args.locators) ? '' : ` in ${folder}`}`;
    }
    case 'modify_labels':
      return args.locator
        ? `Modify labels on message ${args.locator as string}`
        : `Modify labels on email UID ${uid} in ${folder}`;
    case 'mark_read':
      return args.locator
        ? `Mark message ${args.locator as string} as read`
        : `Mark email UID ${uid} as read in ${folder}`;
    case 'mark_unread':
      return args.locator
        ? `Mark message ${args.locator as string} as unread`
        : `Mark email UID ${uid} as unread in ${folder}`;
    case 'star':
      return args.locator
        ? `Star message ${args.locator as string}`
        : `Star email UID ${uid} in ${folder}`;
    case 'unstar':
      return args.locator
        ? `Unstar message ${args.locator as string}`
        : `Unstar email UID ${uid} in ${folder}`;
    case 'register_oauth2_account':
      return `Register OAuth2 credentials for account ${args.accountId as string}`;
    case 'set_filter':
      return `Create/update SIEVE filter '${args.name as string}' on account ${args.accountId as string}`;
    case 'delete_filter':
      return `Delete SIEVE filter '${args.name as string}' on account ${args.accountId as string}`;
    case 'apple_mail_mutate':
    case 'microsoft_mail_send':
      return `Execute ${args.operation as string} for provider account ${args.accountId as string}`;
    case 'mailtrap_mutate': {
      const input = args.input && typeof args.input === 'object' && !Array.isArray(args.input)
        ? args.input as Record<string, unknown>
        : {};
      const operation = [args.action, input.resource, input.operation]
        .filter(value => typeof value === 'string' && value.length > 0)
        .join(' / ');
      const identifiers = [
        'templateId', 'projectId', 'folderId', 'inboxId', 'messageId', 'attachmentId',
        'threadId', 'domainId', 'suppressionId', 'webhookId', 'contact', 'id', 'campaignId',
      ].flatMap(key => input[key] === undefined ? [] : [`${key}=${String(input[key])}`]);
      return `Execute Mailtrap ${operation} for account ${args.accountId as string}${
        identifiers.length > 0 ? ` (${identifiers.join(', ')})` : ''
      }`;
    }
    default:
      return `Execute ${toolName}`;
  }
}

export class MailMCPServer {
  private server: Server;
  private services: Map<string, MailService>;
  private serviceCreations: Map<string, Promise<MailService>>;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private inFlightCount = 0;
  private readonly rateLimiter: TieredRateLimiter;
  private readonly allowedTools?: Set<string>;
  private readonly confirmMode: boolean;
  private readonly confirmStore: ConfirmationStore;
  private readonly auditLogger?: AuditLogger;
  private readonly redact: boolean;
  private readonly runtimeState: MailMCPRuntimeState;
  private readonly providerRuntime: ProviderRuntime;
  private readonly ownsRuntimeState: boolean;

  constructor(
    private readonly readOnly: boolean = false,
    allowedTools?: Set<string>,
    auditLogger?: AuditLogger,
    confirmMode: boolean = false,
    redact: boolean = false,
    runtimeState?: MailMCPRuntimeState
  ) {
    if (readOnly && allowedTools !== undefined) {
      throw new Error(
        '--read-only and --allow-tools are mutually exclusive. Use --read-only to disable all write operations, or --allow-tools to enable specific ones.'
      );
    }

    this.allowedTools = allowedTools;
    this.auditLogger = auditLogger;
    this.confirmMode = confirmMode;
    this.confirmStore = new ConfirmationStore();
    this.redact = redact;
    this.runtimeState = runtimeState ?? new MailMCPRuntimeState();
    this.providerRuntime = new ProviderRuntime(this.runtimeState, { redact: this.redact });
    this.ownsRuntimeState = runtimeState === undefined;
    this.services = this.runtimeState.services;
    this.serviceCreations = this.runtimeState.serviceCreations;
    this.rateLimiter = this.runtimeState.rateLimiter;

    const instructionsSuffix = (() => {
      if (readOnly) {
        return ' This server is running in read-only mode. Write operations advertised by the normal server are disabled.';
      }
      if (allowedTools !== undefined) {
        const list = [...allowedTools].join(', ') || 'none';
        return ` This server is running with allow-listed write selectors. Only these write operations are enabled: ${list}.`;
      }
      if (confirmMode) {
        return ' This server is running in confirmation mode. Write operations require a two-step confirmation: the first call returns a confirmationId; include it in the second call to execute the action.';
      }
      return '';
    })();

    this.server = new Server(
      {
        name: 'mail-mcp-server',
        version: PACKAGE_VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        instructions: `${MAIL_SERVER_INSTRUCTIONS}\n\n${instructionsSuffix.trim()}`.trim(),
      }
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;

    this.shutdownPromise = (async () => {
      // Wait for in-flight requests to drain (max 10s).
      const deadline = Date.now() + 10_000;
      while (this.inFlightCount > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (this.ownsRuntimeState) {
        await this.runtimeState.shutdown();
      }
      await this.server.close();
    })();
    return this.shutdownPromise;
  }

  private async _createAndCacheService(accountId: string): Promise<MailService> {
    const accounts = await getAccounts();
    const account = accounts.find(a => a.id === accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found in configuration.`);
    }
    const service = new MailService(account, this.redact);
    await service.connect();
    this.services.set(accountId, service);

    // Remove closed connections so the next call reconnects.
    service.imap.onClose = () => {
      if (!this.runtimeState.isShuttingDown && this.services.get(accountId) === service) {
        this.services.delete(accountId);
      }
    };

    return service;
  }

  private async getService(accountId: string): Promise<MailService> {
    if (this.services.has(accountId)) {
      return this.services.get(accountId)!;
    }
    const existingCreation = this.serviceCreations.get(accountId);
    if (existingCreation) return existingCreation;

    const creation = (async () => {
      try {
        try {
          return await this._createAndCacheService(accountId);
        } catch (firstErr) {
          // IMAP connection setup is safe to retry because no SMTP send has started.
          await new Promise(r => setTimeout(r, 1_000));
          try {
            return await this._createAndCacheService(accountId);
          } catch (secondErr) {
            throw new NetworkError(
              `Could not connect to account ${accountId} after reconnect attempt: ${(secondErr as Error).message}`,
              { cause: secondErr }
            );
          }
        }
      } finally {
        this.serviceCreations.delete(accountId);
      }
    })();
    this.serviceCreations.set(accountId, creation);
    return creation;
  }

  getTools(readOnly: boolean, allowedTools?: Set<string>) {
    return filterToolCatalog(readOnly, allowedTools);
  }
  async dispatchTool(name: string, readOnly: boolean, args: Record<string, unknown>) {
    const _dispatchStart = Date.now();
    const requestedName = name;
    const requestedArgs = args;
    let _dispatchIsError = false;
    let _dispatchErrorMsg: string | undefined;
    const trackResult = <T extends { isError?: boolean; content?: Array<{ type: string; text?: string }> }>(result: T): T => {
      if (result.isError) {
        _dispatchIsError = true;
        _dispatchErrorMsg = result.content
          ?.map(item => item.text)
          .filter((text): text is string => Boolean(text))
          .join('\n') || 'Tool returned an error result';
      }
      return result;
    };
    try {
      if (readOnly && isWriteCall(name)) {
        return trackResult({
          content: [{
            type: 'text',
            text: `Tool '${name}' is not available: server is running in read-only mode. Use a server without --read-only to perform write operations.`,
          }],
          isError: true,
        });
      }

      if (this.allowedTools !== undefined && isWriteCall(name)
        && !isWriteCallAllowed(name, args, this.allowedTools)) {
        const list = [...this.allowedTools].join(', ') || 'none';
        return trackResult({
          content: [{
            type: 'text',
            text: `Tool '${name}' is not available: its operation is not in the allowlist. Allowed write selectors: ${list}. Use --allow-tools to change the list.`,
          }],
          isError: true,
        });
      }

      // Confirmation mode gate — intercept write tools when --confirm is active
      if (this.confirmMode && isWriteCall(name)) {
        const confirmationId = args.confirmationId as string | undefined;
        if (confirmationId) {
          // Second call: validate and consume the token
          const pending = this.confirmStore.consume(confirmationId);
          if (!pending) {
            return trackResult({
              content: [{
                type: 'text',
                text: 'Confirmation token invalid or expired. Call the tool again without confirmationId to get a new token.',
              }],
              isError: true,
            });
          }
          // Token valid — strip confirmationId from args and fall through to execute
          if (pending.toolName !== name) {
            return trackResult({
              content: [{
                type: 'text',
                text: `Confirmation token was issued for '${pending.toolName}', not '${name}'. Request a new confirmation token.`,
              }],
              isError: true,
            });
          }
          const confirmedArgs = { ...args };
          delete confirmedArgs.confirmationId;
          if (pending.argsHash !== confirmationArgsHash(confirmedArgs)) {
            return trackResult({
              content: [{
                type: 'text',
                text: 'Tool arguments changed after confirmation. Request a new confirmation token for the updated action.',
              }],
              isError: true,
            });
          }
          args = confirmedArgs;
        } else {
          // First call: create confirmation token and return prompt
          const argsWithoutId = { ...args };
          delete argsWithoutId.confirmationId;
          const confirmationAccountId = argsWithoutId.accountId as string | undefined;
          if (confirmationAccountId) {
            await this.rateLimiter.consumeWrite(confirmationAccountId);
          }
          const description = buildConfirmationDescription(name, args);
          const id = this.confirmStore.create(name, argsWithoutId);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                confirmationRequired: true,
                action: name,
                description,
                confirmationId: id,
                expiresIn: '5 minutes',
              }, null, 2),
            }],
          };
        }
      }

      // Rate limit guard — before any I/O (list_accounts has no accountId, skip it)
      const accountId = (args as Record<string, unknown>)?.accountId as string | undefined;
      if (accountId) {
        if (isWriteCall(name)) {
          await this.rateLimiter.consumeWrite(accountId);
        } else {
          await this.rateLimiter.consumeRead(accountId);
        }
      }

      const routed = routeMailToolCall(name, args);
      name = routed.name;
      args = routed.args;

      if (name === 'list_accounts') {
        const accounts = await getConfiguredAccounts();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(
              accounts.map((account) => ({
                id: account.id,
                name: account.name,
                backend: account.backend ?? 'imap-smtp',
                ...('user' in account ? { user: account.user } : {}),
                capabilities: getAccountCapabilities(account),
              })),
              null,
              2
            ),
          }],
        };
      }

      if (name === 'apple_mail_query' || name === 'apple_mail_mutate') {
        const accountId = args.accountId as string;
        const input = requireObject(args.input, 'input');
        try {
          const result = name === 'apple_mail_query'
            ? await this.providerRuntime.executeAppleRead(
                accountId,
                args.operation as AppleReadOperation,
                input as never,
              )
            : await this.providerRuntime.executeAppleWrite(
                accountId,
                args.operation as AppleWriteOperation,
                input as never,
              );
          return formatProviderResult(
            result,
            `apple-mail-result://${encodeURIComponent(accountId)}/${encodeURIComponent(String(args.operation))}`,
          );
        } catch (error) {
          throw new Error(providerErrorMessage(error), { cause: error });
        }
      }

      if (name === 'microsoft_mail_query' || name === 'microsoft_mail_send') {
        const accountId = args.accountId as string;
        const input = requireObject(args.input, 'input');
        try {
          const result = name === 'microsoft_mail_query'
            ? await this.providerRuntime.executeMicrosoftRead(
                accountId,
                args.operation as MicrosoftReadOperation,
                input as never,
              )
            : await this.providerRuntime.executeMicrosoftWrite(
                accountId,
                args.operation as MicrosoftWriteOperation,
                input as never,
              );
          return formatProviderResult(
            result,
            `microsoft-mail-result://${encodeURIComponent(accountId)}/${encodeURIComponent(String(args.operation))}`,
          );
        } catch (error) {
          throw new Error(providerErrorMessage(error), { cause: error });
        }
      }

      if (name === 'mailtrap_query' || name === 'mailtrap_mutate') {
        const accountId = args.accountId as string;
        const input = requireObject(args.input, 'input');
        try {
          const result = name === 'mailtrap_query'
            ? await this.providerRuntime.executeMailtrapRead(
                accountId,
                args.action as MailtrapAction,
                input as never,
              )
            : await this.providerRuntime.executeMailtrapWrite(
                accountId,
                args.action as MailtrapAction,
                input as never,
              );
          return formatProviderResult(
            result,
            `mailtrap-result://${encodeURIComponent(accountId)}/${encodeURIComponent(String(args.action))}`,
          );
        } catch (error) {
          throw new Error(providerErrorMessage(error), { cause: error });
        }
      }

      // Email validation guard for send/draft/reply/forward tools — before SMTP/IMAP I/O
      if (name === 'send_email' || name === 'create_draft') {
        validateEmailAddresses(
          args.to as string,
          args.cc as string | undefined,
          args.bcc as string | undefined
        );
      }
      if (name === 'forward_email') {
        validateEmailAddresses(
          args.to as string,
          args.cc as string | undefined,
          args.bcc as string | undefined
        );
      }
      if (name === 'reply_email') {
        // to is determined from original message; validate optional cc/bcc only
        if (args.cc || args.bcc) {
          validateEmailAddresses(
            'placeholder@example.com', // dummy valid to — real to is set from original message
            args.cc as string | undefined,
            args.bcc as string | undefined
          );
        }
      }

      // Allowlist guard — validate recipients against per-account allowedRecipients when set
      if (
        name === 'send_email' ||
        name === 'create_draft' ||
        name === 'forward_email' ||
        name === 'reply_email'
      ) {
        const sendAccountId = args.accountId as string | undefined;
        if (sendAccountId) {
          const allAccounts = await getAccounts();
          const sendAccount = allAccounts.find((a) => a.id === sendAccountId);
          if (sendAccount?.allowedRecipients && sendAccount.allowedRecipients.length > 0) {
            const allowlist = sendAccount.allowedRecipients;
            if (name === 'reply_email') {
              // to is auto-determined from original sender — only validate cc/bcc
              validateRecipients(
                [args.cc as string | undefined, args.bcc as string | undefined],
                allowlist,
                sendAccountId
              );
            } else {
              validateRecipients(
                [
                  args.to as string | undefined,
                  args.cc as string | undefined,
                  args.bcc as string | undefined,
                ],
                allowlist,
                sendAccountId
              );
            }
          }
        }
      }

      if (name === 'reply_email') {
        const service = await this.getService(args.accountId as string);
        const includeSignature = (args.includeSignature as boolean | undefined) !== false;
        const result = args.locator
          ? await service.replyLocatedEmail(
              args.locator as string,
              args.body as string,
              args.isHtml as boolean | undefined,
              args.cc as string | undefined,
              args.bcc as string | undefined,
              includeSignature,
              args.attachments as OutgoingAttachment[] | undefined,
            )
          : await service.replyEmail(
              args.uid as string,
              (args.folder as string | undefined) || 'INBOX',
              args.body as string,
              args.isHtml as boolean | undefined,
              args.cc as string | undefined,
              args.bcc as string | undefined,
              includeSignature,
              args.attachments as OutgoingAttachment[] | undefined,
            );
        return trackResult(formatDeliveryResult(result));
      }

      if (name === 'reply_all_email') {
        const service = await this.getService(args.accountId as string);
        const result = await service.replyAllEmail(
          args.locator as string,
          args.body as string,
          {
            ...(args.isHtml !== undefined ? { isHtml: args.isHtml as boolean } : {}),
            ...(args.bcc ? { bcc: args.bcc as string } : {}),
            includeSignature: args.includeSignature !== false,
            includeOriginalAttachments: args.includeOriginalAttachments === true,
          },
        );
        return trackResult(formatDeliveryResult(result));
      }

      if (name === 'forward_email') {
        const service = await this.getService(args.accountId as string);
        const includeSignature = (args.includeSignature as boolean | undefined) !== false;
        const result = args.locator
          ? await service.forwardLocatedEmail(
              args.locator as string,
              args.to as string,
              (args.body as string | undefined) || '',
              args.isHtml as boolean | undefined,
              args.cc as string | undefined,
              args.bcc as string | undefined,
              includeSignature,
              args.attachments as OutgoingAttachment[] | undefined,
              args.includeOriginalAttachments === true,
            )
          : await service.forwardEmail(
              args.uid as string,
              (args.folder as string | undefined) || 'INBOX',
              args.to as string,
              (args.body as string | undefined) || '',
              args.isHtml as boolean | undefined,
              args.cc as string | undefined,
              args.bcc as string | undefined,
              includeSignature,
              args.attachments as OutgoingAttachment[] | undefined,
              args.includeOriginalAttachments === true,
            );
        return trackResult(formatDeliveryResult(result));
      }

      if (name === 'list_emails') {
        if ('offset' in args) {
          throw new Error('Pagination is cursor-only; offset is not accepted');
        }
        const service = await this.getService(args.accountId as string);
        const messages = await service.listEmailsPage({
          folder: args.folder as string | undefined,
          limit: args.limit as number | undefined,
          cursor: args.cursor as string | undefined,
          headerOnly: args.headerOnly as boolean | undefined,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
        };
      }

      if (name === 'search_emails') {
        if ('offset' in args) {
          throw new Error('Pagination is cursor-only; offset is not accepted');
        }
        const service = await this.getService(args.accountId as string);
        const messages = await service.searchEmailsPage({
          from: args.from as string | undefined,
          to: args.to as string | undefined,
          cc: args.cc as string | undefined,
          messageId: args.messageId as string | undefined,
          subject: args.subject as string | undefined,
          since: args.since as string | undefined,
          before: args.before as string | undefined,
          keywords: args.keywords as string | undefined,
        }, {
          folder: args.folder as string | undefined,
          limit: args.limit as number | undefined,
          cursor: args.cursor as string | undefined,
          headerOnly: args.headerOnly as boolean | undefined,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
        };
      }

      if (name === 'read_email') {
        const service = await this.getService(args.accountId as string);
        const content = args.locator
          ? await service.readLocatedEmail(args.locator as string)
          : await service.readEmail(
              args.uid as string,
              (args.folder as string | undefined) ?? 'INBOX',
            );
        return { content: [{ type: 'text', text: content }] };
      }

      if (name === 'list_folders') {
        const service = await this.getService(args.accountId as string);
        const folders = await service.listMailboxMetadata();
        return {
          content: [{ type: 'text', text: JSON.stringify(folders, null, 2) }],
        };
      }

      if (name === 'get_raw_email') {
        const service = await this.getService(args.accountId as string);
        const maxBytes = Math.min(
          Math.max((args.maxBytes as number | undefined) ?? 10 * 1024 * 1024, 1),
          50 * 1024 * 1024,
        );
        const raw = await service.readRawEmail(args.locator as string, maxBytes);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                locator: raw.locator,
                mediaType: raw.mediaType,
                size: raw.size,
              }, null, 2),
            },
            {
              type: 'resource',
              resource: {
                uri: `mail-message://${encodeURIComponent(args.accountId as string)}/${encodeURIComponent(raw.locator)}`,
                mimeType: raw.mediaType,
                blob: raw.contentBase64,
              },
            },
          ],
        };
      }

      if (name === 'get_thread') {
        const service = await this.getService(args.accountId as string);
        const messages = await service.getThread(
          args.threadId as string,
          (args.folder as string | undefined) ?? 'INBOX'
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
        };
      }

      if (name === 'get_attachment') {
        const filename = args.filename as string;
        const uid = args.uid as string;
        const service = await this.getService(args.accountId as string);
        const locator = args.locator as string | undefined;
        const { content, contentType } = locator
          ? await service.downloadLocatedAttachment(locator, filename)
          : await service.downloadAttachment(
              uid,
              filename,
              (args.folder as string | undefined) ?? 'INBOX'
            );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ...(locator ? { locator } : { uid }),
                filename,
                contentType,
                bytes: content.length,
              }, null, 2),
            },
            {
              type: 'resource',
              resource: {
                uri: `mail-attachment://${encodeURIComponent(args.accountId as string)}/${encodeURIComponent(locator ?? uid)}/${encodeURIComponent(filename)}`,
                mimeType: contentType,
                blob: content.toString('base64'),
              },
            },
          ],
        };
      }

      if (name === 'extract_attachment_text') {
        const service = await this.getService(args.accountId as string);
        const locator = args.locator as string | undefined;
        const content = locator
          ? await service.extractLocatedAttachmentText(locator, args.filename as string)
          : await service.extractAttachmentText(
              args.uid as string,
              args.filename as string,
              (args.folder as string | undefined) ?? 'INBOX'
            );
        return { content: [{ type: 'text', text: content }] };
      }

      if (name === 'extract_contacts') {
        const service = await this.getService(args.accountId as string);
        const count = Math.min((args.count as number | undefined) ?? 100, 500);
        const contacts = await service.extractContacts(
          (args.folder as string | undefined) ?? 'INBOX',
          count
        );
        return {
          content: [{ type: 'text', text: JSON.stringify({ contacts }, null, 2) }],
        };
      }

      if (name === 'verify_sent_message') {
        const messageId = String(args.messageId ?? '').trim();
        if (!messageId) {
          throw new Error('messageId is required');
        }
        const service = await this.getService(args.accountId as string);
        const sentFolder = await service.resolveSentFolder(args.sentFolder as string | undefined);
        const page = await service.searchEmailsPage(
          { messageId },
          {
            folder: sentFolder,
            limit: Math.min((args.count as number | undefined) ?? 10, 100),
          },
        );
        const matches = page.items;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: matches.length > 0 ? 'found_in_sent' : 'not_found_in_sent',
              messageId,
              sentFolder,
              count: matches.length,
              matches,
              caution: matches.length > 0
                ? 'The IMAP Sent copy exists. Do not resend.'
                : 'Absence from Sent does not prove SMTP non-delivery. Do not retry automatically.',
            }, null, 2),
          }],
        };
      }

      if (name === 'send_email') {
        const service = await this.getService(args.accountId as string);
        const result = usesExtendedOutgoingArgs(args)
          ? await service.sendMessage(outgoingMessageFromArgs(args))
          : await service.sendEmail(
              args.to as string,
              args.subject as string,
              args.body as string,
              args.isHtml as boolean | undefined,
              args.cc as string | undefined,
              args.bcc as string | undefined,
              args.includeSignature !== false,
            );
        return trackResult(formatDeliveryResult(result));
      }

      if (name === 'create_draft') {
        const service = await this.getService(args.accountId as string);
        const draft = await service.createDraftMessage(outgoingMessageFromArgs(args));
        return {
          content: [{ type: 'text', text: JSON.stringify(draft, null, 2) }],
        };
      }

      if (name === 'move_email') {
        const service = await this.getService(args.accountId as string);
        const targetFolder = args.targetFolder as string;
        if (args.locator) {
          await service.moveLocatedEmail(args.locator as string, targetFolder);
        } else {
          await service.moveMessage(
            args.uid as string,
            args.sourceFolder as string,
            targetFolder,
          );
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ moved: true, targetFolder }, null, 2),
          }],
        };
      }

      if (name === 'create_mailbox') {
        const service = await this.getService(args.accountId as string);
        const result = await service.createMailbox(args.path as string);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'rename_mailbox') {
        const service = await this.getService(args.accountId as string);
        const result = await service.renameMailbox(args.path as string, args.newPath as string);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'delete_mailbox') {
        const service = await this.getService(args.accountId as string);
        const result = await service.deleteMailbox(args.path as string);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'copy_email') {
        const service = await this.getService(args.accountId as string);
        const result = await service.copyEmail(
          args.locator as string,
          args.targetFolder as string,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'modify_labels') {
        const service = await this.getService(args.accountId as string);
        const addLabels = (args.addLabels as string[] | undefined) ?? [];
        const removeLabels = (args.removeLabels as string[] | undefined) ?? [];
        if (args.locator) {
          await service.modifyLocatedLabels(args.locator as string, addLabels, removeLabels);
        } else {
          await service.modifyLabels(
            args.uid as string,
            (args.folder as string | undefined) ?? 'INBOX',
            addLabels,
            removeLabels,
          );
        }
        return {
          content: [{
            type: 'text',
            text: args.locator
              ? `Labels updated for message ${args.locator as string}.`
              : `Labels updated for email ${args.uid as string} in ${(args.folder as string | undefined) ?? 'INBOX'}.`,
          }],
        };
      }

      if (name === 'batch_operations') {
        const service = await this.getService(args.accountId as string);
        const action = args.action as 'move' | 'copy' | 'delete' | 'label';
        let operation: Parameters<MailService['batchOperations']>[2];

        if (action === 'move' || action === 'copy') {
          const targetFolder = args.targetFolder as string | undefined;
          if (!targetFolder) throw new Error(`targetFolder is required for ${action} action`);
          operation = { type: action, targetFolder };
        } else if (action === 'delete') {
          operation = { type: 'delete' };
        } else if (action === 'label') {
          operation = {
            type: 'label',
            addLabels: args.addLabels as string[] | undefined,
            removeLabels: args.removeLabels as string[] | undefined,
          };
        } else {
          throw new Error(`Unknown action: ${String(args.action)}`);
        }

        const result = Array.isArray(args.locators)
          ? await service.batchLocatedOperations(args.locators as string[], operation)
          : await service.batchOperations(
              args.uids as string[],
              args.folder as string,
              operation,
            );
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ action, ...result }, null, 2),
          }],
        };
      }

      if (name === 'register_oauth2_account') {
        const accountId = args.accountId as string;
        const tokenEndpoint = validateOAuth2TokenEndpoint(args.tokenEndpoint as string);
        const accounts = await getConfiguredAccounts();
        if (!accounts.some(account => account.id === accountId)) {
          throw new Error(`Account ${accountId} not found in configuration.`);
        }

        const { saveCredentials } = await import('./security/keychain.js');
        await saveCredentials(accountId, JSON.stringify({
          clientId: args.clientId,
          clientSecret: args.clientSecret,
          refreshToken: args.refreshToken,
          tokenEndpoint,
        }));
        return {
          content: [{
            type: 'text',
            text: `OAuth2 credentials successfully saved for account ${accountId}.`,
          }],
        };
      }

      if (name === 'mailbox_stats') {
        const service = await this.getService(args.accountId as string);
        const stats = await (service as any).getMailboxStats(args.folders as string[] | undefined);
        const header = `Folder            | Total | Unread | Recent\n` +
                       `------------------|-------|--------|-------\n`;
        const rows = stats.map((s: any) => {
          const total = s.total !== null ? String(s.total) : (s.error ? 'ERR' : '-');
          const unread = s.unread !== null ? String(s.unread) : (s.error ? 'ERR' : '-');
          const recent = s.recent !== null ? String(s.recent) : (s.error ? 'ERR' : '-');
          const folderName = s.name.padEnd(17).slice(0, 17);
          return `${folderName} | ${total.padStart(5)} | ${unread.padStart(6)} | ${recent.padStart(6)}${s.error ? `  [${s.error}]` : ''}`;
        }).join('\n');
        return {
          content: [{ type: 'text', text: header + rows }],
        };
      }

      if (name === 'list_templates') {
        const accountId = args.accountId as string | undefined;
        const templates = await getTemplates();
        const filtered = accountId
          ? templates.filter(t => !t.accountId || t.accountId === accountId)
          : templates;
        return {
          content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }],
        };
      }

      if (name === 'use_template') {
        const templateId = args.templateId as string;
        const accountId = args.accountId as string | undefined;
        const variables = (args.variables as Record<string, string> | undefined) ?? {};
        const templates = await getTemplates();
        const template = templates.find(t =>
          t.id === templateId && (!accountId || !t.accountId || t.accountId === accountId)
        );
        if (!template) {
          return trackResult({
            content: [{ type: 'text', text: `Template not found: "${templateId}". Use list_templates to see available templates.` }],
            isError: true,
          });
        }
        const result: Record<string, unknown> = {
          body: applyVariables(template.body, variables),
        };
        if (template.subject !== undefined) {
          result.subject = applyVariables(template.subject, variables);
        }
        if (template.isHtml !== undefined) result.isHtml = template.isHtml;
        if (args.to !== undefined) result.to = args.to;
        if (args.cc !== undefined) result.cc = args.cc;
        if (args.bcc !== undefined) result.bcc = args.bcc;
        if (accountId !== undefined) result.accountId = accountId;
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === 'delete_email') {
        const service = await this.getService(args.accountId as string);
        if (args.locator) {
          await service.deleteLocatedEmail(
            args.locator as string,
            args.trashFolder as string | undefined,
          );
        } else {
          await service.deleteEmail(
            args.uid as string,
            (args.folder as string | undefined) ?? 'INBOX',
            args.trashFolder as string | undefined,
          );
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ movedToTrash: true }, null, 2) }],
        };
      }

      if (name === 'permanently_delete_email') {
        const service = await this.getService(args.accountId as string);
        if (args.locator) {
          await service.permanentlyDeleteLocatedEmail(args.locator as string);
        } else {
          await service.permanentlyDeleteEmail(
            args.uid as string,
            (args.folder as string | undefined) ?? 'Trash',
          );
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ permanentlyDeleted: true }, null, 2) }],
        };
      }

      if (name === 'mark_read') {
        const service = await this.getService(args.accountId as string);
        const folder = (args.folder as string | undefined) ?? 'INBOX';
        if (args.locator) {
          await service.modifyLocatedLabels(args.locator as string, ['\\Seen'], []);
        } else {
          await service.modifyLabels(args.uid as string, folder, ['\\Seen'], []);
        }
        return {
          content: [{ type: 'text', text: args.locator
            ? `Message ${args.locator as string} marked as read.`
            : `Email ${args.uid as string} marked as read in ${folder}.` }],
        };
      }

      if (name === 'mark_unread') {
        const service = await this.getService(args.accountId as string);
        const folder = (args.folder as string | undefined) ?? 'INBOX';
        if (args.locator) {
          await service.modifyLocatedLabels(args.locator as string, [], ['\\Seen']);
        } else {
          await service.modifyLabels(args.uid as string, folder, [], ['\\Seen']);
        }
        return {
          content: [{ type: 'text', text: args.locator
            ? `Message ${args.locator as string} marked as unread.`
            : `Email ${args.uid as string} marked as unread in ${folder}.` }],
        };
      }

      if (name === 'star') {
        const service = await this.getService(args.accountId as string);
        const folder = (args.folder as string | undefined) ?? 'INBOX';
        if (args.locator) {
          await service.modifyLocatedLabels(args.locator as string, ['\\Flagged'], []);
        } else {
          await service.modifyLabels(args.uid as string, folder, ['\\Flagged'], []);
        }
        return {
          content: [{ type: 'text', text: args.locator
            ? `Message ${args.locator as string} starred.`
            : `Email ${args.uid as string} starred in ${folder}.` }],
        };
      }

      if (name === 'unstar') {
        const service = await this.getService(args.accountId as string);
        const folder = (args.folder as string | undefined) ?? 'INBOX';
        if (args.locator) {
          await service.modifyLocatedLabels(args.locator as string, [], ['\\Flagged']);
        } else {
          await service.modifyLabels(args.uid as string, folder, [], ['\\Flagged']);
        }
        return {
          content: [{ type: 'text', text: args.locator
            ? `Message ${args.locator as string} unstarred.`
            : `Email ${args.uid as string} unstarred in ${folder}.` }],
        };
      }

      if (name === 'list_filters' || name === 'get_filter' || name === 'set_filter' || name === 'delete_filter') {
        const accountId = args.accountId as string;
        const accounts = await getAccounts();
        const account = accounts.find(a => a.id === accountId);
        if (!account) {
          throw new Error(`Account ${accountId} not found in configuration.`);
        }
        const { loadCredentials } = await import('./security/keychain.js');
        const password = await loadCredentials(accountId);
        if (!password) {
          throw new Error(`Credentials not found for account: ${accountId}`);
        }
        const sievePort = account.manageSievePort ?? 4190;
        const sieve = new SieveClient(account.host, sievePort, account.user, password);
        await sieve.connect();
        try {
          if (name === 'list_filters') {
            const scripts = await sieve.listScripts();
            return {
              content: [{ type: 'text', text: JSON.stringify(scripts, null, 2) }],
            };
          }
          if (name === 'get_filter') {
            const content = await sieve.getScript(args.name as string);
            return {
              content: [{ type: 'text', text: content }],
            };
          }
          if (name === 'set_filter') {
            await sieve.putScript(args.name as string, args.content as string);
            return {
              content: [{ type: 'text', text: `Filter "${args.name as string}" saved successfully.` }],
            };
          }
          if (name === 'delete_filter') {
            await sieve.deleteScript(args.name as string);
            return {
              content: [{ type: 'text', text: `Filter "${args.name as string}" deleted.` }],
            };
          }
        } finally {
          await sieve.disconnect();
        }
      }

      // Tools beyond list_accounts require an account connection.
      // Attempt to fetch the service so auth errors surface via the catch block.
      await this.getService(args.accountId as string);
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    } catch (error: unknown) {
      const message = error instanceof MailMCPError
        ? `[${error.code}] ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
      _dispatchIsError = true;
      _dispatchErrorMsg = message;
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
      };
    } finally {
      if (this.auditLogger) {
        const _accountId = requestedArgs.accountId as string | undefined;
        await this.auditLogger.log({
          timestamp: new Date().toISOString(),
          tool: requestedName,
          ...(_accountId !== undefined ? { accountId: _accountId } : {}),
          args: requestedArgs,
          success: !_dispatchIsError,
          durationMs: Date.now() - _dispatchStart,
          ...(_dispatchIsError ? { error: _dispatchErrorMsg } : {}),
        }).catch(() => {});
      }
    }
  }
  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getTools(this.readOnly, this.allowedTools),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (this.shuttingDown) {
        return {
          content: [{ type: 'text', text: 'Server is shutting down' }],
          isError: true,
        };
      }

      this.inFlightCount++;
      try {
        const advertised = this.getTools(this.readOnly, this.allowedTools);
        if (!advertised.some(tool => tool.name === request.params.name)) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
        return await this.dispatchTool(
          request.params.name,
          this.readOnly,
          (request.params.arguments ?? {}) as Record<string, unknown>
        );
      } finally {
        this.inFlightCount--;
      }

    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [MAIL_AGENT_GUIDE_RESOURCE],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const resource = readMailAgentGuideResource(request.params.uri);
      if (!resource) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${request.params.uri}`);
      }
      return resource;
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [MAIL_AGENT_GUIDE_PROMPT],
    }));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const prompt = getMailAgentGuidePrompt(request.params.name);
      if (!prompt) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`);
      }
      return prompt;
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    console.error('Mail MCP server running on stdio');
  }

  async connect(transport: StreamableHTTPServerTransport | StdioServerTransport): Promise<void> {
    await this.server.connect(transport);
  }
}

export async function runValidateAccounts(): Promise<void> {
  const accounts = await getAccounts();
  if (accounts.length === 0) {
    console.log('No accounts configured.');
    return;
  }

  for (const account of accounts) {
    // IMAP probe
    try {
      const imap = new ImapClient(account);
      await imap.connect();
      await imap.disconnect();
      console.log(`[PASS] ${account.id} IMAP`);
    } catch (e) {
      console.log(`[FAIL] ${account.id} IMAP - ${(e as Error).message}`);
    }

    // SMTP probe
    if (account.smtpHost) {
      const smtp = new SmtpClient(account);
      try {
        await smtp.connect();
        console.log(`[PASS] ${account.id} SMTP`);
      } catch (e) {
        console.log(`[FAIL] ${account.id} SMTP - ${(e as Error).message}`);
      } finally {
        smtp.disconnect();
      }
    } else {
      console.log(`[SKIP] ${account.id} SMTP - no smtpHost configured`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Check for CLI subcommands before starting MCP server
  const handled = await handleAccountsCommand(args);
  if (handled) {
    process.exit(0);
  }

  // No CLI subcommand: start MCP server.
  const values = parseCliArgs(args);

  if (values['version']) {
    console.log(PACKAGE_VERSION);
    process.exit(0);
  }

  if (values['help']) {
    console.log(`mail-mcp v${PACKAGE_VERSION} - MCP server for IMAP/SMTP email access

Usage: mail-mcp [options] [command]

Commands:
  accounts add        Add a new email account (interactive)
  accounts list       List configured accounts
  accounts remove ID  Remove an account

Options:
  --read-only                 Start in read-only mode (no send/move/label tools)
  --allow-tools op1,op2,...   Allow only specific write operations (comma-separated). Mutually exclusive with --read-only.
  --confirm                   Enable confirmation mode; writes require a two-step call (first returns confirmationId, second executes)
  --audit-log                 Append a JSONL entry for every tool call to ~/.config/mail-mcp/audit.log
  --redact                    Mask credit card numbers, SSNs, passwords, and API keys in email content before returning to AI
  --http                      Run one shared Streamable HTTP service instead of stdio
  --host HOST                 HTTP bind address (default: 127.0.0.1)
  --port PORT                 HTTP port (default: 8765; use 0 for an ephemeral port)
  --bearer-token-env NAME     Environment variable containing the HTTP bearer token
  --validate-accounts         Probe IMAP/SMTP connections and exit
  --install-claude            Write an auto-updating npm command to Claude Desktop config and exit
  --install-claude-code       Register an auto-updating user-scoped MCP server in Claude Code
  --install-codex             Install one shared HTTP service for Codex on Windows; use stdio elsewhere
  --install-codex-stdio       Write an auto-updating per-client stdio command to Codex config
  --auto-update-seconds N     Managed HTTP service update check interval (minimum: 60)
  --version                   Show version number
  -h, --help                  Show this help message`);
    process.exit(0);
  }

  if (values['validate-accounts']) {
    await runValidateAccounts();
    process.exit(0);
  }

  const readOnly = (values['read-only'] as boolean | undefined) ?? false;
  const allowToolsRaw = values['allow-tools'] as string | undefined;

  if (readOnly && allowToolsRaw !== undefined) {
    console.error('Error: --read-only and --allow-tools are mutually exclusive.');
    process.exit(1);
  }

  let allowedTools: Set<string> | undefined;
  try {
    allowedTools = parseAllowedTools(allowToolsRaw);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }

  const installRuntimeArgs = readOnly
    ? ['--read-only']
    : allowedTools !== undefined
      ? ['--allow-tools', [...allowedTools].join(',')]
      : ['--confirm'];
  installRuntimeArgs.push('--audit-log', '--redact');
  const npxArgs = buildMailMcpNpxArgs(installRuntimeArgs);

  if (values['install-codex-stdio'] || values['install-claude'] || values['install-claude-code']) {
    await prepareMailMcpNpxRuntime();
  }

  if (values['install-codex']) {
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const codexHome = join(homedir(), '.codex');
    const configPath = join(codexHome, 'config.toml');
    try {
      if (process.platform === 'win32') {
        const expectedUrl = `http://${SHARED_HTTP_HOST}:${SHARED_HTTP_PORT}/mcp`;
        const bundle = await installCodexBundle(configPath, codexHome, {
          transport: 'http',
          options: {
            url: expectedUrl,
            bearerTokenEnvVar: HTTP_BEARER_TOKEN_ENV,
          },
        });
        let service;
        try {
          service = await installWindowsHttpService({
            runtimeArgs: installRuntimeArgs,
            host: SHARED_HTTP_HOST,
            port: SHARED_HTTP_PORT,
            bearerTokenEnvVar: HTTP_BEARER_TOKEN_ENV,
          });
        } catch (error) {
          await bundle.rollback();
          throw error;
        }
        console.log(bundle.config.changed
          ? `mail-mcp shared HTTP service configured for Codex at: ${bundle.config.configPath}`
          : `Codex already uses the shared mail-mcp HTTP service.`);
        if (bundle.config.backupPath) {
          console.log(`Previous config backed up to: ${bundle.config.backupPath}`);
        }
        console.log(`Service task: ${service.taskName}`);
        console.log(`Health check: ${service.healthUrl}`);
        console.log(`Codex skill: ${bundle.skill.skillPath}`);
        console.log('Service status: healthy');
        console.log('Restart Codex to load the bearer token from the user environment.');
        process.exit(0);
      }

      await prepareMailMcpNpxRuntime();
      const bundle = await installCodexBundle(configPath, codexHome, {
        transport: 'stdio',
        npxArgs,
      });
      console.log(bundle.config.changed
        ? `mail-mcp configured for Codex at: ${bundle.config.configPath}`
        : `Codex already tracks ${MAIL_MCP_LATEST_SPEC}.`);
      if (bundle.config.backupPath) {
        console.log(`Previous config backed up to: ${bundle.config.backupPath}`);
      }
      console.log(`Server command: npx ${npxArgs.join(' ')}`);
      console.log(`Codex skill: ${bundle.skill.skillPath}`);
      console.log('Restart Codex to load the server.');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (values['install-codex-stdio']) {
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const codexHome = join(homedir(), '.codex');
    const configPath = join(codexHome, 'config.toml');
    try {
      const bundle = await installCodexBundle(configPath, codexHome, {
        transport: 'stdio',
        npxArgs,
      });
      console.log(bundle.config.changed
        ? `mail-mcp stdio command configured for Codex at: ${bundle.config.configPath}`
        : `Codex already tracks ${MAIL_MCP_LATEST_SPEC} over stdio.`);
      if (bundle.config.backupPath) {
        console.log(`Previous config backed up to: ${bundle.config.backupPath}`);
      }
      console.log(`Server command: npx ${npxArgs.join(' ')}`);
      console.log(`Codex skill: ${bundle.skill.skillPath}`);
      console.log('Restart Codex to load the server.');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (values['install-claude']) {
    try {
      const result = await installClaude(
        getClaudeConfigPath(),
        'npx',
        npxArgs
      );
      console.log(result.changed
        ? `mail-mcp configured for Claude Desktop at: ${result.configPath}`
        : `Claude Desktop already tracks ${MAIL_MCP_LATEST_SPEC}.`);
      if (result.backupPath) {
        console.log(`Previous config backed up to: ${result.backupPath}`);
      }
      console.log(`Server command: npx ${npxArgs.join(' ')}`);
      console.log('Restart Claude Desktop to activate.');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (values['install-claude-code']) {
    try {
      const result = await installClaudeCode(npxArgs);
      console.log('mail-mcp configured in Claude Code user scope.');
      if (result.stdout) console.log(result.stdout);
      console.log(`Server command: npx ${npxArgs.join(' ')}`);
      console.log('Restart Claude Code to activate.');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  const confirmMode = (values['confirm'] as boolean | undefined) ?? false;

  const auditLogEnabled = (values['audit-log'] as boolean | undefined) ?? false;
  const auditLogger = new AuditLogger(AUDIT_LOG_PATH, auditLogEnabled);
  const redact = (values['redact'] as boolean | undefined) ?? false;
  const httpMode = (values['http'] as boolean | undefined) ?? false;
  const autoUpdateSecondsRaw = values['auto-update-seconds'] as string | undefined;
  let autoUpdateIntervalMs: number | undefined;
  if (autoUpdateSecondsRaw !== undefined) {
    const autoUpdateSeconds = Number(autoUpdateSecondsRaw);
    if (!Number.isInteger(autoUpdateSeconds) || autoUpdateSeconds < 60) {
      throw new Error(`Invalid auto-update interval: ${autoUpdateSecondsRaw}`);
    }
    if (!httpMode) {
      throw new Error('--auto-update-seconds requires --http');
    }
    autoUpdateIntervalMs = autoUpdateSeconds * 1000;
  }
  const runtimeState = httpMode ? new MailMCPRuntimeState() : undefined;
  const createServer = () => new MailMCPServer(
    readOnly,
    allowedTools,
    auditLogger,
    confirmMode,
    redact,
    runtimeState
  );
  const server = httpMode ? undefined : createServer();
  let httpHost: Awaited<ReturnType<typeof startHttpHost>> | undefined;

  if (httpMode) {
    const host = values['host'] as string;
    const portRaw = values['port'] as string;
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid HTTP port: ${portRaw}`);
    }

    const tokenEnv = values['bearer-token-env'] as string;
    const bearerToken = process.env[tokenEnv];
    if (!bearerToken) {
      throw new Error(`Environment variable ${tokenEnv} is not set`);
    }

    httpHost = await startHttpHost({
      host,
      port,
      bearerToken,
      createSession: createServer,
      shutdownSharedResources: () => runtimeState!.shutdown(),
      serverVersion: PACKAGE_VERSION,
    });
    console.error(`Mail MCP server running on ${httpHost.url}`);
  }

  let shutdownPromise: Promise<void> | undefined;
  let autoUpdateMonitor: AutoUpdateMonitor | undefined;
  const shutdown = (exitCode: number = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      autoUpdateMonitor?.stop();
      const timer = setTimeout(() => {
        console.error('Forced exit after 10s shutdown timeout');
        process.exit(1);
      }, 10_000);
      timer.unref();
      if (httpHost) {
        await httpHost.close();
      } else {
        await server!.shutdown();
      }
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  if (autoUpdateIntervalMs !== undefined) {
    autoUpdateMonitor = startAutoUpdateMonitor({
      currentVersion: PACKAGE_VERSION,
      intervalMs: autoUpdateIntervalMs,
      onUpdateAvailable: async latestVersion => {
        console.error(`mail-mcp ${latestVersion} is available; restarting the managed service.`);
        await shutdown(75);
      },
      onCheckError: error => {
        console.error(
          `Automatic update check failed: ${error instanceof Error ? error.message : String(error)}`
        );
      },
    });
  }

  if (!httpMode) {
    await server!.run();
  }
}

// Importing the module must not start a stdio server.
const isDirectRun = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
