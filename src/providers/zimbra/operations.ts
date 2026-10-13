import { z } from 'zod';
import { itemId, NATIVE_READ_OPERATIONS, NATIVE_WRITE_OPERATIONS, schemas } from './native-operations.js';
import { attachmentsSchema, MAX_MIME_BYTES } from './mime.js';
import { FILTER_READ_SCHEMAS, FILTER_WRITE_SCHEMAS } from './filters.js';
import { DOCUMENT_READ_SCHEMAS, DOCUMENT_WRITE_SCHEMAS } from './documents.js';
import { CALENDAR_READ_SCHEMAS, CALENDAR_WRITE_SCHEMAS } from './calendar-schema.js';

const id = itemId;
const attachmentPart = z.string().regex(/^[1-9][0-9]*(?:\.[1-9][0-9]*)*$/);
// Zimbra represents single-message conversations with a negative item ID.
const conversationId = z.string().regex(/^(?:[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}:)?-?[1-9][0-9]{0,15}$/);
const text = z.string().max(200000).refine(v => !v.includes('\0'));
// Zimbra MailItem naming rules; reject controls instead of silently stripping them.
const tagName = z.string().min(1).max(255).refine(v => !/[:/"\x00-\x1f]/.test(v)
  && v.trimEnd().length > 0 && !['.', '..'].includes(v.trimEnd()));
const addresses = z.array(z.email().max(320)).max(100);
const rfcMessageId = z.string().max(998).regex(/^<[^<>\s"\\]+>$/);
const composeOptions = {
  from: z.email().optional(), replyTo: z.email().optional(), identityId: z.string().uuid().optional(),
  signatureId: z.string().uuid().optional(), includeSignature: z.boolean().default(true),
};
const page = { query: z.string().min(1).max(4096), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(128).optional() };
const draft = {
  to: addresses.min(1), cc: addresses.optional(), bcc: addresses.optional(),
  subject: z.string().max(998).refine(v => !/[\r\n\0]/.test(v)), body: text.optional(),
  textBody: text.optional(), htmlBody: text.optional(), ...composeOptions,
  isHtml: z.boolean().default(false), originalMessageId: id.optional(),
  replyType: z.enum(['r', 'w']).optional(), attachOriginal: z.boolean().default(false),
  quoteOriginal: z.boolean().default(false),
  attachments: attachmentsSchema.optional(),
  references: z.array(rfcMessageId).max(100).optional(),
};
const hasBody = (v: { body?: string; textBody?: string; htmlBody?: string }) =>
  v.body !== undefined ? v.textBody === undefined && v.htmlBody === undefined : v.textBody !== undefined || v.htmlBody !== undefined;
const replyDraft = {
  messageId: id, body: text, isHtml: z.boolean().default(false), cc: addresses.optional(), bcc: addresses.optional(),
  attachments: attachmentsSchema.optional(), includeOriginalAttachments: z.boolean().default(false),
  quoteOriginal: z.boolean().default(false), ...composeOptions,
};
export const draftChangesSchema = z.object({
  to: addresses.min(1).optional(), cc: addresses.optional(), bcc: addresses.optional(),
  subject: draft.subject.optional(), textBody: text.optional(), htmlBody: text.optional(),
  attachments: attachmentsSchema.optional(),
  from: z.email().optional(), replyTo: z.union([z.email(), z.literal('')]).optional(), identityId: z.string().uuid().optional(),
}).strict().refine(v => Object.keys(v).length > 0);
export const ZIMBRA_READ_SCHEMAS = {
  ...schemas(NATIVE_READ_OPERATIONS),
  ...FILTER_READ_SCHEMAS,
  ...DOCUMENT_READ_SCHEMAS,
  ...CALENDAR_READ_SCHEMAS,
  sessionStatus: z.object({ remote: z.boolean().default(false) }).strict(),
  getSendStatus: z.object({ draftId: id }).strict(),
  verifySentMessage: z.object({ messageId: rfcMessageId, limit: z.number().int().min(1).max(100).default(20) }).strict(),
  searchMessages: z.object(page).strict(),
  searchDocuments: z.object(page).strict(),
  readMessage: z.object({ messageId: id }).strict(),
  getRawMessage: z.object({ messageId: id, maxBytes: z.number().int().min(1).max(MAX_MIME_BYTES).default(10 * 1024 * 1024) }).strict(),
  getThread: z.object({ conversationId }).strict(),
  listFolders: z.object({}).strict(),
  mailboxStats: z.object({}).strict(),
  listTags: z.object({}).strict(),
  searchContacts: z.object(page).strict(),
  searchGal: z.object({ ...page, type: z.enum(['all', 'account', 'resource']).default('all') }).strict(),
  getContact: z.object({ contactId: id, dereferenceMembers: z.boolean().default(false), maxMembers: z.number().int().min(1).max(1000).default(100) }).strict(),
  getAttachment: z.object({ messageId: id, partId: attachmentPart, maxBytes: z.number().int().min(1).max(25 * 1024 * 1024).default(5 * 1024 * 1024) }).strict(),
  extractAttachmentText: z.object({ messageId: id, partId: attachmentPart, maxBytes: z.number().int().min(1).max(25 * 1024 * 1024).default(5 * 1024 * 1024), maxChars: z.number().int().min(1).max(200000).default(100000), maxPages: z.number().int().min(1).max(100).default(25) }).strict(),
};
export const ZIMBRA_WRITE_SCHEMAS = {
  ...schemas(NATIVE_WRITE_OPERATIONS),
  ...FILTER_WRITE_SCHEMAS,
  ...DOCUMENT_WRITE_SCHEMAS,
  ...CALENDAR_WRITE_SCHEMAS,
  createDraft: z.object(draft).strict().refine(hasBody, 'Supply body or textBody/htmlBody, not both forms.'),
  createReplyDraft: z.object(replyDraft).strict(),
  createReplyAllDraft: z.object(replyDraft).strict(),
  createForwardDraft: z.object({ ...replyDraft, to: addresses.min(1) }).strict(),
  updateDraft: z.union([
    z.object({ draftId: id, changes: draftChangesSchema, expectedRevision: z.string().regex(/^[0-9]+$/).optional() }).strict(),
    z.object({ ...draft, draftId: id }).strict().refine(hasBody),
  ]),
  sendDraft: z.object({ draftId: id, expectedRevision: z.string().regex(/^[0-9]+$/).optional() }).strict(),
  createTag: z.object({ name: tagName, color: z.number().int().min(0).max(9).optional() }).strict(),
  deleteTag: z.object({ tagId: id }).strict(),
  addTag: z.object({ messageIds: z.array(id).min(1).max(100), tagName }).strict(),
  removeTag: z.object({ messageIds: z.array(id).min(1).max(100), tagName }).strict(),
  moveMessages: z.object({ messageIds: z.array(id).min(1).max(100), folderId: id }).strict(),
  markRead: z.object({ messageIds: z.array(id).min(1).max(100), read: z.boolean() }).strict(),
  moveToTrash: z.object({ messageIds: z.array(id).min(1).max(100) }).strict(),
};
export type ZimbraReadOperation = keyof typeof ZIMBRA_READ_SCHEMAS;
export type ZimbraWriteOperation = keyof typeof ZIMBRA_WRITE_SCHEMAS;
