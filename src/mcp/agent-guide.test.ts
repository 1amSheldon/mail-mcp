import { describe, expect, it } from 'vitest';
import {
  getMailAgentGuidePrompt,
  MAIL_AGENT_GUIDE,
  MAIL_AGENT_GUIDE_PROMPT,
  MAIL_AGENT_GUIDE_PROMPT_NAME,
  MAIL_AGENT_GUIDE_RESOURCE,
  MAIL_AGENT_GUIDE_URI,
  readMailAgentGuideResource,
} from './agent-guide.js';

describe('mail agent guide', () => {
  it('covers the required operating rules', () => {
    expect(MAIL_AGENT_GUIDE).toContain('Call `list_accounts`');
    expect(MAIL_AGENT_GUIDE).toContain('pass the returned `nextCursor` unchanged');
    expect(MAIL_AGENT_GUIDE).toContain('Read each target message before');
    expect(MAIL_AGENT_GUIDE).toContain('Prefer a draft');
    expect(MAIL_AGENT_GUIDE).toContain('confirmation IDs');
    expect(MAIL_AGENT_GUIDE).toContain('Never automatically retry `smtp_outcome_unknown`');
    expect(MAIL_AGENT_GUIDE).toContain('returned Message-ID');
    expect(MAIL_AGENT_GUIDE).toContain('Inspect attachment metadata');
    expect(MAIL_AGENT_GUIDE).toContain('Explain capability boundaries');
  });

  it('contains no embedded credential values or environment-specific account data', () => {
    expect(MAIL_AGENT_GUIDE).not.toMatch(/MAIL_MCP_BEARER_TOKEN|clientSecret|refreshToken|BEGIN [A-Z ]+PRIVATE KEY/);
    expect(MAIL_AGENT_GUIDE).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
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
});
