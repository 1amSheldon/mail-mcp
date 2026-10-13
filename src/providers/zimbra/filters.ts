import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ZimbraError } from './session.js';

type Obj = Record<string, unknown>;
const name = z.string().min(1).max(255).refine(v => !/[\r\n\0]/.test(v));
const text = z.string().max(20000).refine(v => !v.includes('\0'));
const header = z.string().min(1).max(998).regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:,[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/);
const common = { negative: z.boolean().default(false) };
const comparison = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('string'), operator: z.enum(['is', 'contains', 'matches']), caseSensitive: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('value'), operator: z.enum(['gt', 'ge', 'lt', 'le', 'eq', 'ne']), comparator: z.enum(['i;ascii-numeric', 'i;ascii-casemap', 'i;octet']).default('i;ascii-casemap') }).strict(),
  z.object({ kind: z.literal('count'), operator: z.enum(['gt', 'ge', 'lt', 'le', 'eq', 'ne']) }).strict(),
]);
const test = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['header', 'mimeHeader', 'address', 'envelope']), header, value: text, comparison, part: z.enum(['all', 'localpart', 'domain']).optional(), ...common }).strict()
    .refine(v => !v.part || v.type === 'address' || v.type === 'envelope'),
  z.object({ type: z.enum(['addressBook', 'contactRanking', 'headerExists', 'me']), header, ...common }).strict(),
  z.object({ type: z.enum(['true', 'attachment', 'bulk', 'facebook', 'linkedin', 'list', 'socialcast', 'twitter', 'communityRequests', 'communityContent', 'communityConnections']), ...common }).strict(),
  z.object({ type: z.literal('body'), value: text, caseSensitive: z.boolean().default(false), ...common }).strict(),
  z.object({ type: z.literal('conversation'), where: z.enum(['started', 'participated']), ...common }).strict(),
  z.object({ type: z.literal('currentDayOfWeek'), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), ...common }).strict(),
  z.object({ type: z.literal('currentTime'), comparison: z.enum(['before', 'after']), time: z.string().regex(/^(?:[01][0-9]|2[0-3])[0-5][0-9]$/), ...common }).strict(),
  z.object({ type: z.literal('date'), comparison: z.enum(['before', 'after']), seconds: z.number().int().min(0).max(253402300799), ...common }).strict(),
  z.object({ type: z.literal('flagged'), flag: z.enum(['flagged', 'read', 'priority']), ...common }).strict(),
  z.object({ type: z.literal('importance'), importance: z.enum(['high', 'normal', 'low']), ...common }).strict(),
  z.object({ type: z.literal('size'), comparison: z.enum(['over', 'under']), bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), ...common }).strict(),
  z.object({ type: z.literal('invite'), methods: z.array(z.enum(['anyrequest', 'anyreply', 'publish', 'request', 'reply', 'add', 'cancel', 'refresh', 'counter', 'declinecounter'])).max(10), ...common }).strict(),
]);
const action = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['keep', 'discard', 'stop']) }).strict(),
  z.object({ type: z.literal('fileInto'), folderPath: z.string().min(1).max(1024), copy: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('tag'), tagName: name }).strict(),
  z.object({ type: z.literal('flag'), flag: z.enum(['flagged', 'read', 'priority']) }).strict(),
  z.object({ type: z.literal('redirect'), address: z.email(), copy: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('reply'), body: text }).strict(),
  z.object({ type: z.literal('notify'), address: z.email(), subject: text.optional(), body: text.optional(), maxBodySize: z.number().int().min(0).max(1048576).optional(), originalHeaders: z.union([header, z.literal('*')]).optional() }).strict(),
  z.object({ type: z.literal('rfcNotify'), from: z.email(), subject: text, method: z.string().startsWith('mailto:').max(4096) }).strict(),
  z.object({ type: z.enum(['reject', 'ereject']), message: text }).strict(),
  z.object({ type: z.literal('log'), message: text, level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info') }).strict(),
]);
const variables = z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), value: text }).strict()).max(100);
const branchBase = { condition: z.enum(['allof', 'anyof']).default('allof'), tests: z.array(test).min(1).max(100) };
// Bounded nesting avoids unbounded schema recursion and transport expansion.
const leaf = z.object({ ...branchBase, actions: z.array(action).min(1).max(100), variables: variables.optional() }).strict();
const level1 = z.union([leaf, z.object({ ...branchBase, nested: leaf }).strict()]);
const level2 = z.union([leaf, z.object({ ...branchBase, nested: level1 }).strict()]);
const branch = z.union([leaf, z.object({ ...branchBase, nested: level2 }).strict()]);
export const filterRuleSchema = z.object({ name, active: z.boolean().default(true), variables: variables.optional(), branch }).strict();
const direction = z.enum(['incoming', 'outgoing']).default('incoming');
const expectedRevision = z.string().regex(/^[a-f0-9]{64}$/);
const base = { direction, expectedRevision };
export const FILTER_READ_SCHEMAS = { getFilterRules: z.object({ direction }).strict() };
export const FILTER_WRITE_SCHEMAS = {
  upsertFilterRule: z.object({ ...base, rule: filterRuleSchema, beforeRuleName: name.optional() }).strict(),
  setFilterRuleEnabled: z.object({ ...base, name, enabled: z.boolean() }).strict(),
  deleteFilterRule: z.object({ ...base, name }).strict(),
  replaceFilterRules: z.object({ ...base, rules: z.array(z.discriminatedUnion('source', [
    z.object({ source: z.literal('existing'), name, active: z.boolean().optional() }).strict(),
    z.object({ source: z.literal('new'), rule: filterRuleSchema }).strict(),
  ])).max(1000) }).strict(),
  applyFilterRules: z.object({ ...base, names: z.array(name).min(1).max(100), messageIds: z.array(z.string().regex(/^[1-9][0-9]{0,15}$/)).min(1).max(100) }).strict(),
};
export type FilterWriteOperation = keyof typeof FILTER_WRITE_SCHEMAS;
type Test = z.output<typeof test>;
type Action = z.output<typeof action>;
function append(target: Obj, key: string, value: Obj): void {
  const values = (target[key] ??= []) as Obj[];
  values.push(value);
}
function testNode(t: Test, index: number): [string, Obj] {
  const v: Obj = { index, negative: t.negative ? 1 : 0 };
  if ('header' in t) v.header = t.header;
  if ('value' in t) v.value = t.value;
  if ('part' in t && t.part) v.part = t.part;
  if ('comparison' in t && typeof t.comparison === 'object') {
    const c = t.comparison;
    v[c.kind + 'Comparison'] = c.operator;
    if (c.kind === 'string') v.caseSensitive = c.caseSensitive ? 1 : 0;
    if (c.kind === 'value') v.valueComparisonComparator = c.comparator;
  }
  if (t.type === 'body') v.caseSensitive = t.caseSensitive ? 1 : 0;
  if (t.type === 'conversation') v.where = t.where;
  if (t.type === 'currentDayOfWeek') v.value = [...new Set(t.days)].join(',');
  if (t.type === 'currentTime') { v.dateComparison = t.comparison; v.d = t.time; }
  if (t.type === 'date') { v.dateComparison = t.comparison; v.d = t.seconds; }
  if (t.type === 'flagged') v.flagName = t.flag;
  if (t.type === 'importance') v.imp = t.importance;
  if (t.type === 'size') { v.numberComparison = t.comparison; v.s = String(t.bytes); }
  if (t.type === 'invite') v.method = t.methods.map(_content => ({ _content }));
  return [t.type + 'Test', v];
}
function actionNode(a: Action, index: number): [string, Obj] {
  const v: Obj = { index };
  if (a.type === 'fileInto') { v.folderPath = a.folderPath; v.copy = a.copy ? 1 : 0; }
  if (a.type === 'tag') v.tagName = a.tagName;
  if (a.type === 'flag') v.flagName = a.flag;
  if (a.type === 'redirect' || a.type === 'notify') v.a = a.address;
  if (a.type === 'redirect') v.copy = a.copy ? 1 : 0;
  if (a.type === 'reply') v.content = { _content: a.body };
  if (a.type === 'notify') {
    if (a.subject !== undefined) v.su = a.subject;
    if (a.body !== undefined) v.content = { _content: a.body };
    if (a.maxBodySize !== undefined) v.maxBodySize = a.maxBodySize;
    if (a.originalHeaders !== undefined) v.origHeaders = a.originalHeaders;
  }
  if (a.type === 'rfcNotify') { v.from = a.from; v.message = a.subject; v.method = { _content: a.method }; }
  if (a.type === 'reject' || a.type === 'ereject' || a.type === 'log') v._content = a.message;
  if (a.type === 'log') v.level = a.level;
  return [a.type === 'rfcNotify' ? 'actionRFCCompliantNotify' : 'action' + a.type[0].toUpperCase() + a.type.slice(1), v];
}
const vars = (v: z.output<typeof variables>) => ({ filterVariable: v });
function branchNode(b: z.output<typeof branch>): Obj {
  const tests: Obj = { condition: b.condition };
  b.tests.forEach((t, i) => { const [key, value] = testNode(t, i); append(tests, key, value); });
  if ('nested' in b) return { filterTests: [tests], nestedRule: [branchNode(b.nested)] };
  const actions: Obj = {};
  b.actions.forEach((a, i) => { const [key, value] = actionNode(a, i); append(actions, key, value); });
  if (b.variables) actions.filterVariables = [vars(b.variables)];
  return { filterTests: [tests], filterActions: [actions] };
}
export function compileRule(input: z.output<typeof filterRuleSchema>): Obj {
  return { name: input.name, active: input.active ? 1 : 0, ...(input.variables ? { filterVariables: [vars(input.variables)] } : {}), ...branchNode(input.branch) };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function filterRevision(rules: Obj[]): string { return createHash('sha256').update(canonical(rules)).digest('hex'); }
export function readRules(response: Obj): Obj[] {
  const wrapper = response.filterRules;
  if (Array.isArray(wrapper) && wrapper.length > 1) throw new ZimbraError('PROVIDER_ERROR', 'Ambiguous filter rule wrappers.');
  const container = Array.isArray(wrapper) ? wrapper[0] : wrapper;
  if (container === undefined) return [];
  if (!container || typeof container !== 'object' || Array.isArray(container)) throw new ZimbraError('PROVIDER_ERROR', 'Invalid filter rule response.');
  const raw = (container as Obj).filterRule;
  const rules = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (rules.length > 1000 || rules.some(r => !r || typeof r !== 'object' || Array.isArray(r) || typeof r.name !== 'string') || new Set(rules.map(r => r.name)).size !== rules.length) throw new ZimbraError('PROVIDER_ERROR', 'Ambiguous or oversized filter rule list.');
  return rules as Obj[];
}

// Check the entire native structure, including preserved/unknown server rules.
// Unknown actions and dynamic forwarding fail closed on restricted accounts.
export function checkFilterPolicy(rules: Obj[], allowed: readonly string[] | undefined): void {
  if (allowed === undefined) return;
  const recipients = new Set(allowed.map(a => a.toLowerCase()));
  const safeActions = new Set(['actionKeep', 'actionDiscard', 'actionFileInto', 'actionTag', 'actionFlag', 'actionStop', 'actionLog']);
  let visited = 0;
  const visit = (node: unknown, depth: number, inActions = false): void => {
    if (++visited > 50000 || depth > 32) throw new ZimbraError('ACCESS_DENIED', 'Cannot establish filter recipient policy for this rule structure.');
    if (Array.isArray(node)) { node.forEach(v => visit(v, depth + 1, inActions)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'actionRedirect' || key === 'actionNotify') {
        for (const a of Array.isArray(value) ? value : [value]) {
          const address = a && typeof a === 'object' ? (a as Obj).a : undefined;
          if (typeof address !== 'string' || !z.email().safeParse(address).success || address.includes('${') || !recipients.has(address.toLowerCase())) throw new ZimbraError('ACCESS_DENIED', 'Filter destination is outside allowedRecipients or is dynamic.');
        }
      } else if ((key.startsWith('action') || (inActions && !['filterVariables', 'index'].includes(key))) && !safeActions.has(key)) {
        throw new ZimbraError('ACCESS_DENIED', 'Automatic replies, unknown actions and RFC notify require an unrestricted account.');
      }
      visit(value, depth + 1, key === 'filterActions');
    }
  };
  rules.forEach(r => visit(r, 0));
}

type Request = (name: string, params: Obj, write?: boolean) => Promise<Obj>;
export class ZimbraFilters {
  private writing = false;
  constructor(private readonly request: Request, private readonly allowedRecipients?: readonly string[]) {}
  async read(direction: 'incoming' | 'outgoing'): Promise<{ direction: string; rules: Obj[]; revision: string; warning: string }> {
    const rules = readRules(await this.request(direction === 'incoming' ? 'GetFilterRules' : 'GetOutgoingFilterRules', {}));
    return { direction, rules, revision: filterRevision(rules), warning: 'Revision is a preflight guard, not an atomic server lock. Avoid concurrent filter edits in other clients.' };
  }
  async write(operation: FilterWriteOperation, input: unknown): Promise<unknown> {
    if (this.writing) throw new ZimbraError('CONFLICT', 'Another filter mutation is in progress on this client.');
    this.writing = true;
    try {
      const v = FILTER_WRITE_SCHEMAS[operation].parse(input);
      const current = await this.read(v.direction);
      if (current.revision !== v.expectedRevision) throw new ZimbraError('CONFLICT', 'Filter rules changed. Read the current list and reconsider the edit.');
      const rules = structuredClone(current.rules);
      const locate = (name: string) => {
        const i = rules.findIndex(r => r.name === name);
        if (i < 0) throw new ZimbraError('INVALID_INPUT', 'Filter rule does not exist.');
        return i;
      };
      if ('messageIds' in v) {
        // The server executes rules by name, without a version/snapshot contract.
        if (this.allowedRecipients !== undefined) throw new ZimbraError('ACCESS_DENIED', 'Applying server rules requires an unrestricted account because rules can change before execution.');
        v.names.forEach(locate);
        const result = await this.request(v.direction === 'incoming' ? 'ApplyFilterRules' : 'ApplyOutgoingFilterRules', { filterRules: [{ filterRule: v.names.map(name => ({ name })) }], m: { ids: v.messageIds.join(',') } }, true);
        return { ...result, warning: 'Rules were requested against these messages. Re-query their state; server actions may send notifications. Do not retry an uncertain result.' };
      }
      let desired: Obj[] = rules;
      if ('rules' in v) {
        desired = v.rules.map(r => r.source === 'new' ? compileRule(r.rule) : { ...rules[locate(r.name)], ...(r.active === undefined ? {} : { active: r.active ? 1 : 0 }) });
      } else if ('rule' in v) {
        const i = rules.findIndex(r => r.name === v.rule.name);
        if (i >= 0) rules.splice(i, 1);
        const target = v.beforeRuleName ? locate(v.beforeRuleName) : i >= 0 ? Math.min(i, rules.length) : rules.length;
        rules.splice(target, 0, compileRule(v.rule));
      } else if ('enabled' in v) rules[locate(v.name)].active = v.enabled ? 1 : 0;
      else rules.splice(locate(v.name), 1);
      if (desired.length > 1000 || new Set(desired.map(r => r.name)).size !== desired.length || JSON.stringify(desired).length > 1048576) throw new ZimbraError('INVALID_INPUT', 'Duplicate rule names or oversized filter list.');
      checkFilterPolicy(desired, this.allowedRecipients);
      await this.request(v.direction === 'incoming' ? 'ModifyFilterRules' : 'ModifyOutgoingFilterRules', { filterRules: [{ filterRule: desired }] }, true);
      // The server can normalize rules. Always return actual read-back, never
      // treat a SOAP acknowledgement as evidence of exact round-trip retention.
      let observed;
      try { observed = await this.read(v.direction); }
      catch { return { status: 'accepted_unverified', warning: 'Rule replacement was accepted but read-back failed. Read the rules before another write; do not retry automatically.' }; }
      return { status: 'accepted', ...observed, exactMatch: filterRevision(desired) === observed.revision,
        warning: 'Inspect the returned rules: server normalization or concurrent edits may change them. This API has no atomic compare-and-set.' };
    } finally { this.writing = false; }
  }
}
