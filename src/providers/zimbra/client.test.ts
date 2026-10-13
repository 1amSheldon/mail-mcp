import { describe, expect, it, vi } from 'vitest';
import { ZimbraClient } from './client.js';
import { zimbraAccountSchema, type ZimbraConfiguredAccount } from '../account-types.js';
import type { ZimbraSession } from './session.js';

const account: ZimbraConfiguredAccount = { id: 'z', name: 'Zimbra', backend: 'zimbra', user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const session = (): ZimbraSession => ({ kind: 'zimbra-session-v1', endpoint: account.endpoint, user: account.user, authToken: 'secret-token', expiresAt: Date.now() + 60000 });
const response = (name: string, value: unknown) => new Response(JSON.stringify({ Body: { [name + 'Response']: value } }));
const fault = (code: string) => new Response(JSON.stringify({ Body: { Fault: { Detail: { Error: { Code: code } }, Reason: { Text: 'raw private server details secret-token' } } } }), { status: 500 });
function make(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const r of responses) fetch.mockResolvedValueOnce(r);
  const client = new ZimbraClient(account, { fetch, sessionProvider: async () => session() });
  return { fetch, client, body: (i = 0) => JSON.parse(fetch.mock.calls[i][1]!.body as string) };
}

describe('Zimbra SOAP transport and authentication', () => {
  it('accepts only user HTTPS SOAP endpoints without embedded secrets', () => {
    for (const endpoint of ['http://mail/service/soap', 'https://x/service/admin/soap', 'https://a:b@x/service/soap', 'https://x/service/soap?token=x', 'nonsense']) {
      expect(zimbraAccountSchema.safeParse({ ...account, endpoint }).success).toBe(false);
    }
    expect(zimbraAccountSchema.safeParse({ ...account, authToken: 'do-not-store' }).success).toBe(false);
  });
  it('keeps the second factor separate from the password and returns only a session', async () => {
    const { client, body } = make(response('Auth', { authToken: [{ _content: 'unused' }] }));
    await expect(client.authenticate('pass', '123456')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(body().Body.AuthRequest).toMatchObject({ password: { _content: 'pass' }, twoFactorCode: { _content: '123456' } });
    expect(body().Header.context.authToken).toBeUndefined();
  });
  it.each([{ authToken: { _content: 'session' } }, { authToken: [{ _content: 'session' }] }])('accepts singleton and list-valued auth tokens: %j', async ({ authToken }) => {
    const { client, fetch } = make(response('Auth', { authToken, lifetime: 60000 }));
    await expect(client.authenticate('pass', '123456')).resolves.toMatchObject({ authToken: 'session' });
    expect(fetch.mock.calls[0][1]!.headers).not.toHaveProperty('cookie');
  });
  it.each([{ authToken: [] }, { authToken: [{ _content: 'one' }, { _content: 'two' }] }])('rejects ambiguous or missing tokens: %j', async ({ authToken }) => {
    const { client } = make(response('Auth', { authToken, lifetime: 60000 }));
    await expect(client.authenticate('pass')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
  it('routes authenticated SOAP requests with a cookie and context token', async () => {
    const { client, fetch, body } = make(response('GetTag', {}));
    await client.executeRead('listTags', {});
    expect(fetch.mock.calls[0][1]!.headers).toMatchObject({ cookie: 'ZM_AUTH_TOKEN=secret-token' });
    expect(body().Header.context.authToken).toEqual({ _content: 'secret-token' });
  });
  it.each(['bad;cookie=x', 'bad\r\nheader', 'bad token', 'bad"token', 'bad\\token'])('rejects unsafe cookie tokens before dispatch: %j', async authToken => {
    const fetch = vi.fn();
    const client = new ZimbraClient(account, { fetch, sessionProvider: async () => ({ ...session(), authToken }) });
    await expect(client.executeRead('listTags', {})).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403])('classifies empty and HTML HTTP %s for reads and writes without retries', async status => {
    for (const body of [null, '<html>denied</html>']) {
      for (const write of [false, true]) {
        const { client, fetch } = make(new Response(body, { status }));
        await expect(write ? client.executeWrite('deleteTag', { tagId: '7' }) : client.executeRead('listTags', {}))
          .rejects.toMatchObject({ code: status === 401 ? 'AUTH_REQUIRED' : 'ACCESS_DENIED' });
        expect(fetch).toHaveBeenCalledOnce();
      }
    }
  });
  it('preserves an explicit SOAP auth fault returned with HTTP 403', async () => {
    const denied = fault('service.AUTH_EXPIRED');
    const { client } = make(new Response(await denied.text(), { status: 403 }));
    await expect(client.executeWrite('deleteTag', { tagId: '7' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('rejects a temporary token when a second factor is still required', async () => {
    const { client } = make(response('Auth', { authToken: { _content: 'temporary' }, lifetime: 60000, twoFactorAuthRequired: true }));
    await expect(client.authenticate('pass')).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
  });
  it('accepts a complete MFA session with its server lifetime', async () => {
    const { client, body } = make(response('Auth', { authToken: { _content: 'session' }, lifetime: 60000 }));
    const result = await client.authenticate('pass', 'backup-code');
    expect(result).toMatchObject({ user: account.user, endpoint: account.endpoint, authToken: 'session' });
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(result)).not.toContain('pass');
    expect(body().Body.AuthRequest.twoFactorCode).toEqual({ _content: 'backup-code' });
    expect(body().Body.AuthRequest.recoveryCode).toBeUndefined();
  });
  it.each(['service.AUTH_EXPIRED', 'service.AUTH_REQUIRED', 'account.AUTH_FAILED'])('requires local reauthentication on %s without retries', async code => {
    const { client, fetch } = make(fault(code));
    await expect(client.executeRead('listFolders', {})).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('fails before network I/O for an expired or differently scoped session', async () => {
    for (const patch of [{ expiresAt: 1 }, { user: 'other@example.test' }, { endpoint: 'https://other.test/service/soap' }]) {
      const fetch = vi.fn();
      const client = new ZimbraClient(account, { fetch, sessionProvider: async () => ({ ...session(), ...patch }) });
      await expect(client.executeRead('listFolders', {})).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  it('redacts tokens from responses even when general content redaction is disabled', async () => {
    const { client } = make(response('GetFolder', { authToken: 'other', folder: { name: 'secret-token' } }));
    expect(JSON.stringify(await client.executeRead('listFolders', {}))).not.toContain('secret-token');
  });
  it('contains private fault details', async () => {
    const { client } = make(fault('mail.NO_SUCH_MSG'));
    await expect(client.executeRead('readMessage', { messageId: '7' })).rejects.toThrow('Zimbra rejected');
  });
  it('does not follow redirects carrying credentials', async () => {
    const { client, fetch } = make(response('GetTag', {}));
    await client.executeRead('listTags', {});
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });
  it('aborts a stalled request and never retries it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const client = new ZimbraClient(account, { fetch, sessionProvider: async () => session(), timeoutMs: 5 });
    await expect(client.executeRead('listTags', {})).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('bounds chunked responses, including reads without content-length', async () => {
    const oversized = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); c.close(); } }));
    const { client } = make(oversized);
    await expect(client.executeRead('listTags', {})).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
  it('does not send arbitrary SOAP operations or unknown fields', async () => {
    const { client, fetch } = make();
    await expect(client.executeRead('listTags', { authToken: 'override' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.executeWrite('sendDraft', { draftId: '1', password: 'override' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Zimbra operations', () => {
  it('reads without marking messages read', async () => {
    const { client, body } = make(response('GetMsg', { m: [{ id: '7' }] }));
    await client.executeRead('readMessage', { messageId: '7' });
    expect(body().Body.GetMsgRequest.m).toMatchObject({ id: '7', read: 0, max: 200000 });
  });
  it('uses opaque query-bound consumed cursors for native paging', async () => {
    const { client, body } = make(response('Search', { m: [{ id: '7' }], more: true }), response('Search', { m: [{ id: '6' }], more: false }));
    const first = await client.executeRead('searchMessages', { query: 'tag:urgent', limit: 1 }) as { nextCursor: string };
    await expect(client.executeRead('searchMessages', { query: 'tag:other', limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await client.executeRead('searchMessages', { query: 'tag:urgent', limit: 1, cursor: first.nextCursor });
    expect(body(1).Body.SearchRequest.offset).toBe(1);
    await expect(client.executeRead('searchMessages', { query: 'tag:urgent', limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('keeps the cursor reusable after a failed page read', async () => {
    const { client, fetch } = make(response('Search', { m: [{ id: '7' }], more: true }));
    const first = await client.executeRead('searchMessages', { query: '*', limit: 1 }) as { nextCursor: string };
    fetch.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response('Search', { m: [{ id: '6' }], more: false }));
    await expect(client.executeRead('searchMessages', { query: '*', limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await expect(client.executeRead('searchMessages', { query: '*', limit: 1, cursor: first.nextCursor })).resolves.toMatchObject({ nextCursor: null });
  });
  it('preserves native reply/forward linkage and attaches the original message', async () => {
    const { client, body } = make(response('GetMsg', { m: [{ id: '7' }] }), response('SaveDraft', { m: [{ id: '8' }] }));
    await client.executeWrite('createDraft', { to: ['a@example.test'], subject: 'Fwd: test', body: '<p>Hello</p>', isHtml: true, originalMessageId: '7', replyType: 'w', attachOriginal: true });
    expect(body(1).Body.SaveDraftRequest.m).toMatchObject({ origid: '7', rt: 'w', attach: { m: [{ id: '7' }] }, mp: { ct: 'text/html', content: { _content: '<p>Hello</p>' } } });
    expect(body(1).Body.SendMsgRequest).toBeUndefined();
  });
  it('sets the original RFC Message-ID and safely quotes HTML replies', async () => {
    const { client, body } = make(response('GetMsg', { m: [{ id: '7', mid: { _content: '<original@example.test>' }, mp: [{ ct: 'text/plain', content: { _content: '<script>source</script>' } }] }] }), response('SaveDraft', { m: [{ id: '8' }] }));
    await client.executeWrite('createDraft', { to: ['a@example.test'], subject: 'Re: test', body: '<p>Reply</p>', isHtml: true, originalMessageId: '7', replyType: 'r', quoteOriginal: true });
    const saved = body(1).Body.SaveDraftRequest.m;
    expect(saved.irt).toEqual({ _content: '<original@example.test>' });
    expect(saved.mp.content._content).toContain('&lt;script&gt;source&lt;/script&gt;');
  });
  it('never substitutes an unthreaded reply when the source lacks Message-ID', async () => {
    const { client, fetch } = make(response('GetMsg', { m: [{ id: '7' }] }));
    await expect(client.executeWrite('createDraft', { to: ['a@example.test'], subject: 'Re: test', body: 'Reply', originalMessageId: '7', replyType: 'r' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('treats a missing saved draft ID as an uncertain write', async () => {
    const { client } = make(response('SaveDraft', {}));
    await expect(client.executeWrite('createDraft', { to: ['a@example.test'], subject: 'x', body: 'x' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  });
  it('sends the current server draft using sfd, not recomposed text', async () => {
    const { client, body } = make(response('GetMsg', { m: [{ id: '8', f: 'd', e: [{ t: 't', a: 'a@example.test' }] }] }), response('SendMsg', { m: [{ id: '9' }] }));
    await expect(client.executeWrite('sendDraft', { draftId: '8' })).resolves.toMatchObject({ status: 'accepted', retrySafe: false });
    expect(body(1).Body.SendMsgRequest.m).toEqual({ did: '8', sfd: 1 });
    expect(body(1).Body.SendMsgRequest.suid).toBeTruthy();
  });
  it('rejects sending a non-draft message without a write request', async () => {
    const { client, fetch } = make(response('GetMsg', { m: [{ id: '8', f: 'u' }] }));
    await expect(client.executeWrite('sendDraft', { draftId: '8' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('fails closed for recipient restrictions and concurrently editable native drafts', async () => {
    const fetch = vi.fn();
    const client = new ZimbraClient({ ...account, allowedRecipients: [] }, { fetch, sessionProvider: async () => session() });
    await expect(client.executeWrite('sendDraft', { draftId: '8' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not retry a send on connection loss', async () => {
    const { client, fetch } = make(response('GetMsg', { m: [{ id: '8', f: 'd', e: [{ t: 't', a: 'a@example.test' }] }] }));
    fetch.mockRejectedValueOnce(new Error('lost socket'));
    await expect(client.executeWrite('sendDraft', { draftId: '8' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not claim safe retry after a SaveDraft metadata fault', async () => {
    const { client } = make(fault('mail.NO_SUCH_TAG'));
    await expect(client.executeWrite('createDraft', { to: ['a@example.test'], subject: 'x', body: 'x' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  });
  it('uses a cookie instead of putting the attachment token in the URL', async () => {
    const { client, fetch } = make(new Response('file', { headers: { 'content-type': 'text/plain' } }));
    await expect(client.executeRead('getAttachment', { messageId: '7', partId: '2.1' })).resolves.toEqual(Buffer.from('file'));
    expect(String(fetch.mock.calls[0][0])).not.toContain('secret-token');
    expect(fetch.mock.calls[0][1]!.headers).toMatchObject({ cookie: 'ZM_AUTH_TOKEN=secret-token' });
  });
  it('bounds attachments and cancels oversized downloads', async () => {
    const { client } = make(new Response('123456'));
    await expect(client.executeRead('getAttachment', { messageId: '7', partId: '2', maxBytes: 5 })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
  it('uses native contact and tag endpoints', async () => {
    const { client, body } = make(response('GetContacts', { cn: [{ id: '7' }] }), response('MsgAction', {}));
    await client.executeRead('getContact', { contactId: '7' });
    await client.executeWrite('addTag', { messageIds: ['8', '9'], tagName: 'urgent' });
    expect(body().Body.GetContactsRequest.cn.id).toBe('7');
    expect(body(1).Body.MsgActionRequest.action).toEqual({ id: '8,9', op: 'tag', tn: 'urgent' });
  });
});


describe('Zimbra tag-name validation before dispatch', () => {
  it.each(['', 'x'.repeat(256), 'Project/2026', 'bad:name', 'bad"name', 'bad\tname', 'bad\rname', 'bad\nname', 'bad\0name', '.', '..', '   ', '.. '])('rejects invalid tag name %j without network I/O', async name => {
    const { client, fetch } = make();
    for (const operation of ['createTag', 'addTag', 'removeTag'] as const) {
      await expect(client.executeWrite(operation, operation === 'createTag' ? { name } : { messageIds: ['7'], tagName: name }))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['x'.repeat(255), 'Project 2026', 'Important'])('preserves valid tag name %j', async name => {
    const { client, body } = make(response('CreateTag', { tag: [{ id: '9', name }] }));
    await client.executeWrite('createTag', { name });
    expect(body().Body.CreateTagRequest.tag.name).toBe(name);
  });
});
