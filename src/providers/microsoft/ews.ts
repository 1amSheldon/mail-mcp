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
import { child, elements, EWS_MESSAGES_NS, parseEwsXml, textChild } from './xml.js';
import type { Element } from '@xmldom/xmldom';

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

export interface EwsMailbox { address: string; name?: string }
export interface EwsMessage extends EwsMessageSummary {
  body?: { contentType: string; content: string };
  from?: EwsMailbox;
  toRecipients: EwsMailbox[];
  ccRecipients: EwsMailbox[];
  bccRecipients: EwsMailbox[];
  receivedDateTime?: string;
  sentDateTime?: string;
  attachments: Array<{ id: string; name?: string; contentType?: string; size?: number; isInline?: boolean }>;
}

function parseMailbox(node: Element): EwsMailbox[] {
  return elements(node, 'Mailbox').flatMap(mailbox => {
    const address = textChild(mailbox, 'EmailAddress');
    return address ? [{ address, ...(textChild(mailbox, 'Name') ? { name: textChild(mailbox, 'Name') } : {}) }] : [];
  });
}

function detailedMessage(node: Element, summary: EwsMessageSummary): EwsMessage {
  const body = child(node, 'Body');
  const addresses = (name: string) => { const group = child(node, name); return group ? parseMailbox(group) : []; };
  const attachmentGroup = child(node, 'Attachments');
  return {
    ...summary,
    ...(body ? { body: { contentType: body.getAttribute('BodyType') || 'Text', content: body.textContent ?? '' } } : {}),
    ...(addresses('From')[0] ? { from: addresses('From')[0] } : {}),
    toRecipients: addresses('ToRecipients'), ccRecipients: addresses('CcRecipients'), bccRecipients: addresses('BccRecipients'),
    ...(textChild(node, 'DateTimeReceived') ? { receivedDateTime: textChild(node, 'DateTimeReceived') } : {}),
    ...(textChild(node, 'DateTimeSent') ? { sentDateTime: textChild(node, 'DateTimeSent') } : {}),
    attachments: attachmentGroup ? Array.from(attachmentGroup.childNodes).flatMap(item => {
      if (item.nodeType !== 1) return [];
      const attachment = item as Element;
      const id = child(attachment, 'AttachmentId')?.getAttribute('Id');
      if (!id) return [];
      const size = textChild(attachment, 'Size');
      return [{ id,
        ...(textChild(attachment, 'Name') !== undefined ? { name: textChild(attachment, 'Name') } : {}),
        ...(textChild(attachment, 'ContentType') ? { contentType: textChild(attachment, 'ContentType') } : {}),
        ...(size !== undefined && Number.isFinite(Number(size)) ? { size: Number(size) } : {}),
        ...(textChild(attachment, 'IsInline') !== undefined ? { isInline: textChild(attachment, 'IsInline') === 'true' } : {}),
      }];
    }) : [],
  };
}

export interface EwsSearchOptions {
  query?: string;
  folderId?: string;
  distinguishedFolderId?: string;
  maxResults?: number;
  offset?: number;
}

export interface EwsSearchResult {
  messages: EwsMessageSummary[];
  partial: boolean;
  nextOffset?: number;
  totalItems?: number;
  warning?: string;
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

function parseMessages(xml: string, detailed = false): Array<EwsMessageSummary | EwsMessage> {
  const messages: EwsMessageSummary[] = [];
  for (const value of elements(parseEwsXml(xml), 'Message')) {
    const idNode = child(value, 'ItemId');
    const id = idNode?.getAttribute('Id');
    if (!id) continue;
    const changeKey = idNode?.getAttribute('ChangeKey');
    const summary = {
      itemId: id,
      ...(changeKey ? { changeKey } : {}),
      ...(textChild(value, 'Subject') !== undefined ? { subject: textChild(value, 'Subject') } : {}),
      ...(textChild(value, 'InternetMessageId')
        ? { internetMessageId: textChild(value, 'InternetMessageId') }
        : {}),
    };
    messages.push(detailed ? detailedMessage(value, summary) : summary);
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

  async searchMessages(options: EwsSearchOptions = {}): Promise<EwsSearchResult> {
    const maxResults = options.maxResults ?? 50;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new MicrosoftProviderError('ews', 'validation', 'EWS offset must be a nonnegative safe integer');
    }
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
      + `<m:IndexedPageItemView MaxEntriesReturned="${maxResults}" Offset="${offset}" BasePoint="Beginning" />`
      + query
      + '<m:ParentFolderIds>'
      + (options.folderId
        ? `<t:FolderId Id="${escapeXml(options.folderId)}" />`
        : `<t:DistinguishedFolderId Id="${escapeXml(options.distinguishedFolderId ?? 'inbox')}" />`)
      + '</m:ParentFolderIds>'
      + '</m:FindItem>';
    const xml = await this.soap('FindItem', operation, false);
    const root = elements(parseEwsXml(xml), 'RootFolder', EWS_MESSAGES_NS)[0];
    const last = root?.getAttribute('IncludesLastItemInRange');
    const nextText = root?.getAttribute('IndexedPagingOffset');
    const next = nextText && /^\d+$/.test(nextText) ? Number(nextText) : undefined;
    const totalText = root?.getAttribute('TotalItemsInView');
    const total = totalText && /^\d+$/.test(totalText) ? Number(totalText) : undefined;
    const partial = last !== 'true';
    const canContinue = partial && next !== undefined && Number.isSafeInteger(next) && next > offset;
    return {
      messages: parseMessages(xml), partial,
      ...(canContinue ? { nextOffset: next } : {}),
      ...(total !== undefined && Number.isSafeInteger(total) ? { totalItems: total } : {}),
      ...(partial && !canContinue ? { warning: 'EWS did not provide a usable next-page offset. These results may be incomplete.' } : {}),
    };
  }

  async getMessage(itemId: string): Promise<EwsMessage> {
    if (!itemId) {
      throw new MicrosoftProviderError('ews', 'validation', 'EWS item id is required');
    }
    const operation = '<m:GetItem>'
      + '<m:ItemShape><t:BaseShape>AllProperties</t:BaseShape>'
      + '<t:AdditionalProperties><t:FieldURI FieldURI="message:InternetMessageId" /></t:AdditionalProperties>'
      + '</m:ItemShape>'
      + `<m:ItemIds><t:ItemId Id="${escapeXml(itemId)}" /></m:ItemIds>`
      + '</m:GetItem>';
    const messages = parseMessages(await this.soap('GetItem', operation, false), true);
    if (messages.length === 0) {
      throw new MicrosoftProviderError('ews', 'invalid_response', 'EWS GetItem response did not contain a message');
    }
    return messages[0] as EwsMessage;
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
