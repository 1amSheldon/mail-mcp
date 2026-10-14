import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAIL_QUERY_OPERATIONS, MAIL_MUTATION_OPERATIONS, routeMailToolCall } from './tool-catalog.js';
import {
  MAIL_AGENT_GUIDE, MAIL_REFERENCE_DOCUMENTS, MAIL_DOCUMENTATION_RESOURCES,
  MAIL_DOCUMENTATION_PROMPTS, MAIL_AGENT_GUIDE_URI,
} from './agent-guide.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MailMCPServer } from '../index.js';
import { installCodexSkill } from '../cli/install-codex.js';
import { installClaudeCodeSkill } from '../cli/install-claude-code.js';
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

  it.each([
    ['Codex', installCodexSkill],
    ['Claude Code', installClaudeCodeSkill],
  ] as const)('installs matching portable topic references for %s', async (_name, install) => {
    const home = await mkdtemp(join(tmpdir(), 'mail-docs-install-'));
    try {
      await install(home);
      for (const doc of await documents()) {
        expect(await readFile(join(home, 'skills/mail-mcp', doc.name), 'utf8'))
          .toBe(await readFile(doc.url, 'utf8'));
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('has an operation-table entry for every public router selector, with no retired selectors', async () => {
    const docs = await documents();
    const listed = new Set(docs.flatMap(doc => [...doc.content.matchAll(/^\| ([^|]+) \|/gm)]
      .flatMap(row => [...row[1].matchAll(/`([a-zA-Z][\w.]*)`/g)].map(match => match[1]))));
    const actual = new Set([...MAIL_QUERY_OPERATIONS, ...MAIL_MUTATION_OPERATIONS]);
    expect([...actual].filter(name => !listed.has(name))).toEqual([]);
    expect([...listed].filter(name => !actual.has(name as never))).toEqual([]);
  });

  it('resolves portable links and preserves each reference in its own runtime resource', async () => {
    for (const doc of await documents()) {
      expect(doc.content).not.toContain('\uFFFD');
      for (const match of doc.content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (/^[a-z]+:/i.test(match[1])) continue;
        const target = new URL(match[1].split('#')[0], doc.url);
        expect(target.href.startsWith(skill.href)).toBe(true);
        expect((await readFile(target, 'utf8')).length).toBeGreaterThan(0);
      }
      const runtimeText = doc.content.replace(/^---\n[\s\S]*?\n---\n/, '').trim().replace(
        /\[([^\]]+)\]\((?:references\/)?([a-z-]+)\.md(#[^)]+)?\)/g,
        (_, label, topic) => `[${label}](mail://reference/${topic})`,
      ) + '\n';
      const runtime = doc.name === 'SKILL.md' ? MAIL_AGENT_GUIDE
        : MAIL_REFERENCE_DOCUMENTS.find(reference => `references/${reference.topic}.md` === doc.name)?.text;
      expect(runtime).toBe(runtimeText);
      for (const [, topic] of runtimeText.matchAll(/\]\(mail:\/\/reference\/([a-z-]+)\)/g)) {
        expect(MAIL_DOCUMENTATION_RESOURCES.some(resource => resource.uri === `mail://reference/${topic}`)).toBe(true);
      }
    }
  });

  it('discovers and reads documentation through the MCP protocol without accounts or external effects', async () => {
    const server = new MailMCPServer(true);
    const client = new Client({ name: 'documentation-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await (server as unknown as { server: Server }).server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['list_accounts', 'mail_query']);
      expect((await client.listResources()).resources).toEqual(MAIL_DOCUMENTATION_RESOURCES);
      expect((await client.listPrompts()).prompts).toEqual(MAIL_DOCUMENTATION_PROMPTS);
      const core = await client.readResource({ uri: MAIL_AGENT_GUIDE_URI });
      expect(core.contents[0]).toMatchObject({ text: MAIL_AGENT_GUIDE });
      for (const { topic, text } of MAIL_REFERENCE_DOCUMENTS) {
        const uri = `mail://reference/${topic}`;
        expect((await client.readResource({ uri })).contents).toEqual([{ uri, mimeType: 'text/markdown', text }]);
        expect((await client.getPrompt({ name: `mail_reference_${topic.replaceAll('-', '_')}` })).messages)
          .toEqual([{ role: 'user', content: { type: 'text', text } }]);
      }
      await expect(client.readResource({ uri: 'mail://reference/unknown' })).rejects.toThrow('Unknown resource');
      await expect(client.getPrompt({ name: 'mail_reference_unknown' })).rejects.toThrow('Unknown prompt');
    } finally {
      await client.close();
      await server.shutdown();
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
