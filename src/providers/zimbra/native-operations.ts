import { z } from 'zod';

// These descriptors are internal. No caller can choose a SOAP method/namespace.
export interface NativeRequest {
  name: string;
  params: Record<string, unknown>;
  namespace?: 'urn:zimbraAccount' | 'urn:zimbraMail';
}
function operation<S extends z.ZodType>(schema: S, build: (input: z.output<S>) => NativeRequest) {
  return { schema, request: (input: unknown) => build(schema.parse(input)) };
}
export const itemId = z.string().regex(/^(?:[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}:)?[1-9][0-9]{0,15}$/);
const ids = z.array(itemId).min(1).max(100);
const name = z.string().min(1).max(255).refine(v => !/[:/"\x00-\x1f]/.test(v) && v.trimEnd().length > 0 && !['.', '..'].includes(v.trimEnd()));
const color = z.number().int().min(0).max(127);
const empty = z.object({}).strict();
const contactFields = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/), z.string().max(20000).refine(v => !v.includes('\0')))
  .refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 100);
const attributes = (values: Record<string, string>) => Object.entries(values).map(([n, value]) => ({ n, _content: value }));
const folderAction = (id: string, op: string, extra: Record<string, unknown> = {}): NativeRequest => ({ name: 'FolderAction', params: { action: { id, op, ...extra } } });
const messageAction = (values: string[], op: string, extra: Record<string, unknown> = {}): NativeRequest => ({ name: 'MsgAction', params: { action: { id: values.join(','), op, ...extra } } });
const contactAction = (values: string[], op: string, extra: Record<string, unknown> = {}): NativeRequest => ({ name: 'ContactAction', params: { action: { id: values.join(','), op, ...extra } } });
const signatureId = z.string().uuid();
const signatureContent = z.array(z.object({ type: z.enum(['text/plain', 'text/html']), content: z.string().max(200000) }).strict()).min(1).max(2)
  .refine(v => new Set(v.map(c => c.type)).size === v.length);
const signatureParts = (values: z.infer<typeof signatureContent>) => values.map(v => ({ type: v.type, _content: v.content }));

export const NATIVE_READ_OPERATIONS = {
  getAccountInfo: operation(empty, () => ({ name: 'GetInfo', namespace: 'urn:zimbraAccount', params: { sections: 'mbox,idents,sigs' } })),
  getPreferences: operation(z.object({ names: z.array(z.string().regex(/^zimbraPref[A-Za-z0-9]+$/)).min(1).max(100) }).strict(),
    v => ({ name: 'GetPrefs', namespace: 'urn:zimbraAccount', params: { pref: v.names.map(name => ({ name })) } })),
  listSignatures: operation(empty, () => ({ name: 'GetSignatures', namespace: 'urn:zimbraAccount', params: {} })),
  listIdentities: operation(empty, () => ({ name: 'GetIdentities', namespace: 'urn:zimbraAccount', params: {} })),
  getFolder: operation(z.object({ folderId: itemId }).strict(), v => ({ name: 'GetFolder', params: { folder: { id: v.folderId } } })),
  getMessageMetadata: operation(z.object({ messageIds: ids }).strict(), v => ({ name: 'GetMsgMetadata', params: { m: { ids: v.messageIds.join(',') } } })),
};

export const NATIVE_WRITE_OPERATIONS = {
  createFolder: operation(z.object({ name, parentFolderId: itemId, view: z.enum(['message', 'contact', 'appointment', 'task', 'document']).default('message'), color: color.optional() }).strict(),
    v => ({ name: 'CreateFolder', params: { folder: { name: v.name, l: v.parentFolderId, view: v.view, ...(v.color === undefined ? {} : { color: v.color }) } } })),
  renameFolder: operation(z.object({ folderId: itemId, name }).strict(), v => folderAction(v.folderId, 'rename', { name: v.name })),
  moveFolder: operation(z.object({ folderId: itemId, parentFolderId: itemId }).strict().refine(v => v.folderId !== v.parentFolderId), v => folderAction(v.folderId, 'move', { l: v.parentFolderId })),
  trashFolder: operation(z.object({ folderId: itemId }).strict(), v => folderAction(v.folderId, 'trash')),
  deleteFolder: operation(z.object({ folderId: itemId }).strict(), v => folderAction(v.folderId, 'delete')),
  emptyFolder: operation(z.object({ folderId: itemId, recursive: z.boolean().default(false) }).strict(), v => folderAction(v.folderId, 'empty', { recursive: v.recursive ? 1 : 0 })),
  markFolderRead: operation(z.object({ folderId: itemId }).strict(), v => folderAction(v.folderId, 'read')),
  setFolderColor: operation(z.object({ folderId: itemId, color }).strict(), v => folderAction(v.folderId, 'color', { color: v.color })),
  setFlagged: operation(z.object({ messageIds: ids, flagged: z.boolean() }).strict(), v => messageAction(v.messageIds, v.flagged ? 'flag' : '!flag')),
  copyMessages: operation(z.object({ messageIds: ids, folderId: itemId }).strict(), v => messageAction(v.messageIds, 'copy', { l: v.folderId })),
  markSpam: operation(z.object({ messageId: itemId, spam: z.boolean() }).strict(), v => messageAction([v.messageId], v.spam ? 'spam' : '!spam')),
  deleteMessages: operation(z.object({ messageIds: ids }).strict(), v => messageAction(v.messageIds, 'delete')),
  recoverMessages: operation(z.object({ messageIds: ids, folderId: itemId }).strict(), v => ({ name: 'ItemAction', params: { action: { id: v.messageIds.join(','), op: 'recover', l: v.folderId } } })),
  renameTag: operation(z.object({ tagId: itemId, name }).strict(), v => ({ name: 'TagAction', params: { action: { id: v.tagId, op: 'rename', name: v.name } } })),
  setTagColor: operation(z.object({ tagId: itemId, color }).strict(), v => ({ name: 'TagAction', params: { action: { id: v.tagId, op: 'color', color: v.color } } })),
  createContact: operation(z.object({ folderId: itemId.optional(), fields: contactFields }).strict(), v => ({ name: 'CreateContact', params: { verbose: 1, cn: { ...(v.folderId ? { l: v.folderId } : {}), a: attributes(v.fields) } } })),
  updateContact: operation(z.object({ contactId: itemId, fields: contactFields }).strict(), v => ({ name: 'ModifyContact', params: { replace: 0, verbose: 1, cn: { id: v.contactId, a: attributes(v.fields) } } })),
  moveContacts: operation(z.object({ contactIds: ids, folderId: itemId }).strict(), v => contactAction(v.contactIds, 'move', { l: v.folderId })),
  trashContacts: operation(z.object({ contactIds: ids }).strict(), v => contactAction(v.contactIds, 'trash')),
  deleteContacts: operation(z.object({ contactIds: ids }).strict(), v => contactAction(v.contactIds, 'delete')),
  createSignature: operation(z.object({ name, contents: signatureContent }).strict(), v => ({ name: 'CreateSignature', namespace: 'urn:zimbraAccount', params: { signature: { name: v.name, content: signatureParts(v.contents) } } })),
  updateSignature: operation(z.object({ signatureId, name: name.optional(), contents: signatureContent.optional() }).strict().refine(v => v.name !== undefined || v.contents !== undefined),
    v => ({ name: 'ModifySignature', namespace: 'urn:zimbraAccount', params: { signature: { id: v.signatureId, ...(v.name === undefined ? {} : { name: v.name }), ...(v.contents === undefined ? {} : { content: signatureParts(v.contents) }) } } })),
  deleteSignature: operation(z.object({ signatureId }).strict(), v => ({ name: 'DeleteSignature', namespace: 'urn:zimbraAccount', params: { signature: { id: v.signatureId } } })),
};

export function schemas<T extends Record<string, { schema: z.ZodType }>>(operations: T): { [K in keyof T]: T[K]['schema'] } {
  return Object.fromEntries(Object.entries(operations).map(([key, value]) => [key, value.schema])) as { [K in keyof T]: T[K]['schema'] };
}
