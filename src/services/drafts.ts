import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { z } from 'zod';
import { ACCOUNTS_PATH, type EmailAccount } from '../config.js';
import { writeTextFileAtomic } from '../utils/atomic-write.js';
import { decodeMessageLocator } from '../domain/message-locator.js';
import type { OutgoingAttachment, OutgoingMessage } from '../domain/outgoing-message.js';
import type { SmtpComposedMessage } from '../protocol/smtp.js';
import type { DraftCreationResult, SendDeliveryResult } from './mail.js';
import { validateEmailAddresses, validateRecipients } from '../utils/validation.js';

export interface DraftPort {
  folder(): Promise<string>;
  read(locator: string): Promise<Buffer>;
  search(messageId: string): Promise<string[]>;
  append(raw: Buffer): Promise<DraftCreationResult>;
  trash(locator: string): Promise<void>;
  compose(message: OutgoingMessage): Promise<SmtpComposedMessage>;
  send(message: OutgoingMessage, raw: SmtpComposedMessage): Promise<SendDeliveryResult>;
  verify(raw: Buffer, messageId: string, since: Date): Promise<{ folder: string; uid: number } | undefined>;
}
interface DraftPending {
  locator?: string;
  original: string;
  hash: string;
}
interface DraftSendResult extends SendDeliveryResult {
  [key: string]: unknown;
  draftId: string;
  locator: string;
  draftCleanup: 'retained' | 'moved_to_trash' | 'retained_cleanup_failed';
}
interface DraftPendingSendResult {
  [key: string]: unknown;
  draftId: string;
  locator: string;
  messageId: string;
  status: 'smtp_outcome_unknown';
  smtpAccepted: null;
  retrySafe: false;
  draftCleanup: 'retained';
  nextAction: string;
}
interface DraftAttempt {
  status: 'sending' | 'complete';
  result?: DraftSendResult | DraftPendingSendResult;
}
interface DraftRecord {
  draftId: string;
  locator: string;
  aliases: string[];
  messageIds: string[];
  pending?: DraftPending;
  attempt?: DraftAttempt;
}
interface DraftState { records: DraftRecord[] }
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

const draftPendingSchema = z.object({
  locator: z.string().min(1).optional(),
  original: z.string().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/i),
}).strict();
const draftPendingSendResultSchema = z.object({
  draftId: z.string().min(1),
  locator: z.string().min(1),
  messageId: z.string().min(1),
  status: z.literal('smtp_outcome_unknown'),
  smtpAccepted: z.null(),
  retrySafe: z.literal(false),
  draftCleanup: z.literal('retained'),
  nextAction: z.string().min(1),
}).strict();
const draftSendResultSchema = z.object({
  draftId: z.string().min(1),
  locator: z.string().min(1),
  status: z.enum([
    'sent_and_saved',
    'partially_sent_and_saved',
    'smtp_accepted_sent_not_confirmed',
    'smtp_partially_accepted_sent_not_confirmed',
    'smtp_rejected',
    'smtp_connection_failed',
    'smtp_outcome_unknown',
    'sent_provider_managed',
    'partially_sent_provider_managed',
    'sent_without_saved_copy',
    'partially_sent_without_saved_copy',
  ]),
  smtpAccepted: z.union([z.boolean(), z.null()]),
  accepted: z.array(z.string()),
  rejected: z.array(z.string()),
  messageId: z.string().optional(),
  sentFolder: z.string().optional(),
  sentFolderSaved: z.boolean(),
  sentFolderUid: z.number().int().nonnegative().optional(),
  retrySafe: z.boolean(),
  nextAction: z.string().min(1),
  warning: z.string().optional(),
  error: z.string().optional(),
  draftCleanup: z.enum(['retained', 'moved_to_trash', 'retained_cleanup_failed']),
}).strict();
const draftAttemptSchema = z.union([
  z.object({ status: z.literal('sending'), result: draftPendingSendResultSchema.optional() }).strict(),
  z.object({ status: z.literal('complete'), result: draftSendResultSchema }).strict(),
]);
const draftRecordSchema = z.object({
  draftId: z.string().min(1),
  locator: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  messageIds: z.array(z.string().min(1)),
  pending: draftPendingSchema.optional(),
  attempt: draftAttemptSchema.optional(),
}).strict();
const draftStateSchema = z.object({ records: z.array(draftRecordSchema) }).strict();

function parseDraftState(value: unknown): DraftState {
  const parsed = draftStateSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid draft state; refusing to send');

  const ids = new Set<string>();
  const locators = new Map<string, string>();
  for (const record of parsed.data.records) {
    if (ids.has(record.draftId) || new Set(record.aliases).size !== record.aliases.length ||
      new Set(record.messageIds).size !== record.messageIds.length || !record.aliases.includes(record.locator)) {
      throw new Error('Invalid draft state; refusing to send');
    }
    if (record.pending && record.attempt) throw new Error('Invalid draft state; refusing to send');
    if (record.pending && !record.aliases.includes(record.pending.original) && record.pending.original !== record.locator) {
      throw new Error('Invalid draft state; refusing to send');
    }
    if (record.attempt?.result &&
      (record.attempt.result.draftId !== record.draftId || record.attempt.result.locator !== record.locator)) {
      throw new Error('Invalid draft state; refusing to send');
    }
    ids.add(record.draftId);
    for (const locator of record.aliases) {
      const owner = locators.get(locator);
      if (owner && owner !== record.draftId) throw new Error('Invalid draft state; refusing to send');
      locators.set(locator, record.draftId);
    }
  }
  return parsed.data as DraftState;
}

export interface DraftChanges {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  attachments?: OutgoingAttachment[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOutgoingAttachment(value: unknown): value is OutgoingAttachment {
  if (!isRecord(value)) return false;
  if ('path' in value) {
    return typeof value.path === 'string' && optionalString(value.filename) &&
      optionalString(value.contentType) && optionalString(value.contentDisposition) && optionalString(value.cid);
  }
  return typeof value.filename === 'string' && typeof value.contentBase64 === 'string' &&
    optionalString(value.contentType) && optionalString(value.contentDisposition) && optionalString(value.cid);
}

function parseDraftChanges(value: unknown): DraftChanges {
  if (!isRecord(value) || Object.keys(value).length === 0) throw new Error('Draft changes must be a non-empty object');
  const allowed = new Set(['to', 'cc', 'bcc', 'subject', 'textBody', 'htmlBody', 'attachments']);
  const changes: DraftChanges = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error('Unsupported draft change');
    if (key === 'attachments') {
      if (!Array.isArray(item) || !item.every(isOutgoingAttachment)) throw new Error('Invalid attachments');
      changes.attachments = item;
    } else {
      if (typeof item !== 'string') throw new Error(`Invalid ${key}`);
      changes[key as Exclude<keyof DraftChanges, 'attachments'>] = item;
    }
  }
  return changes;
}

/** Account-wide disk lock also serializes adoption of locators across processes. */
export class DraftStore {
  private file: string;
  constructor(accountId: string, root = join(dirname(ACCOUNTS_PATH), 'draft-state')) {
    this.file = join(root, digest(accountId) + '.json');
  }
  async run<T>(work: (state: DraftState, save: () => Promise<void>) => Promise<T>): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true });
    const lock = this.file + '.lock';
    let acquired = false;
    for (let i = 0; i < 2; i++) {
      let fd: Awaited<ReturnType<typeof open>> | undefined;
      let created = false;
      try {
        fd = await open(lock, 'wx', 0o600);
        created = true;
        await fd.writeFile(String(process.pid));
        await fd.close();
        fd = undefined;
        acquired = true;
        break;
      } catch (e) {
        await fd?.close().catch(() => undefined);
        if (created) await rm(lock, { force: true }).catch(() => undefined);
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const pid = Number(await readFile(lock, 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('Draft lock requires manual inspection');
        try { process.kill(pid, 0); throw new Error('Draft operation busy; retry later'); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
        }
        // Never race another process reclaiming a stale lock. Inspection is explicit.
        throw new Error('Stale draft lock; inspect persisted delivery state before removing the lock');
      }
    }
    if (!acquired) throw new Error('Draft operation busy');
    try {
      let state: DraftState = { records: [] };
      try {
        const raw = await readFile(this.file, 'utf8');
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch { throw new Error('Invalid draft state; refusing to send'); }
        state = parseDraftState(parsed);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      return await work(state, () => writeTextFileAtomic(this.file, JSON.stringify(state, null, 2)));
    } finally { await rm(lock, { force: true }); }
  }
}

function addresses(value: AddressObject | AddressObject[] | undefined): string {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap(v => v.value).map(v => v.address).filter(Boolean).join(', ');
}
function displayAddresses(value: AddressObject | AddressObject[] | undefined): string {
  return (Array.isArray(value) ? value : value ? [value] : []).map(v => v.text).join(', ');
}
export function parsedMessage(p: ParsedMail): OutgoingMessage {
  return {
    to: displayAddresses(p.to), cc: displayAddresses(p.cc), bcc: displayAddresses(p.bcc),
    from: displayAddresses(p.from), replyTo: displayAddresses(p.replyTo), subject: p.subject ?? '',
    text: p.text ?? '', ...(p.html ? { html: p.html } : {}),
    threading: { inReplyTo: p.inReplyTo, references: p.references },
    attachments: p.attachments.map(a => ({ filename: a.filename ?? 'attachment',
      contentBase64: a.content.toString('base64'), contentType: a.contentType,
      contentDisposition: a.contentDisposition === 'inline' ? 'inline' : 'attachment',
      ...(a.contentId ? { cid: a.contentId } : {}) })),
  };
}
const parse = (raw: Buffer) => simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });

interface RawHeaderField {
  name: string;
  raw: string;
}

const singletonHeaders = new Set([
  'from', 'to', 'cc', 'bcc', 'reply-to', 'sender', 'subject', 'message-id', 'date',
  'in-reply-to', 'references', 'resent-from', 'resent-to', 'resent-cc', 'resent-bcc',
  'resent-date', 'resent-message-id', 'content-type', 'mime-version',
  'content-transfer-encoding', 'content-disposition', 'content-id', 'content-description',
  'content-location', 'content-base', 'content-md5', 'content-language',
]);
const rebuiltHeaders = new Set([
  ...singletonHeaders,
  'return-path', 'received', 'authentication-results', 'dkim-signature',
]);

function topLevelHeaders(raw: Buffer): { fields: RawHeaderField[]; bodyOffset: number; separator: string } {
  let separator = '\r\n\r\n';
  let at = raw.indexOf(separator);
  if (at < 0) {
    separator = '\n\n';
    at = raw.indexOf(separator);
  }
  if (at < 0) throw new Error('Malformed MIME headers');

  const lines = raw.subarray(0, at).toString('latin1').split(/\r?\n/);
  const fields: RawHeaderField[] = [];
  let current: RawHeaderField | undefined;
  for (const line of lines) {
    if (line.includes('\r')) throw new Error('Malformed MIME headers');
    if (/^[ \t]/.test(line)) {
      if (!current) throw new Error('Malformed MIME headers');
      current.raw += `\r\n${line}`;
      continue;
    }
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon) : '';
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error('Malformed MIME headers');
    if (current) fields.push(current);
    current = { name: name.toLowerCase(), raw: line };
  }
  if (current) fields.push(current);
  return { fields, bodyOffset: at + separator.length, separator };
}

function validateRawHeaders(raw: Buffer): RawHeaderField[] {
  const fields = topLevelHeaders(raw).fields;
  const seen = new Set<string>();
  for (const field of fields) {
    if (!singletonHeaders.has(field.name)) continue;
    if (seen.has(field.name)) throw new Error(`Duplicate ${field.name} header`);
    seen.add(field.name);
  }
  return fields;
}

function validateParsedRouting(message: OutgoingMessage, fields: RawHeaderField[], parsed: ParsedMail): void {
  validateEmailAddresses(message.to, message.cc, message.bcc, addresses(parsed.from), addresses(parsed.replyTo));
  const values = new Set(fields.map(field => field.name));
  for (const [name, value] of [['from', message.from], ['to', message.to], ['cc', message.cc], ['bcc', message.bcc], ['reply-to', message.replyTo]] as const) {
    if (values.has(name) && !value?.trim()) throw new Error(`Malformed ${name} header`);
  }
  if (values.has('from') && parsed.from?.value.length !== 1) throw new Error('From header must contain exactly one address');
  if (values.has('reply-to') && (!parsed.replyTo || parsed.replyTo.value.length === 0)) throw new Error('Malformed reply-to header');
}

/** Carry non-MIME metadata into a recomposed body/attachment revision. */
function preserveCustomHeaders(original: Buffer, replacement: Buffer): Buffer {
  const source = topLevelHeaders(original).fields.filter(field => !rebuiltHeaders.has(field.name));
  if (source.length === 0) return replacement;
  const next = topLevelHeaders(replacement);
  const headers = [...next.fields.map(field => field.raw), ...source.map(field => field.raw)];
  return Buffer.concat([
    Buffer.from(headers.join('\r\n') + '\r\n\r\n', 'latin1'),
    replacement.subarray(next.bodyOffset),
  ]);
}

/** Replace only named top-level fields; MIME body bytes remain untouched. */
export function replaceHeaders(raw: Buffer, replacements: Record<string, string | undefined>): Buffer {
  let at = raw.indexOf('\r\n\r\n'); let sep = '\r\n\r\n';
  if (at < 0) { at = raw.indexOf('\n\n'); sep = '\n\n'; }
  if (at < 0) throw new Error('Malformed MIME headers');
  const fields = raw.subarray(0, at).toString('latin1').split(/\r?\n(?=[^ \t])/);
  const wanted = new Map(Object.entries(replacements).map(([k,v]) => [k.toLowerCase(), v]));
  const kept = fields.filter(f => !wanted.has(f.split(':', 1)[0].toLowerCase()));
  for (const [key, value] of Object.entries(replacements)) {
    if (value !== undefined) kept.push(`${key}: ${value}`);
  }
  return Buffer.concat([Buffer.from(kept.join('\r\n') + '\r\n\r\n', 'latin1'), raw.subarray(at + sep.length)]);
}
function header(raw: Buffer, name: string): string | undefined {
  const block = raw.toString('latin1').split(/\r?\n\r?\n/, 1)[0];
  return block.split(/\r?\n(?=[^ \t])/).find(f => f.toLowerCase().startsWith(name.toLowerCase() + ':'))?.slice(name.length + 1).trim();
}
export async function contentFingerprint(raw: Buffer, includeBcc = false): Promise<string> {
  const p = await parse(raw);
  return digest(JSON.stringify({ to: addresses(p.to), cc: addresses(p.cc), ...(includeBcc ? { bcc: addresses(p.bcc) } : {}), subject: p.subject ?? '',
    text: p.text ?? '', html: p.html || '', inReplyTo: p.inReplyTo, references: p.references,
    attachments: p.attachments.map(a => [a.filename, a.contentType, a.contentId, digest(a.content)]) }));
}

export async function matchesSentDraft(candidate: Buffer, messageId: string, since: Date, expected: string): Promise<boolean> {
  const p = await parse(candidate);
  const actual = p.messageId ?? '';
  const core = messageId.replace(/^<|>$/g, '');
  const idMatches = actual === messageId || (actual.endsWith('+' + core + '>') && /^<[A-Za-z0-9]+\+/.test(actual));
  return idMatches && p.date !== undefined && Math.abs(p.date.getTime() - since.getTime()) < 600000
    && await contentFingerprint(candidate) === expected;
}

export class DraftWorkflow {
  constructor(private account: EmailAccount, private port: DraftPort, private store = new DraftStore(account.id)) {}

  private addAlias(record: DraftRecord, locator: string): void {
    if (!record.aliases.includes(locator)) record.aliases.push(locator);
  }

  async adopt(locator: string, messageId?: string): Promise<string> {
    return this.store.run(async (state, save) => {
      let r = state.records.find(r => r.locator === locator || r.aliases.includes(locator));
      if (!r) {
        r = { draftId: randomUUID(), locator, aliases: [locator], messageIds: messageId ? [messageId] : [] };
        state.records.push(r); await save();
      }
      return r.draftId;
    });
  }

  private async resolve(r: DraftRecord): Promise<Buffer> {
    const expected = await this.port.folder();
    const identity = decodeMessageLocator(r.locator);
    if (identity.accountId !== this.account.id || identity.mailbox !== expected) throw new Error('Target is not an account draft');
    let current: Buffer | undefined;
    try { current = await this.port.read(r.locator); } catch { /* Search retained identifiers, never a subject. */ }
    if (current) {
      const id = (await parse(current)).messageId;
      if (id && new Set(await this.port.search(id)).size > 1) throw new Error('Draft identity ambiguous; select the current draft again');
      return current;
    }
    const matches = new Set<string>();
    for (const id of r.messageIds) for (const locator of await this.port.search(id)) matches.add(locator);
    if (matches.size !== 1) throw new Error('Draft missing or ambiguous; select the current draft again');
    r.locator = [...matches][0]; this.addAlias(r, r.locator);
    return this.port.read(r.locator);
  }

  private async operate(
    target: unknown,
    operation: 'update' | 'send',
    action: (r: DraftRecord, raw: Buffer, save: () => Promise<void>) => Promise<Record<string, unknown>>,
  ) {
    return this.store.run(async (state, save) => {
      if (typeof target !== 'string' || target.length === 0 || target.trim() !== target) {
        throw new Error('Draft target must be a non-empty string');
      }
      let r = state.records.find(r => r.draftId === target || r.locator === target || r.aliases.includes(target));
      if (r?.attempt) {
        if (operation === 'update') {
          throw new Error(r.attempt.status === 'complete'
            ? 'Draft has a recorded delivery attempt; inspect delivery before updating'
            : 'Draft send outcome is unknown; inspect delivery before updating');
        }
        return r.attempt.result ?? {
          draftId: r.draftId,
          locator: r.locator,
          status: 'smtp_outcome_unknown',
          smtpAccepted: null,
          retrySafe: false,
          draftCleanup: 'retained',
          nextAction: 'Inspect delivery; an interrupted send must not be repeated.',
        };
      }
      if (!r) {
        if (!target.startsWith('imap:v1:')) throw new Error('Unknown draftId');
        const identity = decodeMessageLocator(target);
        if (identity.accountId !== this.account.id || identity.mailbox !== await this.port.folder()) throw new Error('Target is not an account draft');
        const raw = await this.port.read(target);
        const p = await parse(raw);
        // Re-adoption of a web replacement must not bypass a previous send record.
        const related = state.records.filter(x => p.messageId && x.messageIds.includes(p.messageId));
        if (related.length > 1) throw new Error('Ambiguous draft identity');
        r = related[0];
        if (r?.attempt) {
          if (operation === 'update') {
            throw new Error(r.attempt.status === 'complete'
              ? 'Draft has a recorded delivery attempt; inspect delivery before updating'
              : 'Draft send outcome is unknown; inspect delivery before updating');
          }
          return r.attempt.result ?? {
            draftId: r.draftId,
            locator: r.locator,
            status: 'smtp_outcome_unknown',
            smtpAccepted: null,
            retrySafe: false,
            draftCleanup: 'retained',
            nextAction: 'Inspect delivery; an interrupted send must not be repeated.',
          };
        }
        if (r) { r.locator = target; this.addAlias(r, target); }
        else { r = { draftId: randomUUID(), locator: target, aliases: [target], messageIds: p.messageId ? [p.messageId] : [] }; state.records.push(r); }
      }
      if (r.pending) throw new Error('Draft replacement pending cleanup; inspect both versions before continuing');
      const raw = await this.resolve(r);
      const p = await parse(raw);
      if (p.messageId && !r.messageIds.includes(p.messageId)) r.messageIds.push(p.messageId);
      await save();
      return action(r, raw, save);
    });
  }

  async update(target: unknown, changes: unknown) {
    const parsedChanges = parseDraftChanges(changes);
    return this.operate(target, 'update', async (r, raw, save) => {
      const fields = validateRawHeaders(raw);
      const p = await parse(raw); const message = parsedMessage(p);
      validateParsedRouting(message, fields, p);
      for (const key of ['to','cc','bcc','subject'] as const) {
        if (key in parsedChanges) message[key] = parsedChanges[key] as string;
      }
      validateEmailAddresses(message.to, message.cc, message.bcc);
      validateRecipients([message.to, message.cc, message.bcc], this.account.allowedRecipients ?? [], this.account.id);
      const bodyChanged = 'textBody' in parsedChanges || 'htmlBody' in parsedChanges;
      if (bodyChanged) {
        delete message.text; delete message.html;
        if ('textBody' in parsedChanges) message.text = parsedChanges.textBody as string;
        if ('htmlBody' in parsedChanges) message.html = parsedChanges.htmlBody as string;
      }
      if ('attachments' in parsedChanges) message.attachments = parsedChanges.attachments;
      let replacement = (await this.port.compose(message)).rawMessage;
      if (!bodyChanged && !('attachments' in parsedChanges)) {
        const fields: Record<string,string|undefined> = {};
        for (const key of ['to','cc','bcc','subject']) if (key in parsedChanges) fields[key] = header(replacement, key);
        replacement = replaceHeaders(raw, fields);
      }
      const replacementMessageId = p.messageId ?? `<${randomUUID()}@${this.account.user.split('@')[1]}>`;
      // Keep threading and the original ID to support web-client UID replacement.
      if (bodyChanged || 'attachments' in parsedChanges) replacement = preserveCustomHeaders(raw, replacement);
      replacement = replaceHeaders(replacement, { 'Message-ID': replacementMessageId });
      if (digest(await this.port.read(r.locator)) !== digest(raw)) throw new Error('Draft changed concurrently');
      if (!r.messageIds.includes(replacementMessageId)) r.messageIds.push(replacementMessageId);
      r.pending = { original: r.locator, hash: digest(raw) };
      await save();
      const next = await this.port.append(replacement);
      if (!next.locator) throw new Error('Replacement saved but locator unavailable; inspect Drafts');
      r.pending.locator = next.locator;
      await save();
      if (await contentFingerprint(await this.port.read(next.locator), true) !== await contentFingerprint(replacement, true)) throw new Error('Replacement verification failed; both drafts retained');
      if (digest(await this.port.read(r.locator)) !== digest(raw)) throw new Error('Draft changed concurrently; both drafts retained');
      await this.port.trash(r.locator);
      r.locator = next.locator; this.addAlias(r, next.locator); delete r.pending; await save();
      return { ...next, draftId: r.draftId, status: 'draft_updated' };
    });
  }

  async send(target: unknown) {
    return this.operate(target, 'send', async (r, raw, save) => {
      const fields = validateRawHeaders(raw);
      const parsed = await parse(raw); const message = parsedMessage(parsed);
      validateParsedRouting(message, fields, parsed);
      validateRecipients([message.to, message.cc, message.bcc], this.account.allowedRecipients ?? [], this.account.id);
      if (![message.to, message.cc, message.bcc].some(v => v?.trim())) throw new Error('Draft has no recipients');
      const composed = await this.port.compose(message); // Validate recipients, sender, attachments and envelope.
      const messageId = `<${randomUUID()}@${this.account.user.split('@')[1]}>`;
      const prepared = replaceHeaders(raw, { 'From': header(composed.rawMessage, 'from') ?? this.account.user,
        'Date': new Date().toUTCString(), 'Message-ID': messageId,
        'Bcc': undefined, 'Sender': undefined,
        'Resent-From': undefined, 'Resent-To': undefined, 'Resent-Cc': undefined,
        'Resent-Bcc': undefined, 'Resent-Date': undefined, 'Resent-Message-ID': undefined,
        'DKIM-Signature': undefined });
      if (digest(await this.port.read(r.locator)) !== digest(raw)) throw new Error('Draft changed during send preparation; retry against the latest draft');
      r.attempt = { status: 'sending', result: { draftId: r.draftId, locator: r.locator, messageId,
        status: 'smtp_outcome_unknown', smtpAccepted: null, retrySafe: false, draftCleanup: 'retained',
        nextAction: 'Inspect delivery using messageId; an interrupted send must not be repeated.' } }; await save();
      let result: SendDeliveryResult;
      const since = new Date();
      try { result = await this.port.send(message, { rawMessage: prepared, messageId, envelope: composed.envelope }); }
      catch { result = { status: 'smtp_outcome_unknown', smtpAccepted: null, accepted: [], rejected: [], messageId, sentFolderSaved: false, retrySafe: false, nextAction: 'Inspect delivery; do not resend automatically.' }; }
      const output: DraftSendResult = { ...result, draftId: r.draftId, locator: r.locator, draftCleanup: 'retained' };
      r.attempt = { status: 'complete', result: output }; await save();
      const accepted = new Set(result.accepted.map(address => address.toLowerCase()));
      const recipients = composed.envelope.to;
      const fullyAccepted = result.smtpAccepted && !result.rejected.length
        && Array.isArray(recipients) && recipients.length > 0
        && recipients.every(address => typeof address === 'string' && accepted.has(address.toLowerCase()));
      if (result.smtpAccepted && !fullyAccepted) output.warning = 'Not all envelope recipients were confirmed accepted; retain the draft and do not resend accepted recipients.';
      if (fullyAccepted) {
        if (!result.sentFolderSaved) {
          try {
            const match = await this.port.verify(prepared, messageId, since);
            if (match) Object.assign(output, { sentFolderSaved: true, sentFolder: match.folder, sentFolderUid: match.uid, status: 'sent_and_saved' });
          } catch { /* Delivery stays accepted; verification is not a resend trigger. */ }
        }
        if (output.sentFolderSaved) {
          try {
            if (digest(await this.port.read(r.locator)) !== digest(raw)) throw new Error('Draft changed after SMTP');
            await this.port.trash(r.locator); output.draftCleanup = 'moved_to_trash';
          } catch { output.draftCleanup = 'retained_cleanup_failed'; }
        }
      }
      // Only connection failure is known to precede a delivery attempt.
      if (result.status === 'smtp_connection_failed') delete r.attempt;
      await save(); return output;
    });
  }
}
