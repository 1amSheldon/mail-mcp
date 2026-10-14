import { parseMime, addresses } from './compose.js';
import { ZimbraError } from './session.js';
import { ZimbraSendJournal, sendStatus } from './send-journal.js';
import { validateEmailAddresses } from '../../utils/validation.js';

type Obj = Record<string, unknown>;
interface DraftIO {
  read(id: string): Promise<Obj>;
  raw(id: string): Promise<Buffer>;
  upload(raw: Buffer): Promise<string>;
  save(params: Obj, revision: string): Promise<Obj>;
}
function scheduleTime(draft: Obj): number {
  const value = draft.autoSendTime === undefined ? 0 : Number(draft.autoSendTime);
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new ZimbraError('PROVIDER_ERROR', 'Invalid scheduled delivery metadata.');
  return value;
}
export class ZimbraScheduledDrafts {
  constructor(private readonly io: DraftIO, private readonly journal: ZimbraSendJournal, private readonly restricted: boolean) {}
  async read(draftId: string): Promise<unknown> {
    const draft = await this.io.read(draftId);
    const time = scheduleTime(draft);
    const record = await this.journal.read(draftId);
    return { draftId, status: time ? 'schedule_metadata_present' : 'no_schedule_metadata', sendAt: time ? new Date(time).toISOString() : null,
      revision: String(draft.ms ?? ''), localAttempt: record ? sendStatus(record) : null,
      warning: 'This reads draft metadata, not the scheduler queue. The worker sends the then-current MIME and deletes the draft. Missing metadata or a missing draft does not prove non-delivery. Verify Sent separately.' };
  }
  async write(v: { draftId: string; expectedRevision: string; sendAt?: string }): Promise<unknown> {
    const scheduling = v.sendAt !== undefined;
    if (scheduling && this.restricted) throw new ZimbraError('ACCESS_DENIED', 'Native scheduled delivery uses a mutable server draft; allowedRecipients cannot be enforced against later webmail edits.');
    const previous = await this.journal.read(v.draftId);
    if (scheduling && previous) return { ...sendStatus(previous), replayed: true };
    if (!scheduling && previous && !previous.action) throw new ZimbraError('CONFLICT', 'A manual-send claim exists. Reconcile the send outcome before changing this draft.');
    const source = await this.io.read(v.draftId);
    if (String(source.ms) !== v.expectedRevision) throw new ZimbraError('CONFLICT', 'The draft differs from the reviewed revision. Read it again.');
    const existing = scheduleTime(source);
    if (scheduling && existing) throw new ZimbraError('CONFLICT', 'The draft is already scheduled. Inspect or cancel the existing schedule first.');
    if (!scheduling && !existing) return { draftId: v.draftId, status: 'no_schedule_metadata', retrySafe: false, warning: 'No schedule metadata is not proof that a worker has not already sent the message.' };
    const target = scheduling ? Date.parse(v.sendAt!) : 0;
    if (scheduling && (!Number.isFinite(target) || target < Date.now() + 60000)) throw new ZimbraError('INVALID_INPUT', 'Schedule at least one minute in the future.');
    const raw = await this.io.raw(v.draftId);
    const parsed = await parseMime(raw);
    if (scheduling) {
      for (const key of ['to', 'cc', 'bcc', 'from']) if (parsed.headerLines.filter(h => h.key.toLowerCase() === key).length > 1) throw new ZimbraError('INVALID_INPUT', 'Duplicate address headers make the scheduled draft ambiguous.');
      if (parsed.headerLines.some(h => /^resent-/i.test(h.key))) throw new ZimbraError('INVALID_INPUT', 'Resent headers require an explicit resend workflow.');
      const to = [parsed.to, parsed.cc, parsed.bcc].flatMap(addresses);
      if (!to.length || to.some(a => !a)) throw new ZimbraError('INVALID_INPUT', 'Draft recipients are missing or invalid.');
      try { validateEmailAddresses(...to); } catch { throw new ZimbraError('INVALID_INPUT', 'Draft contains invalid recipients.'); }
    }
    const current = await this.io.read(v.draftId);
    if (String(current.ms) !== v.expectedRevision || scheduleTime(current) !== existing) throw new ZimbraError('CONFLICT', 'The draft changed while its MIME was downloaded.');
    const aid = await this.io.upload(raw);
    if (scheduling && target < Date.now() + 60000) throw new ZimbraError('INVALID_INPUT', 'The selected send time is now too close. No schedule was submitted.');
    const record = previous ?? await this.journal.begin(v.draftId, raw, parsed.messageId, { action: scheduling ? 'schedule' : 'cancel_schedule', ...(scheduling ? { scheduledFor: v.sendAt } : {}) });
    if (previous) {
      record.action = 'cancel_schedule'; record.status = 'outcome_unknown';
      await this.journal.save(record);
    }
    try {
      await this.io.save({ m: { id: v.draftId, aid, autoSendTime: target,
        ...(source.idnt ? { idnt: source.idnt } : {}), ...(source.origid ? { origid: source.origid, rt: source.rt } : {}),
        ...(source.f ? { f: source.f } : {}), ...(source.tn ? { tn: source.tn } : {}) } }, v.expectedRevision);
      const verified = await this.io.read(v.draftId);
      if (scheduleTime(verified) !== target) throw new ZimbraError('OUTCOME_UNKNOWN', 'Schedule metadata did not match after the write. Inspect the draft and Sent.');
      record.status = scheduling ? 'schedule_saved' : 'schedule_cleared';
      await this.journal.save(record);
      return { ...sendStatus(record), observedRevision: String(verified.ms ?? ''), warning: scheduling
        ? 'Schedule metadata was saved and read back. The server sends the then-current draft, including later edits. This is not queue or delivery verification.'
        : 'Schedule metadata was cleared and read back. A worker may already have loaded the draft; this does not guarantee non-delivery.' };
    } catch {
      record.status = 'outcome_unknown';
      await this.journal.save(record);
      throw new ZimbraError('OUTCOME_UNKNOWN', 'Schedule write or verification was uncertain. Inspect getScheduledDraft, getSendStatus and Sent; do not retry automatically.');
    }
  }
}
