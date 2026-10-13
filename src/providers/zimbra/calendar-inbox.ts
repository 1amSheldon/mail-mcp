import { z } from 'zod';
import { CALENDAR_WRITE_SCHEMAS, nativeTime } from './calendar-schema.js';
import { ZimbraError } from './session.js';

type Obj = Record<string, unknown>;
type Request = (name: string, params: Obj, write?: boolean) => Promise<Obj>;
export const CALENDAR_INBOX_OPERATIONS = ['replyToInboxInvitation', 'forwardInboxInvitation', 'declineCounterProposal'] as const;
export type CalendarInboxOperation = typeof CALENDAR_INBOX_OPERATIONS[number];
const list = (v: unknown): unknown[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
function obj(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ZimbraError('PROVIDER_ERROR', 'Incomplete invitation message metadata.');
  return v as Obj;
}
const truth = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

export class ZimbraCalendarInbox {
  constructor(private readonly request: Request, private readonly user: string, private readonly allowed?: readonly string[]) {}
  async execute(operation: CalendarInboxOperation, rawInput: unknown): Promise<unknown> {
    const v = CALENDAR_WRITE_SCHEMAS[operation].parse(rawInput);
    // Accepting inbox invitations can persist native email alarms; forwarding
    // can derive an additional organizer recipient after this preflight.
    if (operation !== 'declineCounterProposal' && this.allowed !== undefined) throw new ZimbraError('ACCESS_DENIED', 'Native inbox invitation reply/forward can persist alarms or notify server-derived recipients; it requires an unrestricted account.');
    const result = await this.request('GetMsg', { m: { id: v.messageId, wantModSeq: 1, read: 0, html: 1, max: 200000 } });
    const messages = list(result.m).map(obj);
    if (messages.length !== 1 || String(messages[0].id) !== v.messageId || String(messages[0].ms) !== v.expectedModSequence) throw new ZimbraError('CONFLICT', 'Invitation message changed or its version is unavailable. Read it again.');
    const components = list(messages[0].inv).map(obj).flatMap(inv => list(inv.comp).map(obj).map(comp => ({ inv, comp })));
    const matches = components.filter(c => Number(c.comp.compNum) === v.component);
    if (matches.length !== 1) throw new ZimbraError('INVALID_INPUT', 'The selected invitation component is absent or ambiguous.');
    const { inv, comp } = matches[0];
    const message = (to: string[]) => ({ e: to.map(a => ({ a, t: 't' })), su: { _content: String(comp.name ?? '') }, mp: { ct: 'text/plain', content: { _content: v.message } } });
    if (operation === 'forwardInboxInvitation') {
      const input = CALENDAR_WRITE_SCHEMAS.forwardInboxInvitation.parse(v);
      if (components.some(c => c.comp.method !== 'REQUEST' || c.inv.type !== 'appt')) throw new ZimbraError('INVALID_INPUT', 'Forward only appointment REQUEST messages; the native operation forwards every component in the mail.');
      return this.request('ForwardAppointmentInvite', { id: v.messageId, m: message(input.to) }, true);
    }
    const organizers = list(comp.or).map(obj);
    const organizer = organizers.length === 1 ? organizers[0].a : undefined;
    if (!z.email().safeParse(organizer).success) throw new ZimbraError('PROVIDER_ERROR', 'Invitation organizer address is unavailable.');
    if (operation === 'replyToInboxInvitation') {
      const input = CALENDAR_WRITE_SCHEMAS.replyToInboxInvitation.parse(v);
      if (comp.method !== 'REQUEST') throw new ZimbraError('INVALID_INPUT', 'Participation replies require an invitation REQUEST component.');
      return this.request('SendInviteReply', { id: v.messageId, compNum: v.component, verb: input.response, updateOrganizer: input.notifyOrganizer ? 1 : 0,
        ...(input.instance ? { exceptId: nativeTime(input.instance) } : {}), ...(input.identityId ? { idnt: input.identityId } : {}), m: message(input.notifyOrganizer ? [organizer as string] : []) }, true);
    }
    const input = CALENDAR_WRITE_SCHEMAS.declineCounterProposal.parse(v);
    if (inv.type !== 'appt' || comp.method !== 'COUNTER' || typeof comp.uid !== 'string' || !comp.uid) throw new ZimbraError('INVALID_INPUT', 'Select an incoming appointment COUNTER component with its original UID.');
    if (!truth(comp.isOrg) && String(organizer).toLowerCase() !== this.user.toLowerCase()) throw new ZimbraError('INVALID_INPUT', 'Only the meeting organizer can decline a counter proposal.');
    const proposers = list(comp.at).map(obj).filter(a => typeof a.a === 'string' && a.a.toLowerCase() === input.proposerEmail.toLowerCase());
    if (proposers.length !== 1) throw new ZimbraError('INVALID_INPUT', 'The selected proposer is not an unambiguous attendee in the COUNTER component.');
    if (this.allowed !== undefined && !this.allowed.some(a => a.toLowerCase() === input.proposerEmail.toLowerCase())) throw new ZimbraError('ACCESS_DENIED', 'The counter-proposal recipient is outside allowedRecipients.');
    const reply: Obj = {};
    for (const key of ['uid', 'seq', 'name', 'class', 'priority', 'status', 'loc', 'or', 's', 'e', 'allDay', 'exceptId']) if (comp[key] !== undefined) reply[key] = structuredClone(comp[key]);
    reply.at = [structuredClone(proposers[0])];
    return this.request('DeclineCounterAppointment', { m: { ...message([input.proposerEmail]), inv: { ...(inv.tz ? { tz: inv.tz } : {}), comp: [reply] } } }, true);
  }
}
