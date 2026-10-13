import { describe, expect, it, vi } from 'vitest';
import { ZimbraClient } from './client.js';

const account = { id: 'z', name: 'Zimbra', backend: 'zimbra' as const, user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const response = (name: string, value: unknown) => new Response(JSON.stringify({ Body: { [name + 'Response']: value } }));
function setup(...results: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const result of results) fetch.mockResolvedValueOnce(result);
  const client = new ZimbraClient(account, { fetch, sessionProvider: async () => ({ kind: 'zimbra-session-v1', endpoint: account.endpoint, user: account.user, authToken: 'session', expiresAt: Date.now() + 60000 }) });
  return { client, fetch };
}
describe('Zimbra bounded mail reads', () => {
  it('distinguishes local session availability from a live authenticated check', async () => {
    const { client, fetch } = setup(response('GetInfo', { version: 'test' }));
    expect(await client.executeRead('sessionStatus', {})).toMatchObject({ remoteVerified: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(await client.executeRead('sessionStatus', { remote: true })).toMatchObject({ remoteVerified: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not turn absent counts from a shared folder into zeros', async () => {
    const { client } = setup(response('GetFolder', { folder: [{ id: '1', folder: [{ id: '2', n: 4, u: 0 }], link: [{ id: '256', name: 'Shared' }] }] }));
    const result = await client.executeRead('mailboxStats', {}) as { items: unknown[] };
    expect(result.items).toContainEqual(expect.objectContaining({ id: '2', messages: 4, unread: 0 }));
    expect(result.items).toContainEqual(expect.objectContaining({ id: '256', messages: null, unread: null }));
  });
  it('extracts a selected text part with its declared encoding and explicit truncation', async () => {
    const { client } = setup(response('GetMsg', { m: [{ id: '7', mp: [{ ct: 'multipart/mixed', mp: [{ ct: 'text/plain', part: '2', charset: 'windows-1252' }] }] }] }), new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x21])));
    expect(await client.executeRead('extractAttachmentText', { messageId: '7', partId: '2', maxChars: 4 })).toMatchObject({ text: 'caf\u00e9', partial: true });
  });
  it('rejects absent or unsupported parts before downloading their bytes', async () => {
    for (const partId of ['2', '3']) {
      const { client, fetch } = setup(response('GetMsg', { m: [{ id: '7', mp: [{ ct: 'image/png', part: '2' }] }] }));
      await expect(client.executeRead('extractAttachmentText', { messageId: '7', partId })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
  it('extracts real PDF bytes through the selected part and reports character truncation', async () => {
    const stream = 'BT /F1 12 Tf 20 100 Td (Invoice 39A total 1234.56) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    let pdf = '%PDF-1.4\n'; const offsets: number[] = [];
    objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
    const start = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
    const { client } = setup(response('GetMsg', { m: [{ id: '7', mp: [{ ct: 'application/pdf', part: '2' }] }] }), new Response(pdf));
    expect(await client.executeRead('extractAttachmentText', { messageId: '7', partId: '2', maxChars: 11, maxPages: 1 })).toMatchObject({ text: 'Invoice 39A', pages: 1, partial: true });
  }, 30000);
  it('verifies Message-ID rather than treating any search hit as the sent message', async () => {
    const { client } = setup(response('Search', { m: [{ id: '9', mid: '<wrong@example.test>' }, { id: '10' }], more: true }), response('GetMsg', { m: [{ id: '10', mid: { _content: '<wanted@example.test>' } }] }));
    expect(await client.executeRead('verifySentMessage', { messageId: '<wanted@example.test>' })).toMatchObject({ status: 'found', sentMessageIds: ['10'], partial: true });
  });
  it('distinguishes a truncated verification search from an absent Sent copy', async () => {
    for (const more of [true, false]) {
      const { client } = setup(response('Search', { m: [], more }));
      expect(await client.executeRead('verifySentMessage', { messageId: '<wanted@example.test>' })).toMatchObject({ status: more ? 'indeterminate' : 'not_found' });
    }
  });
  it('copies through the message action without issuing move or delete', async () => {
    const { client, fetch } = setup(response('MsgAction', { action: { id: '7', op: 'copy' } }));
    await client.executeWrite('copyMessages', { messageIds: ['7'], folderId: '257' });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).Body).toEqual({ MsgActionRequest: { _jsns: 'urn:zimbraMail', action: { id: '7', op: 'copy', l: '257' } } });
  });
});
