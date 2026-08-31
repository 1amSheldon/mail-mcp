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

export interface EwsClientOptions {
  endpoint: string;
  fetch: MicrosoftFetch;
  tokenProvider: MicrosoftTokenProvider;
  timeoutMs?: number;
}

export interface EwsMessageSummary {
  itemId: string;
  changeKey?: string;
  subject?: string;
  internetMessageId?: string;
}

export interface EwsSearchOptions {
  query?: string;
  folderId?: string;
  distinguishedFolderId?: string;
  maxResults?: number;
}

const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const MESSAGES_NS = 'http://schemas.microsoft.com/exchange/services/2006/messages';
const TYPES_NS = 'http://schemas.microsoft.com/exchange/services/2006/types';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function envelope(operation: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>`
    + `<s:Envelope xmlns:s="${SOAP_NS}" xmlns:m="${MESSAGES_NS}" xmlns:t="${TYPES_NS}">`
    + '<s:Header><t:RequestServerVersion Version="Exchange2013_SP1" /></s:Header>'
    + `<s:Body>${operation}</s:Body></s:Envelope>`;
}

function childText(xml: string, localName: string): string | undefined {
  const match = new RegExp(`<[^:>]+:${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/[^:>]+:${localName}>`, 'i').exec(xml);
  return match ? unescapeXml(match[1].trim()) : undefined;
}

function responseCode(xml: string): string | undefined {
  return childText(xml, 'ResponseCode');
}

function parseMessages(xml: string): EwsMessageSummary[] {
  const messages: EwsMessageSummary[] = [];
  const messagePattern = /<[^:>]+:Message(?:\s[^>]*)?>([\s\S]*?)<\/[^:>]+:Message>/gi;
  for (const match of xml.matchAll(messagePattern)) {
    const value = match[1];
    const idMatch = /<[^:>]+:ItemId\s+([^>]*?)\/?\s*>/i.exec(value);
    if (!idMatch) continue;
    const id = /\bId="([^"]+)"/i.exec(idMatch[1]);
    if (!id) continue;
    const changeKey = /\bChangeKey="([^"]+)"/i.exec(idMatch[1]);
    messages.push({
      itemId: unescapeXml(id[1]),
      ...(changeKey ? { changeKey: unescapeXml(changeKey[1]) } : {}),
      ...(childText(value, 'Subject') ? { subject: childText(value, 'Subject') } : {}),
      ...(childText(value, 'InternetMessageId')
        ? { internetMessageId: childText(value, 'InternetMessageId') }
        : {}),
    });
  }
  return messages;
}

function recipients(element: string, addresses?: string[]): string {
  if (!addresses?.length) return '';
  return `<t:${element}>${addresses.map(address =>
    `<t:Mailbox><t:EmailAddress>${escapeXml(address)}</t:EmailAddress></t:Mailbox>`).join('')}</t:${element}>`;
}

function attachmentXml(attachments?: MicrosoftAttachment[]): string {
  if (!attachments?.length) return '';
  return `<t:Attachments>${attachments.map(attachment => {
    const contentType = attachment.contentType
      ? `<t:ContentType>${escapeXml(attachment.contentType)}</t:ContentType>`
      : '';
    const contentId = attachment.contentId
      ? `<t:ContentId>${escapeXml(attachment.contentId)}</t:ContentId>`
      : '';
    const isInline = attachment.isInline === undefined
      ? ''
      : `<t:IsInline>${attachment.isInline ? 'true' : 'false'}</t:IsInline>`;
    return '<t:FileAttachment>'
      + `<t:Name>${escapeXml(attachment.name)}</t:Name>`
      + contentType
      + contentId
      + isInline
      + `<t:Content>${Buffer.from(attachmentBytes(attachment, 'ews')).toString('base64')}</t:Content>`
      + '</t:FileAttachment>';
  }).join('')}</t:Attachments>`;
}

export class EwsClient {
  private readonly endpoint: URL;
  private readonly fetchImpl: MicrosoftFetch;
  private readonly tokenProvider: MicrosoftTokenProvider;
  private readonly timeoutMs: number;

  constructor(options: EwsClientOptions) {
    this.endpoint = requireHttps(options.endpoint, 'EWS endpoint');
    this.fetchImpl = options.fetch;
    this.tokenProvider = options.tokenProvider;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async searchMessages(options: EwsSearchOptions = {}): Promise<EwsMessageSummary[]> {
    const maxResults = options.maxResults ?? 50;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1000) {
      throw new MicrosoftProviderError('ews', 'validation', 'EWS maxResults must be an integer from 1 to 1000');
    }
    if (options.folderId && options.distinguishedFolderId) {
      throw new MicrosoftProviderError(
        'ews',
        'validation',
        'Specify either folderId or distinguishedFolderId, not both',
      );
    }
    const query = options.query
      ? `<m:QueryString>${escapeXml(options.query)}</m:QueryString>`
      : '';
    const operation = '<m:FindItem Traversal="Shallow">'
      + '<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>'
      + '<t:AdditionalProperties><t:FieldURI FieldURI="item:Subject" />'
      + '<t:FieldURI FieldURI="message:InternetMessageId" /></t:AdditionalProperties></m:ItemShape>'
      + `<m:IndexedPageItemView MaxEntriesReturned="${maxResults}" Offset="0" BasePoint="Beginning" />`
      + query
      + '<m:ParentFolderIds>'
      + (options.folderId
        ? `<t:FolderId Id="${escapeXml(options.folderId)}" />`
        : `<t:DistinguishedFolderId Id="${escapeXml(options.distinguishedFolderId ?? 'inbox')}" />`)
      + '</m:ParentFolderIds>'
      + '</m:FindItem>';
    return parseMessages(await this.soap('FindItem', operation, false));
  }

  async getMessage(itemId: string): Promise<EwsMessageSummary> {
    if (!itemId) {
      throw new MicrosoftProviderError('ews', 'validation', 'EWS item id is required');
    }
    const operation = '<m:GetItem>'
      + '<m:ItemShape><t:BaseShape>AllProperties</t:BaseShape>'
      + '<t:AdditionalProperties><t:FieldURI FieldURI="message:InternetMessageId" /></t:AdditionalProperties>'
      + '</m:ItemShape>'
      + `<m:ItemIds><t:ItemId Id="${escapeXml(itemId)}" /></m:ItemIds>`
      + '</m:GetItem>';
    const messages = parseMessages(await this.soap('GetItem', operation, false));
    if (messages.length === 0) {
      throw new MicrosoftProviderError('ews', 'invalid_response', 'EWS GetItem response did not contain a message');
    }
    return messages[0];
  }

  async sendMessage(message: MicrosoftMessageContent): Promise<MicrosoftSendResult> {
    assertMessageContent(message, 'ews');
    const bodyType = messageBodyType(message.bodyType, 'ews');
    const operation = '<m:CreateItem MessageDisposition="SendAndSaveCopy">'
      + '<m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems" /></m:SavedItemFolderId>'
      + '<m:Items><t:Message>'
      + `<t:Subject>${escapeXml(message.subject)}</t:Subject>`
      + `<t:Body BodyType="${bodyType}">${escapeXml(message.body)}</t:Body>`
      + recipients('ToRecipients', message.to)
      + recipients('CcRecipients', message.cc)
      + recipients('BccRecipients', message.bcc)
      + recipients('ReplyTo', message.replyTo)
      + attachmentXml(message.attachments)
      + '</t:Message></m:Items></m:CreateItem>';
    const response = await this.soapResponse('CreateItem', operation, true);
    return {
      provider: 'ews',
      status: 'accepted',
      ...(requestIdFrom(response) ? { requestId: requestIdFrom(response) } : {}),
    };
  }

  private async soap(action: string, operation: string, mutating: boolean): Promise<string> {
    return responseText(await this.soapResponse(action, operation, mutating), 4 * 1024 * 1024);
  }

  private async soapResponse(action: string, operation: string, mutating: boolean): Promise<Response> {
    let token: string;
    try {
      token = await this.tokenProvider();
    } catch (error) {
      throw new MicrosoftProviderError('ews', 'auth', 'Unable to obtain EWS access token', undefined, undefined, { cause: error });
    }
    if (!token) {
      throw new MicrosoftProviderError('ews', 'auth', 'EWS access token is empty');
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Accept: 'text/xml',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: `"${MESSAGES_NS}/${action}"`,
        },
        body: envelope(operation),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw transportError('ews', error, mutating);
    }
    if (!response.ok) {
      const detail = await responseText(response);
      throw new MicrosoftProviderError(
        'ews',
        response.status === 401 || response.status === 403 ? 'auth' : 'remote',
        `EWS returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
        requestIdFrom(response),
      );
    }

    const body = await response.clone().text();
    const code = responseCode(body);
    if (!code) {
      throw new MicrosoftProviderError(
        'ews',
        'invalid_response',
        'EWS response did not contain a ResponseCode',
        response.status,
        requestIdFrom(response),
      );
    }
    if (code !== 'NoError') {
      const message = childText(body, 'MessageText');
      throw new MicrosoftProviderError(
        'ews',
        'remote',
        `EWS returned ${code}${message ? `: ${message}` : ''}`,
        response.status,
        requestIdFrom(response),
      );
    }
    return response;
  }
}
