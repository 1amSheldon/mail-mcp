import { describe, expect, it, vi } from 'vitest';
import { ZimbraClient } from './client.js';
import type { ZimbraConfiguredAccount } from '../account-types.js';

const account: ZimbraConfiguredAccount = { id: 'z', name: 'Zimbra', backend: 'zimbra', user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const response = (name: string, value: unknown) => new Response(JSON.stringify({ Body: { [name + 'Response']: value } }));
const metadata = (version = 3) => response('GetItem', { doc: [{ id: '257', ver: version, name: 'report.txt', desc: 'Quarterly report', descEnabled: true }] });
function fixture(responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(); responses.forEach(r => fetch.mockResolvedValueOnce(r));
  const client = new ZimbraClient(account, { fetch, sessionProvider: async () => ({ kind: 'zimbra-session-v1', endpoint: account.endpoint, user: account.user, authToken: 'session', expiresAt: Date.now() + 60000 }) });
  return { client, fetch, request: (i = 0) => JSON.parse(String(fetch.mock.calls[i][1]?.body)) };
}

describe('Zimbra Briefcase content and version integrity', () => {
  it('uploads original binary bytes then creates a document with no replacement ID/version', async () => {
    const { client, fetch, request } = fixture([]);
    const bytes = Buffer.from([0, 255, 1, 2]);
    fetch.mockImplementationOnce(async (_url, init) => {
      const form = init?.body as FormData;
      expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(bytes);
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toEqual({ cookie: 'ZM_AUTH_TOKEN=session' });
      return new Response("200,'" + form.get('requestId') + "','upload-id'");
    }).mockResolvedValueOnce(response('SaveDocument', { doc: { id: '257', ver: 1 } }));
    await client.executeWrite('createDocument', { folderId: '16', name: 'data.bin', source: { type: 'file', file: { filename: 'data.bin', contentBase64: bytes.toString('base64') } } });
    expect(request(1).Body.SaveDocumentRequest.doc).toEqual({ l: '16', name: 'data.bin', upload: { id: 'upload-id' } });
  });
  it('uses content as a native attribute and preserves omitted metadata on updates', async () => {
    const { client, request } = fixture([metadata(), response('SaveDocument', { doc: { id: '257', ver: 4 } })]);
    await client.executeWrite('updateDocument', { documentId: '257', expectedVersion: 3, source: { type: 'text', text: 'Updated content' } });
    expect(request(1).Body.SaveDocumentRequest.doc).toEqual({ id: '257', ver: 3, name: 'report.txt', desc: 'Quarterly report', descEnabled: true, content: 'Updated content', ct: 'text/plain' });
  });
  it('allows explicit description clearing without replacing omitted content metadata', async () => {
    const { client, request } = fixture([metadata(), response('SaveDocument', {})]);
    await client.executeWrite('updateDocument', { documentId: '257', expectedVersion: 3, description: '', descriptionEnabled: false, source: { type: 'attachment', messageId: '111', partId: '2.1' } });
    expect(request(1).Body.SaveDocumentRequest.doc).toMatchObject({ name: 'report.txt', desc: '', descEnabled: false, m: { id: '111', part: '2.1' } });
  });
  it('rejects stale versions before any upload or save', async () => {
    const { client, fetch } = fixture([metadata(4)]);
    await expect(client.executeWrite('updateDocument', { documentId: '257', expectedVersion: 3, source: { type: 'file', file: { filename: 'x.txt', contentBase64: 'eA==' } } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('preserves a server version conflict after preflight instead of retrying the save', async () => {
    const fault = new Response(JSON.stringify({ Body: { Fault: { Detail: { Error: { Code: 'mail.MODIFY_CONFLICT' } } } } }));
    const { client, fetch } = fixture([metadata(), fault]);
    await expect(client.executeWrite('updateDocument', { documentId: '257', expectedVersion: 3, source: { type: 'text', text: 'new' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('restores a historical version by adding a guarded revision, not deleting history', async () => {
    const { client, request } = fixture([metadata(), response('SaveDocument', { doc: { id: '257', ver: 4 } })]);
    await client.executeWrite('restoreDocumentRevision', { documentId: '257', expectedVersion: 3, restoreVersion: 1 });
    expect(request(1).Body.SaveDocumentRequest.doc).toEqual({ id: '257', ver: 3, doc: { id: '257', ver: 1 } });
  });
  it('rejects unconfigured file paths and invalid base64 before network upload', async () => {
    const { client, fetch } = fixture([]);
    for (const file of [{ path: 'C:/unapproved/private.txt' }, { filename: 'x.txt', contentBase64: '%%%bad%%%' }]) {
      await expect(client.executeWrite('createDocument', { folderId: '16', name: 'x.txt', source: { type: 'file', file } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Briefcase bounded reads and actions', () => {
  it('downloads a pinned revision by cookie without forwarding credentials to redirects', async () => {
    const { client, fetch } = fixture([metadata(), new Response('document bytes')]);
    expect(await client.executeRead('downloadDocument', { documentId: '257' })).toEqual(Buffer.from('document bytes'));
    const url = new URL(String(fetch.mock.calls[1][0]));
    expect(url.pathname).toBe('/service/home/~/');
    expect(Object.fromEntries(url.searchParams)).toEqual({ id: '257', ver: '3', auth: 'co' });
    expect(fetch.mock.calls[1][1]).toMatchObject({ redirect: 'error', headers: { cookie: 'ZM_AUTH_TOKEN=session' } });
  });
  it('does not download another item type and bounds the response stream', async () => {
    const other = fixture([response('GetItem', { m: [{ id: '257' }] })]);
    await expect(other.client.executeRead('downloadDocument', { documentId: '257' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(other.fetch).toHaveBeenCalledOnce();
    const large = fixture([metadata(), new Response('12345')]);
    await expect(large.client.executeRead('downloadDocument', { documentId: '257', maxBytes: 4 })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
  it('advances revision windows through purged gaps rather than stopping at short pages', async () => {
    const { client, request } = fixture([metadata(8), response('ListDocumentRevisions', { doc: [{ id: '257', ver: 8 }] }), response('ListDocumentRevisions', { doc: [{ id: '257', ver: 1 }] })]);
    expect(await client.executeRead('listDocumentRevisions', { documentId: '257', count: 5 })).toMatchObject({ nextVersion: 3, partial: true });
    expect(request(1).Body.ListDocumentRevisionsRequest.doc).toEqual({ id: '257', ver: 8, count: 5 });
    expect(await client.executeRead('listDocumentRevisions', { documentId: '257', fromVersion: 3, count: 5 })).toMatchObject({ nextVersion: null, partial: false });
  });
  it('searches the document item type and keeps its cursor separate from message searches', async () => {
    const { client, request } = fixture([response('Search', { doc: [{ id: '257' }], more: 1 })]);
    const result = await client.executeRead('searchDocuments', { query: 'in:briefcase', limit: 1 }) as { nextCursor: string };
    expect(request().Body.SearchRequest.types).toBe('document');
    await expect(client.executeRead('searchMessages', { query: 'in:briefcase', limit: 1, cursor: result.nextCursor })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('uses document-typed actions for lock, tags and trash', async () => {
    const { client, request } = fixture([response('DocumentAction', {}), response('DocumentAction', {}), response('DocumentAction', {})]);
    await client.executeWrite('setDocumentLock', { documentId: '257', locked: true });
    await client.executeWrite('setDocumentTag', { documentId: '257', tagName: 'Reviewed', enabled: false });
    await client.executeWrite('trashDocument', { documentId: '257' });
    expect(request().Body.DocumentActionRequest.action).toEqual({ id: '257', op: 'lock' });
    expect(request(1).Body.DocumentActionRequest.action).toEqual({ id: '257', op: '!tag', tn: 'Reviewed' });
    expect(request(2).Body.DocumentActionRequest.action).toEqual({ id: '257', op: 'trash' });
  });
  it('grants only native supported file principals and revokes a single grant', async () => {
    const { client, fetch, request } = fixture([response('DocumentAction', {}), response('DocumentAction', {})]);
    const uuid = '01234567-89ab-4def-8123-456789abcdef';
    await expect(client.executeWrite('grantDocumentAccess', { documentId: '257', grantee: { type: 'grp', id: uuid }, permissions: 'r' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
    await client.executeWrite('grantDocumentAccess', { documentId: '257', grantee: { type: 'usr', id: uuid }, permissions: 'rw' });
    await client.executeWrite('revokeDocumentAccess', { documentId: '257', granteeId: uuid });
    expect(request().Body.DocumentActionRequest.action).toEqual({ id: '257', op: 'grant', grant: { gt: 'usr', zid: uuid, perm: 'rw' } });
    expect(request(1).Body.DocumentActionRequest.action).toEqual({ id: '257', op: '!grant', zid: uuid });
  });
});
