import { describe, expect, it, vi } from 'vitest';
import { MailtrapClient, MailtrapHttpError } from './client.js';

function jsonResponse(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchMock: ReturnType<typeof vi.fn>, accountId: string | number | undefined = 42): MailtrapClient {
  return new MailtrapClient({
    token: 'mt-secret-token',
    accountId,
    fetch: fetchMock as unknown as typeof fetch,
    endpoints: {
      general: 'https://general.test',
      transactional: 'https://send.test',
      bulk: 'https://bulk.test',
      sandbox: 'https://sandbox.test',
    },
  });
}

function requestAt(fetchMock: ReturnType<typeof vi.fn>, index = 0): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index];
  return { url: String(call[0]), init: call[1] as RequestInit };
}

function executeUnchecked(
  client: MailtrapClient,
  action: string,
  input: unknown,
): Promise<unknown> {
  const execute = client.execute as unknown as (
    action: string,
    input: unknown,
  ) => Promise<unknown>;
  return execute.call(client, action, input);
}

describe('MailtrapClient send actions', () => {
  it('routes transactional send with bearer authentication and the exact payload', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ success: true })));
    const client = clientWith(fetchMock);

    await client.execute('send', {
      operation: 'transactional',
      message: {
        from: { email: 'sender@example.com' },
        to: [{ email: 'recipient@example.com' }],
        subject: 'Status',
        text: 'Ready',
      },
    });

    const request = requestAt(fetchMock);
    expect(request.url).toBe('https://send.test/api/send');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toMatchObject({
      Authorization: 'Bearer mt-secret-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(request.init.body))).toEqual({
      from: { email: 'sender@example.com' },
      to: [{ email: 'recipient@example.com' }],
      subject: 'Status',
      text: 'Ready',
    });
  });

  it('preserves base/request overrides for bulk and sandbox batch sends', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ success: true })));
    const client = clientWith(fetchMock);
    const base = { from: { email: 'sender@example.com' }, category: 'digest' };
    const requests = [{ to: [{ email: 'one@example.com' }], subject: 'One' }];

    await client.execute('send', { operation: 'bulk', base, requests });
    await client.execute('send', { operation: 'sandbox_batch', inboxId: 77, base, requests });

    expect(requestAt(fetchMock, 0).url).toBe('https://bulk.test/api/batch');
    expect(requestAt(fetchMock, 1).url).toBe('https://sandbox.test/api/batch/77');
    expect(JSON.parse(String(requestAt(fetchMock, 0).init.body))).toEqual({ base, requests });
    expect(JSON.parse(String(requestAt(fetchMock, 1).init.body))).toEqual({ base, requests });
  });

  it('never retries a failed send and redacts provider secrets from error details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      error: 'invalid',
      api_token: 'response-secret',
      nested: { signing_secret: 'webhook-secret' },
    }, 500));
    const client = clientWith(fetchMock);

    const failure = client.execute('send', {
      operation: 'transactional',
      message: { to: [{ email: 'recipient@example.com' }], text: 'hello' },
    });
    await expect(failure).rejects.toMatchObject({
      name: 'MailtrapHttpError',
      status: 500,
      details: {
        api_token: '[REDACTED]',
        nested: { signing_secret: '[REDACTED]' },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects ambiguous inline-and-template messages before the network boundary', async () => {
    const fetchMock = vi.fn();
    const client = clientWith(fetchMock);

    await expect(client.execute('send', {
      operation: 'transactional',
      message: {
        to: [{ email: 'recipient@example.com' }],
        template_uuid: 'template-123',
        subject: 'Conflicting inline subject',
      },
    })).rejects.toThrow('cannot combine template_uuid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MailtrapClient core resource routing', () => {
  it('rejects every unknown action, resource, or operation before fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = clientWith(fetchMock);
    const invalidDispatches: Array<{
      action: string;
      input: Record<string, unknown>;
      error: string;
    }> = [
      { action: 'unknown', input: { operation: 'delete' }, error: 'Unsupported Mailtrap action: unknown' },
      { action: 'send', input: { operation: 'delete' }, error: 'Unsupported Mailtrap send operation: delete' },
      { action: 'templates', input: { operation: 'destroy', templateId: 1 }, error: 'Unsupported Mailtrap templates operation: destroy' },
      { action: 'sandbox', input: { resource: 'project', operation: 'archive', projectId: 1 }, error: 'Unsupported Mailtrap sandbox project operation: archive' },
      { action: 'sandbox', input: { resource: 'attachment', operation: 'delete', inboxId: 1, messageId: 2, attachmentId: 3 }, error: 'Unsupported Mailtrap sandbox attachment operation: delete' },
      { action: 'sandbox', input: { resource: 'unknown', operation: 'delete' }, error: 'Unsupported Mailtrap sandbox resource: unknown' },
      { action: 'email_logs', input: { operation: 'delete', messageId: 1 }, error: 'Unsupported Mailtrap email_logs operation: delete' },
      { action: 'stats', input: { operation: 'unknown', query: {} }, error: 'Unsupported Mailtrap stats operation: unknown' },
      { action: 'inbound', input: { resource: 'folder', operation: 'archive', folderId: 1 }, error: 'Unsupported Mailtrap inbound folder operation: archive' },
      { action: 'inbound', input: { resource: 'inbox', operation: 'archive', folderId: 1, inboxId: 2 }, error: 'Unsupported Mailtrap inbound inbox operation: archive' },
      { action: 'inbound', input: { resource: 'thread', operation: 'archive', inboxId: 1, threadId: 2 }, error: 'Unsupported Mailtrap inbound thread operation: archive' },
      { action: 'inbound', input: { resource: 'webhook', operation: 'delete' }, error: 'Unsupported Mailtrap inbound resource: webhook' },
      { action: 'suppressions', input: { operation: 'create', suppressionId: 1 }, error: 'Unsupported Mailtrap suppressions operation: create' },
      { action: 'webhooks', input: { operation: 'rotate', webhookId: 1 }, error: 'Unsupported Mailtrap webhooks operation: rotate' },
      { action: 'contact_lists', input: { operation: 'archive', id: 1 }, error: 'Unsupported Mailtrap contact_lists operation: archive' },
      { action: 'contact_fields', input: { operation: 'archive', id: 1 }, error: 'Unsupported Mailtrap contact_fields operation: archive' },
      { action: 'contact_imports', input: { operation: 'delete', id: 1 }, error: 'Unsupported Mailtrap contact_imports operation: delete' },
      { action: 'contact_exports', input: { operation: 'delete', id: 1 }, error: 'Unsupported Mailtrap contact_exports operation: delete' },
      { action: 'campaigns', input: { operation: 'launch', campaignId: 1 }, error: 'Unsupported Mailtrap campaigns operation: launch' },
      { action: 'accounts', input: { operation: 'delete' }, error: 'Unsupported Mailtrap accounts operation: delete' },
    ];

    for (const dispatch of invalidDispatches) {
      await expect(executeUnchecked(client, dispatch.action, dispatch.input))
        .rejects.toThrow(dispatch.error);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a configured sandbox ID when a sandbox input omits inboxId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new MailtrapClient({
      token: 'mt-secret-token',
      accountId: 42,
      sandboxId: 77,
      fetch: fetchMock as unknown as typeof fetch,
      endpoints: {
        general: 'https://general.test',
        transactional: 'https://send.test',
        bulk: 'https://bulk.test',
        sandbox: 'https://sandbox.test',
      },
    });

    await client.execute('sandbox', {
      resource: 'message', operation: 'list',
    });

    expect(requestAt(fetchMock).url).toBe('https://general.test/api/accounts/42/inboxes/77/messages');
  });

  it('wraps remote template writes and encodes template IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    const client = clientWith(fetchMock, 'account/main');

    await client.execute('templates', {
      operation: 'update',
      templateId: 'welcome/v2',
      template: { name: 'Welcome', subject: 'Hello' },
    });

    const request = requestAt(fetchMock);
    expect(request.url).toBe('https://general.test/api/accounts/account%2Fmain/email_templates/welcome%2Fv2');
    expect(request.init.method).toBe('PATCH');
    expect(JSON.parse(String(request.init.body))).toEqual({
      email_template: { name: 'Welcome', subject: 'Hello' },
    });
  });

  it('routes sandbox projects, inboxes, bodies, analysis, and attachments', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    const client = clientWith(fetchMock);

    await client.execute('sandbox', { resource: 'project', operation: 'create', name: 'Release tests' });
    await client.execute('sandbox', { resource: 'inbox', operation: 'clean', inboxId: 7 });
    await client.execute('sandbox', { resource: 'message', operation: 'body', inboxId: 7, messageId: 9, format: 'eml' });
    await client.execute('sandbox', { resource: 'message', operation: 'analysis', inboxId: 7, messageId: 9, analysis: 'html' });
    await client.execute('sandbox', { resource: 'attachment', operation: 'get', inboxId: 7, messageId: 9, attachmentId: 11 });

    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'https://general.test/api/accounts/42/projects',
      'https://general.test/api/accounts/42/inboxes/7/clean',
      'https://general.test/api/accounts/42/inboxes/7/messages/9/body.eml',
      'https://general.test/api/accounts/42/inboxes/7/messages/9/analyze',
      'https://general.test/api/accounts/42/inboxes/7/messages/9/attachments/11',
    ]);
    expect(JSON.parse(String(requestAt(fetchMock, 0).init.body))).toEqual({
      project: { name: 'Release tests' },
    });
  });

  it('serializes email-log cursors and nested array filters with Rails brackets', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    const client = clientWith(fetchMock);

    await client.execute('email_logs', {
      operation: 'list',
      cursor: 'next/+= token',
      filters: {
        sent_after: '2026-08-01T00:00:00Z',
        category: { operator: 'in', value: ['release notes', 'alerts'] },
      },
    });

    const url = new URL(requestAt(fetchMock).url);
    expect(url.pathname).toBe('/api/accounts/42/email_logs');
    expect(url.searchParams.get('search_after')).toBe('next/+= token');
    expect(url.searchParams.get('filters[sent_after]')).toBe('2026-08-01T00:00:00Z');
    expect(url.searchParams.getAll('filters[category][value][]')).toEqual(['release notes', 'alerts']);
  });

  it('routes each stats grouping through one typed surface', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = clientWith(fetchMock);

    await client.execute('stats', {
      operation: 'by_provider',
      query: { start_date: '2026-08-01', end_date: '2026-08-31', sending_streams: ['transactional'] },
    });

    const url = new URL(requestAt(fetchMock).url);
    expect(url.pathname).toBe('/api/accounts/42/stats/email_service_providers');
    expect(url.searchParams.getAll('sending_streams[]')).toEqual(['transactional']);
  });
});

describe('MailtrapClient inbound and optional API routing', () => {
  it('encodes inbound cursors and sends reply-all payloads', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    const client = clientWith(fetchMock);

    await client.execute('inbound', {
      resource: 'message', operation: 'list', inboxId: 'inbox/one', cursor: 'cursor/+ value',
    });
    await client.execute('inbound', {
      resource: 'message', operation: 'reply_all', inboxId: 'inbox/one', messageId: 'message/7',
      body: { text: 'Acknowledged', cc: [{ email: 'copy@example.com' }] },
    });

    const listUrl = new URL(requestAt(fetchMock, 0).url);
    expect(listUrl.pathname).toBe('/api/inbound/inboxes/inbox%2Fone/messages');
    expect(listUrl.searchParams.get('last_id')).toBe('cursor/+ value');
    expect(requestAt(fetchMock, 1).url).toBe(
      'https://general.test/api/inbound/inboxes/inbox%2Fone/messages/message%2F7/reply_all',
    );
    expect(JSON.parse(String(requestAt(fetchMock, 1).init.body))).toEqual({
      text: 'Acknowledged', cc: [{ email: 'copy@example.com' }],
    });
  });

  it('covers domains, suppressions, webhooks, contacts, collections, transfers, campaigns, and account discovery', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    const client = clientWith(fetchMock);

    await client.execute('domains', { operation: 'send_setup', domainId: 5, email: 'owner@example.com' });
    await client.execute('suppressions', { operation: 'delete', suppressionId: 6 });
    await client.execute('webhooks', { operation: 'create', webhook: { url: 'https://hooks.example.com/mail' } });
    await client.execute('contacts', { operation: 'create_event', contact: 'person+tag@example.com', event: { name: 'checkout' } });
    await client.execute('contact_lists', { operation: 'list', query: { search: 'VIP list' } });
    await client.execute('contact_fields', { operation: 'update', id: 8, body: { name: 'Company' } });
    await client.execute('contact_imports', { operation: 'create', body: { file_url: 'https://files.example.com/a.csv' } });
    await client.execute('contact_exports', { operation: 'get', id: 10 });
    await client.execute('campaigns', { operation: 'schedule', campaignId: 11, schedule: { scheduled_at: '2026-09-01T10:00:00Z' } });
    await client.execute('accounts', { operation: 'list' });

    expect(fetchMock.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual([
      '/api/accounts/42/sending_domains/5/send_setup_instructions',
      '/api/accounts/42/suppressions/6',
      '/api/accounts/42/webhooks',
      '/api/accounts/42/contacts/person%2Btag%40example.com/events',
      '/api/accounts/42/contacts/lists',
      '/api/accounts/42/contacts/fields/8',
      '/api/accounts/42/contacts/imports',
      '/api/accounts/42/contacts/exports/10',
      '/api/email_campaigns/11/schedule',
      '/api/accounts',
    ]);
    expect(new URL(requestAt(fetchMock, 4).url).searchParams.get('search')).toBe('VIP list');
  });

  it('allows account discovery without accountId but rejects account-scoped actions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = new MailtrapClient({
      token: 'mt-secret-token',
      fetch: fetchMock as unknown as typeof fetch,
      endpoints: {
        general: 'https://general.test',
        transactional: 'https://send.test',
        bulk: 'https://bulk.test',
        sandbox: 'https://sandbox.test',
      },
    });

    await expect(client.execute('accounts', { operation: 'list' })).resolves.toEqual([]);
    await expect(client.execute('templates', { operation: 'list' })).rejects.toThrow('accountId is required');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('MailtrapClient response boundary', () => {
  it('aborts a timed-out request without retrying it', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })
    ));
    const client = new MailtrapClient({
      token: 'mt-secret-token',
      fetch: fetchMock as unknown as typeof fetch,
      requestTimeoutMs: 5,
      endpoints: { general: 'https://general.test' },
    });

    await expect(client.execute('accounts', { operation: 'list' }))
      .rejects.toThrow('timed out after 5ms');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects JSON primitives instead of treating them as provider records', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('true', {
      headers: { 'content-type': 'application/json' },
    }));
    const client = clientWith(fetchMock);

    await expect(client.execute('accounts', { operation: 'list' }))
      .rejects.toBeInstanceOf(MailtrapHttpError);
  });

  it('returns non-JSON sandbox message bodies as text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Subject: Test\r\n\r\nBody', {
      headers: { 'content-type': 'message/rfc822' },
    }));
    const client = clientWith(fetchMock);

    await expect(client.execute('sandbox', {
      resource: 'message', operation: 'body', inboxId: 1, messageId: 2, format: 'eml',
    })).resolves.toContain('Subject: Test');
  });

  it('stops reading a streamed response as soon as the byte limit is exceeded', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, {
      headers: { 'content-type': 'text/plain' },
    }));
    const client = new MailtrapClient({
      token: 'mt-secret-token',
      fetch: fetchMock as unknown as typeof fetch,
      maxResponseBytes: 8,
      endpoints: { general: 'https://general.test' },
    });

    await expect(client.execute('accounts', { operation: 'list' }))
      .rejects.toThrow('exceeds the 8-byte limit');
    expect(cancelled).toBe(true);
  });
});
