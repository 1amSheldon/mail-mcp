import { describe, expect, it, vi } from 'vitest';
import { ZimbraClient } from './client.js';
import type { ZimbraConfiguredAccount } from '../account-types.js';

const account: ZimbraConfiguredAccount = { id: 'z', name: 'Zimbra', backend: 'zimbra', user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const uuid = '01234567-89ab-4def-8123-456789abcdef';
const response = (name: string, value: unknown) => new Response(JSON.stringify({ Body: { [name + 'Response']: value } }));
function fixture(responses: Response[], patch: Partial<ZimbraConfiguredAccount> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(); responses.forEach(r => fetch.mockResolvedValueOnce(r));
  const client = new ZimbraClient({ ...account, ...patch }, { fetch, sessionProvider: async () => ({ kind: 'zimbra-session-v1', endpoint: account.endpoint, user: account.user, authToken: 'session', expiresAt: Date.now() + 60000 }) });
  return { client, fetch, request: (i = 0) => JSON.parse(String(fetch.mock.calls[i][1]?.body)) };
}

describe('Zimbra sharing and mountpoints', () => {
  it('discovers an owner mailbox instead of relying only on published share metadata', async () => {
    const { client, request } = fixture([response('GetShareInfo', { share: [] })]);
    await client.executeRead('getShareInfo', { owner: 'owner@example.test', includeOwn: false, granteeType: 'grp' });
    expect(request().Body.GetShareInfoRequest).toEqual({ _jsns: 'urn:zimbraAccount', owner: { by: 'name', _content: 'owner@example.test' }, includeSelf: 0, grantee: { type: 'grp' } });
  });
  it('grants precise internal rights without silently falling back to an external guest', async () => {
    const { client, fetch, request } = fixture([response('FolderAction', {})]);
    await expect(client.executeWrite('grantFolderAccess', { folderId: '257', grantee: { type: 'usr', name: 'typo@example.test' }, permissions: 'r' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
    await client.executeWrite('grantFolderAccess', { folderId: '257', grantee: { type: 'usr', id: uuid }, permissions: 'rwi', expiresAt: '2026-12-01T09:00:00+02:00' });
    expect(request().Body.FolderActionRequest.action).toEqual({ id: '257', op: 'grant', grant: { gt: 'usr', zid: uuid, perm: 'rwi', expiry: Date.parse('2026-12-01T07:00:00Z') } });
  });
  it('supports explicit public/guest/key grants and redacts returned access secrets', async () => {
    const { client, request } = fixture([response('FolderAction', { action: { key: 'secret-access-key', pw: 'secret-password' } }), response('FolderAction', {}), response('FolderAction', {})]);
    expect(await client.executeWrite('grantFolderAccess', { folderId: '257', grantee: { type: 'key', email: 'guest@example.test', accessKey: 'secret-access-key' }, permissions: 'r' })).toEqual({ action: { key: '[REDACTED]', pw: '[REDACTED]' } });
    await client.executeWrite('grantFolderAccess', { folderId: '257', grantee: { type: 'guest', email: 'guest@example.test', password: 'secret-password' }, permissions: 'r' });
    expect(request(1).Body.FolderActionRequest.action.grant).toEqual({ gt: 'guest', d: 'guest@example.test', pw: 'secret-password', perm: 'r' });
    await client.executeWrite('grantFolderAccess', { folderId: '257', grantee: { type: 'pub' }, permissions: 'r', expiresAt: 'never' });
    expect(request(2).Body.FolderActionRequest.action.grant).toEqual({ gt: 'pub', perm: 'r', expiry: 0 });
  });
  it('revokes only the selected grantee rather than replacing the folder ACL', async () => {
    const { client, request } = fixture([response('FolderAction', {})]);
    await client.executeWrite('revokeFolderAccess', { folderId: '257', granteeId: uuid });
    expect(request().Body.FolderActionRequest.action).toEqual({ id: '257', op: '!grant', zid: uuid });
  });
  it('creates a local mountpoint and controls shared reminders separately', async () => {
    const { client, request } = fixture([response('CreateMountpoint', { link: [{ id: '258' }] }), response('EnableSharedReminder', {})]);
    await client.executeWrite('createMountpoint', { name: 'Team Calendar', parentFolderId: '1', owner: 'owner@example.test', remoteFolderId: '10', view: 'appointment' });
    expect(request().Body.CreateMountpointRequest.link).toEqual({ name: 'Team Calendar', l: '1', owner: 'owner@example.test', rid: '10', view: 'appointment', reminder: 0 });
    await client.executeWrite('setSharedReminders', { mountpointId: '258', enabled: true });
    expect(request(1).Body.EnableSharedReminderRequest.link).toEqual({ id: '258', reminder: 1 });
  });
  it('refuses mountpoint removal for an owned folder or remote ID', async () => {
    const { client, fetch } = fixture([response('GetFolder', { folder: [{ id: '257', name: 'Owned' }] })]);
    await expect(client.executeWrite('removeMountpoint', { mountpointId: uuid + ':257' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.executeWrite('removeMountpoint', { mountpointId: '257' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('removes the verified local link, without deleting the remote target ID', async () => {
    const { client, request } = fixture([response('GetFolder', { link: [{ id: '258', rid: '10', zid: uuid }] }), response('FolderAction', {})]);
    await client.executeWrite('removeMountpoint', { mountpointId: '258' });
    expect(request(1).Body.FolderActionRequest.action).toEqual({ id: '258', op: 'delete' });
  });
  it('enforces recipient restrictions before sending share notifications', async () => {
    const { client, fetch, request } = fixture([response('SendShareNotification', {})], { allowedRecipients: ['allowed@example.test'] });
    await expect(client.executeWrite('sendShareNotification', { folderId: '257', to: ['other@example.test'] })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(fetch).not.toHaveBeenCalled();
    await client.executeWrite('sendShareNotification', { folderId: '257', to: ['allowed@example.test'], notes: 'Project archive', revoked: true });
    expect(request().Body.SendShareNotificationRequest).toEqual({ _jsns: 'urn:zimbraMail', item: { id: '257' }, e: [{ a: 'allowed@example.test', t: 't' }], notes: { _content: 'Project archive' }, action: 'revoke' });
    const denied = fixture([], { allowedRecipients: [] });
    await expect(denied.client.executeWrite('sendShareNotification', { folderId: '257', to: ['allowed@example.test'] })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});
