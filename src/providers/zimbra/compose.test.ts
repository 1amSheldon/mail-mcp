import { describe, expect, it, vi } from 'vitest';
import { composeMime } from './mime.js';
import { addresses, parseMime, replyEnvelope } from './compose.js';
import { ZimbraClient } from './client.js';

const account = { id: 'z', name: 'Zimbra', backend: 'zimbra' as const, user: 'me@example.test', fromAliases: ['alias@example.test'], endpoint: 'https://mail.example.test/service/soap' };
const options = (fetch: typeof globalThis.fetch) => ({ fetch, sessionProvider: async () => ({ kind: 'zimbra-session-v1' as const, user: account.user, endpoint: account.endpoint, authToken: 'session', expiresAt: Date.now() + 60000 }) });
const response = (name: string, value: unknown) => new Response(JSON.stringify({ Body: { [name + 'Response']: value } }));

describe('Zimbra reply composition', () => {
  it('uses Reply-To, excludes own aliases, deduplicates across To/CC, and never infers Bcc', async () => {
    const raw = await composeMime({ from: 'sender@example.test', replyTo: 'reply@example.test', to: 'me@example.test, alias@example.test, other@example.test', cc: 'OTHER@example.test, colleague@example.test', bcc: 'private@example.test', subject: 'Report', text: 'Body' }, account.user);
    const parsed = await parseMime(raw);
    expect(replyEnvelope(parsed, [account.user, ...account.fromAliases], true)).toEqual({ to: ['reply@example.test', 'other@example.test'], cc: ['colleague@example.test'], subject: 'Re: Report', references: [parsed.messageId] });
  });
  it('replies to the original recipients of a message sent by self and flattens address groups', async () => {
    const raw = await composeMime({ from: account.user, to: 'Team: one@example.test, two@example.test;', cc: 'alias@example.test, extra@example.test', subject: 'Re: Report', text: 'Body' }, account.user);
    const parsed = await parseMime(raw);
    expect(addresses(parsed.to)).toEqual(['one@example.test', 'two@example.test']);
    expect(replyEnvelope(parsed, [account.user, ...account.fromAliases], true)).toMatchObject({ to: ['one@example.test', 'two@example.test'], cc: ['extra@example.test'], subject: 'Re: Report' });
  });
  it('creates an unsent reply-all draft with inherited files and complete reply headers', async () => {
    const original = await composeMime({ from: 'sender@example.test', to: account.user, cc: 'colleague@example.test', subject: 'Report', text: 'Original', threading: { references: '<root@example.test>' }, attachments: [{ filename: 'report.csv', contentBase64: 'YSxiCg==' }] }, account.user);
    const source = await parseMime(original);
    let uploaded: Buffer | undefined; const writes: any[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).includes('/service/home/')) return new Response(new Uint8Array(original));
      if (String(url).includes('/service/upload')) {
        const form = init?.body as FormData; uploaded = Buffer.from(await (form.get('file') as Blob).arrayBuffer());
        return new Response(`200,'${form.get('requestId')}','aid'`);
      }
      const request = JSON.parse(String(init?.body));
      if (request.Body.GetMsgRequest) return response('GetMsg', { m: [{ id: '7', mid: { _content: source.messageId } }] });
      writes.push(request);
      return response('SaveDraft', { m: [{ id: '8' }] });
    });
    await new ZimbraClient(account, options(fetch)).executeWrite('createReplyAllDraft', { messageId: '7', body: 'Reply', includeOriginalAttachments: true, attachments: [{ filename: 'new.txt', contentBase64: 'bmV3' }] });
    const draft = await parseMime(uploaded!);
    expect(addresses(draft.to)).toEqual(['sender@example.test']);
    expect(addresses(draft.cc)).toEqual(['colleague@example.test']);
    expect(draft.inReplyTo).toBe(source.messageId);
    expect(draft.references).toEqual(['<root@example.test>', source.messageId]);
    expect(draft.attachments.map(a => a.filename)).toEqual(['report.csv', 'new.txt']);
    expect(writes).toHaveLength(1);
    expect(writes[0].Body.SaveDraftRequest.m).toEqual({ aid: 'aid', origid: '7', rt: 'r' });
  });
  it('selects a native identity and signature for both body formats without losing Reply-To', async () => {
    const identityId = '01234567-89ab-4def-8123-456789abcdef';
    const signatureId = '01234567-89ab-4def-8123-456789abcdea';
    const requests: any[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)); requests.push(request);
      if (request.Body.GetIdentitiesRequest) return response('GetIdentities', { identity: [{ id: identityId, _attrs: { zimbraPrefFromAddress: 'persona@example.test', zimbraPrefReplyToEnabled: 'TRUE', zimbraPrefReplyToAddress: 'reply@example.test' } }] });
      if (request.Body.GetSignaturesRequest) return response('GetSignatures', { signature: [{ id: signatureId, content: [{ type: 'text/plain', _content: 'Plain signature' }, { type: 'text/html', _content: '<b>HTML signature</b>' }] }] });
      return response('SaveDraft', { m: [{ id: '8' }] });
    });
    await new ZimbraClient(account, options(fetch)).executeWrite('createDraft', { to: ['to@example.test'], subject: 'Test', textBody: 'Plain', htmlBody: '<p>Rich</p>', identityId, signatureId });
    const saved = requests[2].Body.SaveDraftRequest.m;
    expect(saved.idnt).toBe(identityId);
    expect(saved.e).toContainEqual({ t: 'f', a: 'persona@example.test' });
    expect(saved.e).toContainEqual({ t: 'r', a: 'reply@example.test' });
    expect(saved.mp).toEqual({ ct: 'multipart/alternative', mp: [{ ct: 'text/plain', content: { _content: 'Plain\n\nPlain signature' } }, { ct: 'text/html', content: { _content: '<p>Rich</p><br><br><b>HTML signature</b>' } }] });
  });
  it('rejects unauthorized From and ambiguous body shapes before network access', async () => {
    const fetch = vi.fn(); const client = new ZimbraClient(account, options(fetch));
    await expect(client.executeWrite('createDraft', { to: ['to@example.test'], subject: 'Test', body: 'Body', from: 'stranger@example.test' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(client.executeWrite('createDraft', { to: ['to@example.test'], subject: 'Test', body: 'Body', htmlBody: '<b>Other</b>' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a missing reply Message-ID before any draft write', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('From: sender@example.test\r\nTo: me@example.test\r\n\r\nBody'));
    await expect(new ZimbraClient(account, options(fetch)).executeWrite('createReplyDraft', { messageId: '7', body: 'Reply' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
