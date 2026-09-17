import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { ACCOUNTS_PATH, type EmailAccount } from '../config.js';
import { writeTextFileAtomic } from '../utils/atomic-write.js';
import { decodeMessageLocator } from '../domain/message-locator.js';
import type { OutgoingMessage } from '../domain/outgoing-message.js';
import type { SmtpComposedMessage } from '../protocol/smtp.js';
import type { DraftCreationResult, SendDeliveryResult } from './mail.js';
import { validateEmailAddresses } from '../utils/validation.js';

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
interface DraftRecord {
  draftId: string;
  locator: string;
  aliases: string[];
  messageIds: string[];
  pending?: { locator: string; original: string; hash: string };
  attempt?: { status: 'sending' | 'complete'; result?: Record<string, unknown> };
}
interface DraftState { records: DraftRecord[] }
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

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
      try {
        const fd = await open(lock, 'wx', 0o600);
        await fd.writeFile(String(process.pid));
        await fd.close(); acquired = true; break;
      } catch (e) {
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
      try { state = JSON.parse(await readFile(this.file, 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (!Array.isArray(state.records)) throw new Error('Invalid draft state; refusing to send');
      return await work(state, () => writeTextFileAtomic(this.file, JSON.stringify(state, null, 2)));
    } finally { await rm(lock); }
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
    r.locator = [...matches][0]; r.aliases.push(r.locator);
    return this.port.read(r.locator);
  }

  private async operate(target: string, action: (r: DraftRecord, raw: Buffer, save: () => Promise<void>) => Promise<Record<string, unknown>>) {
    return this.store.run(async (state, save) => {
      let r = state.records.find(r => r.draftId === target || r.locator === target || r.aliases.includes(target));
      if (r?.attempt) return r.attempt.result ?? { draftId: r.draftId, status: 'smtp_outcome_unknown', retrySafe: false, nextAction: 'Inspect delivery; an interrupted send must not be repeated.' };
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
        if (r?.attempt) return r.attempt.result ?? { draftId: r.draftId, status: 'smtp_outcome_unknown', retrySafe: false };
        if (r) { r.locator = target; r.aliases.push(target); }
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

  async update(target: string, changes: Record<string, unknown>) {
    return this.operate(target, async (r, raw, save) => {
      const allowed = ['to','cc','bcc','subject','textBody','htmlBody','attachments'];
      if (Object.keys(changes).some(k => !allowed.includes(k))) throw new Error('Unsupported draft change');
      for (const [key, value] of Object.entries(changes)) {
        if (key === 'attachments' ? !Array.isArray(value) : typeof value !== 'string') throw new Error(`Invalid ${key}`);
      }
      const p = await parse(raw); const message = parsedMessage(p);
      for (const key of ['to','cc','bcc','subject'] as const) if (key in changes) message[key] = changes[key] as string;
      validateEmailAddresses(message.to, message.cc, message.bcc);
      const bodyChanged = 'textBody' in changes || 'htmlBody' in changes;
      if (bodyChanged) {
        delete message.text; delete message.html;
        if ('textBody' in changes) message.text = changes.textBody as string;
        if ('htmlBody' in changes) message.html = changes.htmlBody as string;
      }
      if ('attachments' in changes) message.attachments = changes.attachments as OutgoingMessage['attachments'];
      let replacement = (await this.port.compose(message)).rawMessage;
      if (!bodyChanged && !('attachments' in changes)) {
        const fields: Record<string,string|undefined> = {};
        for (const key of ['to','cc','bcc','subject']) if (key in changes) fields[key] = header(replacement, key);
        replacement = replaceHeaders(raw, fields);
      }
      // Keep threading and the original ID to support web-client UID replacement.
      replacement = replaceHeaders(replacement, { 'Message-ID': p.messageId ?? `<${randomUUID()}@${this.account.user.split('@')[1]}>` });
      if (digest(await this.port.read(r.locator)) !== digest(raw)) throw new Error('Draft changed concurrently');
      const next = await this.port.append(replacement);
      if (!next.locator) throw new Error('Replacement saved but locator unavailable; inspect Drafts');
      r.pending = { locator: next.locator, original: r.locator, hash: digest(raw) }; await save();
      if (await contentFingerprint(await this.port.read(next.locator), true) !== await contentFingerprint(replacement, true)) throw new Error('Replacement verification failed; both drafts retained');
      if (digest(await this.port.read(r.locator)) !== digest(raw)) throw new Error('Draft changed concurrently; both drafts retained');
      await this.port.trash(r.locator);
      r.locator = next.locator; r.aliases.push(next.locator); delete r.pending; await save();
      return { ...next, draftId: r.draftId, status: 'draft_updated' };
    });
  }

  async send(target: string) {
    return this.operate(target, async (r, raw, save) => {
      const parsed = await parse(raw); const message = parsedMessage(parsed);
      validateEmailAddresses(message.to, message.cc, message.bcc);
      if (![message.to, message.cc, message.bcc].some(v => v?.trim())) throw new Error('Draft has no recipients');
      const composed = await this.port.compose(message); // Validate recipients, sender, attachments and envelope.
      const messageId = `<${randomUUID()}@${this.account.user.split('@')[1]}>`;
      const prepared = replaceHeaders(raw, { 'Date': new Date().toUTCString(), 'Message-ID': messageId,
        'Bcc': undefined, 'Resent-Bcc': undefined, 'DKIM-Signature': undefined });
      if (digest(await this.port.read(r.locator)) !== digest(raw)) throw new Error('Draft changed during send preparation; retry against the latest draft');
      r.attempt = { status: 'sending', result: { draftId: r.draftId, locator: r.locator, messageId,
        status: 'smtp_outcome_unknown', smtpAccepted: null, retrySafe: false, draftCleanup: 'retained',
        nextAction: 'Inspect delivery using messageId; an interrupted send must not be repeated.' } }; await save();
      let result: SendDeliveryResult;
      const since = new Date();
      try { result = await this.port.send(message, { rawMessage: prepared, messageId, envelope: composed.envelope }); }
      catch { result = { status: 'smtp_outcome_unknown', smtpAccepted: null, accepted: [], rejected: [], messageId, sentFolderSaved: false, retrySafe: false, nextAction: 'Inspect delivery; do not resend automatically.' }; }
      const output: Record<string, unknown> = { ...result, draftId: r.draftId, locator: r.locator, draftCleanup: 'retained' };
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
      r.attempt.result = output;
      // Only connection failure is known to precede a delivery attempt.
      if (result.status === 'smtp_connection_failed') delete r.attempt;
      await save(); return output;
    });
  }
}
