import { createHash } from 'node:crypto';
import { getConfiguredAccounts } from '../config.js';
import { MailMCPRuntimeState } from '../runtime-state.js';
import type { RuntimeProviderClient } from '../runtime-state.js';
import { loadCredentials } from '../security/keychain.js';
import { getValidAccessToken } from '../security/oauth2.js';
import {
  isAppleMailAccount,
  isEwsAccount,
  isMailtrapAccount,
  isMicrosoftGraphAccount,
} from './account-types.js';
import type {
  AppleMailConfiguredAccount,
  ConfiguredAccount,
  EwsConfiguredAccount,
  MailtrapConfiguredAccount,
  MicrosoftGraphConfiguredAccount,
} from './account-types.js';
import { AppleMailAdapter } from './apple-mail/adapter.js';
import type {
  AppleComposeInput,
  AppleDraftInput,
  AppleForwardInput,
  AppleListMessagesInput,
  AppleMailAccount,
  AppleMailMessage,
  AppleMailMessageSummary,
  AppleMailMutationResult,
  AppleMailRule,
  AppleMailbox,
  AppleMailboxCreateInput,
  AppleMailboxDeleteInput,
  AppleMailboxRenameInput,
  AppleMailboxSelector,
  AppleMessageSelector,
  AppleMessageUpdateInput,
  AppleMoveMessageInput,
  AppleReplyInput,
  AppleRuleCreateInput,
  AppleRuleDeleteInput,
  AppleRuleUpdateInput,
  AppleSearchMessagesInput,
} from './apple-mail/types.js';
import { classifyMailtrapAction } from './mailtrap/classification.js';
import { MailtrapClient } from './mailtrap/client.js';
import { redactMailtrapSecrets } from './mailtrap/redaction.js';
import { redactProviderResult } from './redaction.js';
import type {
  MailtrapAction,
  MailtrapActionInputMap,
  MailtrapResult,
  JsonValue,
} from './mailtrap/types.js';
import type { MicrosoftMessageContent, MicrosoftSendResult } from './microsoft/common.js';
import { EwsClient } from './microsoft/ews.js';
import type { EwsMessageSummary, EwsSearchOptions } from './microsoft/ews.js';
import { MicrosoftGraphClient } from './microsoft/graph.js';
import type {
  GraphMessageSummary,
  GraphThreadResult,
} from './microsoft/graph.js';
import type { PaginationPage, PaginationScope } from '../utils/pagination-store.js';

export const APPLE_READ_OPERATIONS = [
  'listAccounts',
  'listMailboxes',
  'listMessages',
  'searchMessages',
  'readMessage',
  'getRawSource',
  'listRules',
] as const;

export const APPLE_WRITE_OPERATIONS = [
  'compose',
  'createDraft',
  'reply',
  'replyAll',
  'forward',
  'updateMessage',
  'moveMessage',
  'trashMessage',
  'createMailbox',
  'renameMailbox',
  'deleteMailbox',
  'createRule',
  'updateRule',
  'deleteRule',
] as const;

export const MICROSOFT_READ_OPERATIONS = [
  'getMessage',
  'findByInternetMessageId',
  'getThread',
  'searchMessages',
] as const;

export const MICROSOFT_WRITE_OPERATIONS = ['sendMessage', 'reply'] as const;

export const MAILTRAP_ACTIONS = [
  'send',
  'templates',
  'sandbox',
  'email_logs',
  'stats',
  'inbound',
  'domains',
  'suppressions',
  'webhooks',
  'contacts',
  'contact_lists',
  'contact_fields',
  'contact_imports',
  'contact_exports',
  'campaigns',
  'accounts',
] as const satisfies readonly MailtrapAction[];

export type AppleReadOperation = typeof APPLE_READ_OPERATIONS[number];
export type AppleWriteOperation = typeof APPLE_WRITE_OPERATIONS[number];
export type MicrosoftReadOperation = typeof MICROSOFT_READ_OPERATIONS[number];
export type MicrosoftWriteOperation = typeof MICROSOFT_WRITE_OPERATIONS[number];

export interface AppleReadInputMap {
  listAccounts: Record<string, never>;
  listMailboxes: AppleMailboxSelector;
  listMessages: Omit<AppleListMessagesInput, 'maxItems'> & { limit?: number; cursor?: string };
  searchMessages: Omit<AppleSearchMessagesInput, 'maxItems'> & { limit?: number; cursor?: string };
  readMessage: AppleMessageSelector;
  getRawSource: AppleMessageSelector;
  listRules: AppleMailboxSelector;
}

export interface AppleReadResultMap {
  listAccounts: AppleMailAccount[];
  listMailboxes: AppleMailbox[];
  listMessages: PaginationPage<AppleMailMessageSummary>;
  searchMessages: PaginationPage<AppleMailMessageSummary>;
  readMessage: AppleMailMessage;
  getRawSource: { rawSource: string };
  listRules: AppleMailRule[];
}

export interface AppleWriteInputMap {
  compose: AppleComposeInput;
  createDraft: AppleDraftInput;
  reply: AppleReplyInput;
  replyAll: AppleReplyInput;
  forward: AppleForwardInput;
  updateMessage: AppleMessageUpdateInput;
  moveMessage: AppleMoveMessageInput;
  trashMessage: AppleMessageSelector;
  createMailbox: AppleMailboxCreateInput;
  renameMailbox: AppleMailboxRenameInput;
  deleteMailbox: AppleMailboxDeleteInput;
  createRule: AppleRuleCreateInput;
  updateRule: AppleRuleUpdateInput;
  deleteRule: AppleRuleDeleteInput;
}

export type AppleWriteResultMap = {
  [Operation in AppleWriteOperation]: AppleMailMutationResult;
};

export interface MicrosoftReadInputMap {
  getMessage: { messageId: string };
  findByInternetMessageId: { internetMessageId: string };
  getThread: { anchor: GraphMessageSummary };
  searchMessages: EwsSearchOptions;
}

export interface MicrosoftReadResultMap {
  getMessage: GraphMessageSummary | EwsMessageSummary;
  findByInternetMessageId: GraphMessageSummary[];
  getThread: GraphThreadResult;
  searchMessages: EwsMessageSummary[];
}

export interface MicrosoftWriteInputMap {
  sendMessage: { message: MicrosoftMessageContent; saveToSentItems?: boolean };
  reply: { messageId: string; message: MicrosoftMessageContent };
}

export type MicrosoftWriteResultMap = {
  [Operation in MicrosoftWriteOperation]: MicrosoftSendResult;
};

export type ProviderRuntimeErrorCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_SCOPE_MISMATCH'
  | 'BACKEND_MISMATCH'
  | 'CREDENTIALS_MISSING'
  | 'OPERATION_NOT_ALLOWED'
  | 'RUNTIME_SHUTTING_DOWN';

export class ProviderRuntimeError extends Error {
  constructor(
    public readonly code: ProviderRuntimeErrorCode,
    message: string,
    public readonly accountId?: string,
  ) {
    super(message);
    this.name = 'ProviderRuntimeError';
  }
}

export interface ProviderRuntimeFactories {
  appleMail(account: AppleMailConfiguredAccount): AppleMailAdapter;
  microsoftGraph(
    account: MicrosoftGraphConfiguredAccount,
    tokenProvider: () => Promise<string>,
  ): MicrosoftGraphClient;
  ews(account: EwsConfiguredAccount, tokenProvider: () => Promise<string>): EwsClient;
  mailtrap(account: MailtrapConfiguredAccount, token: string): MailtrapClient;
}

export interface ProviderRuntimeOptions {
  getAccounts?: () => Promise<ConfiguredAccount[]>;
  loadCredentials?: (accountId: string) => Promise<string | null>;
  getValidAccessToken?: (accountId: string) => Promise<string>;
  fetch?: typeof fetch;
  factories?: Partial<ProviderRuntimeFactories>;
  /** Apply the server's content redaction policy to provider responses. */
  redact?: boolean;
}

function backendName(account: ConfiguredAccount): string {
  return account.backend ?? 'imap-smtp';
}

function sanitizeMailtrapResult(
  result: MailtrapResult,
  sensitive: boolean,
  redact: boolean,
): MailtrapResult {
  const secretSafe = sensitive && result !== null && typeof result !== 'string' && !(result instanceof Uint8Array)
    ? redactMailtrapSecrets(result as JsonValue) as MailtrapResult
    : result;
  return redact ? redactProviderResult(secretSafe) : secretSafe;
}

const APPLE_MAX_SNAPSHOT_ITEMS = 10_000;

function applePaginationRevision(account: AppleMailConfiguredAccount, queryKey: string): string {
  // Apple Mail has no IMAP UIDVALIDITY. Use an opaque, deterministic namespace
  // for the immutable in-memory snapshot instead of pretending it has a server
  // UID validity value.
  const digest = createHash('sha256')
    .update(`${account.id}\u0000${queryKey}`)
    .digest('hex');
  return String((BigInt(`0x${digest.slice(0, 8)}`) % 4_294_967_295n) + 1n);
}

export class ProviderRuntime {
  private readonly getAccounts: () => Promise<ConfiguredAccount[]>;
  private readonly loadCredentials: (accountId: string) => Promise<string | null>;
  private readonly getAccessToken: (accountId: string) => Promise<string>;
  private readonly factories: ProviderRuntimeFactories;
  private readonly redact: boolean;

  constructor(
    private readonly state: MailMCPRuntimeState,
    options: ProviderRuntimeOptions = {},
  ) {
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.getAccounts = options.getAccounts ?? getConfiguredAccounts;
    this.loadCredentials = options.loadCredentials ?? loadCredentials;
    this.getAccessToken = options.getValidAccessToken ?? getValidAccessToken;
    this.redact = options.redact ?? false;
    this.factories = {
      appleMail: options.factories?.appleMail ?? (account => new AppleMailAdapter({
        allowedAttachmentRoots: account.allowedAttachmentRoots,
      })),
      microsoftGraph: options.factories?.microsoftGraph ?? ((account, tokenProvider) => (
        new MicrosoftGraphClient({
          fetch: fetchImpl,
          tokenProvider,
          userId: account.user,
          ...(account.endpoint ? { baseUrl: account.endpoint } : {}),
        })
      )),
      ews: options.factories?.ews ?? ((account, tokenProvider) => new EwsClient({
        endpoint: account.endpoint,
        fetch: fetchImpl,
        tokenProvider,
      })),
      mailtrap: options.factories?.mailtrap ?? ((account, token) => new MailtrapClient({
        token,
        fetch: fetchImpl,
        ...(account.accountId ? { accountId: account.accountId } : {}),
        ...(account.sandboxId ? { sandboxId: account.sandboxId } : {}),
      })),
    };
  }

  async executeAppleRead<Operation extends AppleReadOperation>(
    accountId: string,
    operation: Operation,
    input: AppleReadInputMap[Operation],
  ): Promise<AppleReadResultMap[Operation]> {
    const account = await this.resolveAccount(accountId);
    if (!isAppleMailAccount(account)) this.backendMismatch(account, 'apple-mail');
    const scopedInput = operation === 'listAccounts'
      ? input
      : this.scopeAppleInput(account, input as { account?: string });
    const client = await this.appleMailClient(account);

    switch (operation) {
      case 'listAccounts': return this.redactResult(await client.listAccounts()) as AppleReadResultMap[Operation];
      case 'listMailboxes': return this.redactResult(await client.listMailboxes(
        scopedInput as AppleReadInputMap['listMailboxes'],
      )) as AppleReadResultMap[Operation];
      case 'listMessages': return this.redactResult(await this.appleMessagePage(
        account,
        client,
        'list',
        scopedInput as AppleReadInputMap['listMessages'],
      )) as AppleReadResultMap[Operation];
      case 'searchMessages': return this.redactResult(await this.appleMessagePage(
        account,
        client,
        'search',
        scopedInput as AppleReadInputMap['searchMessages'],
      )) as AppleReadResultMap[Operation];
      case 'readMessage': return this.redactResult(await client.readMessage(
        scopedInput as AppleReadInputMap['readMessage'],
      )) as AppleReadResultMap[Operation];
      case 'getRawSource': return this.redactResult(await client.getRawSource(
        scopedInput as AppleReadInputMap['getRawSource'],
      )) as AppleReadResultMap[Operation];
      case 'listRules': return this.redactResult(await client.listRules(
        scopedInput as AppleReadInputMap['listRules'],
      )) as AppleReadResultMap[Operation];
      default: return this.unsupportedOperation(accountId, operation);
    }
  }

  async executeAppleWrite<Operation extends AppleWriteOperation>(
    accountId: string,
    operation: Operation,
    input: AppleWriteInputMap[Operation],
  ): Promise<AppleWriteResultMap[Operation]> {
    const account = await this.resolveAccount(accountId);
    if (!isAppleMailAccount(account)) this.backendMismatch(account, 'apple-mail');
    const scopedInput = this.scopeAppleInput(account, input);
    const client = await this.appleMailClient(account);

    switch (operation) {
      case 'compose': return this.redactResult(await client.compose(scopedInput as AppleWriteInputMap['compose']));
      case 'createDraft': return this.redactResult(await client.createDraft(scopedInput as AppleWriteInputMap['createDraft']));
      case 'reply': return this.redactResult(await client.reply(scopedInput as AppleWriteInputMap['reply']));
      case 'replyAll': return this.redactResult(await client.replyAll(scopedInput as AppleWriteInputMap['replyAll']));
      case 'forward': return this.redactResult(await client.forward(scopedInput as AppleWriteInputMap['forward']));
      case 'updateMessage': return this.redactResult(await client.updateMessage(scopedInput as AppleWriteInputMap['updateMessage']));
      case 'moveMessage': return this.redactResult(await client.moveMessage(scopedInput as AppleWriteInputMap['moveMessage']));
      case 'trashMessage': return this.redactResult(await client.trashMessage(scopedInput as AppleWriteInputMap['trashMessage']));
      case 'createMailbox': return this.redactResult(await client.createMailbox(scopedInput as AppleWriteInputMap['createMailbox']));
      case 'renameMailbox': return this.redactResult(await client.renameMailbox(scopedInput as AppleWriteInputMap['renameMailbox']));
      case 'deleteMailbox': return this.redactResult(await client.deleteMailbox(scopedInput as AppleWriteInputMap['deleteMailbox']));
      case 'createRule': return this.redactResult(await client.createRule(scopedInput as AppleWriteInputMap['createRule']));
      case 'updateRule': return this.redactResult(await client.updateRule(scopedInput as AppleWriteInputMap['updateRule']));
      case 'deleteRule': return this.redactResult(await client.deleteRule(scopedInput as AppleWriteInputMap['deleteRule']));
      default: return this.unsupportedOperation(accountId, operation);
    }
  }

  async executeMicrosoftRead<Operation extends MicrosoftReadOperation>(
    accountId: string,
    operation: Operation,
    input: MicrosoftReadInputMap[Operation],
  ): Promise<MicrosoftReadResultMap[Operation]> {
    const account = await this.resolveAccount(accountId);
    if (isMicrosoftGraphAccount(account)) {
      if (operation === 'searchMessages') {
        return this.unsupportedOperation(accountId, operation, 'microsoft-graph');
      }
      const client = await this.microsoftGraphClient(account);
      switch (operation) {
        case 'getMessage': return this.redactResult(await client.getMessage(
          (input as MicrosoftReadInputMap['getMessage']).messageId,
        )) as MicrosoftReadResultMap[Operation];
        case 'findByInternetMessageId': return this.redactResult(await client.findByInternetMessageId(
          (input as MicrosoftReadInputMap['findByInternetMessageId']).internetMessageId,
        )) as MicrosoftReadResultMap[Operation];
        case 'getThread': return this.redactResult(await client.getThread(
          (input as MicrosoftReadInputMap['getThread']).anchor,
        )) as MicrosoftReadResultMap[Operation];
        default: return this.unsupportedOperation(accountId, operation, 'microsoft-graph');
      }
    }
    if (isEwsAccount(account)) {
      if (operation !== 'getMessage' && operation !== 'searchMessages') {
        return this.unsupportedOperation(accountId, operation, 'ews');
      }
      const client = await this.ewsClient(account);
      switch (operation) {
        case 'getMessage': return this.redactResult(await client.getMessage(
          (input as MicrosoftReadInputMap['getMessage']).messageId,
        )) as MicrosoftReadResultMap[Operation];
        case 'searchMessages': return this.redactResult(await client.searchMessages(
          input as MicrosoftReadInputMap['searchMessages'],
        )) as MicrosoftReadResultMap[Operation];
        default: return this.unsupportedOperation(accountId, operation, 'ews');
      }
    }
    return this.backendMismatch(account, 'microsoft-graph or ews');
  }

  async executeMicrosoftWrite<Operation extends MicrosoftWriteOperation>(
    accountId: string,
    operation: Operation,
    input: MicrosoftWriteInputMap[Operation],
  ): Promise<MicrosoftWriteResultMap[Operation]> {
    const account = await this.resolveAccount(accountId);
    if (isMicrosoftGraphAccount(account)) {
      const client = await this.microsoftGraphClient(account);
      switch (operation) {
        case 'sendMessage': {
          const value = input as MicrosoftWriteInputMap['sendMessage'];
          return this.redactResult(await client.sendMessage(value.message, value.saveToSentItems));
        }
        case 'reply': {
          const value = input as MicrosoftWriteInputMap['reply'];
          return this.redactResult(await client.reply(value.messageId, value.message));
        }
        default: return this.unsupportedOperation(accountId, operation, 'microsoft-graph');
      }
    }
    if (isEwsAccount(account)) {
      if (operation !== 'sendMessage') {
        return this.unsupportedOperation(accountId, operation, 'ews');
      }
      const value = input as MicrosoftWriteInputMap['sendMessage'];
      return this.redactResult(await (await this.ewsClient(account)).sendMessage(value.message));
    }
    return this.backendMismatch(account, 'microsoft-graph or ews');
  }

  async executeMailtrapRead<Action extends MailtrapAction>(
    accountId: string,
    action: Action,
    input: MailtrapActionInputMap[Action],
  ): Promise<MailtrapResult> {
    return await this.executeMailtrap(accountId, action, input, 'read');
  }

  async executeMailtrapWrite<Action extends MailtrapAction>(
    accountId: string,
    action: Action,
    input: MailtrapActionInputMap[Action],
  ): Promise<MailtrapResult> {
    return await this.executeMailtrap(accountId, action, input, 'write');
  }

  private async executeMailtrap<Action extends MailtrapAction>(
    accountId: string,
    action: Action,
    input: MailtrapActionInputMap[Action],
    expectedAccess: 'read' | 'write',
  ): Promise<MailtrapResult> {
    if (!(MAILTRAP_ACTIONS as readonly string[]).includes(action)) {
      return this.unsupportedOperation(accountId, action, 'mailtrap');
    }
    const classification = classifyMailtrapAction(action, input);
    if (classification.access !== expectedAccess) {
      throw new ProviderRuntimeError(
        'OPERATION_NOT_ALLOWED',
        `Mailtrap action ${action} is classified as ${classification.access}, not ${expectedAccess}`,
        accountId,
      );
    }
    const account = await this.resolveAccount(accountId);
    if (!isMailtrapAccount(account)) this.backendMismatch(account, 'mailtrap');
    const result = await (await this.mailtrapClient(account)).execute(action, input);
    return sanitizeMailtrapResult(result, classification.sensitiveResponse, this.redact);
  }

  private async resolveAccount(accountId: string): Promise<ConfiguredAccount> {
    const account = (await this.getAccounts()).find(candidate => candidate.id === accountId);
    if (!account) {
      throw new ProviderRuntimeError(
        'ACCOUNT_NOT_FOUND',
        `Configured account ${accountId} was not found`,
        accountId,
      );
    }
    return account;
  }

  private backendMismatch(account: ConfiguredAccount, expected: string): never {
    throw new ProviderRuntimeError(
      'BACKEND_MISMATCH',
      `Account ${account.id} uses backend ${backendName(account)}; expected ${expected}`,
      account.id,
    );
  }

  private scopeAppleInput<Input extends { account?: string }>(
    account: AppleMailConfiguredAccount,
    input: Input,
  ): Input {
    const canonicalSelector = account.nativeAccountUuid ?? account.nativeAccountName;
    if (!canonicalSelector) {
      throw new ProviderRuntimeError(
        'ACCOUNT_SCOPE_MISMATCH',
        `Apple Mail account ${account.id} requires nativeAccountUuid or nativeAccountName for this operation`,
        account.id,
      );
    }

    const allowedSelectors = new Set([
      account.nativeAccountUuid,
      account.nativeAccountName,
    ].filter((value): value is string => value !== undefined));
    if (input.account !== undefined && !allowedSelectors.has(input.account)) {
      throw new ProviderRuntimeError(
        'ACCOUNT_SCOPE_MISMATCH',
        `Apple Mail account selector does not match configured account ${account.id}`,
        account.id,
      );
    }
    return { ...input, account: canonicalSelector };
  }

  private async appleMessagePage(
    account: AppleMailConfiguredAccount,
    client: AppleMailAdapter,
    kind: 'list' | 'search',
    input: AppleReadInputMap['listMessages'] | AppleReadInputMap['searchMessages'],
  ): Promise<PaginationPage<AppleMailMessageSummary>> {
    if ('offset' in input) {
      throw new ProviderRuntimeError(
        'OPERATION_NOT_ALLOWED',
        'Apple Mail pagination is cursor-only; offset is not accepted',
        account.id,
      );
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ProviderRuntimeError(
        'OPERATION_NOT_ALLOWED',
        'Apple Mail page limit must be an integer from 1 to 100',
        account.id,
      );
    }
    const { cursor, limit: _limit, ...query } = input;
    void _limit;
    const queryKey = JSON.stringify(Object.fromEntries(
      Object.entries({ kind, ...query }).sort(([left], [right]) => left.localeCompare(right)),
    ));
    const scope: PaginationScope = {
      accountId: account.id,
      mailbox: query.mailbox ?? '*',
      uidValidity: applePaginationRevision(account, queryKey),
      queryKey,
    };
    if (cursor) return this.state.appleMailPages.getNextPage(cursor, scope, limit);

    const snapshot = kind === 'list'
      ? await client.listMessages({
        ...query,
        maxItems: APPLE_MAX_SNAPSHOT_ITEMS,
      } as AppleListMessagesInput)
      : await client.searchMessages({
        ...query,
        maxItems: APPLE_MAX_SNAPSHOT_ITEMS,
      } as AppleSearchMessagesInput);
    return this.state.appleMailPages.getFirstPage(scope, snapshot, limit);
  }

  private redactResult<T>(value: T): T {
    return this.redact ? redactProviderResult(value) : value;
  }

  private unsupportedOperation(accountId: string, operation: unknown, backend?: string): never {
    throw new ProviderRuntimeError(
      'OPERATION_NOT_ALLOWED',
      `Operation ${String(operation)} is not allowed${backend ? ` for ${backend}` : ''}`,
      accountId,
    );
  }

  private assertRunning(accountId: string): void {
    if (this.state.isShuttingDown) {
      throw new ProviderRuntimeError(
        'RUNTIME_SHUTTING_DOWN',
        'Provider runtime is shutting down',
        accountId,
      );
    }
  }

  private async getOrCreate<Client extends RuntimeProviderClient>(
    accountId: string,
    backend: string,
    clients: Map<string, Client>,
    factory: () => Promise<Client> | Client,
  ): Promise<Client> {
    this.assertRunning(accountId);
    const cached = clients.get(accountId);
    if (cached) return cached;

    const creationKey = `${backend}:${accountId}`;
    const inProgress = this.state.providerCreations.get(creationKey) as Promise<Client> | undefined;
    if (inProgress) return await inProgress;

    const creation = Promise.resolve().then(factory).then(client => {
      clients.set(accountId, client);
      return client;
    }).finally(() => {
      if (this.state.providerCreations.get(creationKey) === creation) {
        this.state.providerCreations.delete(creationKey);
      }
    });
    this.state.providerCreations.set(creationKey, creation);
    return await creation;
  }

  private async appleMailClient(account: AppleMailConfiguredAccount): Promise<AppleMailAdapter> {
    return await this.getOrCreate(
      account.id,
      'apple-mail',
      this.state.appleMailAdapters,
      () => this.factories.appleMail(account),
    );
  }

  private async microsoftGraphClient(
    account: MicrosoftGraphConfiguredAccount,
  ): Promise<MicrosoftGraphClient> {
    return await this.getOrCreate(
      account.id,
      'microsoft-graph',
      this.state.microsoftGraphClients,
      () => this.factories.microsoftGraph(account, () => this.getAccessToken(account.id)),
    );
  }

  private async ewsClient(account: EwsConfiguredAccount): Promise<EwsClient> {
    return await this.getOrCreate(
      account.id,
      'ews',
      this.state.ewsClients,
      () => this.factories.ews(account, () => this.getAccessToken(account.id)),
    );
  }

  private async mailtrapClient(account: MailtrapConfiguredAccount): Promise<MailtrapClient> {
    return await this.getOrCreate(
      account.id,
      'mailtrap',
      this.state.mailtrapClients,
      async () => {
        const token = await this.loadCredentials(account.id);
        if (!token) {
          throw new ProviderRuntimeError(
            'CREDENTIALS_MISSING',
            `No Mailtrap credentials found for account ${account.id}`,
            account.id,
          );
        }
        return this.factories.mailtrap(account, token);
      },
    );
  }
}
