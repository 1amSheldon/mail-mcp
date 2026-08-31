import { describe, expect, it, vi } from 'vitest';
import {
  GRAPH_MAX_THREAD_PAGES,
  GRAPH_SIMPLE_ATTACHMENT_LIMIT,
  GRAPH_UPLOAD_CHUNK_GRANULARITY,
  MicrosoftGraphClient,
} from './graph.js';
import type { MicrosoftFetch, MicrosoftMessageContent } from './common.js';

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input.toString());
}

function message(attachments: MicrosoftMessageContent['attachments'] = []): MicrosoftMessageContent {
  return {
    subject: 'Subject',
    body: '<p>Body</p>',
    bodyType: 'HTML',
    to: ['to@example.com'],
    attachments,
  };
}

describe('MicrosoftGraphClient', () => {
  it('sends sub-3 MiB inline attachments in one sendMail request', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockResolvedValue(new Response(null, {
      status: 202,
      headers: { 'request-id': 'request-1' },
    }));
    const client = new MicrosoftGraphClient({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    const result = await client.sendMessage(message([{
      name: 'logo.svg',
      content: Buffer.from('<svg />'),
      contentType: 'image/svg+xml',
      contentId: 'logo',
      isInline: true,
    }]));

    expect(result).toEqual({ provider: 'graph', status: 'accepted', requestId: 'request-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    expect(requestUrl(input).pathname).toBe('/v1.0/me/sendMail');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer token' });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      message: {
        attachments: [{
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'logo.svg',
          contentBytes: Buffer.from('<svg />').toString('base64'),
          contentType: 'image/svg+xml',
          contentId: 'logo',
          isInline: true,
        }],
      },
      saveToSentItems: true,
    });
  });

  it('accepts JSON-safe base64 and byte-array attachments without dropping bytes', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const client = new MicrosoftGraphClient({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    await client.sendMessage(message([
      { name: 'base64.bin', content: 'AAEC/w==' },
      { name: 'array.bin', content: [0, 1, 2, 255] },
    ]));

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload.message.attachments).toMatchObject([
      { name: 'base64.bin', contentBytes: 'AAEC/w==' },
      { name: 'array.bin', contentBytes: 'AAEC/w==' },
    ]);
  });

  it('rejects malformed base64 and invalid byte arrays before any request', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>();
    const client = new MicrosoftGraphClient({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    await expect(client.sendMessage(message([{
      name: 'invalid-base64.bin',
      content: 'not base64',
    }]))).rejects.toMatchObject({ kind: 'validation' });
    await expect(client.sendMessage(message([{
      name: 'invalid-array.bin',
      content: [0, 256, 1.5],
    }]))).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a draft, uploads aligned chunks, and sends once for a large attachment', async () => {
    const size = GRAPH_SIMPLE_ATTACHMENT_LIMIT;
    const bytes = Buffer.alloc(size, 7);
    const responses = [
      new Response(JSON.stringify({ id: 'draft/id' }), { status: 201 }),
      new Response(JSON.stringify({ uploadUrl: 'https://upload.example/session?sig=secret' }), { status: 200 }),
      new Response(JSON.stringify({ nextExpectedRanges: ['655360-'] }), { status: 202 }),
      new Response(JSON.stringify({ nextExpectedRanges: ['1310720-'] }), { status: 202 }),
      new Response(JSON.stringify({ nextExpectedRanges: ['1966080-'] }), { status: 202 }),
      new Response(JSON.stringify({ nextExpectedRanges: ['2621440-'] }), { status: 202 }),
      new Response(JSON.stringify({ id: 'attachment-id' }), { status: 201 }),
      new Response(null, { status: 202 }),
    ];
    const fetchMock = vi.fn<MicrosoftFetch>().mockImplementation(async () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected request');
      return response;
    });
    const client = new MicrosoftGraphClient({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
      uploadChunkSize: 2 * GRAPH_UPLOAD_CHUNK_GRANULARITY,
    });

    const result = await client.sendMessage(message([{ name: 'large.bin', content: bytes }]));

    expect(result).toMatchObject({ provider: 'graph', status: 'accepted', draftId: 'draft/id' });
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(requestUrl(fetchMock.mock.calls[0][0]).pathname).toBe('/v1.0/me/messages');
    expect(requestUrl(fetchMock.mock.calls[1][0]).pathname)
      .toBe('/v1.0/me/messages/draft%2Fid/attachments/createUploadSession');

    const uploadCalls = fetchMock.mock.calls.slice(2, 7);
    expect(uploadCalls.map(call => (call[1]?.headers as Record<string, string>)['Content-Range']))
      .toEqual([
        `bytes 0-655359/${size}`,
        `bytes 655360-1310719/${size}`,
        `bytes 1310720-1966079/${size}`,
        `bytes 1966080-2621439/${size}`,
        `bytes 2621440-3145727/${size}`,
      ]);
    for (const [input, init] of uploadCalls) {
      expect(requestUrl(input).host).toBe('upload.example');
      expect(init?.headers).not.toHaveProperty('Authorization');
    }
    expect(requestUrl(fetchMock.mock.calls[7][0]).pathname)
      .toBe('/v1.0/me/messages/draft%2Fid/send');
  });

  it('rejects saveToSentItems=false for the draft-based large attachment path', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>();
    const client = new MicrosoftGraphClient({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    await expect(client.sendMessage(message([{
      name: 'large.bin',
      content: Buffer.alloc(GRAPH_SIMPLE_ATTACHMENT_LIMIT),
    }]), false)).rejects.toMatchObject({
      provider: 'graph',
      kind: 'validation',
      message: expect.stringContaining('saveToSentItems=false'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses createReply before upload sessions for a large reply attachment', async () => {
    const responses = [
      new Response(JSON.stringify({ id: 'reply-draft' }), { status: 201 }),
      new Response(JSON.stringify({ id: 'reply-draft' }), { status: 200 }),
      new Response(JSON.stringify({ uploadUrl: 'https://upload.example/reply' }), { status: 200 }),
      new Response(JSON.stringify({ id: 'attachment-id' }), { status: 201 }),
      new Response(null, { status: 202 }),
    ];
    const fetchMock = vi.fn<MicrosoftFetch>().mockImplementation(async () => responses.shift()
      ?? Promise.reject(new Error('Unexpected request')));
    const client = new MicrosoftGraphClient({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    await client.reply('message/id', message([{
      name: 'large.bin',
      content: Buffer.alloc(GRAPH_SIMPLE_ATTACHMENT_LIMIT),
    }]));

    expect(requestUrl(fetchMock.mock.calls[0][0]).pathname)
      .toBe('/v1.0/me/messages/message%2Fid/createReply');
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
    expect(requestUrl(fetchMock.mock.calls[1][0]).pathname)
      .toBe('/v1.0/me/messages/reply-draft');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PATCH');
    expect(requestUrl(fetchMock.mock.calls[4][0]).pathname)
      .toBe('/v1.0/me/messages/reply-draft/send');
  });

  it('adds a small inline reply attachment to the reply draft before sending', async () => {
    const responses = [
      new Response(JSON.stringify({ id: 'reply-draft' }), { status: 201 }),
      new Response(JSON.stringify({ id: 'reply-draft' }), { status: 200 }),
      new Response(JSON.stringify({ id: 'attachment-id' }), { status: 201 }),
      new Response(null, { status: 202 }),
    ];
    const fetchMock = vi.fn<MicrosoftFetch>().mockImplementation(async () => responses.shift()
      ?? Promise.reject(new Error('Unexpected request')));
    const client = new MicrosoftGraphClient({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    await client.reply('message-id', message([{
      name: 'inline.png',
      content: Buffer.from('small'),
      contentType: 'image/png',
      contentId: 'inline-image',
      isInline: true,
    }]));

    expect(requestUrl(fetchMock.mock.calls[2][0]).pathname)
      .toBe('/v1.0/me/messages/reply-draft/attachments');
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      name: 'inline.png',
      contentId: 'inline-image',
      isInline: true,
      contentBytes: Buffer.from('small').toString('base64'),
    });
    expect(requestUrl(fetchMock.mock.calls[3][0]).pathname)
      .toBe('/v1.0/me/messages/reply-draft/send');
  });

  it('encodes Internet Message-ID lookup values as one OData query parameter', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockResolvedValue(new Response(JSON.stringify({
      value: [{ id: 'graph-id', internetMessageId: "<o'hara+tag@example.com>" }],
    }), { status: 200 }));
    const client = new MicrosoftGraphClient({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
      userId: 'mailbox+alias@example.com',
    });

    const found = await client.findByInternetMessageId("<o'hara+tag@example.com>");

    const url = requestUrl(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/v1.0/users/mailbox%2Balias%40example.com/messages');
    expect(url.searchParams.get('$filter'))
      .toBe("internetMessageId eq '<o''hara+tag@example.com>'");
    expect(found).toEqual([{ id: 'graph-id', internetMessageId: "<o'hara+tag@example.com>" }]);
  });

  it('returns a structured partial warning instead of pretending an anchor-only result is complete', async () => {
    const client = new MicrosoftGraphClient({
      fetch: vi.fn<MicrosoftFetch>(),
      tokenProvider: async () => 'token',
    });

    await expect(client.getThread({ id: 'anchor' })).resolves.toEqual({
      messages: [{ id: 'anchor' }],
      partial: true,
      warning: {
        code: 'conversation_unavailable',
        strategy: 'anchor_only',
        message: 'Microsoft Graph did not return a conversationId; only the anchor message is available.',
      },
    });
  });

  it('follows Graph @odata.nextLink pages and reports a complete thread', async () => {
    const responses = [
      new Response(JSON.stringify({
        value: [{ id: 'one', conversationId: 'thread' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next',
      }), { status: 200 }),
      new Response(JSON.stringify({
        value: [{ id: 'two', conversationId: 'thread' }],
      }), { status: 200 }),
    ];
    const fetchMock = vi.fn<MicrosoftFetch>().mockImplementation(async () => responses.shift()
      ?? Promise.reject(new Error('Unexpected request')));
    const client = new MicrosoftGraphClient({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    await expect(client.getThread({ id: 'anchor', conversationId: 'thread' })).resolves.toEqual({
      messages: [
        { id: 'one', conversationId: 'thread' },
        { id: 'two', conversationId: 'thread' },
      ],
      partial: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchMock.mock.calls[1][0]).searchParams.get('$skiptoken')).toBe('next');
  });

  it('returns accumulated messages as partial when a later thread page fails', async () => {
    const responses = [
      new Response(JSON.stringify({
        value: [{ id: 'one', conversationId: 'thread' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next',
      }), { status: 200 }),
      new Response('client_secret=LEAK', { status: 503 }),
    ];
    const fetchMock = vi.fn<MicrosoftFetch>().mockImplementation(async () => responses.shift()
      ?? Promise.reject(new Error('Unexpected request')));
    const client = new MicrosoftGraphClient({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    const result = await client.getThread({ id: 'anchor', conversationId: 'thread' });

    expect(result).toMatchObject({
      messages: [{ id: 'one', conversationId: 'thread' }],
      partial: true,
      warning: {
        code: 'conversation_pagination_failed',
        strategy: 'partial_conversation',
      },
    });
    expect(result.warning?.message).toContain('HTTP 503');
    expect(result.warning?.message).not.toContain('client_secret');
    expect(result.warning?.message).not.toContain('LEAK');
  });

  it('stops thread pagination at the bounded page limit', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockImplementation(async input => {
      const url = requestUrl(input);
      const page = Number(url.searchParams.get('page') ?? '0');
      return new Response(JSON.stringify({
        value: [{ id: `message-${page}`, conversationId: 'thread' }],
        '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/messages?page=${page + 1}`,
      }), { status: 200 });
    });
    const client = new MicrosoftGraphClient({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    const result = await client.getThread({ id: 'anchor', conversationId: 'thread' });

    expect(fetchMock).toHaveBeenCalledTimes(GRAPH_MAX_THREAD_PAGES);
    expect(result).toMatchObject({
      partial: true,
      warning: { code: 'conversation_truncated', strategy: 'partial_conversation' },
    });
    expect(result.messages).toHaveLength(GRAPH_MAX_THREAD_PAGES);
  });

  it('does not retry a send whose transport outcome is ambiguous', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockRejectedValue(new Error('socket closed'));
    const client = new MicrosoftGraphClient({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    await expect(client.sendMessage(message())).rejects.toMatchObject({
      name: 'MicrosoftProviderError',
      provider: 'graph',
      kind: 'outcome_unknown',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
