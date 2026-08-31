export type AppleMailOperationKind = 'read' | 'write' | 'destructive';

export type AppleMailOperation =
  | 'listAccounts'
  | 'listMailboxes'
  | 'listMessages'
  | 'searchMessages'
  | 'readMessage'
  | 'getRawSource'
  | 'compose'
  | 'createDraft'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'updateMessage'
  | 'moveMessage'
  | 'trashMessage'
  | 'createMailbox'
  | 'renameMailbox'
  | 'deleteMailbox'
  | 'listRules'
  | 'createRule'
  | 'updateRule'
  | 'deleteRule';

export const APPLE_MAIL_OPERATION_KINDS: Readonly<Record<AppleMailOperation, AppleMailOperationKind>> = {
  listAccounts: 'read',
  listMailboxes: 'read',
  listMessages: 'read',
  searchMessages: 'read',
  readMessage: 'read',
  getRawSource: 'read',
  compose: 'write',
  createDraft: 'write',
  reply: 'write',
  replyAll: 'write',
  forward: 'write',
  updateMessage: 'write',
  moveMessage: 'write',
  trashMessage: 'destructive',
  createMailbox: 'write',
  renameMailbox: 'write',
  deleteMailbox: 'destructive',
  listRules: 'read',
  createRule: 'write',
  updateRule: 'write',
  deleteRule: 'destructive',
};

export interface AppleMailAccount {
  id: string;
  name: string;
  fullName: string | null;
  aliases: string[];
  type: string;
  enabled: boolean;
}

export interface AppleMailbox {
  name: string;
  path: string;
  unreadCount: number;
  messageCount: number;
}

export interface AppleMailAddress {
  name?: string;
  address: string;
}

export interface AppleMailAttachment {
  path: string;
  name?: string;
}

export interface AppleMailMessageSummary {
  id: string;
  rfcMessageId: string | null;
  subject: string;
  sender: string;
  to: string[];
  cc: string[];
  dateReceived: string | null;
  read: boolean;
  flagged: boolean;
  snippet: string;
}

export interface AppleMailMessage extends AppleMailMessageSummary {
  content: string;
  replyTo: string | null;
}

export interface AppleMailAccountSelector {
  account: string;
}

export interface AppleMailboxSelector extends AppleMailAccountSelector {
  mailbox?: string;
}

export interface AppleMessageSelector extends AppleMailboxSelector {
  messageId: string;
}

export interface AppleListMessagesInput extends AppleMailboxSelector {
  /** Internal safety ceiling for a complete cursor snapshot. */
  maxItems?: number;
}

export interface AppleSearchMessagesInput extends AppleListMessagesInput {
  query?: string;
  from?: string;
  subject?: string;
  body?: string;
  unread?: boolean;
  flagged?: boolean;
  hasAttachments?: boolean;
  since?: string;
  before?: string;
}

export interface AppleComposeInput {
  account?: string;
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: AppleMailAttachment[];
}

export interface AppleDraftInput extends AppleComposeInput {
  open?: boolean;
}

export interface AppleReplyInput extends AppleMessageSelector {
  body: string;
  attachments?: AppleMailAttachment[];
  send?: boolean;
}

export interface AppleForwardInput extends AppleReplyInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
}

export interface AppleMessageUpdateInput extends AppleMessageSelector {
  read?: boolean;
  flagged?: boolean;
  flagColor?: number;
}

export interface AppleMoveMessageInput extends AppleMessageSelector {
  destination: string;
}

export interface AppleMailboxCreateInput extends AppleMailAccountSelector {
  path: string;
}

export interface AppleMailboxRenameInput extends AppleMailAccountSelector {
  path: string;
  newName: string;
}

export interface AppleMailboxDeleteInput extends AppleMailAccountSelector {
  path: string;
}

export type AppleRuleField = 'from' | 'to' | 'cc' | 'subject' | 'content';
export type AppleRuleOperator = 'contains' | 'notContains' | 'equals' | 'beginsWith' | 'endsWith';

export interface AppleRuleCondition {
  field: AppleRuleField;
  operator: AppleRuleOperator;
  value: string;
}

export interface AppleRuleActions {
  markRead?: boolean;
  markFlagged?: boolean;
  delete?: boolean;
  moveTo?: string;
  copyTo?: string;
  forwardTo?: string;
}

export interface AppleMailRule {
  name: string;
  enabled: boolean;
  match: 'all' | 'any';
  conditions: AppleRuleCondition[];
  actions: AppleRuleActions;
}

export interface AppleRuleCreateInput extends AppleMailAccountSelector {
  rule: AppleMailRule;
}

export interface AppleRuleUpdateInput extends AppleMailAccountSelector {
  name: string;
  rule: Partial<AppleMailRule>;
}

export interface AppleRuleDeleteInput extends AppleMailAccountSelector {
  name: string;
}

export interface AppleMailMutationResult {
  ok: true;
  operation: AppleMailOperation;
  id?: string;
}

export interface ReplyEnvelope {
  from: AppleMailAddress[];
  to: AppleMailAddress[];
  cc: AppleMailAddress[];
}
