import { describe, expect, it, vi } from 'vitest';
import { ZimbraClient } from './client.js';
import { compileRule, filterRevision, filterRuleSchema } from './filters.js';
import type { ZimbraConfiguredAccount } from '../account-types.js';

const account: ZimbraConfiguredAccount = { id: 'z', name: 'Zimbra', backend: 'zimbra', user: 'me@example.test', endpoint: 'https://mail.example.test/service/soap' };
const ruleInput = { name: 'Invoices', branch: { tests: [{ type: 'header', header: 'Subject', value: 'Invoice', comparison: { kind: 'string', operator: 'contains' } }], actions: [{ type: 'fileInto', folderPath: '/Invoices' }, { type: 'stop' }] } };
const rule = compileRule(filterRuleSchema.parse(ruleInput));
const response = (name: string, value: unknown) => new Response(JSON.stringify({ Body: { [name + 'Response']: value } }));
const rulesResponse = (rules: unknown[], outgoing = false) => response(outgoing ? 'GetOutgoingFilterRules' : 'GetFilterRules', { filterRules: [{ filterRule: rules }] });
function fixture(responses: Response[], patch: Partial<ZimbraConfiguredAccount> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(); responses.forEach(r => fetch.mockResolvedValueOnce(r));
  const client = new ZimbraClient({ ...account, ...patch }, { fetch, sessionProvider: async () => ({ kind: 'zimbra-session-v1', endpoint: account.endpoint, user: account.user, authToken: 'session', expiresAt: Date.now() + 60000 }) });
  return { client, fetch, request: (i = 0) => JSON.parse(String(fetch.mock.calls[i][1]?.body)) };
}

describe('Zimbra rule replacement integrity', () => {
  it('reads revisioned incoming and outgoing lists without executing rules', async () => {
    const { client, request } = fixture([rulesResponse([rule]), rulesResponse([], true)]);
    expect(await client.executeRead('getFilterRules', {})).toMatchObject({ rules: [rule], revision: filterRevision([rule]), direction: 'incoming' });
    expect(await client.executeRead('getFilterRules', { direction: 'outgoing' })).toMatchObject({ rules: [], direction: 'outgoing' });
    expect(request(1).Body).toHaveProperty('GetOutgoingFilterRulesRequest');
  });
  it('rejects stale revisions before the whole-list write', async () => {
    const { client, fetch } = fixture([rulesResponse([rule])]);
    await expect(client.executeWrite('deleteFilterRule', { name: 'Invoices', expectedRevision: filterRevision([]) })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('retains unfamiliar server constructs when toggling another rule', async () => {
    const unknown = { name: 'Server feature', active: true, filterTests: { futureTest: [{ index: 0, value: 'opaque' }] }, nestedRule: { futureNode: { exact: 'retain me' } } };
    const before = [unknown, rule]; const after = [unknown, { ...rule, active: 0 }];
    const { client, request } = fixture([rulesResponse(before), response('ModifyFilterRules', {}), rulesResponse(after)]);
    expect(await client.executeWrite('setFilterRuleEnabled', { name: 'Invoices', enabled: false, expectedRevision: filterRevision(before) })).toMatchObject({ status: 'accepted', exactMatch: true, rules: after });
    expect(request(1).Body.ModifyFilterRulesRequest.filterRules[0].filterRule).toEqual(after);
  });
  it('reorders retained rules and inserts typed replacements without accepting arbitrary SOAP', async () => {
    const old = { ...rule, name: 'Other' }; const before = [rule, old];
    const { client, request } = fixture([rulesResponse(before), response('ModifyFilterRules', {}), rulesResponse([old, rule])]);
    await client.executeWrite('replaceFilterRules', { expectedRevision: filterRevision(before), rules: [{ source: 'existing', name: 'Other' }, { source: 'new', rule: ruleInput }] });
    expect(request(1).Body.ModifyFilterRulesRequest.filterRules[0].filterRule).toEqual([old, rule]);
    await expect(client.executeWrite('replaceFilterRules', { expectedRevision: filterRevision(before), rules: [{ source: 'new', rule: { ...ruleInput, actionAdmin: {} } }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('exposes normalized or changed read-back and never promises atomic CAS', async () => {
    const { client } = fixture([rulesResponse([]), response('ModifyFilterRules', {}), rulesResponse([{ ...rule, active: true }])]);
    expect(await client.executeWrite('upsertFilterRule', { expectedRevision: filterRevision([]), rule: ruleInput })).toMatchObject({ status: 'accepted', exactMatch: false, rules: [{ ...rule, active: true }] });
  });
  it('reports an accepted write with failed read-back without retrying it', async () => {
    const { client, fetch } = fixture([rulesResponse([rule]), response('ModifyFilterRules', {})]);
    expect(await client.executeWrite('deleteFilterRule', { name: 'Invoices', expectedRevision: filterRevision([rule]) })).toMatchObject({ status: 'accepted_unverified' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('treats a lost write acknowledgement as unknown and does not retry', async () => {
    const { client, fetch } = fixture([rulesResponse([rule])]);
    await expect(client.executeWrite('deleteFilterRule', { name: 'Invoices', expectedRevision: filterRevision([rule]) })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects simultaneous edits through the same client', async () => {
    const { client, fetch } = fixture([]);
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const first = client.executeWrite('deleteFilterRule', { name: 'Invoices', expectedRevision: filterRevision([]) });
    await expect(client.executeWrite('deleteFilterRule', { name: 'Invoices', expectedRevision: filterRevision([]) })).rejects.toMatchObject({ code: 'CONFLICT' });
    resolve(rulesResponse([rule]));
    await expect(first).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('filter compiler and recipient boundaries', () => {
  it('compiles nested conditions, variables and ordered native tests/actions', () => {
    const compiled = compileRule(filterRuleSchema.parse({ name: 'Nested', variables: [{ name: 'label', value: 'Invoices' }], branch: {
      tests: [{ type: 'attachment', negative: true }], nested: { condition: 'anyof', tests: [
        { type: 'address', header: 'From', value: 'example.test', part: 'domain', comparison: { kind: 'string', operator: 'is' } },
        { type: 'size', comparison: 'over', bytes: 1024 },
      ], actions: [{ type: 'redirect', address: 'allowed@example.test', copy: true }, { type: 'keep' }] },
    } }));
    expect(compiled).toMatchObject({ filterVariables: [{ filterVariable: [{ name: 'label', value: 'Invoices' }] }], filterTests: [{ attachmentTest: [{ index: 0, negative: 1 }] }], nestedRule: [{
      filterTests: [{ condition: 'anyof', addressTest: [{ index: 0, part: 'domain', stringComparison: 'is', caseSensitive: 0 }], sizeTest: [{ index: 1, s: '1024' }] }],
      filterActions: [{ actionRedirect: [{ index: 0, a: 'allowed@example.test', copy: 1 }], actionKeep: [{ index: 1 }] }],
    }] });
  });
  it('checks nested, unknown, dynamic and disabled preserved actions before replacement', async () => {
    for (const actions of [
      { actionRedirect: [{ a: 'outside@example.test' }] }, { actionRedirect: [{ a: '${sender}@example.test' }] },
      { actionReply: [{ content: { _content: 'Away' } }] }, { actionRFCCompliantNotify: [{ method: 'mailto:outside@example.test' }] },
      { actionFutureSend: [{}] }, { futureSend: [{}] },
    ]) {
      const unsafe = { name: 'Unsafe', active: 0, nestedRule: { filterActions: actions } };
      const { client, fetch } = fixture([rulesResponse([unsafe, rule])], { allowedRecipients: ['allowed@example.test'] });
      await expect(client.executeWrite('setFilterRuleEnabled', { name: 'Invoices', enabled: false, expectedRevision: filterRevision([unsafe, rule]) })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
  it('allows an exact allowed redirect and harmless actions on restricted accounts', async () => {
    const input = { name: 'Allowed', branch: { tests: [{ type: 'attachment' }], actions: [{ type: 'redirect', address: 'allowed@example.test' }, { type: 'keep' }] } };
    const desired = compileRule(filterRuleSchema.parse(input));
    const { client } = fixture([rulesResponse([]), response('ModifyFilterRules', {}), rulesResponse([desired])], { allowedRecipients: ['allowed@example.test'] });
    expect(await client.executeWrite('upsertFilterRule', { expectedRevision: filterRevision([]), rule: input })).toMatchObject({ status: 'accepted' });
  });
  it('applies only explicit bounded message IDs, and refuses race-prone execution on restricted accounts', async () => {
    const input = { names: ['Invoices'], messageIds: ['21', '22'], expectedRevision: filterRevision([rule]), direction: 'outgoing' };
    const { client, request } = fixture([rulesResponse([rule], true), response('ApplyOutgoingFilterRules', { m: { ids: '21,22' } })]);
    await client.executeWrite('applyFilterRules', input);
    expect(request(1).Body.ApplyOutgoingFilterRulesRequest).toMatchObject({ filterRules: [{ filterRule: [{ name: 'Invoices' }] }], m: { ids: '21,22' } });
    const restricted = fixture([rulesResponse([rule], true)], { allowedRecipients: [] });
    await expect(restricted.client.executeWrite('applyFilterRules', input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(restricted.fetch).toHaveBeenCalledOnce();
  });
});
