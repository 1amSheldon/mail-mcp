import { z } from 'zod';
import { itemId } from './native-operations.js';

const line = z.string().max(998).refine(v => !/[\r\n\0]/.test(v));
const text = z.string().max(200000).refine(v => !v.includes('\0'));
export const instant = z.iso.datetime({ offset: true }).refine(v => !/\.\d*[1-9]/.test(v), 'Use whole seconds.');
export const calendarTime = z.discriminatedUnion('type', [
  z.object({ type: z.literal('date'), date: z.iso.date() }).strict(),
  z.object({ type: z.literal('instant'), at: instant }).strict(),
  z.object({ type: z.literal('local'), at: z.iso.datetime({ local: true, precision: 0 }).refine(v => !/Z$|[+-]\d\d:\d\d$/.test(v)), timeZone: z.string().min(1).max(255).refine(v => !/[\r\n\0]/.test(v)) }).strict(),
]);
export type CalendarTime = z.output<typeof calendarTime>;
export const invitationId = z.string().regex(/^(?:[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}:)?[1-9][0-9]{0,15}-[1-9][0-9]{0,15}$/);
export function nativeTime(v: CalendarTime): Record<string, unknown> {
  if (v.type === 'date') return { d: v.date.replaceAll('-', '') };
  if (v.type === 'instant') return { d: new Date(v.at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') };
  return { d: v.at.replace(/[-:]/g, ''), tz: v.timeZone };
}
export function sameTimeBasis(a: CalendarTime, b: CalendarTime): boolean {
  return a.type === b.type && (a.type !== 'local' || b.type === 'local' && a.timeZone === b.timeZone);
}
export function compareTimes(a: CalendarTime, b: CalendarTime): number {
  if (!sameTimeBasis(a, b)) return NaN;
  if (a.type === 'instant' && b.type === 'instant') return Date.parse(a.at) - Date.parse(b.at);
  const aa = a.type === 'date' ? a.date : a.at;
  const bb = b.type === 'date' ? b.date : b.at;
  return aa.localeCompare(bb);
}
export const calendarWindow = { startsAt: instant, endsAt: instant };
export const validWindow = (v: { startsAt: string; endsAt: string }) => {
  const size = Date.parse(v.endsAt) - Date.parse(v.startsAt);
  return size > 0 && size <= 200 * 86400000;
};
const weekday = z.enum(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);
const signed = (max: number) => z.number().int().min(-max).max(max).refine(v => v !== 0);
const recurrenceRule = z.object({
  frequency: z.enum(['SEC', 'MIN', 'HOU', 'DAI', 'WEE', 'MON', 'YEA']), interval: z.number().int().min(1).max(10000).default(1),
  count: z.number().int().min(1).max(100000).optional(), until: z.union([z.iso.date(), instant]).optional(),
  byDay: z.array(z.object({ day: weekday, ordinal: signed(53).optional() }).strict()).min(1).max(53).optional(),
  byMonthDay: z.array(signed(31)).min(1).max(62).optional(), byMonth: z.array(z.number().int().min(1).max(12)).min(1).max(12).optional(),
  byYearDay: z.array(signed(366)).min(1).max(732).optional(), byWeekNo: z.array(signed(53)).min(1).max(106).optional(),
  bySetPosition: z.array(signed(366)).min(1).max(732).optional(),
  byHour: z.array(z.number().int().min(0).max(23)).min(1).max(24).optional(),
  byMinute: z.array(z.number().int().min(0).max(59)).min(1).max(60).optional(),
  bySecond: z.array(z.number().int().min(0).max(59)).min(1).max(60).optional(), weekStartsOn: weekday.optional(),
}).strict().refine(v => !(v.count !== undefined && v.until !== undefined))
  .refine(v => !v.bySetPosition || Object.keys(v).some(k => k.startsWith('by') && k !== 'bySetPosition'));
export const recurrence = z.object({ rules: z.array(recurrenceRule).max(10).default([]), excludeRules: z.array(recurrenceRule).max(10).default([]), includeDates: z.array(calendarTime).max(1000).default([]), excludeDates: z.array(calendarTime).max(1000).default([]) }).strict()
  .refine(v => v.rules.length > 0 || v.includeDates.length > 0);
export const attendees = z.array(z.object({ email: z.email(), name: line.optional(), role: z.enum(['REQ', 'OPT', 'CHA', 'NON']).default('REQ'), type: z.enum(['IND', 'GRO', 'RES', 'ROO', 'UNK']).default('IND'), rsvp: z.boolean().default(true) }).strict()).max(100)
  .refine(v => new Set(v.map(a => a.email.toLowerCase())).size === v.length);
const alarmTrigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('relative'), minutes: z.number().int().min(-525600).max(525600), related: z.enum(['START', 'END']).default('START') }).strict(),
  z.object({ type: z.literal('absolute'), at: instant }).strict(),
]);
export const alarms = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('display'), trigger: alarmTrigger, description: text.optional() }).strict(),
  z.object({ type: z.literal('email'), trigger: alarmTrigger, to: z.array(z.email()).min(1).max(100), subject: line, body: text }).strict(),
  z.object({ type: z.literal('audio'), trigger: alarmTrigger }).strict(),
])).max(10);
export const sharedFields = {
  subject: line, location: line.optional(), description: text.optional(), htmlDescription: text.optional(),
  privacy: z.enum(['PUB', 'PRI', 'CON']).default('PUB'), priority: z.number().int().min(0).max(9).default(0),
  categories: z.array(line).max(100).optional(), url: z.url().max(2048).optional(), attendees: attendees.default([]),
  alarms: alarms.default([]), recurrence: recurrence.optional(),
};
export const appointmentFields = { ...sharedFields, start: calendarTime, endExclusive: calendarTime, status: z.enum(['TENT', 'CONF', 'CANC']).default('CONF'), freeBusy: z.enum(['F', 'B', 'T', 'O']).default('B') };
export const taskFields = { ...sharedFields, start: calendarTime.optional(), due: calendarTime.optional(), status: z.enum(['NEED', 'INPR', 'COMP', 'WAITING', 'DEFERRED', 'CANC']).default('NEED'), percentComplete: z.number().int().min(0).max(100).default(0), completedAt: instant.optional() };
const commonCreate = { folderId: itemId, notifyAttendees: z.boolean().default(false) };
const validDates = (v: { start?: CalendarTime; recurrence?: z.output<typeof recurrence> }) => !v.recurrence || Boolean(v.start)
  && [...v.recurrence.includeDates, ...v.recurrence.excludeDates].every(d => sameTimeBasis(v.start!, d))
  && [...v.recurrence.rules, ...v.recurrence.excludeRules].every(r => !r.until || (v.start!.type === 'date') === !r.until.includes('T'));
export const CALENDAR_READ_SCHEMAS = {
  getAppointment: z.object({ appointmentId: itemId, includeContent: z.boolean().default(true) }).strict(),
  getTask: z.object({ taskId: itemId, includeContent: z.boolean().default(true) }).strict(),
  getRecurrence: z.object({ itemId }).strict(),
  getCalendarSummaries: z.object({ ...calendarWindow, folderId: itemId }).strict().refine(validWindow),
  getFreeBusy: z.object({ ...calendarWindow, users: z.array(z.object({ email: z.email(), folderId: itemId.optional() }).strict()).min(1).max(100), excludeUid: line.optional() }).strict().refine(validWindow),
  getWorkingHours: z.object({ ...calendarWindow, emails: z.array(z.email()).min(1).max(100) }).strict().refine(validWindow),
  getICalendar: z.object({ invitationId }).strict(),
};
export const CALENDAR_WRITE_SCHEMAS = {
  createAppointment: z.object({ ...commonCreate, ...appointmentFields }).strict().refine(v => compareTimes(v.start, v.endExclusive) < 0, 'Use matching date/time bases and a later exclusive end.').refine(validDates),
  createTask: z.object({ ...commonCreate, ...taskFields }).strict().refine(v => !v.start || !v.due || compareTimes(v.start, v.due) <= 0).refine(validDates)
    .refine(v => v.status !== 'COMP' || v.percentComplete === 100).refine(v => v.status === 'COMP' || v.completedAt === undefined),
  dismissCalendarAlarm: z.object({ kind: z.enum(['appointment', 'task']), itemId, dismissedAt: instant }).strict(),
  snoozeCalendarAlarm: z.object({ kind: z.enum(['appointment', 'task']), itemId, until: instant }).strict(),
};

function nativeRule(v: z.output<typeof recurrenceRule>): Record<string, unknown> {
  const r: Record<string, unknown> = { freq: v.frequency, interval: { ival: v.interval } };
  if (v.count !== undefined) r.count = { num: v.count };
  if (v.until) r.until = nativeTime(v.until.includes('T') ? { type: 'instant', at: v.until } : { type: 'date', date: v.until });
  if (v.byDay) r.byday = { wkday: v.byDay.map(d => ({ day: d.day, ...(d.ordinal !== undefined ? { ordwk: d.ordinal } : {}) })) };
  for (const [field, node, attr] of [
    ['byMonthDay', 'bymonthday', 'modaylist'], ['byMonth', 'bymonth', 'molist'], ['byYearDay', 'byyearday', 'yrdaylist'],
    ['byWeekNo', 'byweekno', 'wklist'], ['bySetPosition', 'bysetpos', 'poslist'], ['byHour', 'byhour', 'hrlist'],
    ['byMinute', 'byminute', 'minlist'], ['bySecond', 'bysecond', 'seclist'],
  ] as const) if (v[field]) r[node] = { [attr]: v[field]!.join(',') };
  if (v.weekStartsOn) r.wkst = { day: v.weekStartsOn };
  return r;
}
export function nativeRecurrence(v: z.output<typeof recurrence>): Record<string, unknown> {
  const dates = (values: CalendarTime[]) => values.map(d => {
    const s = nativeTime(d); const tz = s.tz; delete s.tz;
    return { ...(tz ? { tz } : {}), dtval: [{ s }] };
  });
  return { add: [{ rule: v.rules.map(nativeRule), dates: dates(v.includeDates) }], exclude: [{ rule: v.excludeRules.map(nativeRule), dates: dates(v.excludeDates) }] };
}
export function nativeAlarms(values: z.output<typeof alarms>, subject: string): Record<string, unknown>[] {
  return values.map(v => ({
    action: v.type.toUpperCase(), trigger: v.trigger.type === 'absolute' ? { abs: nativeTime({ type: 'instant', at: v.trigger.at }) }
      : { rel: { m: Math.abs(v.trigger.minutes), neg: v.trigger.minutes < 0 ? 1 : 0, related: v.trigger.related } },
    ...(v.type === 'display' ? { desc: { _content: v.description ?? subject } } : {}),
    ...(v.type === 'email' ? { desc: { _content: v.body }, summary: { _content: v.subject }, at: v.to.map(a => ({ a })) } : {}),
  }));
}
