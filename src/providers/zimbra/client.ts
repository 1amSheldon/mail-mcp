import { randomBytes, randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';
import type { OutgoingAttachment, OutgoingMessage } from '../../domain/outgoing-message.js';
import { htmlToMarkdown } from '../../utils/markdown.js';
import type { ZimbraConfiguredAccount } from '../account-types.js';
import { ZimbraError, validateZimbraEndpoint, type ZimbraSession } from './session.js';
import { ZIMBRA_READ_SCHEMAS, ZIMBRA_WRITE_SCHEMAS, type ZimbraReadOperation, type ZimbraWriteOperation } from './operations.js';
import { NATIVE_READ_OPERATIONS, NATIVE_WRITE_OPERATIONS } from './native-operations.js';
import { composeMime, MAX_MIME_BYTES, parseUploadResponse } from './mime.js';

type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ZimbraError('PROVIDER_ERROR', 'Invalid Zimbra response.');
  return value as Obj;
}
function content(value: unknown): unknown {
  return value && typeof value === 'object' && '_content' in value ? (value as Obj)._content : value;
}
function sessionCookie(token: string): string {
  if (!token || /[^\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]/.test(token)) {
    throw new ZimbraError('AUTH_REQUIRED', 'Invalid Zimbra session. Run accounts login ACCOUNT_ID locally.');
  }
  return 'ZM_AUTH_TOKEN=' + token;
}
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const truth = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';

function quotedOriginal(message: Obj, html: boolean): string {
  let plain = ''; let rich = ''; let visited = 0;
  function visit(parts: unknown, depth: number): void {
    if (depth > 16 || visited > 1000) return;
    for (const raw of list(parts)) {
      if (++visited > 1000) return;
      const part = object(raw);
      if (part.cd === 'attachment' || part.filename) continue;
      const body = content(part.content);
      if (typeof body === 'string') {
        if (part.ct === 'text/plain') plain += body.slice(0, 200000 - plain.length);
        if (part.ct === 'text/html') rich += body.slice(0, 200000 - rich.length);
      }
      if (part.mp) visit(part.mp, depth + 1);
    }
  }
  visit(message.mp, 0);
  const text = plain || htmlToMarkdown(rich);
  if (!text) throw new ZimbraError('INVALID_INPUT', 'No original text was returned for quoting; read the message and supply the intended body explicitly.');
  if (html) return '<blockquote><pre>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre></blockquote>';
  return text.split('\n').map(line => '> ' + line).join('\n');
}

function withoutSecrets(value: unknown, authToken: string): unknown {
  if (typeof value === 'string') return value.split(authToken).join('[REDACTED]');
  if (Array.isArray(value)) return value.map(v => withoutSecrets(v, authToken));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
    /(?:password|secret|token|credential|authorization)$/i.test(k) ? '[REDACTED]' : withoutSecrets(v, authToken)]));
}

async function boundedBytes(response: Response, max: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel(); throw new ZimbraError('PROVIDER_ERROR', 'Zimbra response exceeds the size limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ZimbraError('PROVIDER_ERROR', 'Zimbra returned an empty response.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > max) { await reader.cancel(); throw new ZimbraError('PROVIDER_ERROR', 'Zimbra response exceeds the size limit.'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export interface ZimbraClientOptions {
  fetch?: typeof fetch;
  sessionProvider: () => Promise<ZimbraSession>;
  timeoutMs?: number;
}

/** User SOAP API only. Never retries a write or exports authentication material. */
export class ZimbraClient {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly cursors = new Map<string, { key: string; offset: number; expires: number }>();
  private readonly pending = new Set<AbortController>();
  private closed = false;
  constructor(private readonly account: ZimbraConfiguredAccount, private readonly options: ZimbraClientOptions) {
    this.endpoint = validateZimbraEndpoint(account.endpoint);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  disconnect(): void { this.closed = true; this.cursors.clear(); for (const c of this.pending) c.abort(); }

  private async request(name: string, params: Obj, namespace = 'urn:zimbraMail', write = false, auth?: Obj, changeToken?: string): Promise<Obj> {
    if (this.closed) throw new ZimbraError('PROVIDER_ERROR', 'Zimbra client is closed.');
    const session = auth ? undefined : await this.options.sessionProvider();
    if (session && (session.endpoint !== this.endpoint || session.user !== this.account.user || session.expiresAt <= Date.now() + 5000)) {
      throw new ZimbraError('AUTH_REQUIRED', 'Zimbra session expired or configuration changed. Run accounts login ACCOUNT_ID locally.');
    }
    const cookie = session ? sessionCookie(session.authToken) : undefined;
    const controller = new AbortController(); this.pending.add(controller);
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30000);
    let dispatched = false;
    try {
      dispatched = true;
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/soap+json; charset=utf-8', accept: 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ Header: { context: { _jsns: 'urn:zimbra', ...(session ? { authToken: { _content: session.authToken } } : {}), ...(changeToken ? { change: { token: changeToken, type: 'mod' } } : {}) } },
          Body: { [name + 'Request']: { _jsns: namespace, ...params } } }),
      });
      if (response.status === 401) {
        await response.body?.cancel();
        throw new ZimbraError(auth ? 'AUTH_FAILED' : 'AUTH_REQUIRED', 'Zimbra authentication rejected. Run accounts login ACCOUNT_ID locally.');
      }
      // Preserve SOAP auth faults in 403 responses; a generic 403 is an access
      // policy denial and does not establish that the session has expired.
      const denied = () => new ZimbraError('ACCESS_DENIED', 'Zimbra access denied (HTTP 403). Check account and proxy permissions.');
      if (response.status === 403 && !response.body) throw denied();
      const bytes = await boundedBytes(response, 8 * 1024 * 1024);
      let root: Obj;
      try { root = object(JSON.parse(bytes.toString('utf8'))); }
      catch { if (response.status === 403) throw denied(); throw new ZimbraError(write ? 'OUTCOME_UNKNOWN' : 'PROVIDER_ERROR', 'Zimbra returned an invalid response.'); }
      if (response.status === 403 && (!root.Body || typeof root.Body !== 'object' || Array.isArray(root.Body))) throw denied();
      const body = object(root.Body);
      if (body.Fault) {
        const fault = object(body.Fault);
        const detail = fault.Detail && typeof fault.Detail === 'object' ? fault.Detail as Obj : {};
        const error = detail.Error && typeof detail.Error === 'object' ? detail.Error as Obj : {};
        const code = String(content(error.Code) ?? '');
        if (code === 'mail.MODIFY_CONFLICT') throw new ZimbraError('CONFLICT', 'The server item changed. Read the current version before applying the edit again.');
        if (['service.AUTH_REQUIRED', 'service.AUTH_EXPIRED', 'account.AUTH_EXPIRED'].includes(code)) {
          throw new ZimbraError('AUTH_REQUIRED', 'Zimbra session was rejected. Run accounts login ACCOUNT_ID locally.');
        }
        if (code === 'account.TWO_FACTOR_AUTH_REQUIRED') throw new ZimbraError('TWO_FACTOR_REQUIRED', 'A second authentication factor is required.');
        if (!auth && code === 'account.AUTH_FAILED') throw new ZimbraError('AUTH_REQUIRED', 'Zimbra session rejected. Run accounts login ACCOUNT_ID locally.');
        if (auth || code === 'account.TWO_FACTOR_AUTH_FAILED') {
          throw new ZimbraError('AUTH_FAILED', 'Zimbra authentication failed. Check the password, second factor and server policy.');
        }
        if (response.status === 403) throw denied();
        // Some draft metadata faults occur after content was saved. Do not claim a safe retry.
        throw new ZimbraError(write ? 'OUTCOME_UNKNOWN' : 'PROVIDER_ERROR', 'Zimbra rejected the operation; inspect the server state before repeating a write.');
      }
      if (response.status === 403) throw denied();
      if (!response.ok || !body[name + 'Response']) throw new ZimbraError(write ? 'OUTCOME_UNKNOWN' : 'PROVIDER_ERROR', 'Unexpected Zimbra response.');
      const result = object(body[name + 'Response']);
      return session ? object(withoutSecrets(result, session.authToken)) : result;
    } catch (error) {
      if (error instanceof ZimbraError && (!write || error.code !== 'PROVIDER_ERROR' || !dispatched)) throw error;
      throw new ZimbraError(write && dispatched ? 'OUTCOME_UNKNOWN' : 'PROVIDER_ERROR',
        write && dispatched ? 'Zimbra write outcome is unknown. Do not retry automatically; inspect the current server state.' : 'Zimbra request failed or timed out.');
    } finally { clearTimeout(timer); this.pending.delete(controller); }
  }

  async authenticate(password: string, twoFactorCode?: string): Promise<ZimbraSession> {
    const result = await this.request('Auth', {
      account: { by: 'name', _content: this.account.user }, password: { _content: password },
      ...(twoFactorCode ? { twoFactorCode: { _content: twoFactorCode } } : {}),
    }, 'urn:zimbraAccount', false, {});
    if (truth(content(result.twoFactorAuthRequired))) throw new ZimbraError('TWO_FACTOR_REQUIRED', 'A second authentication factor is required.');
    const tokens = list(result.authToken);
    const token = tokens.length === 1 ? content(tokens[0]) : undefined; const lifetime = Number(content(result.lifetime));
    if (typeof token !== 'string' || !token || token.length > 16384 || !Number.isSafeInteger(lifetime) || lifetime <= 5000 || lifetime > 365 * 86400000) {
      throw new ZimbraError('AUTH_FAILED', 'Zimbra did not return a usable session.');
    }
    return { kind: 'zimbra-session-v1', endpoint: this.endpoint, user: this.account.user, authToken: token, expiresAt: Date.now() + lifetime };
  }

  async executeRead(operation: ZimbraReadOperation, input: unknown): Promise<unknown> {
    const schema = ZIMBRA_READ_SCHEMAS[operation];
    if (!schema) throw new ZimbraError('INVALID_INPUT', 'Unknown Zimbra read operation.');
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new ZimbraError('INVALID_INPUT', 'Invalid fields for Zimbra ' + operation + '.');
    const v = parsed.data;
    if (Object.hasOwn(NATIVE_READ_OPERATIONS, operation)) {
      const native = NATIVE_READ_OPERATIONS[operation as keyof typeof NATIVE_READ_OPERATIONS].request(v);
      return this.request(native.name, native.params, native.namespace);
    }
    switch (operation) {
      case 'sessionStatus': {
        const session = await this.options.sessionProvider();
        return { status: 'session_available', remoteVerified: false, expiresAt: new Date(session.expiresAt).toISOString(), nextAction: 'Run accounts login ACCOUNT_ID locally when the session expires.' };
      }
      case 'searchMessages': case 'searchContacts': return this.search(operation, v as { query: string; limit: number; cursor?: string });
      case 'readMessage': return this.request('GetMsg', { m: { id: (v as { messageId: string }).messageId, html: 1, read: 0, wantModSeq: 1, max: 200000 } });
      case 'getRawMessage': return this.attachment(v as { messageId: string; maxBytes: number });
      case 'getThread': return { ...await this.request('GetConv', { c: { id: (v as { conversationId: string }).conversationId } }), partial: true, warning: 'Conversation metadata only. Read individual messages explicitly; completeness is not guaranteed.' };
      case 'listFolders': return this.request('GetFolder', { folder: { path: '/' } });
      case 'listTags': return this.request('GetTag', {});
      case 'getContact': return this.request('GetContacts', { cn: { id: (v as { contactId: string }).contactId } });
      case 'getAttachment': return this.attachment(v as { messageId: string; partId: string; maxBytes: number });
    }
    throw new ZimbraError('INVALID_INPUT', 'Unknown Zimbra read operation.');
  }

  private async search(operation: string, v: { query: string; limit: number; cursor?: string }): Promise<unknown> {
    const key = JSON.stringify([operation, v.query, v.limit]);
    const cursor = v.cursor ? this.cursors.get(v.cursor) : undefined;
    if (v.cursor && (!cursor || cursor.key !== key || cursor.expires <= Date.now())) throw new ZimbraError('INVALID_INPUT', 'Zimbra cursor expired or does not match the query. Restart the search.');
    const offset = cursor?.offset ?? 0;
    const result = await this.request('Search', { query: { _content: v.query }, limit: v.limit, offset, types: operation === 'searchContacts' ? 'contact' : 'message', fetch: 'all', read: 0, max: 20000, sortBy: 'dateDesc' });
    const items = list(result[operation === 'searchContacts' ? 'cn' : 'm']);
    if (items.length > v.limit || (truth(result.more) && !items.length)) throw new ZimbraError('PROVIDER_ERROR', 'Zimbra returned invalid search pagination.');
    let nextCursor: string | null = null;
    if (truth(result.more)) {
      for (const [k, entry] of this.cursors) if (entry.expires <= Date.now()) this.cursors.delete(k);
      while (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!);
      nextCursor = randomBytes(24).toString('base64url');
      this.cursors.set(nextCursor, { key, offset: offset + items.length, expires: Date.now() + 300000 });
    }
    if (v.cursor) this.cursors.delete(v.cursor);
    return { items, nextCursor, total: null, partial: nextCursor !== null, warning: 'Native Zimbra offset paging may shift when the mailbox changes. Cursors expire after five minutes.' };
  }

  async executeWrite(operation: ZimbraWriteOperation, input: unknown): Promise<unknown> {
    const schema = ZIMBRA_WRITE_SCHEMAS[operation];
    if (!schema) throw new ZimbraError('INVALID_INPUT', 'Unknown Zimbra write operation.');
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new ZimbraError('INVALID_INPUT', 'Invalid fields for Zimbra ' + operation + '.');
    const v = parsed.data;
    if (Object.hasOwn(NATIVE_WRITE_OPERATIONS, operation)) {
      const native = NATIVE_WRITE_OPERATIONS[operation as keyof typeof NATIVE_WRITE_OPERATIONS].request(v);
      return this.request(native.name, native.params, native.namespace, true);
    }
    switch (operation) {
      case 'createDraft': case 'updateDraft': {
        if (operation === 'updateDraft' && 'changes' in v) return this.patchDraft(v as Extract<typeof ZIMBRA_WRITE_SCHEMAS.updateDraft._output, { changes: unknown }>);
        const d = v as typeof ZIMBRA_WRITE_SCHEMAS.createDraft._output & { draftId: string };
        if (Boolean(d.originalMessageId) !== Boolean(d.replyType) || ((d.attachOriginal || d.quoteOriginal) && !d.originalMessageId)) throw new ZimbraError('INVALID_INPUT', 'originalMessageId and replyType must be supplied together.');
        let inReplyTo: string | undefined;
        let body = d.body;
        if (d.originalMessageId) {
          const original = await this.executeRead('readMessage', { messageId: d.originalMessageId }) as Obj;
          const source = object(list(original.m)[0]);
          const mid = content(source.mid);
          if (d.quoteOriginal) body += (d.isHtml ? '<br><br>' : '\n\n') + quotedOriginal(source, d.isHtml);
          if (d.replyType === 'r') {
            if (typeof mid !== 'string' || !/^<[^<>\s]+>$/.test(mid)) throw new ZimbraError('INVALID_INPUT', 'The original message has no usable RFC Message-ID for a threaded reply.');
            inReplyTo = mid;
          }
        }
        if (operation === 'updateDraft') return this.patchDraft({ draftId: d.draftId, changes: {
          to: d.to, cc: d.cc ?? [], bcc: d.bcc ?? [], subject: d.subject,
          ...(d.isHtml ? { htmlBody: body } : { textBody: body }),
          ...(d.attachments === undefined ? {} : { attachments: d.attachments }),
        } }, d.originalMessageId ? { originalMessageId: d.originalMessageId, replyType: d.replyType!, inReplyTo, attachOriginal: d.attachOriginal } : undefined);
        const message = {
          e: [{ t: 'f', a: this.account.user }, ...d.to.map(a => ({ t: 't', a })), ...(d.cc ?? []).map(a => ({ t: 'c', a })), ...(d.bcc ?? []).map(a => ({ t: 'b', a }))],
          su: { _content: d.subject }, mp: { ct: d.isHtml ? 'text/html' : 'text/plain', content: { _content: body } },
          ...(d.originalMessageId ? { origid: d.originalMessageId, rt: d.replyType } : {}),
          ...(inReplyTo ? { irt: { _content: inReplyTo } } : {}),
          ...(d.attachOriginal ? { attach: { m: [{ id: d.originalMessageId }] } } : {}),
        };
        let savedMessage: Obj = message;
        if (d.attachments !== undefined) {
          const attachments = [...d.attachments];
          if (d.attachOriginal && d.originalMessageId) {
            const original = await this.attachment({ messageId: d.originalMessageId, maxBytes: MAX_MIME_BYTES }) as Buffer;
            attachments.push({ filename: 'original.eml', contentBase64: original.toString('base64'), contentType: 'message/rfc822' });
          }
          const raw = await composeMime({ to: d.to.join(', '), cc: d.cc?.join(', '), bcc: d.bcc?.join(', '), subject: d.subject,
            ...(d.isHtml ? { html: body } : { text: body }), attachments,
            ...(inReplyTo ? { threading: { inReplyTo } } : {}),
          }, this.account.user, this.account.allowedAttachmentRoots ?? []);
          const aid = await this.upload(raw, 'message.eml', 'message/rfc822');
          savedMessage = { aid,
            ...(d.originalMessageId ? { origid: d.originalMessageId, rt: d.replyType } : {}) };
        }
        const result = await this.request('SaveDraft', { m: savedMessage }, 'urn:zimbraMail', true);
        const rawSaved = list(result.m)[0];
        if (!rawSaved || typeof rawSaved !== 'object' || Array.isArray(rawSaved)) throw new ZimbraError('OUTCOME_UNKNOWN', 'Draft response did not identify the saved message. Inspect Drafts before creating another copy.');
        const saved = rawSaved as Obj;
        if (typeof saved.id !== 'string' || !saved.id) throw new ZimbraError('OUTCOME_UNKNOWN', 'Draft response did not identify the saved message. Inspect Drafts before creating another copy.');
        return { status: 'saved', draftId: saved.id, retrySafe: false, result, nextAction: 'Read the saved draft and preserve its provider ID. Do not create another copy.' };
      }
      case 'sendDraft': {
        // sfd sends the latest server draft. Recipient restrictions cannot be
        // checked atomically against concurrent webmail edits, so fail closed.
        if (this.account.allowedRecipients !== undefined) throw new ZimbraError('INVALID_INPUT', 'Native sendDraft is disabled for accounts with recipient restrictions: webmail edits cannot be checked atomically.');
        const draftId = (v as { draftId: string }).draftId;
        const draft = await this.assertDraft(draftId);
        const recipients = list(draft.e).map(object).filter(e => ['t', 'c', 'b'].includes(String(e.t))).map(e => String(e.a));
        if (!recipients.length) throw new ZimbraError('INVALID_INPUT', 'Draft recipients are empty.');
        const result = await this.request('SendMsg', { suid: randomUUID(), fetchSavedMsg: 1, m: { did: draftId, sfd: 1 } }, 'urn:zimbraMail', true);
        return { status: 'accepted', retrySafe: false, result, nextAction: 'Do not resend. Inspect the saved Sent message; this does not prove recipient delivery.' };
      }
      case 'createTag': return this.request('CreateTag', { tag: v }, 'urn:zimbraMail', true);
      case 'deleteTag': return this.request('TagAction', { action: { id: (v as { tagId: string }).tagId, op: 'delete' } }, 'urn:zimbraMail', true);
      default: {
        const a = v as { messageIds: string[]; tagName?: string; folderId?: string; read?: boolean };
        const actions: Partial<Record<ZimbraWriteOperation, string>> = { addTag: 'tag', removeTag: '!tag', moveMessages: 'move', markRead: a.read ? 'read' : '!read', moveToTrash: 'trash' };
        const op = actions[operation];
        if (!op) throw new ZimbraError('INVALID_INPUT', 'Unknown Zimbra write operation.');
        return this.request('MsgAction', { action: { id: a.messageIds.join(','), op, ...(a.tagName ? { tn: a.tagName } : {}), ...(a.folderId ? { l: a.folderId } : {}) } }, 'urn:zimbraMail', true);
      }
    }
  }

  private async assertDraft(id: string): Promise<Obj> {
    const response = await this.executeRead('readMessage', { messageId: id }) as Obj;
    const draft = object(list(response.m)[0]);
    if (String(draft.id) !== id || !String(draft.f ?? '').includes('d')) throw new ZimbraError('INVALID_INPUT', 'The selected message is not a draft.');
    return draft;
  }

  private async patchDraft(v: Extract<typeof ZIMBRA_WRITE_SCHEMAS.updateDraft._output, { changes: unknown }>, linkage?: { originalMessageId: string; replyType: 'r' | 'w'; inReplyTo?: string; attachOriginal: boolean }): Promise<unknown> {
    const source = await this.assertDraft(v.draftId);
    const revision = String(source.ms ?? '');
    if (!/^[0-9]+$/.test(revision)) throw new ZimbraError('CONFLICT', 'Server omitted the draft change sequence; a safe partial update is unavailable.');
    if (v.expectedRevision !== undefined && revision !== v.expectedRevision) throw new ZimbraError('CONFLICT', 'The draft differs from the selected revision. Read it again.');
    const raw = await this.attachment({ messageId: v.draftId, maxBytes: MAX_MIME_BYTES }) as Buffer;
    const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
    const mimeType = parsed.headers.get('content-type');
    if (mimeType && typeof mimeType === 'object' && 'value' in mimeType && /(?:signed|encrypted|pkcs7)/i.test(String(mimeType.value))) {
      throw new ZimbraError('INVALID_INPUT', 'Signed or encrypted drafts require a compatible signing client.');
    }
    const c = v.changes;
    const field = (value: typeof parsed.to) => value === undefined ? '' : (Array.isArray(value) ? value.map(v => v.text).join(', ') : value.text);
    let text = parsed.text; let html = typeof parsed.html === 'string' ? parsed.html : undefined;
    if (c.textBody !== undefined || c.htmlBody !== undefined) { text = c.textBody; html = c.htmlBody; }
    const attachments: OutgoingAttachment[] = c.attachments ?? parsed.attachments.map(a => ({
      filename: a.filename || 'attachment', contentBase64: a.content.toString('base64'), contentType: a.contentType,
      contentDisposition: a.contentDisposition === 'inline' ? 'inline' : 'attachment', ...(a.cid ? { cid: a.cid } : {}),
    }));
    if (linkage?.attachOriginal) {
      const original = await this.attachment({ messageId: linkage.originalMessageId, maxBytes: MAX_MIME_BYTES }) as Buffer;
      attachments.push({ filename: 'original.eml', contentBase64: original.toString('base64'), contentType: 'message/rfc822' });
    }
    const headers: Record<string, string> = {};
    const controlled = /^(?:bcc|cc|content-.*|from|to|subject|date|message-id|mime-version|reply-to|references|in-reply-to|dkim-signature|return-path|received|authentication-results|arc-.*)$/i;
    for (const entry of parsed.headerLines) {
      if (controlled.test(entry.key)) continue;
      if (headers[entry.key] !== undefined) throw new ZimbraError('INVALID_INPUT', 'The draft has duplicate custom headers; exact preservation requires a compatible MIME editor.');
      headers[entry.key] = entry.line.slice(entry.line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim();
    }
    const message: OutgoingMessage = {
      from: field(parsed.from) || this.account.user,
      to: c.to?.join(', ') ?? field(parsed.to), cc: c.cc?.join(', ') ?? field(parsed.cc), bcc: c.bcc?.join(', ') ?? field(parsed.bcc),
      replyTo: field(parsed.replyTo), subject: c.subject ?? parsed.subject ?? '',
      ...(text !== undefined ? { text } : {}), ...(html !== undefined ? { html } : {}), attachments, headers,
      threading: { inReplyTo: linkage?.inReplyTo ?? parsed.inReplyTo, references: parsed.references },
    };
    if (!message.to) throw new ZimbraError('INVALID_INPUT', 'The draft has no To recipients.');
    const composed = await composeMime(message, this.account.user, this.account.allowedAttachmentRoots ?? [], { messageId: parsed.messageId, date: parsed.date });
    const aid = await this.upload(composed, 'message.eml', 'message/rfc822');
    const result = await this.request('SaveDraft', { m: { aid, id: v.draftId,
      ...(linkage ? { origid: linkage.originalMessageId, rt: linkage.replyType } : source.origid ? { origid: source.origid, rt: source.rt } : {}),
      ...(source.f ? { f: source.f } : {}), ...(source.tn ? { tn: source.tn } : {}),
    } }, 'urn:zimbraMail', true, undefined, revision);
    const saved = list(result.m)[0];
    if (!saved || typeof saved !== 'object' || !('id' in saved) || typeof saved.id !== 'string') throw new ZimbraError('OUTCOME_UNKNOWN', 'Draft save did not return an ID. Inspect Drafts before another write.');
    return { status: 'saved', draftId: saved.id, retrySafe: false, result, nextAction: 'Read the saved draft and verify its content and attachments.' };
  }

  private async upload(bytes: Buffer, filename: string, contentType: string): Promise<string> {
    if (this.closed) throw new ZimbraError('PROVIDER_ERROR', 'Zimbra client is closed.');
    if (bytes.length > MAX_MIME_BYTES) throw new ZimbraError('INVALID_INPUT', 'Upload exceeds the 50 MiB limit.');
    const session = await this.options.sessionProvider();
    if (session.endpoint !== this.endpoint || session.user !== this.account.user || session.expiresAt <= Date.now() + 5000) throw new ZimbraError('AUTH_REQUIRED', 'Run accounts login ACCOUNT_ID locally.');
    const cookie = sessionCookie(session.authToken);
    const requestId = randomUUID();
    const form = new FormData();
    form.set('requestId', requestId);
    form.set('file', new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
    const controller = new AbortController(); this.pending.add(controller);
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30000);
    try {
      const response = await this.fetchImpl(new URL('/service/upload?fmt=raw', this.endpoint), {
        method: 'POST', redirect: 'error', signal: controller.signal, headers: { cookie }, body: form,
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new ZimbraError(response.status === 401 ? 'AUTH_REQUIRED' : 'ACCESS_DENIED', 'Zimbra upload access rejected. Check the session and server permissions.');
      }
      const data = await boundedBytes(response, 8192);
      if (!response.ok) throw new ZimbraError('OUTCOME_UNKNOWN', 'Zimbra upload failed. No draft save was attempted.');
      return parseUploadResponse(data.toString('utf8'), requestId);
    } catch (error) {
      if (error instanceof ZimbraError && error.code !== 'PROVIDER_ERROR') throw error;
      throw new ZimbraError('OUTCOME_UNKNOWN', 'Zimbra upload outcome is unknown. No draft save was attempted.');
    } finally { clearTimeout(timer); this.pending.delete(controller); }
  }

  private async attachment(v: { messageId: string; partId?: string; maxBytes: number }): Promise<unknown> {
    if (this.closed) throw new ZimbraError('PROVIDER_ERROR', 'Zimbra client is closed.');
    const session = await this.options.sessionProvider();
    if (session.endpoint !== this.endpoint || session.user !== this.account.user || session.expiresAt <= Date.now() + 5000) throw new ZimbraError('AUTH_REQUIRED', 'Run accounts login ACCOUNT_ID locally.');
    const url = new URL('/service/home/~/', this.endpoint);
    url.search = new URLSearchParams({ id: v.messageId, ...(v.partId ? { part: v.partId } : { fmt: 'raw' }), auth: 'co' }).toString();
    const controller = new AbortController(); this.pending.add(controller);
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30000);
    try {
      const cookie = sessionCookie(session.authToken);
      const response = await this.fetchImpl(url, { redirect: 'error', signal: controller.signal, headers: { cookie } });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new ZimbraError(response.status === 401 ? 'AUTH_REQUIRED' : 'ACCESS_DENIED', response.status === 401 ? 'Zimbra session rejected. Run accounts login ACCOUNT_ID locally.' : 'Zimbra access denied. Check account and proxy permissions.');
      }
      if (!response.ok) { await response.body?.cancel(); throw new ZimbraError('PROVIDER_ERROR', 'Zimbra attachment request failed.'); }
      const bytes = await boundedBytes(response, v.maxBytes);
      // Keep binary data out of text redaction; the MCP formatter emits a resource.
      return bytes;
    } catch (error) {
      if (error instanceof ZimbraError) throw error;
      throw new ZimbraError('PROVIDER_ERROR', 'Zimbra attachment request failed or timed out.');
    } finally { clearTimeout(timer); this.pending.delete(controller); }
  }
}
