import type { GetPromptResult, Prompt, ReadResourceResult, Resource } from '@modelcontextprotocol/sdk/types.js';

export const MAIL_AGENT_GUIDE_URI = 'mail://agent-guide';
export const MAIL_AGENT_GUIDE_PROMPT_NAME = 'mail_agent_workflow';

export const MAIL_SERVER_INSTRUCTIONS = `Call list_accounts first. Use mail_query for reads and mail_mutate for writes. Read mail://agent-guide for operation names and input rules. Preserve cursors and message locators. Respect read-only, allowlist, and confirmation gates. Never retry smtp_outcome_unknown automatically.`;

import { MAIL_AGENT_GUIDE } from './agent-guide-content.js';
export { MAIL_AGENT_GUIDE } from './agent-guide-content.js';

export const MAIL_AGENT_GUIDE_RESOURCE: Resource = {
  uri: MAIL_AGENT_GUIDE_URI,
  name: 'mail_agent_guide',
  title: 'Mail MCP agent workflow',
  description: 'Client-neutral rules for safe, capability-aware mail operations.',
  mimeType: 'text/markdown',
};

export const MAIL_AGENT_GUIDE_PROMPT: Prompt = {
  name: MAIL_AGENT_GUIDE_PROMPT_NAME,
  title: 'Mail MCP agent workflow',
  description: 'Apply the safe mail workflow before reading or changing mailbox data.',
};

export function readMailAgentGuideResource(uri: string): ReadResourceResult | undefined {
  if (uri !== MAIL_AGENT_GUIDE_URI) return undefined;

  return {
    contents: [{
      uri: MAIL_AGENT_GUIDE_URI,
      mimeType: 'text/markdown',
      text: MAIL_AGENT_GUIDE,
    }],
  };
}

export function getMailAgentGuidePrompt(name: string): GetPromptResult | undefined {
  if (name !== MAIL_AGENT_GUIDE_PROMPT_NAME) return undefined;

  return {
    description: MAIL_AGENT_GUIDE_PROMPT.description,
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: MAIL_AGENT_GUIDE,
      },
    }],
  };
}
