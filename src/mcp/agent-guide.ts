import type { GetPromptResult, Prompt, ReadResourceResult, Resource } from '@modelcontextprotocol/sdk/types.js';

export const MAIL_AGENT_GUIDE_URI = 'mail://agent-guide';
export const MAIL_AGENT_GUIDE_PROMPT_NAME = 'mail_agent_workflow';

export const MAIL_SERVER_INSTRUCTIONS = `Call list_accounts first. Use mail_query for reads and mail_mutate for writes. Read mail://agent-guide for the core workflow, then only the needed mail://reference/<topic> for input rules. Resources and equivalent prompts list the available topics. Preserve cursors and message locators. Respect read-only, allowlist, and confirmation gates. Never retry smtp_outcome_unknown automatically.`;

import { MAIL_AGENT_GUIDE, MAIL_REFERENCE_DOCUMENTS } from './agent-guide-content.js';
export { MAIL_AGENT_GUIDE, MAIL_REFERENCE_DOCUMENTS } from './agent-guide-content.js';

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

export const MAIL_DOCUMENTATION_RESOURCES: Resource[] = [
  MAIL_AGENT_GUIDE_RESOURCE,
  ...MAIL_REFERENCE_DOCUMENTS.map(({ topic, title }) => ({
    uri: `mail://reference/${topic}`,
    name: `mail_reference_${topic.replaceAll('-', '_')}`,
    title,
    description: `On-demand ${title} operation inputs and workflow.`,
    mimeType: 'text/markdown',
  })),
];

export const MAIL_DOCUMENTATION_PROMPTS: Prompt[] = [
  MAIL_AGENT_GUIDE_PROMPT,
  ...MAIL_DOCUMENTATION_RESOURCES.slice(1).map(({ name, title, description }) => ({
    name, title, description,
  })),
];

export function readMailAgentGuideResource(uri: string): ReadResourceResult | undefined {
  const reference = MAIL_REFERENCE_DOCUMENTS.find(doc => uri === `mail://reference/${doc.topic}`);
  const text = uri === MAIL_AGENT_GUIDE_URI ? MAIL_AGENT_GUIDE : reference?.text;
  if (text === undefined) return undefined;

  return {
    contents: [{
      uri,
      mimeType: 'text/markdown',
      text,
    }],
  };
}

export function getMailAgentGuidePrompt(name: string): GetPromptResult | undefined {
  const prompt = MAIL_DOCUMENTATION_PROMPTS.find(candidate => candidate.name === name);
  if (!prompt) return undefined;
  const resource = MAIL_DOCUMENTATION_RESOURCES.find(candidate =>
    name === MAIL_AGENT_GUIDE_PROMPT_NAME ? candidate.uri === MAIL_AGENT_GUIDE_URI : candidate.name === name
  );
  const content = resource && readMailAgentGuideResource(resource.uri)?.contents[0];
  if (!content || !('text' in content)) return undefined;

  return {
    description: prompt.description,
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: content.text,
      },
    }],
  };
}
