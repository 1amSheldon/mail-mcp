import {
  assertMessageContent,
  attachmentBytes,
  messageBodyType,
  MicrosoftProviderError,
  requestIdFrom,
  requireHttps,
  responseText,
  transportError,
} from './common.js';
import type {
  MicrosoftAttachment,
  MicrosoftFetch,
  MicrosoftMessageContent,
  MicrosoftSendResult,
  MicrosoftTokenProvider,
} from './common.js';

export const GRAPH_SIMPLE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
export const GRAPH_MAX_ATTACHMENT_SIZE = 150 * 1024 * 1024;
export const GRAPH_UPLOAD_CHUNK_GRANULARITY = 320 * 1024;
export const GRAPH_DEFAULT_UPLOAD_CHUNK_SIZE = 10 * GRAPH_UPLOAD_CHUNK_GRANULARITY;
export const GRAPH_MAX_THREAD_PAGES = 100;
export const GRAPH_MAX_THREAD_MESSAGES = 10_000;

export interface GraphClientOptions {
  fetch: MicrosoftFetch;
  tokenProvider: MicrosoftTokenProvider;
  baseUrl?: string;
  userId?: string;
  timeoutMs?: number;
  uploadChunkSize?: number;
}

interface GraphRecipient {
  emailAddress: { address: string };
}

interface GraphFileAttachment {
  '@odata.type': '#microsoft.graph.fileAttachment';
  name: string;
  contentBytes: string;
  contentType?: string;
  contentId?: string;
  isInline?: boolean;
}

interface GraphMessagePayload {
  subject: string;
  body: { contentType: 'HTML' | 'Text'; content: string };
  toRecipients: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  attachments?: GraphFileAttachment[];
}

export interface GraphMessageSummary {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  receivedDateTime?: string;
}

export interface GraphThreadWarning {
  code:
    | 'conversation_lookup_failed'
    | 'conversation_pagination_failed'
    | 'conversation_truncated'
    | 'conversation_unavailable';
  message: string;
  strategy: 'anchor_only' | 'partial_conversation';
}

export interface GraphThreadResult {
  messages: GraphMessageSummary[];
  partial: boolean;
  warning?: GraphThreadWarning;
}

interface GraphCollection<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

function recipients(addresses?: string[]): GraphRecipient[] | undefined {
  if (!addresses || addresses.length === 0) return undefined;
  return addresses.map(address => ({ emailAddress: { address } }));
}

function fileAttachment(attachment: MicrosoftAttachment): GraphFileAttachment {
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: attachment.name,
    contentBytes: Buffer.from(attachmentBytes(attachment)).toString('base64'),
    ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
    ...(attachment.isInline !== undefined ? { isInline: attachment.isInline } : {}),
  };
}

function messagePayload(
  message: MicrosoftMessageContent,
  includeAttachments: boolean,
): GraphMessagePayload {
  return {
    subject: message.subject,
    body: { contentType: messageBodyType(message.bodyType), content: message.body },
    toRecipients: recipients(message.to) ?? [],
    ...(recipients(message.cc) ? { ccRecipients: recipients(message.cc) } : {}),
    ...(recipients(message.bcc) ? { bccRecipients: recipients(message.bcc) } : {}),
    ...(recipients(message.replyTo) ? { replyTo: recipients(message.replyTo) } : {}),
    ...(includeAttachments && message.attachments?.length
      ? { attachments: message.attachments.map(fileAttachment) }
      : {}),
  };
}

function parseMessage(value: unknown): GraphMessageSummary {
  if (!value || typeof value !== 'object') {
    throw new MicrosoftProviderError('graph', 'invalid_response', 'Microsoft Graph returned an invalid message');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) {
    throw new MicrosoftProviderError('graph', 'invalid_response', 'Microsoft Graph message is missing id');
  }
  return {
    id: record.id,
    ...(typeof record.conversationId === 'string' ? { conversationId: record.conversationId } : {}),
    ...(typeof record.internetMessageId === 'string'
      ? { internetMessageId: record.internetMessageId }
      : {}),
    ...(typeof record.subject === 'string' ? { subject: record.subject } : {}),
    ...(typeof record.receivedDateTime === 'string'
      ? { receivedDateTime: record.receivedDateTime }
      : {}),
  };
}

export class MicrosoftGraphClient {
  private readonly fetchImpl: MicrosoftFetch;
  private readonly tokenProvider: MicrosoftTokenProvider;
  private readonly baseUrl: URL;
  private readonly mailboxPath: string;
  private readonly timeoutMs: number;
  private readonly uploadChunkSize: number;

  constructor(options: GraphClientOptions) {
    this.fetchImpl = options.fetch;
    this.tokenProvider = options.tokenProvider;
    this.baseUrl = requireHttps(options.baseUrl ?? 'https://graph.microsoft.com/v1.0/', 'Graph base URL');
    this.baseUrl.pathname = this.baseUrl.pathname.replace(/\/?$/, '/');
    this.mailboxPath = options.userId ? `users/${encodePathSegment(options.userId)}` : 'me';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.uploadChunkSize = options.uploadChunkSize ?? GRAPH_DEFAULT_UPLOAD_CHUNK_SIZE;
    if (
      this.uploadChunkSize <= 0
      || this.uploadChunkSize % GRAPH_UPLOAD_CHUNK_GRANULARITY !== 0
    ) {
      throw new MicrosoftProviderError(
        'graph',
        'validation',
        `Graph upload chunk size must be a positive multiple of ${GRAPH_UPLOAD_CHUNK_GRANULARITY}`,
      );
    }
  }

  async sendMessage(message: MicrosoftMessageContent, saveToSentItems = true): Promise<MicrosoftSendResult> {
    assertMessageContent(message);
    const attachments = message.attachments ?? [];
    this.assertAttachmentSizes(attachments);
    if (attachments.every(item => attachmentBytes(item).byteLength < GRAPH_SIMPLE_ATTACHMENT_LIMIT)) {
      const response = await this.request(
        `${this.mailboxPath}/sendMail`,
        {
          method: 'POST',
          body: JSON.stringify({ message: messagePayload(message, true), saveToSentItems }),
        },
        true,
      );
      return {
        provider: 'graph',
        status: 'accepted',
        ...(requestIdFrom(response) ? { requestId: requestIdFrom(response) } : {}),
      };
    }

    if (!saveToSentItems) {
      throw new MicrosoftProviderError(
        'graph',
        'validation',
        'Graph cannot send large attachments with saveToSentItems=false because the upload-session workflow requires a draft',
      );
    }

    const draft = await this.requestJson<Record<string, unknown>>(
      `${this.mailboxPath}/messages`,
      { method: 'POST', body: JSON.stringify(messagePayload(message, false)) },
    );
    const draftId = this.requiredId(draft, 'draft');
    await this.attachToDraft(draftId, attachments);
    const response = await this.request(
      `${this.mailboxPath}/messages/${encodePathSegment(draftId)}/send`,
      { method: 'POST' },
      true,
    );
    return {
      provider: 'graph',
      status: 'accepted',
      draftId,
      ...(requestIdFrom(response) ? { requestId: requestIdFrom(response) } : {}),
    };
  }

  async reply(messageId: string, message: MicrosoftMessageContent): Promise<MicrosoftSendResult> {
    assertMessageContent(message);
    if (!messageId) {
      throw new MicrosoftProviderError('graph', 'validation', 'Graph message id is required');
    }
    const encodedId = encodePathSegment(messageId);
    const attachments = message.attachments ?? [];
    this.assertAttachmentSizes(attachments);
    if (attachments.length === 0) {
      const response = await this.request(
        `${this.mailboxPath}/messages/${encodedId}/reply`,
        { method: 'POST', body: JSON.stringify({ message: messagePayload(message, false) }) },
        true,
      );
      return {
        provider: 'graph',
        status: 'accepted',
        ...(requestIdFrom(response) ? { requestId: requestIdFrom(response) } : {}),
      };
    }

    const draft = await this.requestJson<Record<string, unknown>>(
      `${this.mailboxPath}/messages/${encodedId}/createReply`,
      { method: 'POST' },
    );
    const draftId = this.requiredId(draft, 'reply draft');
    await this.request(
      `${this.mailboxPath}/messages/${encodePathSegment(draftId)}`,
      { method: 'PATCH', body: JSON.stringify(messagePayload(message, false)) },
    );
    await this.attachToDraft(draftId, attachments);
    const response = await this.request(
      `${this.mailboxPath}/messages/${encodePathSegment(draftId)}/send`,
      { method: 'POST' },
      true,
    );
    return {
      provider: 'graph',
      status: 'accepted',
      draftId,
      ...(requestIdFrom(response) ? { requestId: requestIdFrom(response) } : {}),
    };
  }

  async getMessage(messageId: string): Promise<GraphMessageSummary> {
    if (!messageId) {
      throw new MicrosoftProviderError('graph', 'validation', 'Graph message id is required');
    }
    return parseMessage(await this.requestJson(
      `${this.mailboxPath}/messages/${encodePathSegment(messageId)}?${new URLSearchParams({
        '$select': 'id,conversationId,internetMessageId,subject,receivedDateTime',
      })}`,
    ));
  }

  async findByInternetMessageId(internetMessageId: string): Promise<GraphMessageSummary[]> {
    if (!internetMessageId) {
      throw new MicrosoftProviderError('graph', 'validation', 'Internet Message-ID is required');
    }
    const params = new URLSearchParams({
      '$filter': `internetMessageId eq '${escapeODataString(internetMessageId)}'`,
      '$select': 'id,conversationId,internetMessageId,subject,receivedDateTime',
    });
    const collection = await this.requestJson<GraphCollection<unknown>>(
      `${this.mailboxPath}/messages?${params.toString()}`,
    );
    return (collection.value ?? []).map(parseMessage);
  }

  async getThread(anchor: GraphMessageSummary): Promise<GraphThreadResult> {
    if (!anchor.conversationId) {
      return {
        messages: [anchor],
        partial: true,
        warning: {
          code: 'conversation_unavailable',
          strategy: 'anchor_only',
          message: 'Microsoft Graph did not return a conversationId; only the anchor message is available.',
        },
      };
    }

    const params = new URLSearchParams({
      '$filter': `conversationId eq '${escapeODataString(anchor.conversationId)}'`,
      '$select': 'id,conversationId,internetMessageId,subject,receivedDateTime',
      '$orderby': 'receivedDateTime asc',
    });
    let nextPath: string | undefined = `${this.mailboxPath}/messages?${params.toString()}`;
    const messages: GraphMessageSummary[] = [];
    let pagesRead = 0;
    while (nextPath) {
      if (pagesRead >= GRAPH_MAX_THREAD_PAGES) {
        return this.partialThread(
          messages,
          'conversation_truncated',
          `Conversation exceeded the ${GRAPH_MAX_THREAD_PAGES}-page safety limit.`,
        );
      }
      try {
        const collection: GraphCollection<unknown> = await this.requestJson<GraphCollection<unknown>>(
          nextPath,
        );
        if (!Array.isArray(collection.value)) {
          throw new MicrosoftProviderError(
            'graph',
            'invalid_response',
            'Microsoft Graph conversation page is missing a value array',
          );
        }
        const pageMessages = collection.value.map(parseMessage);
        const remaining = GRAPH_MAX_THREAD_MESSAGES - messages.length;
        if (pageMessages.length > remaining) {
          messages.push(...pageMessages.slice(0, remaining));
          return this.partialThread(
            messages,
            'conversation_truncated',
            `Conversation exceeded the ${GRAPH_MAX_THREAD_MESSAGES}-message safety limit.`,
          );
        }
        messages.push(...pageMessages);
        pagesRead += 1;
        const nextLink: unknown = collection['@odata.nextLink'];
        if (nextLink !== undefined && (typeof nextLink !== 'string' || nextLink.length === 0)) {
          throw new MicrosoftProviderError(
            'graph',
            'invalid_response',
            'Microsoft Graph conversation page returned an invalid @odata.nextLink',
          );
        }
        nextPath = typeof nextLink === 'string' && nextLink
          ? this.validatedNextLink(nextLink)
          : undefined;
      } catch (error) {
        if (!(error instanceof MicrosoftProviderError) || error.kind === 'auth') throw error;
        const safeFailure = error.status !== undefined
          ? `Microsoft Graph request failed with HTTP ${error.status}`
          : error.kind === 'invalid_response'
            ? 'Microsoft Graph returned an invalid conversation response'
            : 'Microsoft Graph conversation request failed';
        if (messages.length === 0) {
          return {
            messages: [anchor],
            partial: true,
            warning: {
              code: 'conversation_lookup_failed',
              strategy: 'anchor_only',
              message: `Conversation lookup failed; only the anchor message is available. ${safeFailure}.`,
            },
          };
        }
        return this.partialThread(
          messages,
          'conversation_pagination_failed',
          `Conversation pagination failed after ${messages.length} messages. ${safeFailure}.`,
        );
      }
    }
    return { messages, partial: false };
  }

  private partialThread(
    messages: GraphMessageSummary[],
    code: 'conversation_pagination_failed' | 'conversation_truncated',
    message: string,
  ): GraphThreadResult {
    return {
      messages,
      partial: true,
      warning: { code, strategy: 'partial_conversation', message },
    };
  }

  private validatedNextLink(value: string): string {
    let url: URL;
    try {
      url = new URL(value, this.baseUrl);
    } catch (error) {
      throw new MicrosoftProviderError(
        'graph',
        'invalid_response',
        'Microsoft Graph returned an invalid @odata.nextLink URL',
        undefined,
        undefined,
        { cause: error },
      );
    }
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith(this.baseUrl.pathname)) {
      throw new MicrosoftProviderError(
        'graph',
        'invalid_response',
        'Microsoft Graph returned an @odata.nextLink outside the configured Graph endpoint',
      );
    }
    return url.href;
  }

  private requiredId(value: Record<string, unknown>, label: string): string {
    if (typeof value.id !== 'string' || !value.id) {
      throw new MicrosoftProviderError('graph', 'invalid_response', `Microsoft Graph ${label} is missing id`);
    }
    return value.id;
  }

  private assertAttachmentSizes(attachments: MicrosoftAttachment[]): void {
    const oversized = attachments.find(
      item => attachmentBytes(item).byteLength > GRAPH_MAX_ATTACHMENT_SIZE,
    );
    if (oversized) {
      throw new MicrosoftProviderError(
        'graph',
        'validation',
        `Graph attachment ${oversized.name} exceeds the 150 MiB upload limit`,
      );
    }
  }

  private async attachToDraft(draftId: string, attachments: MicrosoftAttachment[]): Promise<void> {
    for (const attachment of attachments) {
      if (attachmentBytes(attachment).byteLength < GRAPH_SIMPLE_ATTACHMENT_LIMIT) {
        await this.request(
          `${this.mailboxPath}/messages/${encodePathSegment(draftId)}/attachments`,
          { method: 'POST', body: JSON.stringify(fileAttachment(attachment)) },
        );
      } else {
        await this.uploadLargeAttachment(draftId, attachment);
      }
    }
  }

  private async uploadLargeAttachment(draftId: string, attachment: MicrosoftAttachment): Promise<void> {
    const content = attachmentBytes(attachment);
    const session = await this.requestJson<Record<string, unknown>>(
      `${this.mailboxPath}/messages/${encodePathSegment(draftId)}/attachments/createUploadSession`,
      {
        method: 'POST',
        body: JSON.stringify({
          AttachmentItem: {
            attachmentType: 'file',
            name: attachment.name,
            size: content.byteLength,
            ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
            ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
            ...(attachment.isInline !== undefined ? { isInline: attachment.isInline } : {}),
          },
        }),
      },
    );
    if (typeof session.uploadUrl !== 'string') {
      throw new MicrosoftProviderError('graph', 'invalid_response', 'Graph upload session is missing uploadUrl');
    }
    const uploadUrl = requireHttps(session.uploadUrl, 'Graph upload URL').href;
    const total = content.byteLength;
    for (let start = 0; start < total; start += this.uploadChunkSize) {
      const endExclusive = Math.min(start + this.uploadChunkSize, total);
      const chunk = content.slice(start, endExclusive);
      await this.uploadChunk(uploadUrl, chunk, start, endExclusive - 1, total);
    }
  }

  private async uploadChunk(
    uploadUrl: string,
    chunk: Uint8Array,
    start: number,
    end: number,
    total: number,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.byteLength),
          'Content-Range': `bytes ${start}-${end}/${total}`,
        },
        body: Buffer.from(chunk),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw transportError('graph', error, false);
    }
    if (!response.ok) {
      const detail = await responseText(response);
      throw new MicrosoftProviderError(
        'graph',
        'remote',
        `Graph attachment upload failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
        requestIdFrom(response),
      );
    }
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit = {},
    mutating = false,
  ): Promise<T> {
    const response = await this.request(path, init, mutating);
    try {
      return await response.json() as T;
    } catch (error) {
      throw new MicrosoftProviderError(
        'graph',
        'invalid_response',
        'Microsoft Graph returned invalid JSON',
        response.status,
        requestIdFrom(response),
        { cause: error },
      );
    }
  }

  private async request(path: string, init: RequestInit = {}, mutating = false): Promise<Response> {
    let token: string;
    try {
      token = await this.tokenProvider();
    } catch (error) {
      throw new MicrosoftProviderError('graph', 'auth', 'Unable to obtain Microsoft Graph access token', undefined, undefined, { cause: error });
    }
    if (!token) {
      throw new MicrosoftProviderError('graph', 'auth', 'Microsoft Graph access token is empty');
    }

    const url = new URL(path, this.baseUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw transportError('graph', error, mutating);
    }
    if (!response.ok) {
      const detail = await responseText(response);
      throw new MicrosoftProviderError(
        'graph',
        response.status === 401 || response.status === 403 ? 'auth' : 'remote',
        `Microsoft Graph returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
        requestIdFrom(response),
      );
    }
    return response;
  }
}
