import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZimbraClient } from './client.js';
import { ZimbraSendJournal } from './send-journal.js';
import { composeMime } from './mime.js';
import type { ZimbraConfiguredAccount } from '../account-types.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const account: ZimbraConfiguredAccount = { id: 'z', name: 'Zimbra', backend: 'zimbra', user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const response = (name: string, value: unknown) => new Response(JSON.stringify({ Body: { [name + 'Response']: value } }));
async function fixture(options: { allowedRecipients?: string[]; changedOnRead?: boolean; cleanupConflict?: boolean; sendLost?: boolean } = {}) {
  const journalDirectory = await mkdtemp(join(tmpdir(), 'zimbra-send-')); roots.push(journalDirectory);
  const raw = await composeMime({ to: 'to@example.test', bcc: 'hidden@example.test', subject: 'Test', text: 'Exact MIME body', attachments: [{ filename: 'data.txt', contentBase64: 'YWJj' }] }, account.user);
  const sent: Record<string, any>[] = []; const uploads: Buffer[] = []; const cleanups: Record<string, any>[] = []; let reads = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).includes('/service/home/')) return new Response(new Uint8Array(raw));
    if (String(url).includes('/service/upload')) {
      const form = init?.body as FormData;
      uploads.push(Buffer.from(await (form.get('file') as Blob).arrayBuffer()));
      return new Response(`200,'${form.get('requestId')}','aid'`);
    }
    const payload = JSON.parse(String(init?.body));
    if (payload.Body.GetMsgRequest) return response('GetMsg', { m: [{ id: '8', f: 'd', ms: options.changedOnRead && ++reads > 1 ? 43 : 42 }] });
    if (payload.Body.SendMsgRequest) {
      sent.push(payload);
      if (options.sendLost) throw new Error('reply lost after dispatch');
      return response('SendMsg', { m: [{ id: '9' }] });
    }
    if (payload.Body.MsgActionRequest) {
      cleanups.push(payload);
      if (options.cleanupConflict) return response('Fault', {}); // unknown response; cleanup must not affect acceptance
      return response('MsgAction', { action: { id: '8', op: 'trash' } });
    }
    throw new Error('Unexpected request');
  });
  const make = () => new ZimbraClient({ ...account, ...(options.allowedRecipients === undefined ? {} : { allowedRecipients: options.allowedRecipients }) }, { fetch, journalDirectory,
    sessionProvider: async () => ({ kind: 'zimbra-session-v1', user: account.user, endpoint: account.endpoint, authToken: 'session', expiresAt: Date.now() + 60000 }) });
  return { make, fetch, sent, uploads, raw, cleanups, journalDirectory };
}

describe('durable Zimbra sending', () => {
  it('sends the exact validated MIME snapshot, guards cleanup, and survives a client restart', async () => {
    const f = await fixture({ allowedRecipients: ['to@example.test', 'hidden@example.test'] });
    const first = await f.make().executeWrite('sendDraft', { draftId: '8', expectedRevision: '42' });
    expect(first).toMatchObject({ status: 'accepted', sentMessageId: '9', draftCleanup: 'moved_to_trash' });
    expect(f.uploads[0]).toEqual(f.raw);
    expect(f.sent[0].Body.SendMsgRequest.m).toEqual({ aid: 'aid' });
    expect(f.cleanups[0].Header.context.change).toEqual({ token: '42', type: 'mod' });
    const count = f.fetch.mock.calls.length;
    expect(await f.make().executeWrite('sendDraft', { draftId: '8' })).toMatchObject({ status: 'accepted', replayed: true });
    expect(f.fetch).toHaveBeenCalledTimes(count);
  });
  it('checks Bcc as well as visible recipients before upload or send', async () => {
    const f = await fixture({ allowedRecipients: ['to@example.test'] });
    await expect(f.make().executeWrite('sendDraft', { draftId: '8' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(f.sent).toHaveLength(0); expect(f.uploads).toHaveLength(0);
  });
  it('rejects edits made while downloading the snapshot before uploading it', async () => {
    const f = await fixture({ changedOnRead: true });
    await expect(f.make().executeWrite('sendDraft', { draftId: '8' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.sent).toHaveLength(0); expect(f.uploads).toHaveLength(0);
  });
  it('preserves acceptance if later cleanup fails and does not send again', async () => {
    const f = await fixture({ cleanupConflict: true });
    expect(await f.make().executeWrite('sendDraft', { draftId: '8' })).toMatchObject({ status: 'accepted', draftCleanup: 'retained_changed_or_unverified' });
    expect(await f.make().executeWrite('sendDraft', { draftId: '8' })).toMatchObject({ status: 'accepted', replayed: true });
    expect(f.sent).toHaveLength(1);
  });
  it('keeps uncertain delivery blocked after a restart without repeating SendMsg', async () => {
    const f = await fixture({ sendLost: true });
    await expect(f.make().executeWrite('sendDraft', { draftId: '8' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(await f.make().executeRead('getSendStatus', { draftId: '8' })).toMatchObject({ status: 'outcome_unknown', retrySafe: false });
    expect(await f.make().executeWrite('sendDraft', { draftId: '8' })).toMatchObject({ status: 'outcome_unknown', replayed: true });
    expect(f.sent).toHaveLength(1); expect(f.cleanups).toHaveLength(0);
  });
  it('claims the send exclusively across two clients', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.make().executeWrite('sendDraft', { draftId: '8' }), f.make().executeWrite('sendDraft', { draftId: '8' })]);
    expect(results.some(r => r.status === 'fulfilled')).toBe(true);
    expect(f.sent).toHaveLength(1);
  });
  it('treats a persisted in-flight claim as unknown, not permission to retry', async () => {
    const f = await fixture();
    const journal = new ZimbraSendJournal(JSON.stringify([account.id, account.endpoint, account.user]), f.journalDirectory);
    await journal.begin('8', f.raw);
    expect(await f.make().executeWrite('sendDraft', { draftId: '8' })).toMatchObject({ status: 'outcome_unknown', retrySafe: false });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
