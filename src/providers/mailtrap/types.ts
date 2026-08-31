export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Identifier = string | number;
export type QueryValue = JsonPrimitive | QueryObject | QueryValue[] | undefined;
export interface QueryObject {
  [key: string]: QueryValue;
}

export interface MailtrapEndpoints {
  general: string;
  transactional: string;
  bulk: string;
  sandbox: string;
}

export interface MailtrapClientOptions {
  token: string;
  accountId?: Identifier;
  /** Default Mailtrap Sandbox (inbox) ID used when a sandbox input omits inboxId. */
  sandboxId?: Identifier;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  endpoints?: Partial<MailtrapEndpoints>;
}

type SandboxInboxReference = {
  inboxId?: Identifier;
  sandboxId?: Identifier;
};

export type SendActionInput =
  | { operation: 'transactional'; message: JsonObject }
  | { operation: 'bulk'; base?: JsonObject; requests: JsonObject[] }
  | ({ operation: 'sandbox_transactional'; message: JsonObject } & SandboxInboxReference)
  | ({ operation: 'sandbox_batch'; base?: JsonObject; requests: JsonObject[] } & SandboxInboxReference);

export type TemplateActionInput =
  | { operation: 'list' }
  | { operation: 'get'; templateId: Identifier }
  | { operation: 'create'; template: JsonObject }
  | { operation: 'update'; templateId: Identifier; template: JsonObject }
  | { operation: 'delete'; templateId: Identifier };

export type SandboxActionInput =
  | { resource: 'project'; operation: 'list' }
  | { resource: 'project'; operation: 'get' | 'delete'; projectId: Identifier }
  | { resource: 'project'; operation: 'create'; name: string }
  | { resource: 'project'; operation: 'update'; projectId: Identifier; name: string }
  | { resource: 'inbox'; operation: 'list' }
  | ({ resource: 'inbox'; operation: 'get' | 'delete' | 'clean' | 'mark_read' | 'reset_credentials' | 'toggle_email_address' | 'reset_email_address' } & SandboxInboxReference)
  | { resource: 'inbox'; operation: 'create'; projectId: Identifier; name: string }
  | ({ resource: 'inbox'; operation: 'update'; name?: string; emailUsername?: string } & SandboxInboxReference)
  | ({ resource: 'message'; operation: 'list'; query?: QueryObject } & SandboxInboxReference)
  | ({ resource: 'message'; operation: 'get' | 'delete'; messageId: Identifier } & SandboxInboxReference)
  | ({ resource: 'message'; operation: 'update'; messageId: Identifier; isRead: boolean } & SandboxInboxReference)
  | ({ resource: 'message'; operation: 'forward'; messageId: Identifier; email: string } & SandboxInboxReference)
  | ({ resource: 'message'; operation: 'body'; messageId: Identifier; format: 'text' | 'raw' | 'html' | 'html_source' | 'eml' | 'headers' } & SandboxInboxReference)
  | ({ resource: 'message'; operation: 'analysis'; messageId: Identifier; analysis: 'spam' | 'html' } & SandboxInboxReference)
  | ({ resource: 'attachment'; operation: 'list'; messageId: Identifier } & SandboxInboxReference)
  | ({ resource: 'attachment'; operation: 'get'; messageId: Identifier; attachmentId: Identifier } & SandboxInboxReference);

export type EmailLogActionInput =
  | { operation: 'list'; cursor?: string; filters?: QueryObject }
  | { operation: 'get'; messageId: Identifier };

export type StatsActionInput = {
  operation: 'aggregate' | 'by_domain' | 'by_category' | 'by_provider' | 'by_date';
  query: QueryObject;
};

export type InboundActionInput =
  | { resource: 'folder'; operation: 'list' }
  | { resource: 'folder'; operation: 'get' | 'delete'; folderId: Identifier }
  | { resource: 'folder'; operation: 'create'; body: JsonObject }
  | { resource: 'folder'; operation: 'update'; folderId: Identifier; body: JsonObject }
  | { resource: 'inbox'; operation: 'list'; folderId: Identifier }
  | { resource: 'inbox'; operation: 'get' | 'delete'; folderId: Identifier; inboxId: Identifier }
  | { resource: 'inbox'; operation: 'create'; folderId: Identifier; body: JsonObject }
  | { resource: 'inbox'; operation: 'update'; folderId: Identifier; inboxId: Identifier; body: JsonObject }
  | { resource: 'message'; operation: 'list'; inboxId: Identifier; cursor?: string }
  | { resource: 'message'; operation: 'get' | 'delete'; inboxId: Identifier; messageId: Identifier }
  | { resource: 'message'; operation: 'reply' | 'reply_all' | 'forward'; inboxId: Identifier; messageId: Identifier; body: JsonObject }
  | { resource: 'thread'; operation: 'list'; inboxId: Identifier; cursor?: string }
  | { resource: 'thread'; operation: 'get' | 'delete'; inboxId: Identifier; threadId: Identifier };

export type DomainActionInput =
  | { operation: 'list' }
  | { operation: 'get' | 'delete'; domainId: Identifier }
  | { operation: 'create'; domain: JsonObject }
  | { operation: 'send_setup'; domainId: Identifier; email: string };

export type SuppressionActionInput =
  | { operation: 'list'; email?: string }
  | { operation: 'delete'; suppressionId: Identifier };

export type WebhookActionInput =
  | { operation: 'list' }
  | { operation: 'get' | 'delete'; webhookId: Identifier }
  | { operation: 'create'; webhook: JsonObject }
  | { operation: 'update'; webhookId: Identifier; webhook: JsonObject };

export type ContactActionInput =
  | { operation: 'get' | 'delete'; contact: Identifier }
  | { operation: 'create'; contact: JsonObject }
  | { operation: 'update'; contact: Identifier; body: JsonObject }
  | { operation: 'create_event'; contact: Identifier; event: JsonObject };

export type ContactCollectionActionInput =
  | { operation: 'list'; query?: QueryObject }
  | { operation: 'get' | 'delete'; id: Identifier }
  | { operation: 'create'; body: JsonObject }
  | { operation: 'update'; id: Identifier; body: JsonObject };

export type ContactTransferActionInput =
  | { operation: 'get'; id: Identifier }
  | { operation: 'create'; body: JsonObject };

export type CampaignActionInput =
  | { operation: 'list'; query?: QueryObject }
  | { operation: 'get' | 'delete' | 'start' | 'cancel' | 'terminate' | 'reset'; campaignId: Identifier }
  | { operation: 'create'; campaign: JsonObject }
  | { operation: 'update'; campaignId: Identifier; campaign: JsonObject }
  | { operation: 'schedule'; campaignId: Identifier; schedule: JsonObject }
  | { operation: 'stats'; campaignId: Identifier; query?: QueryObject };

export interface MailtrapActionInputMap {
  send: SendActionInput;
  templates: TemplateActionInput;
  sandbox: SandboxActionInput;
  email_logs: EmailLogActionInput;
  stats: StatsActionInput;
  inbound: InboundActionInput;
  domains: DomainActionInput;
  suppressions: SuppressionActionInput;
  webhooks: WebhookActionInput;
  contacts: ContactActionInput;
  contact_lists: ContactCollectionActionInput;
  contact_fields: ContactCollectionActionInput;
  contact_imports: ContactTransferActionInput;
  contact_exports: ContactTransferActionInput;
  campaigns: CampaignActionInput;
  accounts: { operation: 'list' };
}

export type MailtrapAction = keyof MailtrapActionInputMap;
export type MailtrapResult = JsonObject | JsonValue[] | string | Uint8Array | null;

export interface MailtrapActionClassification {
  access: 'read' | 'write';
  destructive: boolean;
  sendsMail: boolean;
  sensitiveResponse: boolean;
}
