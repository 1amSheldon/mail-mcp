import { describe, expect, it, vi } from 'vitest';
import { ZimbraCalendarEdits } from './calendar-edit.js';
import { CALENDAR_WRITE_SCHEMAS } from './calendar-schema.js';
import { ZimbraClient } from './client.js';

const guard = { invitationId: '257-256', component: 0, expectedModSequence: '40', expectedRevision: '39' };
const comp = { name: 'Planning', isOrg: true, noBlob: true, or: { a: 'me@example.test' }, class: 'PRI', priority: 5, status: 'CONF',
  s: [{ d: '20261014T090000', tz: 'Europe/Kyiv' }], e: [{ d: '20261014T100000', tz: 'Europe/Kyiv' }],
  desc: [{ _content: 'Keep this text' }], at: [{ a: 'allowed@example.test', role: 'REQ', ptst: 'AC', rsvp: true }],
  xprop: [{ name: 'X-CUSTOM', value: 'preserve' }], category: [{ _content: 'Planning' }],
};
function fixture(patch: Record<string, unknown> = {}, allowed?: string[]) {
  const item = { id: '257', l: '10', ms: 40, rev: 39, inv: [{ id: 256, compNum: 0, comp: [{ ...comp, ...patch }] }] };
  const request = vi.fn<(name: string, params: Record<string, unknown>, write?: boolean) => Promise<Record<string, unknown>>>().mockResolvedValueOnce({ appt: [item], task: [item] }).mockResolvedValue({ calItemId: '257' });
  const raw = vi.fn<(_id: string) => Promise<Buffer>>();
  return { service: new ZimbraCalendarEdits(request, raw, 'me@example.test', allowed), request, raw, item, payload: () => request.mock.calls[1][1] as { m: { inv: { comp: Record<string, unknown>[] }; mp: unknown; attach?: unknown; e: unknown[] }; [k: string]: unknown } };
}

describe('guarded partial calendar edits', () => {
  it('forwards an explicitly selected occurrence using the calendar item ID', async () => {
    const f = fixture();
    await f.service.execute('forwardAppointment', { ...guard, to: ['guest@example.test'], instance: { type: 'local', at: '2026-10-14T09:00:00', timeZone: 'Europe/Kyiv' }, message: 'Join us' });
    expect(f.request.mock.calls[1]).toEqual(['ForwardAppointment', { id: '257', exceptId: { d: '20261014T090000', tz: 'Europe/Kyiv' }, m: { e: [{ a: 'guest@example.test', t: 't' }], su: { _content: 'Planning' }, mp: { ct: 'text/plain', content: { _content: 'Join us' } } } }, true]);
    expect(f.raw).not.toHaveBeenCalled();
  });
  it('blocks native forwarding with recipient restrictions even when To is permitted', async () => {
    const f = fixture({}, ['guest@example.test']);
    await expect(f.service.execute('forwardAppointment', { ...guard, to: ['guest@example.test'] })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(f.request).toHaveBeenCalledOnce();
  });
  it('does not accidentally forward an entire series when an exception was selected', async () => {
    const f = fixture({ exceptId: { d: '20261014T090000', tz: 'Europe/Kyiv' } });
    await expect(f.service.execute('forwardAppointment', { ...guard, to: ['guest@example.test'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.request).toHaveBeenCalledOnce();
  });
  it('sends a counter proposal only to the inspected organizer without copying email alarms', async () => {
    const f = fixture({ uid: 'meeting-uid', seq: 4, isOrg: false, or: { a: 'allowed@example.test' }, alarm: [{ action: 'EMAIL', at: [{ a: 'outside@example.test' }] }] }, ['allowed@example.test']);
    await f.service.execute('counterAppointment', { ...guard, start: { type: 'date', date: '2026-10-15' }, endExclusive: { type: 'date', date: '2026-10-16' }, location: 'Room 2', message: 'Would this work?' });
    expect(f.request.mock.calls[1][0]).toBe('CounterAppointment');
    expect(f.payload()).toMatchObject({ id: '257-256', comp: 0, ms: '40', rev: '39', m: { e: [{ a: 'allowed@example.test', t: 't' }], inv: { comp: [{ uid: 'meeting-uid', seq: 4, s: { d: '20261015' }, e: { d: '20261015' }, allDay: 1, loc: 'Room 2', at: [{ a: 'me@example.test', ptst: 'TE' }] }] } } });
    expect(f.payload().m.inv.comp[0]).not.toHaveProperty('alarm');
    expect(f.raw).not.toHaveBeenCalled();
  });
  it('rejects counter proposals from organizers, stale reads and disallowed destinations', async () => {
    const input = { ...guard, start: { type: 'date', date: '2026-10-15' }, endExclusive: { type: 'date', date: '2026-10-16' } };
    const organizer = fixture({ uid: 'uid' });
    await expect(organizer.service.execute('counterAppointment', input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const restricted = fixture({ uid: 'uid', isOrg: false, or: { a: 'outside@example.test' } }, []);
    await expect(restricted.service.execute('counterAppointment', input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    const stale = fixture({ uid: 'uid', isOrg: false }); stale.item.ms++;
    await expect(stale.service.execute('counterAppointment', input)).rejects.toMatchObject({ code: 'CONFLICT' });
    for (const f of [organizer, restricted, stale]) expect(f.request).toHaveBeenCalledOnce();
  });
  it('does not introduce create-time defaults into a partial edit and preserves native metadata', async () => {
    expect(CALENDAR_WRITE_SCHEMAS.updateAppointment.parse({ ...guard, changes: { location: 'Room 2' } }).changes).toEqual({ location: 'Room 2' });
    const f = fixture();
    await f.service.execute('updateAppointment', { ...guard, changes: { location: 'Room 2' } });
    expect(f.payload()).toMatchObject({ id: '257-256', ms: '40', rev: '39', comp: 0, m: { e: [], inv: { comp: [{ name: 'Planning', loc: 'Room 2', class: 'PRI', priority: 5, xprop: comp.xprop, category: comp.category, at: comp.at, desc: { _content: 'Keep this text' } }] } } });
    expect(f.raw).not.toHaveBeenCalled();
  });
  it('refuses stale snapshots before reading MIME or writing', async () => {
    const f = fixture(); f.item.ms = 41;
    await expect(f.service.execute('updateAppointment', { ...guard, changes: { subject: 'New' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.request).toHaveBeenCalledOnce(); expect(f.raw).not.toHaveBeenCalled();
  });
  it('preserves original MIME descriptions and attachment references instead of sanitized SOAP content', async () => {
    const f = fixture({ noBlob: false, descHtml: [{ _content: 'Sanitized' }] });
    Object.assign(f.item.inv[0], { mp: [{ ct: 'multipart/mixed', mp: [{ ct: 'text/html', part: '1', content: { _content: 'Sanitized' } }, { ct: 'application/pdf', part: '2', filename: 'file.pdf', cd: 'attachment' }] }] });
    f.raw.mockResolvedValue(Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/html\r\n\r\n<b>Original</b>\r\n--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="file.pdf"\r\n\r\nfile bytes\r\n--x--\r\n'));
    await f.service.execute('updateAppointment', { ...guard, changes: { location: 'Room 2' } });
    expect(f.raw).toHaveBeenCalledWith('257-256');
    expect(f.payload().m.inv.comp[0].descHtml).toEqual({ _content: '<b>Original</b>' });
    expect(f.payload().m.attach).toEqual({ mp: [{ mid: '257-256', part: '2' }] });
  });
  it('refuses automatic cancellation notices unless notification intent is explicit', async () => {
    const f = fixture();
    await expect(f.service.execute('updateAppointment', { ...guard, changes: { attendees: [] } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.request).toHaveBeenCalledOnce();
    const restricted = fixture({}, []);
    await expect(restricted.service.execute('updateAppointment', { ...guard, notifyAttendees: true, changes: { attendees: [] } })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
  it('requires acknowledgement before schedule changes can reset existing exceptions', async () => {
    const f = fixture({ recur: { add: [{ rule: [{ freq: 'WEE' }] }] } });
    f.item.inv.push({ id: 260, compNum: 0, comp: [{ ...comp, exceptId: { d: '20261021T090000', tz: 'Europe/Kyiv' } } as typeof comp] });
    await expect(f.service.execute('updateAppointment', { ...guard, changes: { endExclusive: { type: 'local', at: '2026-10-14T11:00:00', timeZone: 'Europe/Kyiv' } } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.request).toHaveBeenCalledOnce();
  });
  it('creates an exception at its requested occurrence and preserves original duration', async () => {
    const f = fixture({ recur: { add: [{ rule: [{ freq: 'WEE' }] }] } });
    await f.service.execute('createAppointmentException', { ...guard, instance: { type: 'local', at: '2026-10-21T09:00:00', timeZone: 'Europe/Kyiv' }, changes: { location: 'Other room' } });
    expect(f.request.mock.calls[1][0]).toBe('CreateAppointmentException');
    expect(f.payload().m.inv.comp[0]).toMatchObject({ s: { d: '20261021T090000', tz: 'Europe/Kyiv' }, e: { d: '20261021T100000', tz: 'Europe/Kyiv' }, exceptId: { d: '20261021T090000', tz: 'Europe/Kyiv' } });
    expect(f.payload().m.inv.comp[0]).not.toHaveProperty('recur');
  });
  it('updates task progress without losing subject, categories or due date', async () => {
    const f = fixture({ status: 'NEED', percentComplete: 0 });
    await f.service.execute('updateTask', { ...guard, changes: { status: 'COMP', percentComplete: 100, completedAt: '2026-10-14T10:00:00Z' } });
    expect(f.request.mock.calls[1][0]).toBe('ModifyTask');
    expect(f.payload().m.inv.comp[0]).toMatchObject({ name: 'Planning', status: 'COMP', percentComplete: 100, completed: '20261014T100000Z', e: comp.e, category: comp.category });
  });
});

describe('calendar cancellation and invitation responses', () => {
  it('cancels with explicit recipients but blocks native cancellation under recipient restrictions', async () => {
    const f = fixture();
    await f.service.execute('cancelAppointment', guard);
    expect(f.request.mock.calls[1]).toMatchObject(['CancelAppointment', { id: '257-256', comp: 0, m: { e: [{ a: 'allowed@example.test', t: 't' }] } }, true]);
    const restricted = fixture({}, ['allowed@example.test']);
    await expect(restricted.service.execute('cancelAppointment', guard)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(restricted.request).toHaveBeenCalledOnce();
  });
  it('does not interpret an exception selection as permission to cancel the entire series', async () => {
    const f = fixture({ exceptId: { d: '20261021T090000', tz: 'Europe/Kyiv' } });
    await expect(f.service.execute('cancelAppointment', guard)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.request).toHaveBeenCalledOnce();
  });
  it('addresses a response only to the inspected organizer and respects local-only replies', async () => {
    const f = fixture({ isOrg: false, or: { a: 'organizer@example.test' } }, ['organizer@example.test']);
    await f.service.execute('replyToInvitation', { ...guard, response: 'ACCEPT', message: 'Confirmed' });
    expect(f.request.mock.calls[1]).toMatchObject(['SendInviteReply', { id: '257-256', compNum: 0, verb: 'ACCEPT', updateOrganizer: 1, m: { e: [{ a: 'organizer@example.test', t: 't' }] } }, true]);
    const local = fixture({ isOrg: false, or: { a: 'organizer@example.test' } }, []);
    await local.service.execute('replyToInvitation', { ...guard, response: 'DECLINE', notifyOrganizer: false });
    expect(local.request.mock.calls[1][1]).toMatchObject({ updateOrganizer: 0, m: { e: [] } });
  });
  it('maps INVITE_OUT_OF_DATE to a conflict without automatically retrying a write', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ Body: { Fault: { Detail: { Error: { Code: 'mail.INVITE_OUT_OF_DATE' } } } } })));
    const client = new ZimbraClient({ id: 'z', name: 'Z', backend: 'zimbra', user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' }, { fetch, sessionProvider: async () => ({ kind: 'zimbra-session-v1', endpoint: 'https://mail.example.test/service/soap', user: 'me@example.test', authToken: 'session', expiresAt: Date.now() + 60000 }) });
    await expect(client.executeWrite('createTask', { folderId: '15', subject: 'Task' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
