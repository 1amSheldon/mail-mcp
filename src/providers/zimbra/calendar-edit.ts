import { z } from 'zod';
import { parseMime } from './compose.js';
import { CALENDAR_WRITE_SCHEMAS, calendarEdit, calendarTime, compareTimes, sameTimeBasis, nativeAlarms, nativeRecurrence, nativeTime, type CalendarTime } from './calendar-schema.js';
import { ZimbraError } from './session.js';
import { noCalendarUploads, type CalendarAttach } from './calendar-attachments.js';
import type { OutgoingAttachment } from '../../domain/outgoing-message.js';

type Obj = Record<string, unknown>;
export const CALENDAR_EDIT_OPERATIONS = ['updateAppointment', 'updateTask', 'createAppointmentException', 'createTaskException', 'cancelAppointment', 'cancelTask', 'replyToInvitation', 'forwardAppointment', 'counterAppointment'] as const;
export type CalendarEditOperation = typeof CALENDAR_EDIT_OPERATIONS[number];
type Request = (name: string, params: Obj, write?: boolean) => Promise<Obj>;
type Guard = z.output<z.ZodObject<typeof calendarEdit>>;
const list = (v: unknown): unknown[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
function obj(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ZimbraError('PROVIDER_ERROR', 'Incomplete calendar item data.');
  return v as Obj;
}
const one = (v: unknown): Obj => obj(list(v)[0]);
const truth = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
function content(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  const part = Array.isArray(v) ? v[0] : v;
  return part && typeof part === 'object' && typeof (part as Obj)._content === 'string' ? (part as Obj)._content as string : undefined;
}
function recipients(comp: Obj): string[] {
  return list(comp.at).map(v => {
    const email = obj(v).a;
    if (!z.email().safeParse(email).success) throw new ZimbraError('PROVIDER_ERROR', 'Cannot establish calendar attendee addresses.');
    return email as string;
  });
}
function parseNativeTime(raw: unknown): CalendarTime | undefined {
  if (raw === undefined) return undefined;
  const v = one(raw); const d = String(v.d ?? '');
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(d);
  if (!m) throw new ZimbraError('PROVIDER_ERROR', 'Unsupported native calendar time; read the item before editing.');
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const at = `${date}T${m[4]}:${m[5]}:${m[6]}`;
  const value = !m[4] ? { type: 'date', date } : m[7] ? { type: 'instant', at: at + 'Z' } : { type: 'local', at, timeZone: v.tz };
  const parsed = calendarTime.safeParse(value);
  if (!parsed.success) throw new ZimbraError('PROVIDER_ERROR', 'Calendar timezone is missing or invalid.');
  return parsed.data;
}
const dayShift = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
function validDuration(value: unknown, start: CalendarTime | undefined): boolean {
  if (value === undefined || !start) return false;
  const duration = one(value);
  if (truth(duration.neg)) return false;
  let seconds = 0;
  for (const [key, scale] of [['w', 604800], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    const n = Number(duration[key] ?? 0);
    if (!Number.isSafeInteger(n) || n < 0 || start.type === 'date' && ['h', 'm', 's'].includes(key) && n !== 0) return false;
    seconds += n * scale;
  }
  return Number.isSafeInteger(seconds);
}
const timeValue = (v: CalendarTime) => Date.parse(v.type === 'date' ? v.date + 'T00:00:00Z' : v.type === 'local' ? v.at + 'Z' : v.at);
function shiftTime(v: CalendarTime, milliseconds: number): CalendarTime {
  const shifted = new Date(timeValue(v) + milliseconds).toISOString();
  if (v.type === 'date') return { type: 'date', date: shifted.slice(0, 10) };
  if (v.type === 'local') return { type: 'local', at: shifted.slice(0, 19), timeZone: v.timeZone };
  return { type: 'instant', at: shifted };
}
interface Snapshot { item: Obj; invite: Obj; comp: Obj; invites: Obj[]; itemId: string }

export class ZimbraCalendarEdits {
  constructor(private readonly request: Request, private readonly raw: (id: string) => Promise<Buffer>, private readonly user: string, private readonly allowed?: readonly string[], private readonly attach: CalendarAttach = noCalendarUploads) {}
  private check(recipients: string[]): void {
    if (this.allowed === undefined) return;
    const allowed = new Set(this.allowed.map(a => a.toLowerCase()));
    if (recipients.some(a => !allowed.has(a.toLowerCase()))) throw new ZimbraError('ACCESS_DENIED', 'A calendar notification recipient is outside allowedRecipients.');
  }
  private async snapshot(v: Guard, task: boolean): Promise<Snapshot> {
    const dash = v.invitationId.lastIndexOf('-');
    const itemId = v.invitationId.slice(0, dash); const inviteId = v.invitationId.slice(dash + 1);
    const result = await this.request(task ? 'GetTask' : 'GetAppointment', { id: itemId, sync: 1, includeInvites: 1, includeContent: 1 });
    const item = one(result[task ? 'task' : 'appt']);
    if (String(item.id) !== itemId || String(item.ms) !== v.expectedModSequence || String(item.rev) !== v.expectedRevision) throw new ZimbraError('CONFLICT', 'Calendar item changed or its conflict versions are unavailable. Read it again before editing.');
    const invites = list(item.inv).map(obj);
    const matching = invites.filter(i => String(i.id) === inviteId && Number(i.compNum ?? one(i.comp).compNum ?? 0) === v.component);
    if (matching.length !== 1 || list(matching[0].comp).length !== 1) throw new ZimbraError('CONFLICT', 'The selected invitation component is no longer available or is ambiguous.');
    return { item, invite: matching[0], comp: one(matching[0].comp), invites, itemId };
  }
  private checkAlarms(comp: Obj): void {
    if (this.allowed === undefined) return;
    for (const alarm of list(comp.alarm).map(obj)) {
      if (alarm.action === 'EMAIL') this.check(recipients(alarm));
      else if (!['DISPLAY', 'AUDIO'].includes(String(alarm.action))) throw new ZimbraError('ACCESS_DENIED', 'Cannot establish recipient policy for this native alarm action.');
    }
  }
  private async message(v: Guard, snapshot: Snapshot, comp: Obj, changes: Obj, to: string[]): Promise<Obj> {
    let plain = content(snapshot.comp.desc); let html = content(snapshot.comp.descHtml);
    let attachmentCount = 0;
    let skipGeneratedCalendar = false;
    if (!truth(snapshot.comp.noBlob)) {
      const bytes = await this.raw(v.invitationId);
      if (/^Content-Type:\s*(?:multipart\/(?:signed|encrypted)|application\/(?:pkcs7-mime|x-pkcs7-mime))/im.test(bytes.toString('latin1'))) throw new ZimbraError('INVALID_INPUT', 'Signed or encrypted calendar MIME cannot be safely rebuilt.');
      const parsed = await parseMime(bytes);
      plain = parsed.text; html = parsed.html || undefined;
      const calendars = parsed.attachments.filter(a => a.contentType.toLowerCase() === 'text/calendar');
      if (calendars.length > 1) throw new ZimbraError('INVALID_INPUT', 'Multiple calendar MIME parts require explicit reconstruction; refusing to drop an attached calendar file.');
      if (calendars.length === 1) {
        const unfolded = calendars[0].content.toString('utf8').replace(/\r?\n[ \t]/g, '');
        const uids = [...unfolded.matchAll(/^UID(?:;[^:\r\n]*)?:(.*)$/gm)].map(m => m[1].replace(/\r$/, ''));
        skipGeneratedCalendar = typeof snapshot.comp.uid === 'string' && uids.length > 0 && uids.every(uid => uid === snapshot.comp.uid);
      }
      attachmentCount = parsed.attachments.length - (skipGeneratedCalendar ? 1 : 0);
    } else if (html && changes.htmlDescription === undefined) {
      throw new ZimbraError('INVALID_INPUT', 'This metadata-only invitation has HTML that may be sanitized by the server. Supply htmlDescription explicitly to edit it without silently substituting content.');
    }
    if (changes.description !== undefined) plain = String(changes.description);
    if (changes.htmlDescription !== undefined) html = String(changes.htmlDescription);
    // Update both MIME and invitation descriptions from the same source.
    if (plain !== undefined) comp.desc = { _content: plain }; else delete comp.desc;
    if (html !== undefined) comp.descHtml = { _content: html }; else delete comp.descHtml;
    const parts: Obj[] = [];
    if (plain !== undefined) parts.push({ ct: 'text/plain', content: { _content: plain } });
    if (html !== undefined) parts.push({ ct: 'text/html', content: { _content: html } });
    if (!parts.length) parts.push({ ct: 'text/plain', content: { _content: '' } });
    const body: Obj = parts.length === 1 ? parts[0] : { ct: 'multipart/alternative', mp: parts };
    const inline: Obj[] = []; const attachments: Obj[] = []; let count = 0;
    const walk = (value: unknown, depth: number): void => {
      if (depth > 16 || count > 1000) throw new ZimbraError('PROVIDER_ERROR', 'Calendar MIME structure exceeds limits.');
      for (const p of list(value).map(obj)) {
        count++;
        const type = String(p.ct ?? '').toLowerCase();
        if (type.startsWith('multipart/')) { walk(p.mp, depth + 1); continue; }
        if (type === 'text/calendar' && skipGeneratedCalendar || (!p.filename && p.cd !== 'attachment' && ['text/plain', 'text/html'].includes(type))) continue;
        if (!/^[1-9][0-9]*(?:\.[1-9][0-9]*)*$/.test(String(p.part))) throw new ZimbraError('PROVIDER_ERROR', 'Cannot preserve a calendar attachment without its native part ID.');
        const ref = { mid: v.invitationId, part: String(p.part) };
        if (p.cd === 'inline' || p.ci) inline.push({ ct: p.ct, ...(p.ci ? { ci: p.ci } : {}), attach: { mp: [ref] } });
        else attachments.push(ref);
      }
    };
    if (changes.attachments === undefined) walk(snapshot.invite.mp, 0);
    if (changes.attachments === undefined && attachmentCount !== inline.length + attachments.length) throw new ZimbraError('PROVIDER_ERROR', 'Calendar MIME attachments do not match the returned part metadata. No update was submitted.');
    const message = { l: snapshot.item.l, e: to.map(a => ({ a, t: 't' })), su: { _content: String(comp.name ?? '') },
      inv: { ...(snapshot.invite.tz ? { tz: snapshot.invite.tz } : {}), comp: [comp] },
      mp: inline.length ? { ct: 'multipart/related', mp: [body, ...inline] } : body,
      ...(attachments.length ? { attach: { mp: attachments } } : {}) };
    return changes.attachments === undefined ? message : this.attach(message, changes.attachments as OutgoingAttachment[]);
  }
  async execute(operation: CalendarEditOperation, input: unknown): Promise<unknown> {
    const v = CALENDAR_WRITE_SCHEMAS[operation].parse(input);
    const task = operation.includes('Task') || operation === 'replyToInvitation' && 'kind' in v && v.kind === 'task';
    const snapshot = await this.snapshot(v, task);
    if (operation === 'forwardAppointment') {
      const input = CALENDAR_WRITE_SCHEMAS.forwardAppointment.parse(v);
      if (this.allowed !== undefined) throw new ZimbraError('ACCESS_DENIED', 'Native forwarding can notify a server-derived organizer without an atomic version guard; it requires an unrestricted account.');
      if (!input.instance && (snapshot.comp.exceptId || snapshot.invite.recurId)) throw new ZimbraError('INVALID_INPUT', 'Select the default invitation to forward the series, or explicitly select the original instance time.');
      return this.request('ForwardAppointment', { id: snapshot.itemId, ...(input.instance ? { exceptId: nativeTime(input.instance) } : {}),
        m: { e: input.to.map(a => ({ a, t: 't' })), su: { _content: String(snapshot.comp.name ?? '') }, mp: { ct: 'text/plain', content: { _content: input.message } } } }, true);
    }
    if (operation === 'counterAppointment') {
      const input = CALENDAR_WRITE_SCHEMAS.counterAppointment.parse(v);
      if (truth(snapshot.comp.isOrg)) throw new ZimbraError('INVALID_INPUT', 'Organizers change their own meeting with updateAppointment; counter proposals are for attendees.');
      const organizer = one(snapshot.comp.or).a;
      if (!z.email().safeParse(organizer).success || typeof snapshot.comp.uid !== 'string' || !snapshot.comp.uid) throw new ZimbraError('PROVIDER_ERROR', 'The invitation lacks an organizer address or UID.');
      this.check([organizer as string]);
      const proposal: Obj = {};
      for (const key of ['uid', 'seq', 'name', 'class', 'priority', 'status', 'loc', 'or', 'exceptId']) if (snapshot.comp[key] !== undefined) proposal[key] = structuredClone(snapshot.comp[key]);
      proposal.s = nativeTime(input.start);
      proposal.e = input.endExclusive.type === 'date' ? nativeTime({ type: 'date', date: dayShift(input.endExclusive.date, -1) }) : nativeTime(input.endExclusive);
      proposal.allDay = input.start.type === 'date' ? 1 : 0;
      proposal.at = [{ a: this.user, ptst: 'TE', role: 'REQ' }];
      if (input.location !== undefined) proposal.loc = input.location;
      if (input.instance) proposal.exceptId = nativeTime(input.instance);
      return this.request('CounterAppointment', { id: input.invitationId, comp: input.component, ms: input.expectedModSequence, rev: input.expectedRevision,
        m: { e: [{ a: organizer, t: 't' }], su: { _content: String(proposal.name ?? '') }, mp: { ct: 'text/plain', content: { _content: input.message } },
          inv: { ...(snapshot.invite.tz ? { tz: snapshot.invite.tz } : {}), comp: [proposal] } } }, true);
    }
    const allAttendees = snapshot.invites.flatMap(i => list(i.comp).flatMap(c => recipients(obj(c))));
    if (operation === 'cancelAppointment' || operation === 'cancelTask') {
      const v = CALENDAR_WRITE_SCHEMAS[operation].parse(input);
      // CancelCalendarItem has no atomic version check and may notify people
      // added to exceptions after preflight. Never promise a restricted send.
      if (this.allowed !== undefined) throw new ZimbraError('ACCESS_DENIED', 'Native cancellation can notify server-derived recipients without an atomic version guard; it requires an unrestricted account.');
      if (!truth(snapshot.comp.isOrg)) throw new ZimbraError('INVALID_INPUT', 'Only the organizer can cancel a meeting. Use replyToInvitation to decline.');
      if (!v.instance && (snapshot.comp.exceptId || snapshot.invite.recurId)) throw new ZimbraError('INVALID_INPUT', 'Series cancellation must select the default invitation. To cancel an exception, supply its original instance time explicitly.');
      return this.request(task ? 'CancelTask' : 'CancelAppointment', { id: v.invitationId, comp: v.component,
        ...(v.instance ? { inst: { ...nativeTime(v.instance), ...(v.range ? { range: v.range } : {}) } } : {}),
        m: { e: recipients(snapshot.comp).filter(a => a.toLowerCase() !== this.user.toLowerCase()).map(a => ({ a, t: 't' })), su: { _content: String(snapshot.comp.name ?? '') }, mp: { ct: 'text/plain', content: { _content: v.message } } },
      }, true);
    }
    if (operation === 'replyToInvitation') {
      const v = CALENDAR_WRITE_SCHEMAS.replyToInvitation.parse(input);
      const organizer = one(snapshot.comp.or).a;
      if (!z.email().safeParse(organizer).success) throw new ZimbraError('PROVIDER_ERROR', 'Organizer address is unavailable.');
      if (v.notifyOrganizer) this.check([organizer as string]);
      return this.request('SendInviteReply', { id: v.invitationId, compNum: v.component, verb: v.response, updateOrganizer: v.notifyOrganizer ? 1 : 0,
        ...(v.instance ? { exceptId: nativeTime(v.instance) } : {}), ...(v.identityId ? { idnt: v.identityId } : {}),
        m: { e: v.notifyOrganizer ? [{ a: organizer, t: 't' }] : [], su: { _content: String(snapshot.comp.name ?? '') }, mp: { ct: 'text/plain', content: { _content: v.message } } },
      }, true);
    }
    const edit = CALENDAR_WRITE_SCHEMAS[operation].parse(input);
    const changes = { ...edit.changes } as Obj;
    const comp = structuredClone(snapshot.comp);
    const exception = operation === 'createAppointmentException' || operation === 'createTaskException';
    if (exception && (!comp.recur || comp.exceptId || snapshot.invite.recurId)) throw new ZimbraError('INVALID_INPUT', 'Create an exception from the default recurring invitation; modify an existing exception directly.');
    if (exception && 'instance' in edit) {
      const originalStart = parseNativeTime(comp.s); let originalEnd = parseNativeTime(comp.e);
      if (!originalStart || !sameTimeBasis(originalStart, edit.instance)) throw new ZimbraError('INVALID_INPUT', 'Exception instance must use the series start date/time basis.');
      if (!task && originalEnd?.type === 'date') originalEnd = { type: 'date', date: dayShift(originalEnd.date, 1) };
      const start = (changes.start ?? edit.instance) as CalendarTime;
      if (changes.start === undefined) changes.start = start;
      const endKey = task ? 'due' : 'endExclusive';
      if (changes[endKey] === undefined && originalEnd) changes[endKey] = shiftTime(start, timeValue(originalEnd) - timeValue(originalStart));
    }
    const scheduleChange = ['start', 'endExclusive', 'due', 'recurrence'].some(k => Object.hasOwn(changes, k));
    if (!exception && scheduleChange && snapshot.invites.some(i => i.recurId || list(i.comp).some(c => obj(c).exceptId)) && !('allowExceptionReset' in edit && edit.allowExceptionReset)) {
      throw new ZimbraError('INVALID_INPUT', 'Changing this series schedule may remove exceptions. Review them and explicitly set allowExceptionReset.');
    }
    if (exception && changes.recurrence !== undefined) throw new ZimbraError('INVALID_INPUT', 'An exception cannot replace the series recurrence.');
    for (const [field, key] of [['subject', 'name'], ['location', 'loc'], ['privacy', 'class'], ['priority', 'priority'], ['status', 'status'], ['freeBusy', 'fb'], ['percentComplete', 'percentComplete'], ['url', 'url']] as const) if (Object.hasOwn(changes, field)) comp[key] = changes[field];
    if (changes.categories !== undefined) comp.category = (changes.categories as string[]).map(_content => ({ _content }));
    if (changes.attendees !== undefined) {
      const previous = new Map(list(comp.at).map(obj).map(a => [String(a.a).toLowerCase(), a]));
      comp.at = edit.changes.attendees!.map(a => ({ ...previous.get(a.email.toLowerCase()), a: a.email, ...(a.name === undefined ? {} : { d: a.name }), role: a.role, cutype: a.type, ptst: previous.get(a.email.toLowerCase())?.ptst ?? 'NE', rsvp: a.rsvp ? 1 : 0 }));
    }
    if (changes.alarms !== undefined) comp.alarm = nativeAlarms(edit.changes.alarms!, String(comp.name ?? ''));
    if (changes.recurrence === null) delete comp.recur;
    else if (edit.changes.recurrence) comp.recur = nativeRecurrence(edit.changes.recurrence);
    for (const [key, source] of [['s', 'start'], ['e', task ? 'due' : 'endExclusive']] as const) {
      if (!Object.hasOwn(changes, source)) continue;
      const value = changes[source] as CalendarTime | null;
      if (key === 'e') delete comp.dur;
      if (value === null) delete comp[key];
      else comp[key] = !task && key === 'e' && value.type === 'date' ? nativeTime({ type: 'date', date: dayShift(value.date, -1) }) : nativeTime(value);
    }
    if (Object.hasOwn(changes, 'completedAt')) {
      if (changes.completedAt === null) delete comp.completed;
      else comp.completed = nativeTime({ type: 'instant', at: String(changes.completedAt) }).d;
    }
    const start = parseNativeTime(comp.s); let end = parseNativeTime(comp.e);
    if (!task && end?.type === 'date') end = { type: 'date', date: dayShift(end.date, 1) };
    // Native invitations may omit both end and duration. Zimbra supplies its
    // effective duration; preserve that form instead of inventing a new end.
    const durationEnd = !end && !!start && (comp.dur === undefined || validDuration(comp.dur, start));
    if ((!task && (!start || !(durationEnd || end && compareTimes(start, end) < 0))) || (task && start && end && !(compareTimes(start, end) <= 0)) || comp.dur !== undefined && !end && !durationEnd) throw new ZimbraError('INVALID_INPUT', 'Edited calendar dates are inconsistent. Supply matching start/end forms and timezones.');
    comp.allDay = start?.type === 'date' || !start && end?.type === 'date' ? 1 : 0;
    if (task && ((comp.status === 'COMP' && Number(comp.percentComplete) !== 100) || (comp.status !== 'COMP' && comp.completed))) throw new ZimbraError('INVALID_INPUT', 'Completed tasks require 100 percent; clear completedAt when reopening.');
    if (exception && 'instance' in edit) {
      delete comp.recur; comp.exceptId = nativeTime(edit.instance);
    }
    const after = recipients(comp);
    const removed = recipients(snapshot.comp).filter(a => !after.some(b => a.toLowerCase() === b.toLowerCase()));
    if (!edit.notifyAttendees && (removed.length > 0 || scheduleChange && snapshot.invites.length > 1 && allAttendees.length > 0)) throw new ZimbraError('INVALID_INPUT', 'This edit can send automatic cancellation notices. Set notifyAttendees explicitly after reviewing affected attendees.');
    const to = edit.notifyAttendees ? after.filter(a => a.toLowerCase() !== this.user.toLowerCase()) : [];
    if (to.length && !truth(comp.isOrg)) throw new ZimbraError('INVALID_INPUT', 'Only the organizer can send event updates.');
    this.check([...to, ...removed, ...(edit.notifyAttendees ? allAttendees : [])]);
    this.checkAlarms(comp);
    const m = await this.message(edit, snapshot, comp, changes, to);
    return this.request(exception ? task ? 'CreateTaskException' : 'CreateAppointmentException' : task ? 'ModifyTask' : 'ModifyAppointment',
      { id: edit.invitationId, comp: edit.component, ms: edit.expectedModSequence, rev: edit.expectedRevision, echo: 1, max: 200000, html: 1, forcesend: 0, m }, true);
  }
}
