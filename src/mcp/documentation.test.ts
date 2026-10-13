import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAIL_QUERY_OPERATIONS, MAIL_MUTATION_OPERATIONS, routeMailToolCall } from './tool-catalog.js';
import { MAIL_AGENT_GUIDE } from './agent-guide.js';
import { ZIMBRA_READ_SCHEMAS, ZIMBRA_WRITE_SCHEMAS } from '../providers/zimbra/operations.js';
import { classifyMailtrapAction } from '../providers/mailtrap/classification.js';
import type { MailtrapAction, MailtrapActionInputMap } from '../providers/mailtrap/types.js';

const root = new URL('../../', import.meta.url);
const skill = new URL('skills/mail-mcp/', root);
async function documents() {
  const names = (await readdir(new URL('references/', skill))).filter(name => name.endsWith('.md'));
  return Promise.all(['SKILL.md', ...names.map(name => `references/${name}`)].map(async name => ({
    name, url: new URL(name, skill), content: (await readFile(new URL(name, skill), 'utf8')).replace(/\r\n/g, '\n'),
  })));
}

describe('portable mail documentation contracts', () => {
  it('publishes exactly the maintained content in the runtime resource', () => {
    expect(() => execFileSync(process.execPath, ['scripts/generate-agent-guide.mjs', '--check'], {
      cwd: fileURLToPath(root), stdio: 'pipe',
    })).not.toThrow();
  });

  it('has an operation-table entry for every public router selector, with no retired selectors', async () => {
    const docs = await documents();
    const listed = new Set(docs.flatMap(doc => [...doc.content.matchAll(/^\| ([^|]+) \|/gm)]
      .flatMap(row => [...row[1].matchAll(/`([a-zA-Z][\w.]*)`/g)].map(match => match[1]))));
    const actual = new Set([...MAIL_QUERY_OPERATIONS, ...MAIL_MUTATION_OPERATIONS]);
    expect([...actual].filter(name => !listed.has(name))).toEqual([]);
    expect([...listed].filter(name => !actual.has(name as never))).toEqual([]);
  });

  it('resolves every portable local link and embeds every reference in the resource', async () => {
    for (const doc of await documents()) {
      expect(doc.content).not.toContain('\uFFFD');
      for (const match of doc.content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (/^[a-z]+:/i.test(match[1])) continue;
        const target = new URL(match[1].split('#')[0], doc.url);
        expect(target.href.startsWith(skill.href)).toBe(true);
        expect((await readFile(target, 'utf8')).length).toBeGreaterThan(0);
      }
      if (doc.name !== 'SKILL.md') expect(MAIL_AGENT_GUIDE).toContain(doc.content.split('\n')[0]);
    }
  });

  it('documents every emitted SMTP delivery status', async () => {
    const source = await readFile(new URL('src/services/mail.ts', root), 'utf8');
    const statuses = source.split('export type DeliveryStatus =')[1].split(';')[0];
    const outcomes = await readFile(new URL('references/outcomes.md', skill), 'utf8');
    for (const [, status] of statuses.matchAll(/'([^']+)'/g)) {
      expect(outcomes, status).toContain(`| ${status} |`);
    }
  });

  it('parses documented JSON examples and routes them without external effects', async () => {
    let count = 0;
    for (const doc of await documents()) {
      for (const [, json] of doc.content.matchAll(/```json\n([\s\S]*?)\n```/g)) {
        const envelope = JSON.parse(json);
        const isWrite = envelope.operation.startsWith('mailtrap.')
          ? classifyMailtrapAction(envelope.operation.slice(9), envelope.input).access === 'write'
          : MAIL_MUTATION_OPERATIONS.includes(envelope.operation);
        const tool = isWrite ? 'mail_mutate' : 'mail_query';
        expect(() => routeMailToolCall(tool, envelope), doc.name).not.toThrow();
        if (envelope.operation.startsWith('zimbra.')) {
          const operation = envelope.operation.slice(7);
          const schemas = { ...ZIMBRA_READ_SCHEMAS, ...ZIMBRA_WRITE_SCHEMAS };
          expect(schemas[operation as keyof typeof schemas].safeParse(envelope.input).success, doc.name).toBe(true);
        }
        if (envelope.operation.startsWith('mailtrap.')) {
          const action = envelope.operation.slice(9) as MailtrapAction;
          expect(classifyMailtrapAction(action, envelope.input as MailtrapActionInputMap[typeof action]).access).toBe(isWrite ? 'write' : 'read');
        }
        count++;
      }
    }
    expect(count).toBeGreaterThanOrEqual(6);
  });
});
