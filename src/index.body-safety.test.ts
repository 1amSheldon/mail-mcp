import { describe, expect, it, vi } from 'vitest';
import { MailMCPServer } from './index.js';

describe('outgoing MCP body safety', () => {
  it.each(['body', 'textBody', 'htmlBody'])('rejects a %s source object before opening an account', async field => {
    const server = new MailMCPServer(false);
    const service = vi.spyOn(server as any, 'getService');
    const result = await server.dispatchTool('mail_mutate', false, {
      accountId: 'fixture', operation: 'createDraft', input: {
        to: 'recipient@example.test', subject: 'fixture',
        [field]: { path: 'http://127.0.0.1/private' },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`${field} must be a string`);
    expect(service).not.toHaveBeenCalled();
    await server.shutdown();
  });
});
