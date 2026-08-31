import { describe, expect, it } from 'vitest';
import { classifyMailtrapAction } from './classification.js';

describe('classifyMailtrapAction', () => {
  it('rejects unknown runtime dispatch values instead of classifying them as writes', () => {
    const classifyUnchecked = classifyMailtrapAction as unknown as (
      action: string,
      input: unknown,
    ) => unknown;
    const invalidDispatches: Array<[string, Record<string, unknown>, string]> = [
      ['templates', { operation: 'destroy', templateId: 1 }, 'Unsupported Mailtrap templates operation: destroy'],
      ['inbound', { resource: 'folder', operation: 'archive', folderId: 1 }, 'Unsupported Mailtrap inbound folder operation: archive'],
      ['inbound', { resource: 'unknown', operation: 'delete' }, 'Unsupported Mailtrap inbound resource: unknown'],
      ['webhooks', { operation: 'rotate', webhookId: 1 }, 'Unsupported Mailtrap webhooks operation: rotate'],
      ['contact_lists', { operation: 'archive', id: 1 }, 'Unsupported Mailtrap contact_lists operation: archive'],
      ['contact_fields', { operation: 'archive', id: 1 }, 'Unsupported Mailtrap contact_fields operation: archive'],
      ['campaigns', { operation: 'launch', campaignId: 1 }, 'Unsupported Mailtrap campaigns operation: launch'],
      ['unknown', { operation: 'delete' }, 'Unsupported Mailtrap action: unknown'],
    ];

    for (const [action, input, error] of invalidDispatches) {
      expect(() => classifyUnchecked(action, input)).toThrow(error);
    }
  });

  it('marks reads without escalating them to writes', () => {
    expect(classifyMailtrapAction('email_logs', { operation: 'list' })).toEqual({
      access: 'read', destructive: false, sendsMail: false, sensitiveResponse: true,
    });
    expect(classifyMailtrapAction('sandbox', {
      resource: 'message', operation: 'body', inboxId: 1, messageId: 2, format: 'raw',
    }).access).toBe('read');
  });

  it('marks sends, sensitive webhook creation, and destructive mutations explicitly', () => {
    expect(classifyMailtrapAction('send', {
      operation: 'transactional', message: { text: 'hello' },
    })).toMatchObject({ access: 'write', sendsMail: true, destructive: false });
    expect(classifyMailtrapAction('webhooks', {
      operation: 'create', webhook: { url: 'https://hooks.example.com' },
    })).toMatchObject({ access: 'write', sensitiveResponse: true });
    expect(classifyMailtrapAction('suppressions', {
      operation: 'delete', suppressionId: 7,
    })).toMatchObject({ access: 'write', destructive: true });
    expect(classifyMailtrapAction('inbound', {
      resource: 'thread', operation: 'delete', inboxId: 1, threadId: 9,
    })).toMatchObject({ access: 'write', destructive: true });
    expect(classifyMailtrapAction('campaigns', {
      operation: 'terminate', campaignId: 3,
    })).toMatchObject({ access: 'write', destructive: true });
    expect(classifyMailtrapAction('sandbox', {
      resource: 'message', operation: 'forward', inboxId: 1, messageId: 2,
      email: 'recipient@example.com',
    })).toMatchObject({ access: 'write', sendsMail: true });
    expect(classifyMailtrapAction('sandbox', {
      resource: 'inbox', operation: 'reset_credentials', inboxId: 1,
    })).toMatchObject({ access: 'write', destructive: true, sensitiveResponse: true });
  });

  it('marks message content and inbound reply surfaces as sensitive', () => {
    expect(classifyMailtrapAction('sandbox', {
      resource: 'message', operation: 'body', inboxId: 1, messageId: 2, format: 'raw',
    })).toMatchObject({ access: 'read', sensitiveResponse: true });
    expect(classifyMailtrapAction('inbound', {
      resource: 'message', operation: 'reply_all', inboxId: 1, messageId: 2, body: { text: 'reply' },
    })).toMatchObject({ access: 'write', sendsMail: true, sensitiveResponse: true });
  });
});
