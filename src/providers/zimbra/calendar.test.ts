import { describe, expect, it, vi } from 'vitest';
import { ZimbraClient } from './client.js';
import type { ZimbraConfiguredAccount } from '../account-types.js';

const account: ZimbraConfiguredAccount = { id: 'z', name: 'Zimbra', backend: 'zimbra', user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const response = (name: string, value: unknown) => new Response(JSON.stringify({ Body: { [name + 'Response']: value } }));
function fixture(responses: Response[], patch: Partial<ZimbraConfiguredAccount> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(); responses.forEach(r => fetch.mockResolvedValueOnce(r));
  const client = new ZimbraClient({ ...account, ...patch }, { fetch, sessionProvider: async () => ({ kind: 'zimbra-session-v1', endpoint: account.endpoint, user: account.user, authToken: 'session', expiresAt: Date.now() + 60000 }) });
  return { client, fetch, request: (i = 0) => JSON.parse(String(fetch.mock.calls[i][1]?.body)) };
}
const event = { folderId: '10', subject: 'Planning', start: { type: 'local', at: '2026-10-14T09:00:00', timeZone: 'Europe/Kyiv' }, endExclusive: { type: 'local', at: '2026-10-14T10:00:00', timeZone: 'Europe/Kyiv' } };

describe('Zimbra calendar creation semantics', () => {
  it('preserves wall-clock timezone for recurring events and does not notify by default', async () => {
    const { client, request } = fixture([response('CreateAppointment', { calItemId: '257', invId: '257-256' })]);
    await client.executeWrite('createAppointment', { ...event, attendees: [{ email: 'other@example.test' }], recurrence: { rules: [{ frequency: 'WEE', count: 12, byDay: [{ day: 'WE' }] }] } });
    const body = request().Body.CreateAppointmentRequest;
    expect(body).toMatchObject({ forcesend: 0, echo: 1, m: { l: '10', e: [], inv: { comp: [{ isOrg: 1, or: { a: account.user }, s: { d: '20261014T090000', tz: 'Europe/Kyiv' }, e: { d: '20261014T100000', tz: 'Europe/Kyiv' }, recur: { add: [{ rule: [{ freq: 'WEE', count: { num: 12 }, byday: { wkday: [{ day: 'WE' }] } }] }] } }] } } });
  });
  it('converts an exclusive all-day end to Zimbra inclusive dates without timezone shifts', async () => {
    const { client, request } = fixture([response('CreateAppointment', {})]);
    await client.executeWrite('createAppointment', { folderId: '10', subject: 'Day off', start: { type: 'date', date: '2026-10-14' }, endExclusive: { type: 'date', date: '2026-10-15' } });
    expect(request().Body.CreateAppointmentRequest.m.inv.comp[0]).toMatchObject({ allDay: 1, s: { d: '20261014' }, e: { d: '20261014' } });
  });
  it('normalizes explicit instants and preserves both description formats', async () => {
    const { client, request } = fixture([response('CreateAppointment', {})]);
    await client.executeWrite('createAppointment', { ...event, start: { type: 'instant', at: '2026-10-14T09:00:00+03:00' }, endExclusive: { type: 'instant', at: '2026-10-14T07:00:00Z' }, description: 'Plain', htmlDescription: '<b>Rich</b>' });
    expect(request().Body.CreateAppointmentRequest.m).toMatchObject({ inv: { comp: [{ s: { d: '20261014T060000Z' }, desc: { _content: 'Plain' }, descHtml: { _content: '<b>Rich</b>' } }] }, mp: { ct: 'multipart/alternative', mp: [{ ct: 'text/plain', content: { _content: 'Plain' } }, { ct: 'text/html', content: { _content: '<b>Rich</b>' } }] } });
  });
  it('checks actual invitation and email-alarm recipients before a write', async () => {
    const { client, fetch, request } = fixture([response('CreateAppointment', {})], { allowedRecipients: ['allowed@example.test'] });
    await expect(client.executeWrite('createAppointment', { ...event, notifyAttendees: true, attendees: [{ email: 'outside@example.test' }] })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(client.executeWrite('createAppointment', { ...event, alarms: [{ type: 'email', trigger: { type: 'relative', minutes: -15 }, to: ['outside@example.test'], subject: 'Reminder', body: 'Soon' }] })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(fetch).not.toHaveBeenCalled();
    await client.executeWrite('createAppointment', { ...event, notifyAttendees: true, attendees: [{ email: 'allowed@example.test', role: 'OPT' }], alarms: [{ type: 'display', trigger: { type: 'relative', minutes: -15 } }] });
    expect(request().Body.CreateAppointmentRequest.m).toMatchObject({ e: [{ a: 'allowed@example.test', t: 't' }], inv: { comp: [{ alarm: [{ action: 'DISPLAY', trigger: { rel: { m: 15, neg: 1, related: 'START' } } }] }] } });
  });
  it('rejects mismatched dates, inverted periods and inconsistent recurrence bounds', async () => {
    const { client, fetch } = fixture([]);
    for (const patch of [
      { endExclusive: { type: 'date', date: '2026-10-15' } },
      { endExclusive: { type: 'local', at: '2026-10-14T08:00:00', timeZone: 'Europe/Kyiv' } },
      { recurrence: { rules: [{ frequency: 'DAI', count: 3, until: '2026-12-01T00:00:00Z' }] } },
      { recurrence: { rules: [{ frequency: 'DAI', until: '2026-12-01' }] } },
    ]) await expect(client.executeWrite('createAppointment', { ...event, ...patch })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('creates undated tasks and treats a date-only due date inclusively', async () => {
    const { client, request } = fixture([response('CreateTask', {}), response('CreateTask', {})]);
    await client.executeWrite('createTask', { folderId: '15', subject: 'Review report' });
    expect(request().Body.CreateTaskRequest.m.inv.comp[0]).not.toHaveProperty('s');
    await client.executeWrite('createTask', { folderId: '15', subject: 'Done', due: { type: 'date', date: '2026-10-14' }, status: 'COMP', percentComplete: 100, completedAt: '2026-10-14T10:00:00Z' });
    expect(request(1).Body.CreateTaskRequest.m.inv.comp[0]).toMatchObject({ allDay: 1, e: { d: '20261014' }, completed: '20261014T100000Z', status: 'COMP', percentComplete: 100 });
  });
});

describe('calendar reads and reminders', () => {
  it('requests conflict sequences plus complete invitation data for future guarded edits', async () => {
    const { client, request } = fixture([response('GetAppointment', {}), response('GetTask', {})]);
    await client.executeRead('getAppointment', { appointmentId: '257' });
    await client.executeRead('getTask', { taskId: '258', includeContent: false });
    expect(request().Body.GetAppointmentRequest).toEqual({ _jsns: 'urn:zimbraMail', id: '257', sync: 1, includeInvites: 1, includeContent: 1 });
    expect(request(1).Body.GetTaskRequest.includeContent).toBe(0);
  });
  it('uses explicit bounded time windows for summaries and free/busy without treating no-data as free', async () => {
    const window = { startsAt: '2026-10-14T00:00:00Z', endsAt: '2026-10-15T00:00:00Z' };
    const { client, request } = fixture([response('GetCalendarItemSummaries', { appt: [] }), response('GetFreeBusy', { usr: [{ id: 'unknown@example.test', n: [{ s: 1, e: 2 }] }] })]);
    await client.executeRead('getCalendarSummaries', { ...window, folderId: '10' });
    expect(request().Body.GetCalendarItemSummariesRequest).toMatchObject({ l: '10', s: Date.parse(window.startsAt), e: Date.parse(window.endsAt) });
    expect(await client.executeRead('getFreeBusy', { ...window, users: [{ email: 'unknown@example.test' }] })).toMatchObject({ usr: [{ n: [{ s: 1, e: 2 }] }] });
    await expect(client.executeRead('getFreeBusy', { startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z', users: [{ email: 'x@example.test' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('exports a component-zero invitation by compound ID, not a deletable standalone mail ID', async () => {
    const { client, request } = fixture([response('GetICal', { ical: { _content: 'BEGIN:VCALENDAR' } })]);
    await expect(client.executeRead('getICalendar', { invitationId: '257' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await client.executeRead('getICalendar', { invitationId: '257-256' });
    expect(request().Body.GetICalRequest.id).toBe('257-256');
  });
  it('dismisses/snoozes the selected item kind with millisecond timestamps', async () => {
    const { client, request } = fixture([response('DismissCalendarItemAlarm', {}), response('SnoozeCalendarItemAlarm', {})]);
    await client.executeWrite('dismissCalendarAlarm', { kind: 'appointment', itemId: '257', dismissedAt: '2026-10-14T09:00:00Z' });
    await client.executeWrite('snoozeCalendarAlarm', { kind: 'task', itemId: '258', until: '2026-10-14T09:15:00Z' });
    expect(request().Body.DismissCalendarItemAlarmRequest.appt).toEqual([{ id: '257', dismissedAt: Date.parse('2026-10-14T09:00:00Z') }]);
    expect(request(1).Body.SnoozeCalendarItemAlarmRequest.task).toEqual([{ id: '258', until: Date.parse('2026-10-14T09:15:00Z') }]);
  });
});
