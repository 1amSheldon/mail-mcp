import { describe, expect, it, vi } from 'vitest';
import { ZimbraClient } from './client.js';

const account = { id: 'z', name: 'Zimbra', backend: 'zimbra' as const, user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const guard = { messageId: '300', expectedModSequence: '40', component: 2 };
const base = { compNum: 2, method: 'REQUEST', uid: 'meeting', seq: 3, name: 'Planning', or: [{ a: 'organizer@example.test' }], at: [{ a: 'me@example.test' }], s: [{ d: '20261014T090000Z' }], e: [{ d: '20261014T100000Z' }] };
function fixture(patch: Record<string, unknown> = {}, allowedRecipients?: string[]) {
  const m = { id: '300', ms: 40, inv: [{ type: 'appt', comp: [{ ...base, ...patch }] }] };
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ Body: { GetMsgResponse: { m: [m] } } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ Body: { SendInviteReplyResponse: {}, ForwardAppointmentInviteResponse: {}, DeclineCounterAppointmentResponse: {} } })));
  const client = new ZimbraClient({ ...account, ...(allowedRecipients === undefined ? {} : { allowedRecipients }) }, { fetch, sessionProvider: async () => ({ kind: 'zimbra-session-v1', endpoint: account.endpoint, user: account.user, authToken: 'session', expiresAt: Date.now() + 60000 }) });
  return { client, fetch, request: (i = 1) => JSON.parse(String(fetch.mock.calls[i][1]?.body)).Body };
}

describe('inbox calendar workflows', () => {
  it('accepts a message invitation using its mail ID and actual component number', async () => {
    const f = fixture();
    await f.client.executeWrite('replyToInboxInvitation', { ...guard, response: 'ACCEPT', message: 'See you' });
    expect(f.request(0).GetMsgRequest.m).toMatchObject({ id: '300', wantModSeq: 1, read: 0 });
    expect(f.request().SendInviteReplyRequest).toMatchObject({ id: '300', compNum: 2, verb: 'ACCEPT', updateOrganizer: 1, m: { e: [{ a: 'organizer@example.test', t: 't' }] } });
  });
  it('keeps organizer notification disabled for a local participation response', async () => {
    const f = fixture();
    await f.client.executeWrite('replyToInboxInvitation', { ...guard, response: 'TENTATIVE', notifyOrganizer: false });
    expect(f.request().SendInviteReplyRequest).toMatchObject({ updateOrganizer: 0, m: { e: [] } });
  });
  it('rejects stale message versions and missing invitation components without writing', async () => {
    for (const change of [{ expectedModSequence: '39' }, { component: 1 }]) {
      const f = fixture();
      await expect(f.client.executeWrite('replyToInboxInvitation', { ...guard, ...change, response: 'DECLINE' })).rejects.toBeDefined();
      expect(f.fetch).toHaveBeenCalledOnce();
    }
  });
  it('forwards the native invitation mail but refuses non-REQUEST messages', async () => {
    const f = fixture();
    await f.client.executeWrite('forwardInboxInvitation', { ...guard, to: ['guest@example.test'] });
    expect(f.request().ForwardAppointmentInviteRequest).toMatchObject({ id: '300', m: { e: [{ a: 'guest@example.test', t: 't' }] } });
    const counter = fixture({ method: 'COUNTER' });
    await expect(counter.client.executeWrite('forwardInboxInvitation', { ...guard, to: ['guest@example.test'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(counter.fetch).toHaveBeenCalledOnce();
  });
  it('blocks inbox reply and forward on restricted accounts before sending any request', async () => {
    const f = fixture({}, ['organizer@example.test']);
    await expect(f.client.executeWrite('replyToInboxInvitation', { ...guard, response: 'ACCEPT', notifyOrganizer: false })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(f.client.executeWrite('forwardInboxInvitation', { ...guard, to: ['organizer@example.test'] })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('declines the incoming counter details without copying alarms or changing calendar content', async () => {
    const f = fixture({ method: 'COUNTER', or: [{ a: 'me@example.test' }], at: [{ a: 'proposer@example.test', ptst: 'TE' }], alarm: [{ action: 'EMAIL', at: [{ a: 'outside@example.test' }] }] }, ['proposer@example.test']);
    await f.client.executeWrite('declineCounterProposal', { ...guard, proposerEmail: 'proposer@example.test', message: 'Original time please' });
    const m = f.request().DeclineCounterAppointmentRequest.m;
    expect(m).toMatchObject({ e: [{ a: 'proposer@example.test', t: 't' }], inv: { comp: [{ uid: 'meeting', seq: 3, s: base.s, e: base.e, at: [{ a: 'proposer@example.test' }] }] } });
    expect(m.inv.comp[0]).not.toHaveProperty('alarm');
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('refuses a different proposer or a recipient outside the configured policy', async () => {
    for (const [proposerEmail, allowed] of [['stranger@example.test', ['stranger@example.test']], ['proposer@example.test', []]] as const) {
      const f = fixture({ method: 'COUNTER', or: [{ a: 'me@example.test' }], at: [{ a: 'proposer@example.test' }] }, [...allowed]);
      await expect(f.client.executeWrite('declineCounterProposal', { ...guard, proposerEmail })).rejects.toBeDefined();
      expect(f.fetch).toHaveBeenCalledOnce();
    }
  });
});
