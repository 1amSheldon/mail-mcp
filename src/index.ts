#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getAccounts } from './config.js';
import { handleAccountsCommand } from './cli/accounts.js';
import { getClaudeConfigPath, installClaude } from './cli/install-claude.js';
import { installCodex } from './cli/install-codex.js';
import { buildMailMcpNpxArgs, MAIL_MCP_LATEST_SPEC } from './cli/npm-runtime.js';
import { MailService } from './services/mail.js';
import type { SendDeliveryResult } from './services/mail.js';
import { MailMCPError, NetworkError } from './errors.js';
import { TieredRateLimiter } from './utils/rate-limiter.js';
import { ImapClient } from './protocol/imap.js';
import { SmtpClient } from './protocol/smtp.js';
import { validateEmailAddresses, validateRecipients } from './utils/validation.js';
import { getTemplates, applyVariables } from './utils/templates.js';
import { SieveClient } from './protocol/sieve.js';
import { AuditLogger } from './utils/audit-logger.js';
import { ConfirmationStore } from './utils/confirmation-store.js';
import { AUDIT_LOG_PATH } from './config.js';
import { MailMCPRuntimeState } from './runtime-state.js';
import { startHttpHost } from './http-host.js';

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = (require('../package.json') as { version: string }).version;

const WRITE_TOOLS = new Set<string>([
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
]);

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
      'install-codex': { type: 'boolean', default: false },
      'version': { type: 'boolean', default: false },
      'help': { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }).values;
}

export function parseAllowedTools(raw: string | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined;

  const allowedTools = new Set(raw.split(',').map(tool => tool.trim()).filter(Boolean));
  const unknownTools = [...allowedTools].filter(tool => !WRITE_TOOLS.has(tool));
  if (unknownTools.length > 0) {
    throw new Error(
      `Unknown write tool(s): ${unknownTools.join(', ')}. Available write tools: ${[...WRITE_TOOLS].join(', ')}.`
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

/**
 * Build a human-readable description of a write tool action for the confirmation prompt.
 */
function buildConfirmationDescription(toolName: string, args: Record<string, unknown>): string {
  const uid = args.uid as string | undefined;
  const folder = (args.folder as string | undefined) || 'INBOX';
  switch (toolName) {
    case 'send_email':
      return `Send email to ${args.to as string} with subject '${args.subject as string}'`;
    case 'create_draft':
      return `Save draft to ${args.to as string} with subject '${args.subject as string}'`;
    case 'reply_email':
      return `Reply to email UID ${uid} in ${folder}`;
    case 'forward_email':
      return `Forward email UID ${uid} to ${args.to as string}`;
    case 'delete_email':
      return `Permanently delete email UID ${uid} from ${folder}`;
    case 'move_email':
      return `Move email UID ${uid} from ${args.sourceFolder as string} to ${args.targetFolder as string}`;
    case 'batch_operations': {
      const uids = args.uids as string[] | undefined;
      return `Batch ${args.action as string} ${uids ? uids.length : 0} emails in ${folder}`;
    }
    case 'modify_labels':
      return `Modify labels on email UID ${uid} in ${folder}`;
    case 'mark_read':
      return `Mark email UID ${uid} as read in ${folder}`;
    case 'mark_unread':
      return `Mark email UID ${uid} as unread in ${folder}`;
    case 'star':
      return `Star email UID ${uid} in ${folder}`;
    case 'unstar':
      return `Unstar email UID ${uid} in ${folder}`;
    case 'register_oauth2_account':
      return `Register OAuth2 credentials for account ${args.accountId as string}`;
    case 'set_filter':
      return `Create/update SIEVE filter '${args.name as string}' on account ${args.accountId as string}`;
    case 'delete_filter':
      return `Delete SIEVE filter '${args.name as string}' on account ${args.accountId as string}`;
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
        '--read-only and --allow-tools are mutually exclusive. Use --read-only to disable all write tools, or --allow-tools to enable specific ones.'
      );
    }

    this.allowedTools = allowedTools;
    this.auditLogger = auditLogger;
    this.confirmMode = confirmMode;
    this.confirmStore = new ConfirmationStore();
    this.redact = redact;
    this.runtimeState = runtimeState ?? new MailMCPRuntimeState();
    this.ownsRuntimeState = runtimeState === undefined;
    this.services = this.runtimeState.services;
    this.serviceCreations = this.runtimeState.serviceCreations;
    this.rateLimiter = this.runtimeState.rateLimiter;

    const instructionsSuffix = (() => {
      if (readOnly) {
        return ' This server is running in read-only mode. Write operations (send_email, create_draft, move_email, modify_labels, batch_operations, register_oauth2_account, reply_email, forward_email, delete_email, mark_read, mark_unread, star, unstar) are disabled.';
      }
      if (allowedTools !== undefined) {
        const list = [...allowedTools].join(', ') || 'none';
        return ` This server is running with allow-listed tools. Only these write operations are enabled: ${list}. All other write tools are disabled.`;
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
        },
        instructions: `Access configured email accounts over IMAP and SMTP.${instructionsSuffix}`,
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
    const allTools = [
      {
        name: 'list_accounts',
        description: 'List configured email accounts.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'list_emails',
        description: 'List messages in an IMAP folder. Set headerOnly=true to skip message bodies.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            folder: { type: 'string', description: 'The folder to list emails from (default: INBOX)' },
            count: { type: 'number', description: 'The number of emails to retrieve (default: 10)' },
            offset: { type: 'number', description: 'Number of messages to skip from the newest (for pagination, default: 0)' },
            headerOnly: { type: 'boolean', description: 'When true, skip body download and return only headers (subject, from, date, flags). Much faster for large mailboxes. snippet will be empty. Default: false.' }
          },
          required: ['accountId']
        }
      },
      {
        name: 'search_emails',
        description: 'Search an IMAP folder by address, subject, date, body text, or Message-ID.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            folder: { type: 'string', description: 'The folder to search in (default: INBOX)' },
            from: { type: 'string', description: 'Filter by sender' },
            to: { type: 'string', description: 'Filter by To recipient' },
            cc: { type: 'string', description: 'Filter by Cc recipient' },
            messageId: { type: 'string', description: 'Filter by exact RFC Message-ID header' },
            subject: { type: 'string', description: 'Filter by subject' },
            since: { type: 'string', description: 'Filter by date (ISO format)' },
            before: { type: 'string', description: 'Filter by date (ISO format)' },
            keywords: { type: 'string', description: 'Filter by keywords in body' },
            count: { type: 'number', description: 'The number of emails to retrieve (default: 10)' },
            offset: { type: 'number', description: 'Number of messages to skip from the newest (for pagination, default: 0)' }
          },
          required: ['accountId']
        }
      },
      {
        name: 'verify_sent_message',
        description: 'Check whether a Message-ID exists in Sent. Absence does not prove SMTP non-delivery.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            messageId: { type: 'string', description: 'The exact RFC Message-ID returned by send_email, reply_email, or forward_email' },
            sentFolder: { type: 'string', description: 'Optional Sent folder override. By default the account override or IMAP special-use Sent folder is used.' },
            count: { type: 'number', description: 'Maximum matching messages to return (default: 10)' },
            offset: { type: 'number', description: 'Number of matching messages to skip from the newest (default: 0)' },
          },
          required: ['accountId', 'messageId'],
        },
      },
      {
        name: 'read_email',
        description: 'Read one message by IMAP UID.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uid: { type: 'string', description: 'The UID of the email to read' },
            folder: { type: 'string', description: 'The folder containing the email (default: INBOX)' }
          },
          required: ['accountId', 'uid']
        }
      },
      {
        name: 'send_email',
        description: 'Send through SMTP, then append the same MIME message to Sent.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            to: { type: 'string', description: 'Recipient email address' },
            subject: { type: 'string', description: 'Email subject' },
            body: { type: 'string', description: 'Email body content' },
            isHtml: { type: 'boolean', description: 'Whether the body is HTML (default: false)' },
            cc: { type: 'string', description: 'CC recipients' },
            bcc: { type: 'string', description: 'BCC recipients' },
            includeSignature: {
              type: 'boolean',
              description: 'Whether to append the account signature (default: true). Set to false to suppress the signature for this message.'
            },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'to', 'subject', 'body']
        }
      },
      {
        name: 'create_draft',
        description: 'Append a draft message to Drafts.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            to: { type: 'string', description: 'Recipient email address' },
            subject: { type: 'string', description: 'Email subject' },
            body: { type: 'string', description: 'Email body content' },
            isHtml: { type: 'boolean', description: 'Whether the body is HTML (default: false)' },
            cc: { type: 'string', description: 'CC recipients' },
            bcc: { type: 'string', description: 'BCC recipients' },
            includeSignature: {
              type: 'boolean',
              description: 'Whether to append the account signature (default: true). Set to false to suppress the signature for this draft.'
            },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'to', 'subject', 'body']
        }
      },
      {
        name: 'list_folders',
        description: 'List IMAP folders.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' }
          },
          required: ['accountId']
        }
      },
      {
        name: 'move_email',
        description: 'Move a message between IMAP folders.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uid: { type: 'string', description: 'The UID of the email to move' },
            sourceFolder: { type: 'string', description: 'The current folder of the email' },
            targetFolder: { type: 'string', description: 'The destination folder' },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'uid', 'sourceFolder', 'targetFolder']
        }
      },
      {
        name: 'modify_labels',
        description: 'Add or remove IMAP flags such as \\\\Seen and \\\\Flagged.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uid: { type: 'string', description: 'The UID of the email' },
            folder: { type: 'string', description: 'The folder containing the email' },
            addLabels: { type: 'array', items: { type: 'string' }, description: 'Labels to add (e.g. \\Seen, \\Flagged)' },
            removeLabels: { type: 'array', items: { type: 'string' }, description: 'Labels to remove' },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'uid', 'folder']
        }
      },
      {
        name: 'get_thread',
        description: 'Find messages by Gmail thread ID or RFC Message-ID references.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            threadId: { type: 'string', description: 'The ID of the thread to retrieve' },
            folder: { type: 'string', description: 'The folder containing the thread (default: INBOX)' }
          },
          required: ['accountId', 'threadId']
        }
      },
      {
        name: 'get_attachment',
        description: 'Download one attachment by message UID and filename.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uid: { type: 'string', description: 'The UID of the email' },
            filename: { type: 'string', description: 'The name of the attachment file' },
            folder: { type: 'string', description: 'The folder containing the email (default: INBOX)' }
          },
          required: ['accountId', 'uid', 'filename']
        }
      },
      {
        name: 'extract_attachment_text',
        description: 'Extract text from a PDF or plain-text attachment.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uid: { type: 'string', description: 'The UID of the email' },
            filename: { type: 'string', description: 'The name of the attachment file' },
            folder: { type: 'string', description: 'The folder containing the email (default: INBOX)' }
          },
          required: ['accountId', 'uid', 'filename']
        }
      },
      {
        name: 'register_oauth2_account',
        description: 'Store OAuth2 credentials for an account in the system credential store.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account' },
            clientId: { type: 'string', description: 'OAuth2 Client ID' },
            clientSecret: { type: 'string', description: 'OAuth2 Client Secret' },
            refreshToken: { type: 'string', description: 'OAuth2 Refresh Token' },
            tokenEndpoint: { type: 'string', description: 'OAuth2 Token Endpoint URL' },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'clientId', 'clientSecret', 'refreshToken', 'tokenEndpoint']
        }
      },
      {
        name: 'batch_operations',
        description: 'Move, delete, or label up to 100 messages.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uids: { type: 'array', items: { type: 'string' }, description: 'Array of email UIDs to operate on (max 100)' },
            folder: { type: 'string', description: 'The folder containing the emails' },
            action: { type: 'string', enum: ['move', 'delete', 'label'], description: 'The batch action to perform' },
            targetFolder: { type: 'string', description: 'Target folder (required for move action)' },
            addLabels: { type: 'array', items: { type: 'string' }, description: 'Labels to add (for label action)' },
            removeLabels: { type: 'array', items: { type: 'string' }, description: 'Labels to remove (for label action)' },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'uids', 'folder', 'action']
        }
      },
      {
        name: 'delete_email',
        description: 'Permanently delete one message by IMAP UID. Move to Trash when recovery is required.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uid: { type: 'string', description: 'The UID of the email to delete' },
            folder: { type: 'string', description: 'The folder containing the email (default: INBOX)' },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'uid']
        }
      },
      {
        name: 'reply_email',
        description: 'Reply with In-Reply-To and References headers.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uid: { type: 'string', description: 'The UID of the email to reply to' },
            folder: { type: 'string', description: 'The folder containing the email (default: INBOX)' },
            body: { type: 'string', description: 'Reply body content' },
            isHtml: { type: 'boolean', description: 'Whether the body is HTML (default: false)' },
            cc: { type: 'string', description: 'CC recipients' },
            bcc: { type: 'string', description: 'BCC recipients' },
            includeSignature: {
              type: 'boolean',
              description: 'Whether to append the account signature (default: true). Set to false to suppress the signature.'
            },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'uid', 'body']
        }
      },
      {
        name: 'forward_email',
        description: 'Forward a message with its original headers and body.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uid: { type: 'string', description: 'The UID of the email to forward' },
            folder: { type: 'string', description: 'The folder containing the email (default: INBOX)' },
            to: { type: 'string', description: 'Recipient email address to forward to' },
            body: { type: 'string', description: 'Optional preamble to include before the forwarded message' },
            isHtml: { type: 'boolean', description: 'Whether the body is HTML (default: false)' },
            cc: { type: 'string', description: 'CC recipients' },
            bcc: { type: 'string', description: 'BCC recipients' },
            includeSignature: {
              type: 'boolean',
              description: 'Whether to append the account signature (default: true). Set to false to suppress the signature.'
            },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'uid', 'to']
        }
      },
      {
        name: 'mailbox_stats',
        description: 'Return total, unread, and recent counts for IMAP folders.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            folders: {
              type: 'array',
              items: { type: 'string' },
              description: 'Folder names to report stats for (default: all folders)'
            }
          },
          required: ['accountId']
        }
      },
      {
        name: 'extract_contacts',
        description: 'Count senders in recent messages and return contacts by frequency.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            folder: { type: 'string', description: 'The folder to scan (default: INBOX)' },
            count: { type: 'number', description: 'Number of recent messages to scan (default: 100, max: 500)' },
          },
          required: ['accountId'],
        },
      },
      {
        name: 'list_templates',
        description: 'List global and account-scoped templates.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'Optional account ID. Returns global templates and templates scoped to this account. Omit to return all templates.' },
          },
        },
      },
      {
        name: 'use_template',
        description: 'Fill template variables and return arguments for send_email or create_draft. Does not send.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            templateId: { type: 'string', description: 'The ID of the template to use' },
            variables: {
              type: 'object',
              description: 'Key-value pairs to substitute into {{variable}} placeholders in the template subject and body',
              additionalProperties: { type: 'string' },
            },
            to: { type: 'string', description: 'Recipient email address to include in the returned args' },
            cc: { type: 'string', description: 'CC recipients to include in the returned args' },
            bcc: { type: 'string', description: 'BCC recipients to include in the returned args' },
            accountId: { type: 'string', description: 'Account ID to include in the returned args' },
          },
          required: ['templateId'],
        },
      },
      {
        name: 'mark_read',
        description: 'Mark a message as read by adding \\\\Seen.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uid: { type: 'string', description: 'The UID of the email to mark as read' },
            folder: { type: 'string', description: 'The folder containing the email (default: INBOX)' },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'uid'],
        },
      },
      {
        name: 'mark_unread',
        description: 'Mark a message as unread by removing \\\\Seen.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uid: { type: 'string', description: 'The UID of the email to mark as unread' },
            folder: { type: 'string', description: 'The folder containing the email (default: INBOX)' },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'uid'],
        },
      },
      {
        name: 'star',
        description: 'Star a message by adding \\\\Flagged.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uid: { type: 'string', description: 'The UID of the email to star' },
            folder: { type: 'string', description: 'The folder containing the email (default: INBOX)' },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'uid'],
        },
      },
      {
        name: 'unstar',
        description: 'Unstar a message by removing \\\\Flagged.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            uid: { type: 'string', description: 'The UID of the email to unstar' },
            folder: { type: 'string', description: 'The folder containing the email (default: INBOX)' },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'uid'],
        },
      },
      {
        name: 'list_filters',
        description: 'List ManageSieve scripts and identify the active script.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
          },
          required: ['accountId'],
        },
      },
      {
        name: 'get_filter',
        description: 'Read a ManageSieve script by name.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            name: { type: 'string', description: 'The name of the SIEVE script to retrieve' },
          },
          required: ['accountId', 'name'],
        },
      },
      {
        name: 'set_filter',
        description: 'Create or replace a ManageSieve script.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            name: { type: 'string', description: 'The name for the SIEVE script (e.g. "spam-filter")' },
            content: { type: 'string', description: 'Valid SIEVE script content' },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'name', 'content'],
        },
      },
      {
        name: 'delete_filter',
        description: 'Delete an inactive ManageSieve script.',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The ID of the account to use' },
            name: { type: 'string', description: 'The name of the SIEVE script to delete' },
            confirmationId: { type: 'string', description: 'Confirmation ID returned by the first call when --confirm is enabled.' }
          },
          required: ['accountId', 'name'],
        },
      },
    ];
    if (readOnly) {
      return allTools.filter(t => !WRITE_TOOLS.has(t.name));
    }
    if (allowedTools !== undefined) {
      return allTools.filter(t => !WRITE_TOOLS.has(t.name) || allowedTools.has(t.name));
    }
    return allTools;
  }

  async dispatchTool(name: string, readOnly: boolean, args: Record<string, unknown>) {
    const _dispatchStart = Date.now();
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
      if (readOnly && WRITE_TOOLS.has(name)) {
        return trackResult({
          content: [{
            type: 'text',
            text: `Tool '${name}' is not available: server is running in read-only mode. Use a server without --read-only to perform write operations.`,
          }],
          isError: true,
        });
      }

      if (this.allowedTools !== undefined && WRITE_TOOLS.has(name) && !this.allowedTools.has(name)) {
        const list = [...this.allowedTools].join(', ') || 'none';
        return trackResult({
          content: [{
            type: 'text',
            text: `Tool '${name}' is not available: not in the allowed tools list. Allowed write tools: ${list}. Use --allow-tools to change the list.`,
          }],
          isError: true,
        });
      }

      // Confirmation mode gate — intercept write tools when --confirm is active
      if (this.confirmMode && WRITE_TOOLS.has(name)) {
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
          args = { ...pending.args };
        } else {
          // First call: create confirmation token and return prompt
          const argsWithoutId = { ...args };
          delete argsWithoutId.confirmationId;
          const id = this.confirmStore.create(name, argsWithoutId);
          const description = buildConfirmationDescription(name, args);
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
        if (WRITE_TOOLS.has(name)) {
          await this.rateLimiter.consumeWrite(accountId);
        } else {
          await this.rateLimiter.consumeRead(accountId);
        }
      }

      if (name === 'list_accounts') {
        const accounts = await getAccounts();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(
              accounts.map((a) => ({ id: a.id, name: a.name, user: a.user })),
              null,
              2
            ),
          }],
        };
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
        const result = await service.replyEmail(
          args.uid as string,
          (args.folder as string | undefined) || 'INBOX',
          args.body as string,
          args.isHtml as boolean | undefined,
          args.cc as string | undefined,
          args.bcc as string | undefined,
          includeSignature
        );
        return trackResult(formatDeliveryResult(result));
      }

      if (name === 'forward_email') {
        const service = await this.getService(args.accountId as string);
        const includeSignature = (args.includeSignature as boolean | undefined) !== false;
        const result = await service.forwardEmail(
          args.uid as string,
          (args.folder as string | undefined) || 'INBOX',
          args.to as string,
          (args.body as string | undefined) || '',
          args.isHtml as boolean | undefined,
          args.cc as string | undefined,
          args.bcc as string | undefined,
          includeSignature
        );
        return trackResult(formatDeliveryResult(result));
      }

      if (name === 'list_emails') {
        const service = await this.getService(args.accountId as string);
        const messages = await (service as any).listEmails(args.folder, args.count, args.offset, args.headerOnly ?? false);
        return {
          content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
        };
      }

      if (name === 'search_emails') {
        const service = await this.getService(args.accountId as string);
        const messages = await (service as any).searchEmails({
          from: args.from,
          to: args.to,
          cc: args.cc,
          messageId: args.messageId,
          subject: args.subject,
          since: args.since,
          before: args.before,
          keywords: args.keywords,
        }, args.folder, args.count, args.offset);
        return {
          content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
        };
      }

      if (name === 'read_email') {
        const service = await this.getService(args.accountId as string);
        const content = await service.readEmail(
          args.uid as string,
          (args.folder as string | undefined) ?? 'INBOX'
        );
        return { content: [{ type: 'text', text: content }] };
      }

      if (name === 'list_folders') {
        const service = await this.getService(args.accountId as string);
        const folders = await service.listFolders();
        return {
          content: [{ type: 'text', text: JSON.stringify(folders, null, 2) }],
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
        const { content, contentType } = await service.downloadAttachment(
          uid,
          filename,
          (args.folder as string | undefined) ?? 'INBOX'
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ filename, contentType, bytes: content.length }, null, 2),
            },
            {
              type: 'resource',
              resource: {
                uri: `mail-attachment://${encodeURIComponent(args.accountId as string)}/${encodeURIComponent(uid)}/${encodeURIComponent(filename)}`,
                mimeType: contentType,
                blob: content.toString('base64'),
              },
            },
          ],
        };
      }

      if (name === 'extract_attachment_text') {
        const service = await this.getService(args.accountId as string);
        const content = await service.extractAttachmentText(
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
        const matches = await service.searchEmails(
          { messageId },
          sentFolder,
          (args.count as number | undefined) ?? 10,
          (args.offset as number | undefined) ?? 0
        );
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
        const includeSignature = (args.includeSignature as boolean | undefined) !== false;
        const result = await service.sendEmail(
          args.to as string,
          args.subject as string,
          args.body as string,
          args.isHtml as boolean | undefined,
          args.cc as string | undefined,
          args.bcc as string | undefined,
          includeSignature
        );
        return trackResult(formatDeliveryResult(result));
      }

      if (name === 'create_draft') {
        const service = await this.getService(args.accountId as string);
        const includeSignature = (args.includeSignature as boolean | undefined) !== false;
        await service.createDraft(
          args.to as string,
          args.subject as string,
          args.body as string,
          args.isHtml as boolean | undefined,
          args.cc as string | undefined,
          args.bcc as string | undefined,
          includeSignature
        );
        return {
          content: [{ type: 'text', text: `Draft successfully created in Drafts folder.` }],
        };
      }

      if (name === 'move_email') {
        const service = await this.getService(args.accountId as string);
        const uid = args.uid as string;
        const sourceFolder = args.sourceFolder as string;
        const targetFolder = args.targetFolder as string;
        await service.moveMessage(uid, sourceFolder, targetFolder);
        service.invalidateBodyCache(sourceFolder, uid);
        return {
          content: [{
            type: 'text',
            text: `Email ${uid} moved from ${sourceFolder} to ${targetFolder}.`,
          }],
        };
      }

      if (name === 'modify_labels') {
        const service = await this.getService(args.accountId as string);
        await service.modifyLabels(
          args.uid as string,
          args.folder as string,
          (args.addLabels as string[] | undefined) ?? [],
          (args.removeLabels as string[] | undefined) ?? []
        );
        return {
          content: [{
            type: 'text',
            text: `Labels updated for email ${args.uid as string} in ${args.folder as string}.`,
          }],
        };
      }

      if (name === 'batch_operations') {
        const service = await this.getService(args.accountId as string);
        const action = args.action as 'move' | 'delete' | 'label';
        let operation: Parameters<MailService['batchOperations']>[2];

        if (action === 'move') {
          const targetFolder = args.targetFolder as string | undefined;
          if (!targetFolder) throw new Error('targetFolder is required for move action');
          operation = { type: 'move', targetFolder };
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

        const result = await service.batchOperations(
          args.uids as string[],
          args.folder as string,
          operation
        );
        return {
          content: [{
            type: 'text',
            text: `Batch ${action} completed. ${result.processed} email(s) processed.`,
          }],
        };
      }

      if (name === 'register_oauth2_account') {
        const accountId = args.accountId as string;
        const accounts = await getAccounts();
        if (!accounts.some(account => account.id === accountId)) {
          throw new Error(`Account ${accountId} not found in configuration.`);
        }

        const { saveCredentials } = await import('./security/keychain.js');
        await saveCredentials(accountId, JSON.stringify({
          clientId: args.clientId,
          clientSecret: args.clientSecret,
          refreshToken: args.refreshToken,
          tokenEndpoint: args.tokenEndpoint,
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
        const variables = (args.variables as Record<string, string> | undefined) ?? {};
        const templates = await getTemplates();
        const template = templates.find(t => t.id === templateId);
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
        if (args.accountId !== undefined) result.accountId = args.accountId;
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === 'delete_email') {
        const service = await this.getService(args.accountId as string);
        const folder = (args.folder as string | undefined) ?? 'INBOX';
        await service.deleteEmail(args.uid as string, folder);
        return {
          content: [{ type: 'text', text: `Email ${args.uid as string} deleted from ${folder}.` }],
        };
      }

      if (name === 'mark_read') {
        const service = await this.getService(args.accountId as string);
        const folder = (args.folder as string | undefined) ?? 'INBOX';
        await service.modifyLabels(args.uid as string, folder, ['\\Seen'], []);
        return {
          content: [{ type: 'text', text: `Email ${args.uid as string} marked as read in ${folder}.` }],
        };
      }

      if (name === 'mark_unread') {
        const service = await this.getService(args.accountId as string);
        const folder = (args.folder as string | undefined) ?? 'INBOX';
        await service.modifyLabels(args.uid as string, folder, [], ['\\Seen']);
        return {
          content: [{ type: 'text', text: `Email ${args.uid as string} marked as unread in ${folder}.` }],
        };
      }

      if (name === 'star') {
        const service = await this.getService(args.accountId as string);
        const folder = (args.folder as string | undefined) ?? 'INBOX';
        await service.modifyLabels(args.uid as string, folder, ['\\Flagged'], []);
        return {
          content: [{ type: 'text', text: `Email ${args.uid as string} starred in ${folder}.` }],
        };
      }

      if (name === 'unstar') {
        const service = await this.getService(args.accountId as string);
        const folder = (args.folder as string | undefined) ?? 'INBOX';
        await service.modifyLabels(args.uid as string, folder, [], ['\\Flagged']);
        return {
          content: [{ type: 'text', text: `Email ${args.uid as string} unstarred in ${folder}.` }],
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
        const _accountId = (args as Record<string, unknown>)?.accountId as string | undefined;
        await this.auditLogger.log({
          timestamp: new Date().toISOString(),
          tool: name,
          ...(_accountId !== undefined ? { accountId: _accountId } : {}),
          args,
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
        return await this.dispatchTool(
          request.params.name,
          this.readOnly,
          (request.params.arguments ?? {}) as Record<string, unknown>
        );
      } finally {
        this.inFlightCount--;
      }
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
  --allow-tools t1,t2,...     Allow only specific write tools (comma-separated). Mutually exclusive with --read-only.
  --confirm                   Enable confirmation mode; write tools require a two-step call (first returns confirmationId, second executes)
  --audit-log                 Append a JSONL entry for every tool call to ~/.config/mail-mcp/audit.log
  --redact                    Mask credit card numbers, SSNs, passwords, and API keys in email content before returning to AI
  --http                      Run one shared Streamable HTTP service instead of stdio
  --host HOST                 HTTP bind address (default: 127.0.0.1)
  --port PORT                 HTTP port (default: 8765; use 0 for an ephemeral port)
  --bearer-token-env NAME     Environment variable containing the HTTP bearer token
  --validate-accounts         Probe IMAP/SMTP connections and exit
  --install-claude            Write an auto-updating npm command to Claude Desktop config and exit
  --install-codex             Write an auto-updating npm command to ~/.codex/config.toml and exit
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

  if (values['install-codex']) {
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const configPath = join(homedir(), '.codex', 'config.toml');
    try {
      const result = await installCodex(configPath, MAIL_MCP_LATEST_SPEC, installRuntimeArgs);
      console.log(result.changed
        ? `mail-mcp configured for Codex at: ${result.configPath}`
        : `Codex already tracks ${MAIL_MCP_LATEST_SPEC}.`);
      if (result.backupPath) {
        console.log(`Previous config backed up to: ${result.backupPath}`);
      }
      console.log(`Server command: npx ${buildMailMcpNpxArgs(installRuntimeArgs).join(' ')}`);
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
        buildMailMcpNpxArgs(installRuntimeArgs)
      );
      console.log(result.changed
        ? `mail-mcp configured for Claude Desktop at: ${result.configPath}`
        : `Claude Desktop already tracks ${MAIL_MCP_LATEST_SPEC}.`);
      if (result.backupPath) {
        console.log(`Previous config backed up to: ${result.backupPath}`);
      }
      console.log(`Server command: npx ${buildMailMcpNpxArgs(installRuntimeArgs).join(' ')}`);
      console.log('Restart Claude Desktop to activate.');
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
    const port = Number.parseInt(portRaw, 10);
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
    });
    console.error(`Mail MCP server running on ${httpHost.url}`);
  }

  const shutdown = async () => {
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
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

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
