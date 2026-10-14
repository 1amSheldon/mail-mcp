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
describe('native contact groups and directory lookup', () => {
  it('creates a group with typed local, GAL and inline members', async () => {
    const { client, request } = fixture([response('CreateContact', { cn: [{ id: '258' }] })]);
    await client.executeWrite('createContactGroup', { name: 'Suppliers', folderId: '257', members: [
      { type: 'contact', contactId: '23' }, { type: 'gal', ref: 'gal-reference' }, { type: 'email', email: 'supplier@example.test', name: 'Supplier' },
    ] });
    expect(request().Body.CreateContactRequest.cn).toMatchObject({ l: '257', a: expect.arrayContaining([{ n: 'type', _content: 'group' }]),
      m: [{ type: 'C', value: '23' }, { type: 'G', value: 'gal-reference' }, { type: 'I', value: '"Supplier" <supplier@example.test>' }] });
  });
  it('patches membership without replacing fields, tags or unrelated members', async () => {
    const { client, request } = fixture([response('GetContacts', { cn: [{ id: '258', a: [{ n: 'type', _content: 'group' }] }] }), response('ModifyContact', {})]);
    await client.executeWrite('updateContactGroup', { contactId: '258', addMembers: [{ type: 'email', email: 'new@example.test' }], removeMembers: [{ type: 'contact', contactId: '23' }] });
    expect(request(1).Body.ModifyContactRequest).toEqual({ _jsns: 'urn:zimbraMail', replace: 0, verbose: 1, cn: { id: '258', m: [{ op: '-', type: 'C', value: '23' }, { op: '+', type: 'I', value: 'new@example.test' }] } });
  });
  it('rejects a group edit on an ordinary contact before mutation', async () => {
    const { client, fetch } = fixture([response('GetContacts', { cn: [{ id: '23', a: [{ n: 'firstName', _content: 'Alex' }] }] })]);
    await expect(client.executeWrite('updateContactGroup', { contactId: '23', clearMembers: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('binds GAL cursors to search type and does not manufacture pagination when unsupported', async () => {
    const { client, request } = fixture([response('SearchGal', { cn: [{ ref: 'first' }], more: true, paginationSupported: 1 }), response('SearchGal', { cn: [{ ref: 'second' }], more: false, paginationSupported: 1 })]);
    const first = await client.executeRead('searchGal', { query: 'Alex', type: 'account', limit: 1 }) as { nextCursor: string };
    await expect(client.executeRead('searchGal', { query: 'Alex', type: 'resource', limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await client.executeRead('searchGal', { query: 'Alex', type: 'account', limit: 1, cursor: first.nextCursor });
    expect(request(1).Body.SearchGalRequest).toMatchObject({ _jsns: 'urn:zimbraAccount', offset: 1, type: 'account' });
    const unsupported = fixture([response('SearchGal', { cn: [{ ref: 'a' }, { ref: 'b' }], more: true, paginationSupported: 0 })]);
    expect(await unsupported.client.executeRead('searchGal', { query: 'A', limit: 1 })).toMatchObject({ items: [{ ref: 'a' }], partial: true, nextCursor: null });
  });
});
describe('Zimbra preference writes and recipient policy', () => {
  it('uses the native JSON _attrs contract for preferences and identities', async () => {
    const { client, request } = fixture([response('ModifyPrefs', {}), response('CreateIdentity', {})]);
    await client.executeWrite('setPreferences', { values: { zimbraPrefLocale: 'en_US', zimbraPrefTimeZoneId: 'Europe/Kyiv' } });
    await client.executeWrite('createIdentity', { name: 'Work', values: { zimbraPrefFromAddress: 'me@example.test' } });
    expect(request().Body.ModifyPrefsRequest).toEqual({ _jsns: 'urn:zimbraAccount', _attrs: { zimbraPrefLocale: 'en_US', zimbraPrefTimeZoneId: 'Europe/Kyiv' } });
    expect(request(1).Body.CreateIdentityRequest.identity).toEqual({ name: 'Work', _attrs: { zimbraPrefFromAddress: 'me@example.test' } });
  });
  it('normalizes explicit OOO times to UTC without changing omitted external-reply settings', async () => {
    const { client, request } = fixture([response('ModifyPrefs', {})]);
    await client.executeWrite('setOutOfOffice', { enabled: true, message: 'Away', startsAt: '2026-10-14T09:00:00+03:00', endsAt: '2026-10-15T18:00:00+03:00' });
    // LDAP generalized time uses YYYYMMDDHHMMSSZ, unlike iCalendar's T separator.
    expect(request().Body.ModifyPrefsRequest._attrs).toEqual({ zimbraPrefOutOfOfficeReplyEnabled: 'TRUE', zimbraPrefOutOfOfficeReply: 'Away', zimbraPrefOutOfOfficeFromDate: '20261014060000Z', zimbraPrefOutOfOfficeUntilDate: '20261015150000Z' });
  });
  it('allows harmless preference edits but rejects auto replies and forbidden forwarding under recipient restrictions', async () => {
    const { client, fetch } = fixture([response('ModifyPrefs', {}), response('ModifyPrefs', {})], { allowedRecipients: ['allowed@example.test'] });
    await client.executeWrite('setPreferences', { values: { zimbraPrefLocale: 'en_US' } });
    await client.executeWrite('setOutOfOffice', { enabled: false });
    await expect(client.executeWrite('setOutOfOffice', { enabled: true, message: 'Away' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(client.executeWrite('setPreferences', { values: { zimbraPrefOutOfOfficeReplyEnabled: 'TRUE' } })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(client.executeWrite('setPreferences', { values: { zimbraPrefMailForwardingAddress: 'other@example.test' } })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(client.executeWrite('updateIdentity', { identityId: '01234567-89ab-4def-8123-456789abcdef', values: { zimbraPrefBccAddress: 'other@example.test' } })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects administrator attributes and reversed date ranges before network access', async () => {
    const { client, fetch } = fixture([]);
    await expect(client.executeWrite('setPreferences', { values: { zimbraIsAdminAccount: 'TRUE' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.executeWrite('setOutOfOffice', { enabled: true, message: 'Away', startsAt: '2026-10-15T09:00:00Z', endsAt: '2026-10-14T09:00:00Z' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
