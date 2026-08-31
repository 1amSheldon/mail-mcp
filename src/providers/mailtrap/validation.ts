import type { MailtrapAction } from './types.js';

const SIMPLE_OPERATION_ALLOWLISTS = {
  send: ['transactional', 'bulk', 'sandbox_transactional', 'sandbox_batch'],
  templates: ['list', 'get', 'create', 'update', 'delete'],
  email_logs: ['list', 'get'],
  stats: ['aggregate', 'by_domain', 'by_category', 'by_provider', 'by_date'],
  domains: ['list', 'get', 'create', 'delete', 'send_setup'],
  suppressions: ['list', 'delete'],
  webhooks: ['list', 'get', 'create', 'update', 'delete'],
  contacts: ['get', 'create', 'update', 'delete', 'create_event'],
  contact_lists: ['list', 'get', 'create', 'update', 'delete'],
  contact_fields: ['list', 'get', 'create', 'update', 'delete'],
  contact_imports: ['get', 'create'],
  contact_exports: ['get', 'create'],
  campaigns: ['list', 'get', 'create', 'update', 'delete', 'start', 'schedule', 'cancel', 'terminate', 'reset', 'stats'],
  accounts: ['list'],
} as const satisfies Omit<Record<MailtrapAction, readonly string[]>, 'sandbox' | 'inbound'>;

const RESOURCE_OPERATION_ALLOWLISTS = {
  sandbox: {
    project: ['list', 'get', 'create', 'update', 'delete'],
    inbox: ['list', 'get', 'create', 'update', 'delete', 'clean', 'mark_read', 'reset_credentials', 'toggle_email_address', 'reset_email_address'],
    message: ['list', 'get', 'update', 'delete', 'forward', 'body', 'analysis'],
    attachment: ['list', 'get'],
  },
  inbound: {
    folder: ['list', 'get', 'create', 'update', 'delete'],
    inbox: ['list', 'get', 'create', 'update', 'delete'],
    message: ['list', 'get', 'delete', 'reply', 'reply_all', 'forward'],
    thread: ['list', 'get', 'delete'],
  },
} as const satisfies Record<'sandbox' | 'inbound', Record<string, readonly string[]>>;

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requireInputRecord(action: string, input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`Mailtrap ${action} input must be an object`);
  }
  return input as Record<string, unknown>;
}

function assertAllowedOperation(
  action: string,
  operation: unknown,
  allowed: readonly string[],
  resource?: string,
): void {
  if (typeof operation !== 'string' || !allowed.includes(operation)) {
    const target = resource === undefined ? action : `${action} ${resource}`;
    throw new TypeError(`Unsupported Mailtrap ${target} operation: ${String(operation)}`);
  }
}

/** Rejects unknown runtime dispatch values before classification or HTTP request construction. */
export function assertKnownMailtrapActionInput(action: string, input: unknown): void {
  const record = requireInputRecord(action, input);

  if (action === 'sandbox' || action === 'inbound') {
    const resources = RESOURCE_OPERATION_ALLOWLISTS[action];
    const resource = record.resource;
    if (typeof resource !== 'string' || !hasOwn(resources, resource)) {
      throw new TypeError(`Unsupported Mailtrap ${action} resource: ${String(resource)}`);
    }
    const allowed = resources[resource as keyof typeof resources] as readonly string[];
    assertAllowedOperation(action, record.operation, allowed, resource);
    return;
  }

  if (!hasOwn(SIMPLE_OPERATION_ALLOWLISTS, action)) {
    throw new TypeError(`Unsupported Mailtrap action: ${action}`);
  }
  const allowed = SIMPLE_OPERATION_ALLOWLISTS[
    action as keyof typeof SIMPLE_OPERATION_ALLOWLISTS
  ] as readonly string[];
  assertAllowedOperation(action, record.operation, allowed);
}
