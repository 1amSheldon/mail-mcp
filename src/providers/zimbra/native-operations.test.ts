import { describe, expect, it, vi } from 'vitest';
import { ZimbraClient } from './client.js';
import { MAIL_MUTATION_OPERATIONS, MAIL_QUERY_OPERATIONS } from '../../mcp/tool-catalog.js';
import { ZIMBRA_READ_SCHEMAS, ZIMBRA_WRITE_SCHEMAS } from './operations.js';

const account = { id: 'z', name: 'Zimbra', backend: 'zimbra' as const, user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
function setup() {
  const requests: Record<string, any>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    requests.push(payload);
    const method = Object.keys(payload.Body)[0].replace(/Request$/, '');
    return new Response(JSON.stringify({ Body: { [method + 'Response']: {} } }));
  });
  const client = new ZimbraClient(account, { fetch, sessionProvider: async () => ({ kind: 'zimbra-session-v1', endpoint: account.endpoint, user: account.user, authToken: 'session', expiresAt: Date.now() + 60000 }) });
  return { client, fetch, requests };
}

describe('native user-mailbox workflows', () => {
  it('creates a typed contacts folder and patches a contact without replacing its other attributes', async () => {
    const { client, requests } = setup();
    await client.executeWrite('createFolder', { name: 'Suppliers', parentFolderId: '1', view: 'contact' });
    await client.executeWrite('createContact', { folderId: '257', fields: { firstName: 'Alex', email: 'alex@example.test', company: 'Supplier' } });
    await client.executeWrite('updateContact', { contactId: '258', fields: { company: 'New supplier', workPhone: '' } });
    expect(requests[0].Body.CreateFolderRequest.folder).toEqual({ name: 'Suppliers', l: '1', view: 'contact' });
    expect(requests[1].Body.CreateContactRequest.cn).toMatchObject({ l: '257', a: [{ n: 'firstName', _content: 'Alex' }, { n: 'email', _content: 'alex@example.test' }, { n: 'company', _content: 'Supplier' }] });
    expect(requests[2].Body.ModifyContactRequest).toEqual({ _jsns: 'urn:zimbraMail', replace: 0, verbose: 1, cn: { id: '258', a: [{ n: 'company', _content: 'New supplier' }, { n: 'workPhone', _content: '' }] } });
  });
  it('distinguishes reversible trash, deletion and explicit dumpster recovery', async () => {
    const { client, requests } = setup();
    await client.executeWrite('moveToTrash', { messageIds: ['7'] });
    await client.executeWrite('deleteMessages', { messageIds: ['7'] });
    await client.executeWrite('recoverMessages', { messageIds: ['7'], folderId: '2' });
    expect(requests[0].Body.MsgActionRequest.action.op).toBe('trash');
    expect(requests[1].Body.MsgActionRequest.action.op).toBe('delete');
    expect(requests[2].Body.ItemActionRequest.action).toEqual({ id: '7', op: 'recover', l: '2' });
  });
  it('updates signatures in the account namespace, preserving omitted name and format content', async () => {
    const { client, requests } = setup();
    await client.executeRead('listSignatures', {});
    await client.executeWrite('updateSignature', { signatureId: '01234567-89ab-4def-8123-456789abcdef', contents: [{ type: 'text/html', content: '<p>Alex</p>' }] });
    expect(requests[0].Body.GetSignaturesRequest._jsns).toBe('urn:zimbraAccount');
    expect(requests[1].Body.ModifySignatureRequest).toEqual({ _jsns: 'urn:zimbraAccount', signature: { id: '01234567-89ab-4def-8123-456789abcdef', content: [{ type: 'text/html', _content: '<p>Alex</p>' }] } });
  });
  it('rejects malformed shared IDs, folder paths, empty edits and injected SOAP fields before dispatch', async () => {
    const { client, fetch } = setup();
    for (const [op, input] of [
      ['createFolder', { name: 'A/B', parentFolderId: '1' }],
      ['moveFolder', { folderId: '2', parentFolderId: '2' }],
      ['deleteMessages', { messageIds: ['------------------------------------:1'] }],
      ['updateContact', { contactId: '8', fields: {} }],
      ['updateContact', { contactId: '8', fields: { firstName: 'A' }, replace: 1 }],
      ['emptyFolder', { folderId: '8', op: 'delete' }],
      ['createSignature', { name: 'Signature', contents: [{ type: 'text/plain', content: 'A' }, { type: 'text/plain', content: 'B' }] }],
    ] as const) await expect(client.executeWrite(op, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not misclassify a lost response to a destructive write as safe to retry', async () => {
    const { client, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error('network loss'));
    await expect(client.executeWrite('deleteFolder', { folderId: '257' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('Zimbra router coverage', () => {
  it('exposes every read and mutation schema through the compact router', () => {
    expect(MAIL_QUERY_OPERATIONS.filter(n => n.startsWith('zimbra.')).sort()).toEqual(Object.keys(ZIMBRA_READ_SCHEMAS).map(n => 'zimbra.' + n).sort());
    expect(MAIL_MUTATION_OPERATIONS.filter(n => n.startsWith('zimbra.')).sort()).toEqual(Object.keys(ZIMBRA_WRITE_SCHEMAS).map(n => 'zimbra.' + n).sort());
  });
});
