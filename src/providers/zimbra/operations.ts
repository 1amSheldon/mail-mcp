import { z } from 'zod';

const id = z.string().regex(/^(?:[a-fA-F0-9-]{36}:)?[1-9][0-9]{0,15}$/);
// Zimbra represents single-message conversations with a negative item ID.
const conversationId = z.string().regex(/^(?:[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}:)?-?[1-9][0-9]{0,15}$/);
const text = z.string().max(200000).refine(v => !v.includes('\0'));
const short = z.string().min(1).max(256).refine(v => !/[\r\n\0]/.test(v));
const addresses = z.array(z.email().max(320)).max(100);
const page = { query: z.string().min(1).max(4096), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(128).optional() };
const draft = {
  to: addresses.min(1), cc: addresses.optional(), bcc: addresses.optional(),
  subject: z.string().max(998).refine(v => !/[\r\n\0]/.test(v)), body: text,
  isHtml: z.boolean().default(false), originalMessageId: id.optional(),
  replyType: z.enum(['r', 'w']).optional(), attachOriginal: z.boolean().default(false),
  quoteOriginal: z.boolean().default(false),
};
export const ZIMBRA_READ_SCHEMAS = {
  sessionStatus: z.object({}).strict(),
  searchMessages: z.object(page).strict(),
  readMessage: z.object({ messageId: id }).strict(),
  getThread: z.object({ conversationId }).strict(),
  listFolders: z.object({}).strict(),
  listTags: z.object({}).strict(),
  searchContacts: z.object(page).strict(),
  getContact: z.object({ contactId: id }).strict(),
  getAttachment: z.object({ messageId: id, partId: z.string().regex(/^[1-9][0-9]*(?:\.[1-9][0-9]*)*$/), maxBytes: z.number().int().min(1).max(25 * 1024 * 1024).default(5 * 1024 * 1024) }).strict(),
};
export const ZIMBRA_WRITE_SCHEMAS = {
  createDraft: z.object(draft).strict(),
  updateDraft: z.object({ ...draft, draftId: id }).strict(),
  sendDraft: z.object({ draftId: id }).strict(),
  createTag: z.object({ name: short, color: z.number().int().min(0).max(9).optional() }).strict(),
  deleteTag: z.object({ tagId: id }).strict(),
  addTag: z.object({ messageIds: z.array(id).min(1).max(100), tagName: short }).strict(),
  removeTag: z.object({ messageIds: z.array(id).min(1).max(100), tagName: short }).strict(),
  moveMessages: z.object({ messageIds: z.array(id).min(1).max(100), folderId: id }).strict(),
  markRead: z.object({ messageIds: z.array(id).min(1).max(100), read: z.boolean() }).strict(),
  moveToTrash: z.object({ messageIds: z.array(id).min(1).max(100) }).strict(),
};
export type ZimbraReadOperation = keyof typeof ZIMBRA_READ_SCHEMAS;
export type ZimbraWriteOperation = keyof typeof ZIMBRA_WRITE_SCHEMAS;
