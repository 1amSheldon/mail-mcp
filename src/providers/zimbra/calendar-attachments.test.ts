import { describe, expect, it, vi } from 'vitest';
import { calendarAttachmentWriter } from './calendar-attachments.js';
import { ZimbraCalendar } from './calendar.js';
import { ZimbraCalendarEdits } from './calendar-edit.js';

const file = { filename: 'report.txt', contentBase64: 'YWJj', contentType: 'text/plain' };
const image = { filename: 'image.png', contentBase64: 'AAECAw==', contentType: 'image/png', contentDisposition: 'inline' as const, cid: 'logo' };
const event = { folderId: '10', subject: 'Planning', start: { type: 'date', date: '2026-10-14' }, endExclusive: { type: 'date', date: '2026-10-15' }, htmlDescription: '<img src="cid:logo">' };

describe('calendar attachment composition', () => {
  it('uploads regular and inline bytes and builds native related MIME references', async () => {
    const upload = vi.fn().mockResolvedValueOnce('regular').mockResolvedValueOnce('image');
    const request = vi.fn().mockResolvedValue({ calItemId: '257' });
    const service = new ZimbraCalendar(request, 'me@example.test', undefined, vi.fn(), calendarAttachmentWriter(upload));
    await service.write('createAppointment', { ...event, attachments: [file, image] });
    expect(upload.mock.calls).toEqual([[Buffer.from('abc'), 'report.txt', 'text/plain'], [Buffer.from([0, 1, 2, 3]), 'image.png', 'image/png']]);
    expect(request.mock.calls[0]).toEqual(['CreateAppointment', expect.objectContaining({ m: expect.objectContaining({
      attach: { aid: 'regular' }, mp: { ct: 'multipart/related', mp: [
        { ct: 'text/html', content: { _content: event.htmlDescription } }, { ct: 'image/png', ci: 'logo', attach: { aid: 'image' } },
      ] },
    }) }), true]);
  });
  it('validates all attachments before uploading or creating a task', async () => {
    const upload = vi.fn(); const request = vi.fn();
    const service = new ZimbraCalendar(request, 'me@example.test', undefined, vi.fn(), calendarAttachmentWriter(upload));
    await expect(service.write('createTask', { folderId: '15', subject: 'Task', attachments: [file, { ...image, cid: '<bad>' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(upload).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    await expect(service.write('createTask', { folderId: '15', subject: 'Task', attachments: [{ path: 'C:/not-authorized/report.pdf' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(upload).not.toHaveBeenCalled();
  });
  it('rejects duplicate CIDs and conflicting disposition without uploads', async () => {
    const upload = vi.fn(); const write = calendarAttachmentWriter(upload);
    await expect(write({ mp: {} }, [image, image])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(write({ mp: {} }, [{ ...image, contentDisposition: 'attachment' }])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(upload).not.toHaveBeenCalled();
  });
  it('does not create a calendar item when an attachment upload fails', async () => {
    const upload = vi.fn().mockResolvedValueOnce('orphan').mockRejectedValueOnce(new Error('network'));
    const request = vi.fn(); const service = new ZimbraCalendar(request, 'me@example.test', undefined, vi.fn(), calendarAttachmentWriter(upload));
    await expect(service.write('createAppointment', { ...event, attachments: [file, image] })).rejects.toThrow('network');
    expect(request).not.toHaveBeenCalled();
  });
  it('replaces or removes attachments explicitly while preserving omitted description content', async () => {
    for (const attachments of [[file], []]) {
      const request = vi.fn().mockResolvedValueOnce({ appt: [{ id: '257', ms: 4, rev: 3, l: '10', inv: [{ id: 256, compNum: 0, comp: [{ noBlob: true, isOrg: true, name: 'Planning', desc: { _content: 'Keep text' }, s: { d: '20261014T090000Z' }, e: { d: '20261014T100000Z' } }], mp: [{ ct: 'application/pdf', filename: 'old.pdf', part: '2' }] }] }] }).mockResolvedValue({});
      const upload = vi.fn().mockResolvedValue('replacement');
      const service = new ZimbraCalendarEdits(request, vi.fn(), 'me@example.test', undefined, calendarAttachmentWriter(upload));
      await service.execute('updateAppointment', { invitationId: '257-256', expectedModSequence: '4', expectedRevision: '3', changes: { attachments } });
      const m = request.mock.calls[1][1].m;
      expect(m.mp).toEqual({ ct: 'text/plain', content: { _content: 'Keep text' } });
      if (attachments.length) expect(m.attach).toEqual({ aid: 'replacement' });
      else expect(m).not.toHaveProperty('attach');
    }
  });
});
