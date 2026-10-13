import { CALENDAR_READ_SCHEMAS, CALENDAR_WRITE_SCHEMAS, invitationId, nativeAlarms, nativeRecurrence, nativeTime } from './calendar-schema.js';
import { ZimbraError } from './session.js';
import { CALENDAR_EDIT_OPERATIONS, ZimbraCalendarEdits, type CalendarEditOperation } from './calendar-edit.js';
import { CALENDAR_INBOX_OPERATIONS, ZimbraCalendarInbox, type CalendarInboxOperation } from './calendar-inbox.js';

type Obj = Record<string, unknown>;
type Request = (name: string, params: Obj, write?: boolean) => Promise<Obj>;
type ReadOperation = keyof typeof CALENDAR_READ_SCHEMAS;
type WriteOperation = keyof typeof CALENDAR_WRITE_SCHEMAS;

export class ZimbraCalendar {
  private readonly edits: ZimbraCalendarEdits;
  private readonly inbox: ZimbraCalendarInbox;
  constructor(private readonly request: Request, private readonly user: string, private readonly allowedRecipients: readonly string[] | undefined, raw: (id: string) => Promise<Buffer>) {
    this.edits = new ZimbraCalendarEdits(request, raw, user, allowedRecipients);
    this.inbox = new ZimbraCalendarInbox(request, user, allowedRecipients);
  }
  private checkRecipients(recipients: string[]): void {
    if (this.allowedRecipients === undefined) return;
    const allowed = new Set(this.allowedRecipients.map(a => a.toLowerCase()));
    if (recipients.some(a => !allowed.has(a.toLowerCase()))) throw new ZimbraError('ACCESS_DENIED', 'Calendar notification or email-alarm recipient is outside allowedRecipients.');
  }
  async read(operation: ReadOperation, input: unknown): Promise<unknown> {
    switch (operation) {
      case 'getAppointment': {
        const v = CALENDAR_READ_SCHEMAS.getAppointment.parse(input);
        return this.request('GetAppointment', { id: v.appointmentId, sync: 1, includeInvites: 1, includeContent: v.includeContent ? 1 : 0 });
      }
      case 'getTask': {
        const v = CALENDAR_READ_SCHEMAS.getTask.parse(input);
        return this.request('GetTask', { id: v.taskId, sync: 1, includeInvites: 1, includeContent: v.includeContent ? 1 : 0 });
      }
      case 'getRecurrence': return this.request('GetRecur', { id: CALENDAR_READ_SCHEMAS.getRecurrence.parse(input).itemId });
      case 'getICalendar': return this.request('GetICal', { id: CALENDAR_READ_SCHEMAS.getICalendar.parse(input).invitationId });
      case 'getCalendarSummaries': {
        const v = CALENDAR_READ_SCHEMAS.getCalendarSummaries.parse(input);
        const result = await this.request('GetCalendarItemSummaries', { s: Date.parse(v.startsAt), e: Date.parse(v.endsAt), l: v.folderId });
        return { ...result, window: { startsAt: v.startsAt, endsAt: v.endsAt }, warning: 'Only occurrences in this window and accessible folder are represented. Read individual items for complete invitations; split dense or oversized windows.' };
      }
      case 'getFreeBusy': {
        const v = CALENDAR_READ_SCHEMAS.getFreeBusy.parse(input);
        return this.request('GetFreeBusy', { s: Date.parse(v.startsAt), e: Date.parse(v.endsAt), usr: v.users.map(u => ({ name: u.email, ...(u.folderId ? { l: u.folderId } : {}) })), ...(v.excludeUid ? { excludeUid: v.excludeUid } : {}) });
      }
      case 'getWorkingHours': {
        const v = CALENDAR_READ_SCHEMAS.getWorkingHours.parse(input);
        return this.request('GetWorkingHours', { s: Date.parse(v.startsAt), e: Date.parse(v.endsAt), name: v.emails.join(',') });
      }
    }
  }
  async write(operation: WriteOperation, input: unknown): Promise<unknown> {
    if ((CALENDAR_INBOX_OPERATIONS as readonly string[]).includes(operation)) return this.inbox.execute(operation as CalendarInboxOperation, input);
    if (operation === 'importICalendar') {
      const v = CALENDAR_WRITE_SCHEMAS.importICalendar.parse(input);
      // Arbitrary ICS can carry email alarms and scheduling methods. A string
      // scan is not a reliable recipient-policy check for this native parser.
      if (this.allowedRecipients !== undefined) throw new ZimbraError('ACCESS_DENIED', 'Native iCalendar import is unavailable with allowedRecipients; use typed calendar operations with explicit recipient checks.');
      const result = await this.request('ImportAppointments', { l: v.folderId, ct: 'text/calendar', content: { _content: v.content } }, true);
      const nodes = Array.isArray(result.appt) ? result.appt : [result.appt];
      const summary = nodes.length === 1 && nodes[0] && typeof nodes[0] === 'object' ? nodes[0] as Obj : {};
      const num = typeof summary.num === 'number' ? summary.num : typeof summary.num === 'string' && /^[0-9]+$/.test(summary.num) ? Number(summary.num) : NaN;
      const parsedComponents = Number.isSafeInteger(num) && num >= 0 ? num : null;
      const ids = typeof summary.ids === 'string' ? summary.ids.split(',').filter(Boolean) : null;
      const savedIds = ids?.every(id => invitationId.safeParse(id).success) ? ids : null;
      const missing = parsedComponents !== null && savedIds !== null && parsedComponents >= savedIds.length ? parsedComponents - savedIds.length : null;
      return { native: result, serverParsedComponents: parsedComponents, reportedSavedInvitationIds: savedIds,
        missingComponents: missing, completeness: missing === null ? 'unknown' : missing > 0 ? 'partial' : 'reported_all',
        warning: 'Import is not atomic and may update existing items by UID. The server can skip components; its num field is not a success count. Read returned items to verify contents. Do not automatically retry an uncertain or partial import.' };
    }
    if ((CALENDAR_EDIT_OPERATIONS as readonly string[]).includes(operation)) return this.edits.execute(operation as CalendarEditOperation, input);
    if (operation === 'dismissCalendarAlarm' || operation === 'snoozeCalendarAlarm') {
      const v = CALENDAR_WRITE_SCHEMAS[operation].parse(input);
      return this.request(operation === 'dismissCalendarAlarm' ? 'DismissCalendarItemAlarm' : 'SnoozeCalendarItemAlarm', {
        [v.kind === 'appointment' ? 'appt' : 'task']: [{ id: v.itemId, ...('until' in v ? { until: Date.parse(v.until) } : { dismissedAt: Date.parse(v.dismissedAt) }) }],
      }, true);
    }
    const v = (operation === 'createAppointment' ? CALENDAR_WRITE_SCHEMAS.createAppointment : CALENDAR_WRITE_SCHEMAS.createTask).parse(input);
    const appointment = 'endExclusive' in v;
    const recipients = v.notifyAttendees ? v.attendees.map(a => a.email) : [];
    this.checkRecipients([...recipients, ...v.alarms.flatMap(a => a.type === 'email' ? a.to : [])]);
    const comp: Obj = {
      name: v.subject, isOrg: 1, or: { a: this.user }, class: v.privacy, priority: v.priority, status: v.status,
      allDay: v.start?.type === 'date' || !appointment && v.due?.type === 'date' ? 1 : 0,
      at: v.attendees.map(a => ({ a: a.email, ...(a.name === undefined ? {} : { d: a.name }), role: a.role, cutype: a.type, ptst: 'NE', rsvp: a.rsvp ? 1 : 0 })),
      alarm: nativeAlarms(v.alarms, v.subject),
      ...(v.start ? { s: nativeTime(v.start) } : {}),
      ...(v.location !== undefined ? { loc: v.location } : {}),
      ...(v.description !== undefined ? { desc: { _content: v.description } } : {}),
      ...(v.htmlDescription !== undefined ? { descHtml: { _content: v.htmlDescription } } : {}),
      ...(v.categories ? { category: v.categories.map(_content => ({ _content })) } : {}),
      ...(v.url ? { url: v.url } : {}), ...(v.recurrence ? { recur: nativeRecurrence(v.recurrence) } : {}),
    };
    if (appointment) {
      // SOAP represents an all-day end inclusively; our API consistently uses
      // an exclusive end. Timed events do not need this compatibility offset.
      comp.e = v.endExclusive.type === 'date'
        ? nativeTime({ type: 'date', date: new Date(Date.parse(v.endExclusive.date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10) })
        : nativeTime(v.endExclusive);
      comp.fb = v.freeBusy;
    } else {
      if (v.due) comp.e = nativeTime(v.due);
      comp.percentComplete = v.percentComplete;
      if (v.completedAt) comp.completed = nativeTime({ type: 'instant', at: v.completedAt }).d;
    }
    const parts: Obj[] = [];
    if (v.description !== undefined) parts.push({ ct: 'text/plain', content: { _content: v.description } });
    if (v.htmlDescription !== undefined) parts.push({ ct: 'text/html', content: { _content: v.htmlDescription } });
    if (!parts.length) parts.push({ ct: 'text/plain', content: { _content: '' } });
    return this.request(appointment ? 'CreateAppointment' : 'CreateTask', { echo: 1, max: 200000, html: 1, forcesend: 0,
      m: { l: v.folderId, e: recipients.map(a => ({ a, t: 't' })), su: { _content: v.subject }, inv: { comp: [comp] },
        mp: parts.length === 1 ? parts[0] : { ct: 'multipart/alternative', mp: parts } } }, true);
  }
}
