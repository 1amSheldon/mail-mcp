import { describe, expect, it } from 'vitest';
import {
  getMailAgentGuidePrompt,
  MAIL_AGENT_GUIDE,
  MAIL_AGENT_GUIDE_PROMPT,
  MAIL_AGENT_GUIDE_PROMPT_NAME,
  MAIL_AGENT_GUIDE_RESOURCE,
  MAIL_AGENT_GUIDE_URI,
  MAIL_DOCUMENTATION_PROMPTS,
  MAIL_DOCUMENTATION_RESOURCES,
  MAIL_REFERENCE_DOCUMENTS,
  MAIL_SERVER_INSTRUCTIONS,
  readMailAgentGuideResource,
} from './agent-guide.js';

describe('mail agent guide', () => {
  it('keeps the core workflow bounded and loads provider topics separately', () => {
    expect(Buffer.byteLength(MAIL_AGENT_GUIDE)).toBeLessThan(8_192);
    expect(Buffer.byteLength(MAIL_SERVER_INSTRUCTIONS)).toBeLessThan(1_024);
    for (const topic of MAIL_REFERENCE_DOCUMENTS) {
      expect(MAIL_AGENT_GUIDE).toContain(`mail://reference/${topic.topic}`);
      expect(MAIL_AGENT_GUIDE).not.toContain(topic.text);
    }
    expect(MAIL_AGENT_GUIDE).not.toContain('zimbra.createAppointment');
    expect(MAIL_AGENT_GUIDE).not.toContain('zimbra.uploadDocument');
  });

  it('covers the required operating rules', () => {
    expect(MAIL_AGENT_GUIDE).toContain('Call `list_accounts`');
    expect(MAIL_AGENT_GUIDE).toContain('pass the returned `nextCursor` unchanged');
    expect(MAIL_AGENT_GUIDE).toContain('Read each target message before');
    expect(MAIL_AGENT_GUIDE).toContain('Prefer a draft');
    expect(MAIL_AGENT_GUIDE).toContain('confirmationId');
    expect(MAIL_AGENT_GUIDE).toContain('Never automatically retry `smtp_outcome_unknown`');
    expect(MAIL_AGENT_GUIDE).toContain('returned Message-ID');
    expect(MAIL_AGENT_GUIDE).toContain('metadata before fetching');
    expect(MAIL_AGENT_GUIDE).toContain('backend');
  });

  it('contains no embedded credential values or environment-specific account data', () => {
    // Field names are legitimate contracts; credential values are not.
    expect(MAIL_AGENT_GUIDE).not.toMatch(/BEGIN [A-Z ]+PRIVATE KEY|(?:clientSecret|refreshToken)["']?\s*:\s*["'][^"']+["']/);
    expect(MAIL_AGENT_GUIDE).not.toMatch(/["'][A-Za-z0-9+/]{40,}={0,2}["']/);
    expect(MAIL_AGENT_GUIDE).not.toContain('@gmail.com');
  });

  it('exposes registration-neutral resource metadata and content', () => {
    expect(MAIL_AGENT_GUIDE_RESOURCE.uri).toBe(MAIL_AGENT_GUIDE_URI);
    expect(MAIL_AGENT_GUIDE_RESOURCE.mimeType).toBe('text/markdown');
    expect(readMailAgentGuideResource(MAIL_AGENT_GUIDE_URI)?.contents).toEqual([{
      uri: MAIL_AGENT_GUIDE_URI,
      mimeType: 'text/markdown',
      text: MAIL_AGENT_GUIDE,
    }]);
    expect(readMailAgentGuideResource('mail://unknown')).toBeUndefined();
  });

  it('exposes registration-neutral prompt metadata and content', () => {
    expect(MAIL_AGENT_GUIDE_PROMPT.name).toBe(MAIL_AGENT_GUIDE_PROMPT_NAME);
    expect(getMailAgentGuidePrompt(MAIL_AGENT_GUIDE_PROMPT_NAME)?.messages).toEqual([{
      role: 'user',
      content: { type: 'text', text: MAIL_AGENT_GUIDE },
    }]);
    expect(getMailAgentGuidePrompt('unknown')).toBeUndefined();
  });

  it('lists and serves each topic with an equivalent prompt and no unrelated content', () => {
    expect(MAIL_DOCUMENTATION_RESOURCES).toHaveLength(MAIL_REFERENCE_DOCUMENTS.length + 1);
    expect(MAIL_DOCUMENTATION_PROMPTS).toHaveLength(MAIL_DOCUMENTATION_RESOURCES.length);
    expect(new Set(MAIL_DOCUMENTATION_RESOURCES.map(resource => resource.uri)).size)
      .toBe(MAIL_DOCUMENTATION_RESOURCES.length);
    expect(new Set(MAIL_DOCUMENTATION_PROMPTS.map(prompt => prompt.name)).size)
      .toBe(MAIL_DOCUMENTATION_PROMPTS.length);
    for (const { topic, text } of MAIL_REFERENCE_DOCUMENTS) {
      const uri = `mail://reference/${topic}`;
      const name = `mail_reference_${topic.replaceAll('-', '_')}`;
      expect(MAIL_DOCUMENTATION_RESOURCES.find(resource => resource.uri === uri)?.name).toBe(name);
      expect(MAIL_DOCUMENTATION_PROMPTS.find(prompt => prompt.name === name)).toBeDefined();
      expect(readMailAgentGuideResource(uri)?.contents).toEqual([{ uri, mimeType: 'text/markdown', text }]);
      expect(getMailAgentGuidePrompt(name)?.messages).toEqual([{
        role: 'user', content: { type: 'text', text },
      }]);
    }
    for (const invalid of ['mail://reference/unknown', 'mail://reference/zimbra/../operations', 'mail://reference/zimbra?all=true']) {
      expect(readMailAgentGuideResource(invalid)).toBeUndefined();
    }
  });
});
