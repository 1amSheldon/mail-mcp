import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZimbraClient } from './client.js';
import { composeMime } from './mime.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const account = { id: 'z', name: 'Zimbra', backend: 'zimbra' as const, user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const response = (name: string, value: unknown) => new Response(JSON.stringify({ Body: { [name + 'Response']: value } }));
async function fixture(options: { allowedRecipients?: string[]; lost?: boolean; changed?: boolean; nativeSchedule?: number; mismatch?: boolean } = {}) {
  const journalDirectory = await mkdtemp(join(tmpdir(), 'zimbra-schedule-')); roots.push(journalDirectory);
  const raw = await composeMime({ to: 'to@example.test', bcc: 'hidden@example.test', subject: 'Scheduled', text: 'Exact body', attachments: [{ filename: 'data.txt', contentBase64: 'YWJj' }] }, account.user);
  let revision = 42; let autoSendTime = options.nativeSchedule ?? 0; let reads = 0;
  const writes: Record<string, any>[] = []; const uploads: Buffer[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).includes('/service/home/')) return new Response(new Uint8Array(raw));
    if (String(url).includes('/service/upload')) {
      const form = init?.body as FormData; uploads.push(Buffer.from(await (form.get('file') as Blob).arrayBuffer()));
      return new Response(`200,'${form.get('requestId')}','aid'`);
    }
    const p = JSON.parse(String(init?.body));
    if (p.Body.SendMsgRequest) { writes.push(p); return response('SendMsg', { m: [{ id: '9' }] }); }
    if (p.Body.MsgActionRequest) return response('MsgAction', { action: { id: '8', op: 'trash' } });
    if (p.Body.GetMsgRequest) return response('GetMsg', { m: [{ id: '8', f: 'd', ms: options.changed && ++reads > 1 ? 99 : revision, autoSendTime, origid: '6', rt: 'r', idnt: 'identity', tn: 'Project' }] });
    if (p.Body.SaveDraftRequest) {
      writes.push(p); revision++; autoSendTime = options.mismatch ? 1 : p.Body.SaveDraftRequest.m.autoSendTime;
      if (options.lost) throw new Error('response lost');
      return response('SaveDraft', { m: [{ id: '8', ms: revision, autoSendTime }] });
    }
    throw new Error('Unexpected request');
  });
  const make = () => new ZimbraClient({ ...account, ...(options.allowedRecipients === undefined ? {} : { allowedRecipients: options.allowedRecipients }) }, { fetch, journalDirectory,
    sessionProvider: async () => ({ kind: 'zimbra-session-v1', endpoint: account.endpoint, user: account.user, authToken: 'session', expiresAt: Date.now() + 60000 }) });
  return { make, fetch, raw, uploads, writes };
}
const input = () => ({ draftId: '8', expectedRevision: '42', sendAt: new Date(Date.now() + 3600000).toISOString() });

describe('native scheduled draft lifecycle', () => {
  it('saves exact MIME with a version guard and reads schedule metadata back', async () => {
    const f = await fixture(); const v = input();
    expect(await f.make().executeWrite('scheduleDraft', v)).toMatchObject({ status: 'schedule_saved', scheduledFor: v.sendAt, observedRevision: '43', retrySafe: false });
    expect(f.uploads).toEqual([f.raw]);
    expect(f.writes[0]).toMatchObject({ Header: { context: { change: { token: '42', type: 'mod' } } }, Body: { SaveDraftRequest: { m: { id: '8', aid: 'aid', autoSendTime: Date.parse(v.sendAt), origid: '6', rt: 'r', idnt: 'identity', tn: 'Project' } } } });
    expect(await f.make().executeRead('getScheduledDraft', { draftId: '8' })).toMatchObject({ status: 'schedule_metadata_present', revision: '43', sendAt: v.sendAt });
  });
  it('prevents repeat scheduling and manual sending after restart', async () => {
    const f = await fixture(); const v = input(); await f.make().executeWrite('scheduleDraft', v);
    const before = f.fetch.mock.calls.length;
    expect(await f.make().executeWrite('scheduleDraft', v)).toMatchObject({ status: 'schedule_saved', replayed: true });
    expect(await f.make().executeWrite('sendDraft', { draftId: '8' })).toMatchObject({ status: 'schedule_saved', replayed: true });
    expect(f.fetch).toHaveBeenCalledTimes(before); expect(f.writes).toHaveLength(1);
  });
  it('retains an uncertain claim after response loss and never resubmits it', async () => {
    const f = await fixture({ lost: true });
    await expect(f.make().executeWrite('scheduleDraft', input())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(await f.make().executeWrite('scheduleDraft', input())).toMatchObject({ status: 'outcome_unknown', replayed: true });
    expect(f.writes).toHaveLength(1);
    expect(await f.make().executeRead('getScheduledDraft', { draftId: '8' })).toMatchObject({ status: 'schedule_metadata_present', localAttempt: { status: 'outcome_unknown' } });
  });
  it('cancels with exact raw MIME while retaining the historical send claim', async () => {
    const f = await fixture(); await f.make().executeWrite('scheduleDraft', input());
    expect(await f.make().executeWrite('cancelScheduledDraft', { draftId: '8', expectedRevision: '43' })).toMatchObject({ status: 'schedule_cleared', observedRevision: '44' });
    expect(f.uploads).toEqual([f.raw, f.raw]);
    expect(f.writes[1]).toMatchObject({ Header: { context: { change: { token: '43', type: 'mod' } } }, Body: { SaveDraftRequest: { m: { autoSendTime: 0 } } } });
    expect(await f.make().executeWrite('sendDraft', { draftId: '8' })).toMatchObject({ status: 'schedule_cleared', replayed: true });
  });
  it('refuses mutable native scheduling on restricted accounts but permits canceling an existing schedule', async () => {
    const blocked = await fixture({ allowedRecipients: ['to@example.test', 'hidden@example.test'] });
    await expect(blocked.make().executeWrite('scheduleDraft', input())).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(blocked.fetch).not.toHaveBeenCalled();
    const cancel = await fixture({ allowedRecipients: [], nativeSchedule: Date.now() + 3600000 });
    expect(await cancel.make().executeWrite('cancelScheduledDraft', { draftId: '8', expectedRevision: '42' })).toMatchObject({ status: 'schedule_cleared' });
  });
  it('stops stale or changed drafts before uploading and reports failed read-back as uncertain', async () => {
    const changed = await fixture({ changed: true });
    await expect(changed.make().executeWrite('scheduleDraft', input())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(changed.uploads).toHaveLength(0); expect(changed.writes).toHaveLength(0);
    const mismatch = await fixture({ mismatch: true });
    await expect(mismatch.make().executeWrite('scheduleDraft', input())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(mismatch.writes).toHaveLength(1);
  });
  it('arbitrates concurrent schedule attempts through one durable claim', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.make().executeWrite('scheduleDraft', input()), f.make().executeWrite('scheduleDraft', input())]);
    expect(results.some(r => r.status === 'fulfilled')).toBe(true);
    expect(f.writes).toHaveLength(1);
  });
  it('arbitrates manual sending against native scheduling through the same claim', async () => {
    const f = await fixture();
    await Promise.allSettled([f.make().executeWrite('scheduleDraft', input()), f.make().executeWrite('sendDraft', { draftId: '8', expectedRevision: '42' })]);
    expect(f.writes).toHaveLength(1);
  });
});
