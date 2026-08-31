import type {
  CampaignActionInput,
  ContactActionInput,
  ContactCollectionActionInput,
  ContactTransferActionInput,
  DomainActionInput,
  EmailLogActionInput,
  InboundActionInput,
  JsonObject,
  JsonValue,
  MailtrapAction,
  MailtrapActionInputMap,
  MailtrapClientOptions,
  MailtrapEndpoints,
  MailtrapResult,
  Identifier,
  QueryObject,
  QueryValue,
  SandboxActionInput,
  SendActionInput,
  StatsActionInput,
  SuppressionActionInput,
  TemplateActionInput,
  WebhookActionInput,
} from './types.js';
import { redactMailtrapSecrets } from './redaction.js';
import { assertKnownMailtrapActionInput } from './validation.js';

const DEFAULT_ENDPOINTS: MailtrapEndpoints = {
  general: 'https://mailtrap.io',
  transactional: 'https://send.api.mailtrap.io',
  bulk: 'https://bulk.api.mailtrap.io',
  sandbox: 'https://sandbox.api.mailtrap.io',
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 100_000;

interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  body?: JsonValue;
}

export class MailtrapHttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly details?: JsonValue | string | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MailtrapHttpError';
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new TypeError(`Mailtrap endpoint must use HTTPS: ${value}`);
  }
  return url.toString().replace(/\/$/, '');
}

function segment(value: string | number, label: string): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
    return encodeURIComponent(String(value));
  }
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${label} cannot be empty`);
  return encodeURIComponent(trimmed);
}

function assertNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${label} cannot be empty`);
  return trimmed;
}

function validateMessageContentMode(message: JsonObject, label: string): void {
  const templateId = message.template_uuid;
  const hasTemplate = typeof templateId === 'string' && templateId.trim().length > 0;
  const hasInlineContent = ['subject', 'text', 'html']
    .some(key => message[key] !== undefined && message[key] !== null);
  if (hasTemplate && hasInlineContent) {
    throw new TypeError(`${label} cannot combine template_uuid with subject, text, or html`);
  }
}

function appendQueryValue(params: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendQueryValue(params, `${key}[]`, item);
    return;
  }
  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
      appendQueryValue(params, `${key}[${childKey}]`, childValue);
    }
    return;
  }
  params.append(key, String(value));
}

function withQuery(url: string, query?: QueryObject): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
    appendQueryValue(params, key, value);
  }
  const serialized = params.toString();
  return serialized ? `${url}?${serialized}` : url;
}

function assertSafeJson(value: unknown): asserts value is JsonValue {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new TypeError('Mailtrap response contains too many JSON values');
    if (depth > MAX_JSON_DEPTH) throw new TypeError('Mailtrap response JSON is nested too deeply');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Mailtrap response contains a non-finite number');
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (key === '__proto__' || key === 'prototype') {
          throw new TypeError(`Mailtrap response contains an unsafe key: ${key}`);
        }
        visit(child, depth + 1);
      }
      return;
    }
    throw new TypeError(`Mailtrap response contains unsupported JSON type: ${typeof item}`);
  };
  visit(value, 0);
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes('/json') || contentType.includes('+json');
}

export class MailtrapClient {
  private readonly token: string;
  private readonly accountId?: string | number;
  private readonly sandboxId?: string | number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly endpoints: MailtrapEndpoints;

  constructor(options: MailtrapClientOptions) {
    this.token = assertNonEmpty(options.token, 'Mailtrap token');
    this.accountId = options.accountId;
    this.sandboxId = options.sandboxId;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('requestTimeoutMs must be a positive integer');
    }
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new TypeError('maxResponseBytes must be a positive integer');
    }
    this.endpoints = {
      general: normalizeBaseUrl(options.endpoints?.general ?? DEFAULT_ENDPOINTS.general),
      transactional: normalizeBaseUrl(options.endpoints?.transactional ?? DEFAULT_ENDPOINTS.transactional),
      bulk: normalizeBaseUrl(options.endpoints?.bulk ?? DEFAULT_ENDPOINTS.bulk),
      sandbox: normalizeBaseUrl(options.endpoints?.sandbox ?? DEFAULT_ENDPOINTS.sandbox),
    };
  }

  async execute<A extends MailtrapAction>(
    action: A,
    input: MailtrapActionInputMap[A],
  ): Promise<MailtrapResult> {
    const spec = this.buildRequest(action, input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(spec.url, {
        method: spec.method,
        headers: {
          Accept: 'application/json, text/plain, message/rfc822, application/octet-stream',
          Authorization: `Bearer ${this.token}`,
          ...(spec.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        redirect: 'error',
        signal: controller.signal,
      });
      const result = await this.readResponse(response);
      if (!response.ok) {
        const safeDetails = typeof result === 'string' || result === null
          ? result
          : result instanceof Uint8Array
            ? '[binary response omitted]'
            : redactMailtrapSecrets(result);
        throw new MailtrapHttpError(
          `Mailtrap ${spec.method} ${new URL(spec.url).pathname} failed with HTTP ${response.status}`,
          response.status,
          safeDetails,
        );
      }
      return result;
    } catch (error) {
      if (error instanceof MailtrapHttpError) throw error;
      if (controller.signal.aborted) {
        throw new MailtrapHttpError(`Mailtrap request timed out after ${this.timeoutMs}ms`, undefined, null, { cause: error });
      }
      throw new MailtrapHttpError('Mailtrap request failed before a response was received', undefined, null, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireAccountPath(): string {
    if (this.accountId === undefined || this.accountId === null || String(this.accountId).trim() === '') {
      throw new TypeError('accountId is required for this Mailtrap action');
    }
    return `/api/accounts/${segment(this.accountId, 'accountId')}`;
  }

  private requireSandboxId(explicit: Identifier | undefined): string {
    const value = explicit ?? this.sandboxId;
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new TypeError('inboxId or configured sandboxId is required for this Mailtrap action');
    }
    return segment(value, 'inboxId');
  }

  private general(path: string): string {
    return `${this.endpoints.general}${path}`;
  }

  private account(path: string): string {
    return this.general(`${this.requireAccountPath()}${path}`);
  }

  private buildRequest<A extends MailtrapAction>(
    action: A,
    input: MailtrapActionInputMap[A],
  ): RequestSpec {
    assertKnownMailtrapActionInput(action, input);
    switch (action) {
      case 'send': return this.buildSend(input as SendActionInput);
      case 'templates': return this.buildTemplates(input as TemplateActionInput);
      case 'sandbox': return this.buildSandbox(input as SandboxActionInput);
      case 'email_logs': return this.buildEmailLogs(input as EmailLogActionInput);
      case 'stats': return this.buildStats(input as StatsActionInput);
      case 'inbound': return this.buildInbound(input as InboundActionInput);
      case 'domains': return this.buildDomains(input as DomainActionInput);
      case 'suppressions': return this.buildSuppressions(input as SuppressionActionInput);
      case 'webhooks': return this.buildWebhooks(input as WebhookActionInput);
      case 'contacts': return this.buildContacts(input as ContactActionInput);
      case 'contact_lists': return this.buildContactCollection('lists', input as ContactCollectionActionInput);
      case 'contact_fields': return this.buildContactCollection('fields', input as ContactCollectionActionInput);
      case 'contact_imports': return this.buildContactTransfer('imports', input as ContactTransferActionInput);
      case 'contact_exports': return this.buildContactTransfer('exports', input as ContactTransferActionInput);
      case 'campaigns': return this.buildCampaigns(input as CampaignActionInput);
      case 'accounts': return { method: 'GET', url: this.general('/api/accounts') };
      default: {
        const exhaustive: never = action;
        throw new TypeError(`Unsupported Mailtrap action: ${String(exhaustive)}`);
      }
    }
  }

  private buildSend(input: SendActionInput): RequestSpec {
    if (input.operation === 'transactional') {
      validateMessageContentMode(input.message, 'Transactional message');
      return { method: 'POST', url: `${this.endpoints.transactional}/api/send`, body: input.message };
    }
    if (input.operation === 'bulk') {
      if (input.requests.length === 0) throw new TypeError('Bulk send requires at least one request');
      for (const [index, request] of input.requests.entries()) {
        validateMessageContentMode({ ...(input.base ?? {}), ...request }, `Bulk request ${index}`);
      }
      return {
        method: 'POST',
        url: `${this.endpoints.bulk}/api/batch`,
        body: input.base === undefined ? { requests: input.requests } : { base: input.base, requests: input.requests },
      };
    }
    if (input.operation === 'sandbox_transactional') {
      validateMessageContentMode(input.message, 'Sandbox message');
      return {
        method: 'POST',
        url: `${this.endpoints.sandbox}/api/send/${this.requireSandboxId(input.inboxId ?? input.sandboxId)}`,
        body: input.message,
      };
    }
    if (input.operation === 'sandbox_batch') {
      if (input.requests.length === 0) throw new TypeError('Sandbox batch send requires at least one request');
      for (const [index, request] of input.requests.entries()) {
        validateMessageContentMode({ ...(input.base ?? {}), ...request }, `Sandbox batch request ${index}`);
      }
      return {
        method: 'POST',
        url: `${this.endpoints.sandbox}/api/batch/${this.requireSandboxId(input.inboxId ?? input.sandboxId)}`,
        body: input.base === undefined ? { requests: input.requests } : { base: input.base, requests: input.requests },
      };
    }
    throw new TypeError(`Unsupported Mailtrap send operation: ${String((input as { operation?: unknown }).operation)}`);
  }

  private buildTemplates(input: TemplateActionInput): RequestSpec {
    const base = this.account('/email_templates');
    if (input.operation === 'list') return { method: 'GET', url: base };
    if (input.operation === 'create') return { method: 'POST', url: base, body: { email_template: input.template } };
    const url = `${base}/${segment(input.templateId, 'templateId')}`;
    if (input.operation === 'get') return { method: 'GET', url };
    if (input.operation === 'update') return { method: 'PATCH', url, body: { email_template: input.template } };
    if (input.operation === 'delete') return { method: 'DELETE', url };
    throw new TypeError(`Unsupported Mailtrap templates operation: ${String((input as { operation?: unknown }).operation)}`);
  }

  private buildSandbox(input: SandboxActionInput): RequestSpec {
    if (input.resource === 'project') {
      const base = this.account('/projects');
      if (input.operation === 'list') return { method: 'GET', url: base };
      if (input.operation === 'create') return { method: 'POST', url: base, body: { project: { name: assertNonEmpty(input.name, 'project name') } } };
      const url = `${base}/${segment(input.projectId, 'projectId')}`;
      if (input.operation === 'get') return { method: 'GET', url };
      if (input.operation === 'update') return { method: 'PATCH', url, body: { project: { name: assertNonEmpty(input.name, 'project name') } } };
      if (input.operation === 'delete') return { method: 'DELETE', url };
      throw new TypeError(`Unsupported Mailtrap sandbox project operation: ${String((input as { operation?: unknown }).operation)}`);
    }
    if (input.resource === 'inbox') return this.buildSandboxInbox(input);
    if (input.resource === 'message') return this.buildSandboxMessage(input);
    if (input.resource === 'attachment') {
      const base = this.account(`/inboxes/${this.requireSandboxId(input.inboxId ?? input.sandboxId)}/messages/${segment(input.messageId, 'messageId')}/attachments`);
      if (input.operation === 'list') return { method: 'GET', url: base };
      if (input.operation === 'get') {
        return { method: 'GET', url: `${base}/${segment(input.attachmentId, 'attachmentId')}` };
      }
      throw new TypeError(`Unsupported Mailtrap sandbox attachment operation: ${String((input as { operation?: unknown }).operation)}`);
    }
    throw new TypeError(`Unsupported Mailtrap sandbox resource: ${String((input as { resource?: unknown }).resource)}`);
  }

  private buildSandboxInbox(input: Extract<SandboxActionInput, { resource: 'inbox' }>): RequestSpec {
    if (input.operation === 'create') {
      return {
        method: 'POST',
        url: this.account(`/projects/${segment(input.projectId, 'projectId')}/inboxes`),
        body: { inbox: { name: assertNonEmpty(input.name, 'inbox name') } },
      };
    }
    const base = this.account('/inboxes');
    if (input.operation === 'list') return { method: 'GET', url: base };
    const url = `${base}/${this.requireSandboxId(input.inboxId ?? input.sandboxId)}`;
    if (input.operation === 'get') return { method: 'GET', url };
    if (input.operation === 'delete') return { method: 'DELETE', url };
    if (input.operation === 'update') {
      const inbox: JsonObject = {};
      if (input.name !== undefined) inbox.name = assertNonEmpty(input.name, 'inbox name');
      if (input.emailUsername !== undefined) inbox.email_username = assertNonEmpty(input.emailUsername, 'email username');
      if (Object.keys(inbox).length === 0) throw new TypeError('Inbox update requires name or emailUsername');
      return { method: 'PATCH', url, body: { inbox } };
    }
    const suffixes = {
      clean: 'clean',
      mark_read: 'all_read',
      reset_credentials: 'reset_credentials',
      toggle_email_address: 'toggle_email_username',
      reset_email_address: 'reset_email_username',
    } as const;
    return { method: 'PATCH', url: `${url}/${suffixes[input.operation]}` };
  }

  private buildSandboxMessage(input: Extract<SandboxActionInput, { resource: 'message' }>): RequestSpec {
    const base = this.account(`/inboxes/${this.requireSandboxId(input.inboxId ?? input.sandboxId)}/messages`);
    if (input.operation === 'list') return { method: 'GET', url: withQuery(base, input.query) };
    const url = `${base}/${segment(input.messageId, 'messageId')}`;
    if (input.operation === 'get') return { method: 'GET', url };
    if (input.operation === 'delete') return { method: 'DELETE', url };
    if (input.operation === 'update') return { method: 'PATCH', url, body: { message: { is_read: input.isRead } } };
    if (input.operation === 'forward') return { method: 'POST', url: `${url}/forward`, body: { email: assertNonEmpty(input.email, 'forward email') } };
    if (input.operation === 'analysis') {
      return { method: 'GET', url: `${url}/${input.analysis === 'spam' ? 'spam_report' : 'analyze'}` };
    }
    if (input.operation !== 'body') {
      throw new TypeError(`Unsupported sandbox message operation: ${String(input.operation)}`);
    }
    const suffixes = {
      text: 'body.txt',
      raw: 'body.raw',
      html: 'body.html',
      html_source: 'body.htmlsource',
      eml: 'body.eml',
      headers: 'mail_headers',
    } as const;
    return { method: 'GET', url: `${url}/${suffixes[input.format]}` };
  }

  private buildEmailLogs(input: EmailLogActionInput): RequestSpec {
    const base = this.account('/email_logs');
    if (input.operation === 'get') {
      return { method: 'GET', url: `${base}/${segment(input.messageId, 'messageId')}` };
    }
    if (input.operation === 'list') {
      const query: QueryObject = {};
      if (input.cursor !== undefined) query.search_after = input.cursor;
      if (input.filters !== undefined) query.filters = input.filters;
      return { method: 'GET', url: withQuery(base, query) };
    }
    throw new TypeError(`Unsupported Mailtrap email_logs operation: ${String((input as { operation?: unknown }).operation)}`);
  }

  private buildStats(input: StatsActionInput): RequestSpec {
    const suffix = {
      aggregate: '',
      by_domain: '/domains',
      by_category: '/categories',
      by_provider: '/email_service_providers',
      by_date: '/date',
    }[input.operation];
    return { method: 'GET', url: withQuery(this.account(`/stats${suffix}`), input.query) };
  }

  private buildInbound(input: InboundActionInput): RequestSpec {
    if (input.resource === 'folder') {
      const base = this.general('/api/inbound/folders');
      if (input.operation === 'list') return { method: 'GET', url: base };
      if (input.operation === 'create') return { method: 'POST', url: base, body: input.body };
      const url = `${base}/${segment(input.folderId, 'folderId')}`;
      if (input.operation === 'get') return { method: 'GET', url };
      if (input.operation === 'update') return { method: 'PATCH', url, body: input.body };
      if (input.operation === 'delete') return { method: 'DELETE', url };
      throw new TypeError(`Unsupported Mailtrap inbound folder operation: ${String((input as { operation?: unknown }).operation)}`);
    }
    if (input.resource === 'inbox') {
      const base = this.general(`/api/inbound/folders/${segment(input.folderId, 'folderId')}/inboxes`);
      if (input.operation === 'list') return { method: 'GET', url: base };
      if (input.operation === 'create') return { method: 'POST', url: base, body: input.body };
      const url = `${base}/${segment(input.inboxId, 'inboxId')}`;
      if (input.operation === 'get') return { method: 'GET', url };
      if (input.operation === 'update') return { method: 'PATCH', url, body: input.body };
      if (input.operation === 'delete') return { method: 'DELETE', url };
      throw new TypeError(`Unsupported Mailtrap inbound inbox operation: ${String((input as { operation?: unknown }).operation)}`);
    }
    if (input.resource === 'message') {
      const base = this.general(`/api/inbound/inboxes/${segment(input.inboxId, 'inboxId')}/messages`);
      if (input.operation === 'list') return { method: 'GET', url: withQuery(base, input.cursor === undefined ? undefined : { last_id: input.cursor }) };
      const url = `${base}/${segment(input.messageId, 'messageId')}`;
      if (input.operation === 'get') return { method: 'GET', url };
      if (input.operation === 'delete') return { method: 'DELETE', url };
      if (input.operation === 'reply' || input.operation === 'reply_all' || input.operation === 'forward') {
        return { method: 'POST', url: `${url}/${input.operation}`, body: input.body };
      }
      throw new TypeError(`Unsupported inbound message operation: ${String(input.operation)}`);
    }
    if (input.resource === 'thread') {
      const base = this.general(`/api/inbound/inboxes/${segment(input.inboxId, 'inboxId')}/threads`);
      if (input.operation === 'list') return { method: 'GET', url: withQuery(base, input.cursor === undefined ? undefined : { last_id: input.cursor }) };
      const url = `${base}/${segment(input.threadId, 'threadId')}`;
      if (input.operation === 'get') return { method: 'GET', url };
      if (input.operation === 'delete') return { method: 'DELETE', url };
      throw new TypeError(`Unsupported Mailtrap inbound thread operation: ${String((input as { operation?: unknown }).operation)}`);
    }
    throw new TypeError(`Unsupported Mailtrap inbound resource: ${String((input as { resource?: unknown }).resource)}`);
  }

  private buildDomains(input: DomainActionInput): RequestSpec {
    const base = this.account('/sending_domains');
    if (input.operation === 'list') return { method: 'GET', url: base };
    if (input.operation === 'create') return { method: 'POST', url: base, body: { sending_domain: input.domain } };
    const url = `${base}/${segment(input.domainId, 'domainId')}`;
    if (input.operation === 'get') return { method: 'GET', url };
    if (input.operation === 'delete') return { method: 'DELETE', url };
    if (input.operation === 'send_setup') {
      return { method: 'POST', url: `${url}/send_setup_instructions`, body: { email: assertNonEmpty(input.email, 'setup email') } };
    }
    throw new TypeError(`Unsupported domain operation: ${String(input.operation)}`);
  }

  private buildSuppressions(input: SuppressionActionInput): RequestSpec {
    const base = this.account('/suppressions');
    if (input.operation === 'list') {
      return { method: 'GET', url: withQuery(base, input.email === undefined ? undefined : { email: input.email }) };
    }
    if (input.operation === 'delete') {
      return { method: 'DELETE', url: `${base}/${segment(input.suppressionId, 'suppressionId')}` };
    }
    throw new TypeError(`Unsupported Mailtrap suppressions operation: ${String((input as { operation?: unknown }).operation)}`);
  }

  private buildWebhooks(input: WebhookActionInput): RequestSpec {
    const base = this.account('/webhooks');
    if (input.operation === 'list') return { method: 'GET', url: base };
    if (input.operation === 'create') return { method: 'POST', url: base, body: { webhook: input.webhook } };
    const url = `${base}/${segment(input.webhookId, 'webhookId')}`;
    if (input.operation === 'get') return { method: 'GET', url };
    if (input.operation === 'update') return { method: 'PATCH', url, body: { webhook: input.webhook } };
    if (input.operation === 'delete') return { method: 'DELETE', url };
    throw new TypeError(`Unsupported Mailtrap webhooks operation: ${String((input as { operation?: unknown }).operation)}`);
  }

  private buildContacts(input: ContactActionInput): RequestSpec {
    const base = this.account('/contacts');
    if (input.operation === 'create') return { method: 'POST', url: base, body: { contact: input.contact } };
    const url = `${base}/${segment(input.contact, 'contact')}`;
    if (input.operation === 'get') return { method: 'GET', url };
    if (input.operation === 'delete') return { method: 'DELETE', url };
    if (input.operation === 'create_event') return { method: 'POST', url: `${url}/events`, body: input.event };
    if (input.operation === 'update') return { method: 'PATCH', url, body: { contact: input.body } };
    throw new TypeError(`Unsupported contact operation: ${String(input.operation)}`);
  }

  private buildContactCollection(
    resource: 'lists' | 'fields',
    input: ContactCollectionActionInput,
  ): RequestSpec {
    const base = this.account(`/contacts/${resource}`);
    if (input.operation === 'list') return { method: 'GET', url: withQuery(base, input.query) };
    if (input.operation === 'create') return { method: 'POST', url: base, body: input.body };
    const url = `${base}/${segment(input.id, `${resource} id`)}`;
    if (input.operation === 'get') return { method: 'GET', url };
    if (input.operation === 'update') return { method: 'PATCH', url, body: input.body };
    if (input.operation === 'delete') return { method: 'DELETE', url };
    throw new TypeError(`Unsupported Mailtrap contact ${resource} operation: ${String((input as { operation?: unknown }).operation)}`);
  }

  private buildContactTransfer(
    resource: 'imports' | 'exports',
    input: ContactTransferActionInput,
  ): RequestSpec {
    const base = this.account(`/contacts/${resource}`);
    if (input.operation === 'create') return { method: 'POST', url: base, body: input.body };
    if (input.operation === 'get') {
      return { method: 'GET', url: `${base}/${segment(input.id, `${resource} id`)}` };
    }
    throw new TypeError(`Unsupported Mailtrap contact ${resource} operation: ${String((input as { operation?: unknown }).operation)}`);
  }

  private buildCampaigns(input: CampaignActionInput): RequestSpec {
    const base = this.general('/api/email_campaigns');
    if (input.operation === 'list') return { method: 'GET', url: withQuery(base, input.query) };
    if (input.operation === 'create') return { method: 'POST', url: base, body: input.campaign };
    const url = `${base}/${segment(input.campaignId, 'campaignId')}`;
    if (input.operation === 'get') return { method: 'GET', url };
    if (input.operation === 'update') return { method: 'PATCH', url, body: input.campaign };
    if (input.operation === 'delete') return { method: 'DELETE', url };
    if (input.operation === 'schedule') return { method: 'POST', url: `${url}/schedule`, body: input.schedule };
    if (input.operation === 'stats') return { method: 'GET', url: withQuery(`${url}/stats`, input.query) };
    if (input.operation === 'start' || input.operation === 'cancel'
      || input.operation === 'terminate' || input.operation === 'reset') {
      return { method: 'POST', url: `${url}/${input.operation}` };
    }
    throw new TypeError(`Unsupported Mailtrap campaigns operation: ${String((input as { operation?: unknown }).operation)}`);
  }

  private async readResponse(response: Response): Promise<MailtrapResult> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      throw new MailtrapHttpError(
        `Mailtrap response exceeds the ${this.maxResponseBytes}-byte limit`,
        response.status,
      );
    }
    if (response.status === 204 || response.status === 205) return null;

    const bytes = await this.readResponseBytes(response);
    if (bytes.byteLength === 0) return null;

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('application/octet-stream')) return bytes;
    const text = new TextDecoder().decode(bytes);
    if (isJsonContentType(contentType)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new MailtrapHttpError('Mailtrap returned invalid JSON', response.status, null, { cause: error });
      }
      assertSafeJson(parsed);
      if (parsed !== null && typeof parsed !== 'object') {
        throw new MailtrapHttpError('Mailtrap returned a JSON primitive where an object or array was expected', response.status);
      }
      return parsed;
    }
    return text;
  }

  private async readResponseBytes(response: Response): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > this.maxResponseBytes) {
          await reader.cancel();
          throw new MailtrapHttpError(
            `Mailtrap response exceeds the ${this.maxResponseBytes}-byte limit`,
            response.status,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}
