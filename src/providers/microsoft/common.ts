export type MicrosoftFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type MicrosoftTokenProvider = () => Promise<string>;

export type MicrosoftProviderErrorKind =
  | 'auth'
  | 'invalid_response'
  | 'outcome_unknown'
  | 'remote'
  | 'timeout'
  | 'validation';

export class MicrosoftProviderError extends Error {
  constructor(
    public readonly provider: 'graph' | 'ews',
    public readonly kind: MicrosoftProviderErrorKind,
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MicrosoftProviderError';
  }
}

export interface MicrosoftAttachment {
  name: string;
  /** Raw bytes for programmatic callers, or strict base64 / byte arrays for JSON MCP callers. */
  content: Uint8Array | string | number[];
  contentType?: string;
  contentId?: string;
  isInline?: boolean;
}

export interface MicrosoftMessageContent {
  subject: string;
  body: string;
  bodyType?: 'HTML' | 'Text';
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  attachments?: MicrosoftAttachment[];
}

export interface MicrosoftSendResult {
  provider: 'graph' | 'ews';
  status: 'accepted';
  requestId?: string;
  draftId?: string;
}

export function requireHttps(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new MicrosoftProviderError(
      label === 'EWS endpoint' ? 'ews' : 'graph',
      'validation',
      `${label} must be a valid HTTPS URL`,
      undefined,
      undefined,
      { cause: error },
    );
  }
  if (url.protocol !== 'https:') {
    throw new MicrosoftProviderError(
      label === 'EWS endpoint' ? 'ews' : 'graph',
      'validation',
      `${label} must use HTTPS`,
    );
  }
  return url;
}

export function messageBodyType(
  value: MicrosoftMessageContent['bodyType'],
  provider: 'graph' | 'ews' = 'graph',
): 'HTML' | 'Text' {
  if (value === undefined) return 'Text';
  if (value !== 'HTML' && value !== 'Text') {
    throw new MicrosoftProviderError(
      provider,
      'validation',
      'Message bodyType must be either HTML or Text',
    );
  }
  return value;
}

function validateByteArray(value: number[], provider: 'graph' | 'ews'): Uint8Array {
  if (!value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new MicrosoftProviderError(
      provider,
      'validation',
      'Attachment byte arrays may contain only integers from 0 to 255',
    );
  }
  return Uint8Array.from(value);
}

export function attachmentBytes(
  attachment: MicrosoftAttachment,
  provider: 'graph' | 'ews' = 'graph',
): Uint8Array {
  const { content } = attachment;
  if (content instanceof Uint8Array) return content;
  if (Array.isArray(content)) return validateByteArray(content, provider);
  if (typeof content === 'string') {
    if (
      content.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
    ) {
      throw new MicrosoftProviderError(
        provider,
        'validation',
        `Attachment ${attachment.name || '<unnamed>'} content must be valid base64`,
      );
    }
    return Buffer.from(content, 'base64');
  }
  throw new MicrosoftProviderError(
    provider,
    'validation',
    `Attachment ${attachment.name || '<unnamed>'} content must be base64 or an array of bytes`,
  );
}

export function assertMessageContent(
  message: MicrosoftMessageContent,
  provider: 'graph' | 'ews' = 'graph',
): void {
  if (!message.subject.trim()) {
    throw new MicrosoftProviderError(provider, 'validation', 'Message subject is required');
  }
  if (!message.body) {
    throw new MicrosoftProviderError(provider, 'validation', 'Message body is required');
  }
  if (message.to.length === 0 || message.to.some(address => !address.trim())) {
    throw new MicrosoftProviderError(provider, 'validation', 'At least one recipient is required');
  }
  messageBodyType(message.bodyType, provider);
  for (const attachment of message.attachments ?? []) {
    if (!attachment.name.trim()) {
      throw new MicrosoftProviderError(provider, 'validation', 'Attachment name is required');
    }
    attachmentBytes(attachment, provider);
  }
}

export async function responseText(response: Response, limit = 16_384): Promise<string> {
  try {
    return (await response.text()).slice(0, limit);
  } catch {
    return '';
  }
}

export function requestIdFrom(response: Response): string | undefined {
  return response.headers.get('request-id')
    ?? response.headers.get('client-request-id')
    ?? undefined;
}

export function transportError(
  provider: 'graph' | 'ews',
  error: unknown,
  mutating: boolean,
): MicrosoftProviderError {
  const timedOut = error instanceof Error
    && (error.name === 'TimeoutError' || error.name === 'AbortError');
  const detail = error instanceof Error ? error.message : String(error);
  if (mutating) {
    return new MicrosoftProviderError(
      provider,
      'outcome_unknown',
      `${provider === 'graph' ? 'Microsoft Graph' : 'EWS'} send outcome is unknown: ${detail}`,
      undefined,
      undefined,
      { cause: error },
    );
  }
  return new MicrosoftProviderError(
    provider,
    timedOut ? 'timeout' : 'remote',
    `${provider === 'graph' ? 'Microsoft Graph' : 'EWS'} request failed: ${detail}`,
    undefined,
    undefined,
    { cause: error },
  );
}
