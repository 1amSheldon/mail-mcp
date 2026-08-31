import { describe, expect, it } from 'vitest';
import {
  filterToolCatalog,
  isWriteCall,
  isWriteCallAllowed,
  isWriteTool,
  MAIL_MUTATION_OPERATIONS,
  MAIL_QUERY_OPERATIONS,
  routeMailToolCall,
  TOOL_CATALOG,
  WRITE_TOOL_NAMES,
  WRITE_TOOLS,
} from './tool-catalog.js';

describe('compact tool catalog', () => {
  it('advertises three unique tools', () => {
    const names = TOOL_CATALOG.map(tool => tool.name);

    expect(names).toEqual(['list_accounts', 'mail_query', 'mail_mutate']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps write classification aligned with MCP annotations', () => {
    expect(WRITE_TOOL_NAMES).toEqual(['mail_mutate']);
    expect(WRITE_TOOLS.size).toBe(1);

    for (const tool of TOOL_CATALOG) {
      expect(isWriteTool(tool.name)).toBe(tool.annotations?.readOnlyHint === false);
    }
  });

  it('returns only discovery and query tools in read-only mode', () => {
    expect(filterToolCatalog(true).map(tool => tool.name)).toEqual([
      'list_accounts',
      'mail_query',
    ]);
  });

  it('narrows the mutation operation enum to the allowlist', () => {
    const tools = filterToolCatalog(false, new Set(['sendMessage', 'moveToTrash']));
    const mutation = tools.find(tool => tool.name === 'mail_mutate');

    expect(tools.map(tool => tool.name)).toEqual(['list_accounts', 'mail_query', 'mail_mutate']);
    expect(mutation?.inputSchema.properties?.operation).toEqual({
      type: 'string',
      enum: ['sendMessage', 'moveToTrash'],
    });
  });

  it('accepts legacy internal write selectors without advertising legacy tools', () => {
    const tools = filterToolCatalog(false, new Set(['send_email']));
    const mutation = tools.find(tool => tool.name === 'mail_mutate');

    expect(mutation?.inputSchema.properties?.operation).toEqual({
      type: 'string',
      enum: ['sendMessage'],
    });
    expect(tools.some(tool => tool.name === 'send_email')).toBe(false);
  });

  it('removes mail_mutate when no write operation is allowed', () => {
    expect(filterToolCatalog(false, new Set()).map(tool => tool.name)).toEqual([
      'list_accounts',
      'mail_query',
    ]);
  });

  it('reduces serialized tool schemas by more than 80 percent', () => {
    const previousSchemaBytes = 39_637;
    const currentSchemaBytes = Buffer.byteLength(JSON.stringify(TOOL_CATALOG));

    expect(currentSchemaBytes).toBeLessThan(7_928);
    expect(1 - currentSchemaBytes / previousSchemaBytes).toBeGreaterThan(0.8);
    expect(JSON.stringify(TOOL_CATALOG)).not.toContain('offset');
  });
});

describe('mail router', () => {
  it('has a dispatch route for every advertised operation', () => {
    for (const operation of MAIL_QUERY_OPERATIONS) {
      expect(() => routeMailToolCall('mail_query', {
        accountId: 'test',
        operation,
        input: {},
      })).not.toThrow();
    }
    for (const operation of MAIL_MUTATION_OPERATIONS) {
      expect(() => routeMailToolCall('mail_mutate', {
        accountId: 'test',
        operation,
        input: {},
      })).not.toThrow();
    }
  });

  it('routes standard reads and flattens operation input', () => {
    expect(routeMailToolCall('mail_query', {
      accountId: 'primary',
      operation: 'listMessages',
      input: { folder: 'INBOX', limit: 25 },
    })).toEqual({
      name: 'list_emails',
      args: { accountId: 'primary', folder: 'INBOX', limit: 25 },
    });
  });

  it('routes standard writes and preserves account identity', () => {
    expect(routeMailToolCall('mail_mutate', {
      accountId: 'primary',
      operation: 'sendMessage',
      input: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
    })).toEqual({
      name: 'send_email',
      args: {
        accountId: 'primary',
        to: 'user@example.com',
        subject: 'Hi',
        body: 'Hello',
      },
    });
  });

  it('routes provider reads and writes to their existing adapters', () => {
    expect(routeMailToolCall('mail_query', {
      accountId: 'outlook',
      operation: 'microsoft.searchMessages',
      input: { query: 'invoice' },
    })).toEqual({
      name: 'microsoft_mail_query',
      args: {
        accountId: 'outlook',
        operation: 'searchMessages',
        input: { query: 'invoice' },
      },
    });

    expect(routeMailToolCall('mail_mutate', {
      accountId: 'transactional',
      operation: 'mailtrap.send',
      input: { operation: 'transactional', message: { to: [{ email: 'user@example.com' }] } },
    })).toEqual({
      name: 'mailtrap_mutate',
      args: {
        accountId: 'transactional',
        action: 'send',
        input: { operation: 'transactional', message: { to: [{ email: 'user@example.com' }] } },
      },
    });
  });

  it('preserves optional template account scope', () => {
    expect(routeMailToolCall('mail_query', {
      accountId: 'work',
      operation: 'listTemplates',
      input: {},
    })).toEqual({
      name: 'list_templates',
      args: { accountId: 'work' },
    });

    expect(routeMailToolCall('mail_query', {
      accountId: 'work',
      operation: 'renderTemplate',
      input: { templateId: 'ack' },
    })).toEqual({
      name: 'use_template',
      args: { accountId: 'work', templateId: 'ack' },
    });
  });

  it('rejects invalid optional template account scopes', () => {
    for (const operation of ['listTemplates', 'renderTemplate']) {
      for (const accountId of ['', ' ', 42, null, undefined]) {
        expect(() => routeMailToolCall('mail_query', {
          accountId,
          operation,
          input: {},
        })).toThrow('accountId is required for this operation');
      }
    }
  });

  it('rejects unknown operations and reserved nested fields', () => {
    expect(() => routeMailToolCall('mail_query', {
      accountId: 'primary',
      operation: 'unknown',
      input: {},
    })).toThrow('Unknown mail_query operation');

    expect(() => routeMailToolCall('mail_mutate', {
      accountId: 'primary',
      operation: 'sendMessage',
      input: { accountId: 'other' },
    })).toThrow('accountId belongs at the top level');
  });

  it('classifies and authorizes public and internal write calls', () => {
    expect(isWriteCall('mail_mutate')).toBe(true);
    expect(isWriteCall('send_email')).toBe(true);
    expect(isWriteCall('mail_query')).toBe(false);
    expect(isWriteCallAllowed('mail_mutate', {
      operation: 'sendMessage',
    }, new Set(['sendMessage']))).toBe(true);
    expect(isWriteCallAllowed('mail_mutate', {
      operation: 'moveToTrash',
    }, new Set(['sendMessage']))).toBe(false);
  });
});
