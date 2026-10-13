import { describe, expect, it, vi } from 'vitest';
import { simpleParser } from 'mailparser';
import { composeMime, parseUploadResponse } from './mime.js';
import { ZimbraClient } from './client.js';

const account = { id: 'z', name: 'Zimbra', backend: 'zimbra' as const, user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const session = () => ({ kind: 'zimbra-session-v1' as const, endpoint: account.endpoint, user: account.user, authToken: 'session', expiresAt: Date.now() + 60000 });

describe('Zimbra MIME composition and upload', () => {
  it('does not silently cancel a native schedule while patching a draft', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ Body: { GetMsgResponse: { m: [{ id: '8', f: 'd', ms: 42, autoSendTime: Date.now() + 3600000 }] } } })));
    const client = new ZimbraClient(account, { fetch, sessionProvider: async () => session() });
    await expect(client.executeWrite('updateDraft', { draftId: '8', expectedRevision: '42', changes: { subject: 'New' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).Body).toHaveProperty('GetMsgRequest');
  });
  it('round-trips Unicode, both body formats, Bcc, reply headers and an inline CID', async () => {
    const raw = await composeMime({ to: 'to@example.test', bcc: 'hidden@example.test', subject: 'Delivery: \u0424\u0430\u0439\u043b', text: 'Report', html: '<p>Report<img src="cid:logo"></p>',
      threading: { inReplyTo: '<source@example.test>', references: ['<root@example.test>', '<source@example.test>'] },
      attachments: [{ filename: 'logo.png', contentBase64: 'AAECAw==', contentType: 'image/png', contentDisposition: 'inline', cid: 'logo' }],
    }, account.user);
    const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
    expect(parsed.subject).toBe('Delivery: \u0424\u0430\u0439\u043b');
    expect(parsed.bcc).toMatchObject({ value: [{ address: 'hidden@example.test' }] });
    expect(parsed.html).toContain('cid:logo');
    expect(parsed.inReplyTo).toBe('<source@example.test>');
    expect(parsed.references).toEqual(['<root@example.test>', '<source@example.test>']);
    expect(parsed.attachments[0].content).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(parsed.attachments[0].contentId).toBe('<logo>');
  });
  it('does not accept executable upload replies, mismatched request IDs or multiple attachment IDs', () => {
    expect(parseUploadResponse("200,'request','server:123-4'", 'request')).toBe('server:123-4');
    for (const value of ["200,'other','id'", "500,'request','id'", "200,'request','id';alert(1)", "200,'request','one,two'", '<html>error</html>']) {
      expect(() => parseUploadResponse(value, 'request')).toThrow();
    }
  });
  it('uploads checked MIME using a cookie and saves its ID without sending', async () => {
    let uploaded: Buffer | undefined;
    const payloads: any[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).includes('/service/upload')) {
        expect(String(url)).toBe('https://mail.example.test/service/upload?fmt=raw');
        expect(init?.headers).toMatchObject({ cookie: 'ZM_AUTH_TOKEN=session' });
        expect(init?.redirect).toBe('error');
        const form = init?.body as FormData;
        uploaded = Buffer.from(await (form.get('file') as Blob).arrayBuffer());
        return new Response(`200,'${form.get('requestId')}','uploaded-id'`);
      }
      const payload = JSON.parse(String(init?.body)); payloads.push(payload);
      return new Response(JSON.stringify({ Body: { SaveDraftResponse: { m: [{ id: '9' }] } } }));
    });
    const client = new ZimbraClient(account, { fetch, sessionProvider: async () => session() });
    await expect(client.executeWrite('createDraft', { to: ['to@example.test'], bcc: ['hidden@example.test'], subject: 'Report', body: 'Attached', attachments: [{ filename: 'report.txt', contentBase64: 'YWJj' }] })).resolves.toMatchObject({ draftId: '9' });
    const parsed = await simpleParser(uploaded!);
    expect(parsed.attachments[0].content.toString()).toBe('abc');
    expect(parsed.bcc).toMatchObject({ value: [{ address: 'hidden@example.test' }] });
    expect(payloads).toEqual([{ Header: { context: { _jsns: 'urn:zimbra', authToken: { _content: 'session' } } }, Body: { SaveDraftRequest: { _jsns: 'urn:zimbraMail', m: { aid: 'uploaded-id' } } } }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('never attempts SaveDraft after a failed upload and never repeats it automatically', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('connection lost'));
    const client = new ZimbraClient(account, { fetch, sessionProvider: async () => session() });
    await expect(client.executeWrite('createDraft', { to: ['to@example.test'], subject: 'Report', body: 'Attached', attachments: [] })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects invalid base64 and disabled local file sources before uploading', async () => {
    const fetch = vi.fn();
    const client = new ZimbraClient(account, { fetch, sessionProvider: async () => session() });
    for (const attachment of [{ filename: 'x', contentBase64: 'invalid!' }, { path: 'relative.txt' }]) {
      await expect(client.executeWrite('createDraft', { to: ['to@example.test'], subject: 'Report', body: 'Attached', attachments: [attachment] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('downloads raw MIME without changing read state or accepting arbitrary URLs', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('Subject: test\r\n\r\nbody'));
    const client = new ZimbraClient(account, { fetch, sessionProvider: async () => session() });
    await expect(client.executeRead('getRawMessage', { messageId: '7' })).resolves.toEqual(Buffer.from('Subject: test\r\n\r\nbody'));
    expect(String(fetch.mock.calls[0][0])).toBe('https://mail.example.test/service/home/~/?id=7&fmt=raw&auth=co');
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { cookie: 'ZM_AUTH_TOKEN=session' } });
  });
  it('patches only the subject while preserving HTML, Bcc, threading and inline attachment bytes', async () => {
    const raw = await composeMime({ to: 'to@example.test', bcc: 'hidden@example.test', subject: 'Old', text: 'Body', html: '<p>Exact signature<img src="cid:logo"></p>',
      threading: { inReplyTo: '<source@example.test>' }, attachments: [{ filename: 'logo.png', contentBase64: 'AAECAw==', contentType: 'image/png', contentDisposition: 'inline', cid: 'logo' }],
    }, account.user);
    let uploaded: Buffer | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Body: { GetMsgResponse: { m: [{ id: '8', f: 'd', ms: 42 }] } } })))
      .mockResolvedValueOnce(new Response(new Uint8Array(raw)))
      .mockImplementationOnce(async (_url, init) => {
        const form = init?.body as FormData;
        uploaded = Buffer.from(await (form.get('file') as Blob).arrayBuffer());
        return new Response(`200,'${form.get('requestId')}','aid'`);
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ Body: { SaveDraftResponse: { m: [{ id: '8' }] } } })));
    const client = new ZimbraClient(account, { fetch, sessionProvider: async () => session() });
    await expect(client.executeWrite('updateDraft', { draftId: '8', expectedRevision: '42', changes: { subject: 'New' } })).resolves.toMatchObject({ draftId: '8' });
    const updated = await simpleParser(uploaded!, { skipImageLinks: true });
    const original = await simpleParser(raw, { skipImageLinks: true });
    expect(updated.subject).toBe('New');
    expect(updated.html).toBe(original.html);
    expect(updated.text).toBe(original.text);
    expect(updated.bcc).toEqual(original.bcc);
    expect(updated.messageId).toBe(original.messageId);
    expect(updated.inReplyTo).toBe(original.inReplyTo);
    expect(updated.attachments[0].content).toEqual(original.attachments[0].content);
    expect(updated.attachments[0].cid).toBe('logo');
    expect(JSON.parse(String(fetch.mock.calls[3][1]?.body)).Header.context.change).toEqual({ token: '42', type: 'mod' });
  });
  it('rejects a stale selected draft revision before downloading or uploading content', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ Body: { GetMsgResponse: { m: [{ id: '8', f: 'd', ms: 43 }] } } })));
    const client = new ZimbraClient(account, { fetch, sessionProvider: async () => session() });
    await expect(client.executeWrite('updateDraft', { draftId: '8', expectedRevision: '42', changes: { subject: 'New' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('reports a server modification conflict without retrying', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ Body: { Fault: { Detail: { Error: { Code: 'mail.MODIFY_CONFLICT' } } } } }), { status: 500 }));
    const client = new ZimbraClient(account, { fetch, sessionProvider: async () => session() });
    await expect(client.executeWrite('deleteTag', { tagId: '7' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
