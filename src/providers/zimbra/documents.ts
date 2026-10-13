import { z } from 'zod';
import { itemId } from './native-operations.js';
import { prepareAttachment } from '../../domain/outgoing-message.js';
import { ZimbraError } from './session.js';

type Obj = Record<string, unknown>;
const version = z.number().int().min(1).max(2147483647);
const name = z.string().min(1).max(255).refine(v => !/[\\/\x00-\x1f]/.test(v) && !['.', '..'].includes(v));
const mime = z.string().min(3).max(255).regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n\0]*)?$/);
const fields = { name, description: z.string().max(20000).optional(), descriptionEnabled: z.boolean().optional() };
const file = z.union([
  z.object({ path: z.string().min(1).max(4096), filename: name.optional(), contentType: mime.optional() }).strict(),
  z.object({ filename: name, contentBase64: z.string().max(35 * 1024 * 1024), contentType: mime.optional() }).strict(),
]);
const source = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), file }).strict(),
  z.object({ type: z.literal('text'), text: z.string().max(1048576), contentType: z.enum(['text/plain', 'text/html']).default('text/plain') }).strict(),
  z.object({ type: z.literal('attachment'), messageId: itemId, partId: z.string().regex(/^[1-9][0-9]*(?:\.[1-9][0-9]*)*$/) }).strict(),
]);
const id = { documentId: itemId };
export const DOCUMENT_READ_SCHEMAS = {
  getDocumentMetadata: z.object(id).strict(),
  listDocumentRevisions: z.object({ ...id, fromVersion: version.optional(), count: z.number().int().min(1).max(100).default(20) }).strict(),
  diffDocument: z.object({ ...id, firstVersion: version, secondVersion: version }).strict(),
  downloadDocument: z.object({ ...id, version: version.optional(), maxBytes: z.number().int().min(1).max(50 * 1024 * 1024).default(10 * 1024 * 1024) }).strict(),
};
export const DOCUMENT_WRITE_SCHEMAS = {
  createDocument: z.object({ ...fields, folderId: itemId, source }).strict(),
  updateDocument: z.object({ ...fields, name: name.optional(), ...id, expectedVersion: version, source }).strict(),
  restoreDocumentRevision: z.object({ ...id, expectedVersion: version, restoreVersion: version }).strict(),
  renameDocument: z.object({ ...id, name }).strict(),
  moveDocument: z.object({ ...id, folderId: itemId }).strict(),
  copyDocument: z.object({ ...id, folderId: itemId }).strict(),
  trashDocument: z.object(id).strict(),
  deleteDocument: z.object(id).strict(),
  setDocumentTag: z.object({ ...id, tagName: name, enabled: z.boolean() }).strict(),
  setDocumentFlagged: z.object({ ...id, flagged: z.boolean() }).strict(),
  setDocumentLock: z.object({ ...id, locked: z.boolean() }).strict(),
  setDocumentWatch: z.object({ ...id, enabled: z.boolean() }).strict(),
  grantDocumentAccess: z.object({ ...id, grantee: z.discriminatedUnion('type', [z.object({ type: z.literal('usr'), id: z.string().uuid() }).strict(), z.object({ type: z.enum(['all', 'pub']) }).strict()]), permissions: z.string().min(1).max(8).regex(/^[rwidaxpf]+$/).refine(v => new Set(v).size === v.length), expiresAt: z.union([z.iso.datetime({ offset: true }), z.literal('never')]).optional() }).strict(),
  revokeDocumentAccess: z.object({ ...id, granteeId: z.union([z.string().uuid(), z.literal('99999999-9999-9999-9999-999999999999')]) }).strict(),
};
type ReadOperation = keyof typeof DOCUMENT_READ_SCHEMAS;
type WriteOperation = keyof typeof DOCUMENT_WRITE_SCHEMAS;
type Request = (name: string, params: Obj, write?: boolean) => Promise<Obj>;
type Upload = (bytes: Buffer, filename: string, contentType: string) => Promise<string>;
const first = (value: unknown): Obj | undefined => {
  const v = Array.isArray(value) ? value[0] : value;
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined;
};
export class ZimbraDocuments {
  constructor(private readonly request: Request, private readonly upload: Upload, private readonly download: (id: string, version: number | undefined, maxBytes: number) => Promise<unknown>, private readonly roots: readonly string[] = []) {}
  private async metadata(id: string): Promise<Obj> {
    const result = await this.request('GetItem', { item: { id } });
    const doc = first(result.doc);
    if (!doc || String(doc.id) !== id || !Number.isInteger(Number(doc.ver)) || Number(doc.ver) < 1) throw new ZimbraError('PROVIDER_ERROR', 'Zimbra did not return the requested document metadata and version.');
    return doc;
  }
  async read(operation: ReadOperation, input: unknown): Promise<unknown> {
    const v = DOCUMENT_READ_SCHEMAS[operation].parse(input);
    if (operation === 'getDocumentMetadata') return { doc: await this.metadata(v.documentId) };
    if (operation === 'diffDocument') {
      const v = DOCUMENT_READ_SCHEMAS.diffDocument.parse(input);
      return this.request('DiffDocument', { doc: { id: v.documentId, v1: v.firstVersion, v2: v.secondVersion } });
    }
    if (operation === 'listDocumentRevisions') {
      const v = DOCUMENT_READ_SCHEMAS.listDocumentRevisions.parse(input);
      const start = v.fromVersion ?? Number((await this.metadata(v.documentId)).ver);
      const result = await this.request('ListDocumentRevisions', { doc: { id: v.documentId, ver: start, count: v.count } });
      const nextVersion = Math.max(0, start - v.count) || null;
      return { ...result, nextVersion, partial: nextVersion !== null, warning: 'Missing or purged revisions can create gaps. Continue with nextVersion until null.' };
    }
    if (operation === 'downloadDocument') {
      const v = DOCUMENT_READ_SCHEMAS.downloadDocument.parse(input);
      const metadata = await this.metadata(v.documentId);
      return this.download(v.documentId, v.version ?? Number(metadata.ver), v.maxBytes);
    }
    throw new ZimbraError('INVALID_INPUT', 'Unknown document read operation.');
  }
  async write(operation: WriteOperation, input: unknown): Promise<unknown> {
    const v = DOCUMENT_WRITE_SCHEMAS[operation].parse(input);
    if (operation === 'createDocument' || operation === 'updateDocument' || operation === 'restoreDocumentRevision') {
      const v = DOCUMENT_WRITE_SCHEMAS[operation].parse(input);
      const current = 'documentId' in v ? await this.metadata(v.documentId) : undefined;
      if (current && 'expectedVersion' in v && Number(current.ver) !== v.expectedVersion) throw new ZimbraError('CONFLICT', 'Document version changed. Read the current revision before updating.');
      const doc: Obj = 'documentId' in v ? { id: v.documentId, ver: v.expectedVersion } : { l: v.folderId };
      if ('restoreVersion' in v) {
        doc.doc = { id: v.documentId, ver: v.restoreVersion };
      } else {
        // SaveDocument otherwise clears description and can rename a file from
        // its upload metadata. Carry omitted current metadata explicitly.
        doc.name = v.name ?? current?.name;
        if (v.description !== undefined || current?.desc !== undefined) doc.desc = v.description ?? current?.desc;
        if (v.descriptionEnabled !== undefined || current?.descEnabled !== undefined) doc.descEnabled = v.descriptionEnabled ?? current?.descEnabled;
        if (v.source.type === 'text') { doc.content = v.source.text; doc.ct = v.source.contentType; }
        else if (v.source.type === 'attachment') doc.m = { id: v.source.messageId, part: v.source.partId };
        else {
          let prepared;
          try { prepared = await prepareAttachment(v.source.file, { allowedAttachmentRoots: this.roots }); }
          catch { throw new ZimbraError('INVALID_INPUT', 'Invalid document file. Check base64, size and allowedAttachmentRoots.'); }
          doc.upload = { id: await this.upload(prepared.content, prepared.filename, prepared.contentType ?? 'application/octet-stream') };
          if (prepared.contentType) doc.ct = prepared.contentType;
        }
      }
      return this.request('SaveDocument', { doc }, true);
    }
    if (!('documentId' in v)) throw new ZimbraError('INVALID_INPUT', 'Document ID is required.');
    const action: Obj = { id: v.documentId };
    switch (operation) {
      case 'renameDocument': action.op = 'rename'; action.name = DOCUMENT_WRITE_SCHEMAS.renameDocument.parse(input).name; break;
      case 'moveDocument': case 'copyDocument': action.op = operation === 'moveDocument' ? 'move' : 'copy'; action.l = DOCUMENT_WRITE_SCHEMAS[operation].parse(input).folderId; break;
      case 'trashDocument': action.op = 'trash'; break;
      case 'deleteDocument': action.op = 'delete'; break;
      case 'setDocumentTag': { const v = DOCUMENT_WRITE_SCHEMAS.setDocumentTag.parse(input); action.op = v.enabled ? 'tag' : '!tag'; action.tn = v.tagName; break; }
      case 'setDocumentFlagged': action.op = DOCUMENT_WRITE_SCHEMAS.setDocumentFlagged.parse(input).flagged ? 'flag' : '!flag'; break;
      case 'setDocumentLock': action.op = DOCUMENT_WRITE_SCHEMAS.setDocumentLock.parse(input).locked ? 'lock' : 'unlock'; break;
      case 'setDocumentWatch': action.op = DOCUMENT_WRITE_SCHEMAS.setDocumentWatch.parse(input).enabled ? 'watch' : '!watch'; break;
      case 'grantDocumentAccess': {
        const v = DOCUMENT_WRITE_SCHEMAS.grantDocumentAccess.parse(input);
        action.op = 'grant'; action.grant = { gt: v.grantee.type, ...('id' in v.grantee ? { zid: v.grantee.id } : {}), perm: v.permissions, ...(v.expiresAt ? { expiry: v.expiresAt === 'never' ? 0 : Date.parse(v.expiresAt) } : {}) }; break;
      }
      case 'revokeDocumentAccess': action.op = '!grant'; action.zid = DOCUMENT_WRITE_SCHEMAS.revokeDocumentAccess.parse(input).granteeId; break;
      default: throw new ZimbraError('INVALID_INPUT', 'Unknown document mutation.');
    }
    return this.request('DocumentAction', { action }, true);
  }
}
