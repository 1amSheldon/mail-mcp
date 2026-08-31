import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const MAX_OUTGOING_ATTACHMENTS = 20;
export const MAX_OUTGOING_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface OutgoingFileAttachment {
  path: string;
  filename?: string;
  contentType?: string;
  contentDisposition?: 'attachment' | 'inline';
  cid?: string;
}

export interface OutgoingInlineAttachment {
  contentBase64: string;
  filename: string;
  contentType?: string;
  contentDisposition?: 'attachment' | 'inline';
  cid?: string;
}

export type OutgoingAttachment = OutgoingFileAttachment | OutgoingInlineAttachment;

export interface OutgoingThreadHeaders {
  inReplyTo?: string;
  references?: string | string[];
}

export interface OutgoingMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  cc?: string;
  bcc?: string;
  from?: string;
  replyTo?: string;
  attachments?: OutgoingAttachment[];
  threading?: OutgoingThreadHeaders;
  headers?: Record<string, string>;
}

export interface PreparedOutgoingMessage {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType?: string;
    contentDisposition?: 'attachment' | 'inline';
    cid?: string;
  }>;
  headers?: Record<string, string>;
}

export interface OutgoingMessagePreparationOptions {
  /**
   * When present, file-backed attachments must resolve inside one of these roots.
   * An empty list disables file-backed attachments while leaving base64 attachments available.
   */
  allowedAttachmentRoots?: readonly string[];
}

const CONTROLLED_HEADERS = new Set([
  'bcc',
  'cc',
  'content-type',
  'from',
  'in-reply-to',
  'message-id',
  'mime-version',
  'references',
  'reply-to',
  'subject',
  'to',
]);

function assertSingleLine(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} must not contain CR or LF characters`);
  }
}

function normalizeFilename(value: string): string {
  assertSingleLine(value, 'Attachment filename');
  const trimmed = value.trim();
  if (!trimmed || path.basename(trimmed) !== trimmed) {
    throw new Error('Attachment filename must be a non-empty base name');
  }
  return trimmed;
}

function decodeBase64(value: string): Buffer {
  const compact = value.replace(/\s/g, '');
  if (compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('Attachment contentBase64 is not valid base64');
  }

  const decoded = Buffer.from(compact, 'base64');
  const canonicalInput = compact.replace(/=+$/, '');
  const canonicalDecoded = decoded.toString('base64').replace(/=+$/, '');
  if (canonicalInput !== canonicalDecoded) {
    throw new Error('Attachment contentBase64 is not valid base64');
  }
  return decoded;
}

function assertAttachmentSize(content: Buffer, filename: string): void {
  if (content.length > MAX_OUTGOING_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment ${filename} exceeds the ${MAX_OUTGOING_ATTACHMENT_BYTES}-byte limit`
    );
  }
}

async function assertAllowedAttachmentPath(
  attachmentPath: string,
  allowedRoots: readonly string[] | undefined,
): Promise<string> {
  if (!path.isAbsolute(attachmentPath)) {
    throw new Error('Attachment path must be absolute');
  }
  const resolvedPath = await fs.realpath(attachmentPath);
  if (allowedRoots === undefined) return resolvedPath;
  if (allowedRoots.length === 0) {
    throw new Error('File attachments are disabled. Configure allowedAttachmentRoots or use contentBase64.');
  }

  for (const configuredRoot of allowedRoots) {
    if (!path.isAbsolute(configuredRoot)) {
      throw new Error('allowedAttachmentRoots entries must be absolute paths');
    }
    const resolvedRoot = await fs.realpath(configuredRoot);
    const relative = path.relative(resolvedRoot, resolvedPath);
    if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
      return resolvedPath;
    }
  }
  throw new Error('Attachment path is outside the configured allowedAttachmentRoots');
}

async function prepareAttachment(
  attachment: OutgoingAttachment,
  options: OutgoingMessagePreparationOptions,
): Promise<NonNullable<PreparedOutgoingMessage['attachments']>[number]> {
  let filename: string;
  let content: Buffer;

  if ('path' in attachment) {
    assertSingleLine(attachment.path, 'Attachment path');
    const safePath = await assertAllowedAttachmentPath(
      attachment.path,
      options.allowedAttachmentRoots,
    );
    const stats = await fs.stat(safePath);
    if (!stats.isFile()) {
      throw new Error(`Attachment path is not a regular file: ${attachment.path}`);
    }
    if (stats.size > MAX_OUTGOING_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment ${attachment.path} exceeds the ${MAX_OUTGOING_ATTACHMENT_BYTES}-byte limit`
      );
    }
    filename = normalizeFilename(attachment.filename ?? path.basename(safePath));
    content = await fs.readFile(safePath);
  } else {
    filename = normalizeFilename(attachment.filename);
    content = decodeBase64(attachment.contentBase64);
  }

  assertAttachmentSize(content, filename);
  if (attachment.contentType) assertSingleLine(attachment.contentType, 'Attachment contentType');
  if (attachment.cid) assertSingleLine(attachment.cid, 'Attachment cid');

  return {
    filename,
    content,
    ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    ...(attachment.contentDisposition ? { contentDisposition: attachment.contentDisposition } : {}),
    ...(attachment.cid ? { cid: attachment.cid } : {}),
  };
}

function prepareHeaders(message: OutgoingMessage): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`Invalid mail header name: ${name}`);
    }
    if (CONTROLLED_HEADERS.has(name.toLowerCase())) {
      throw new Error(`Mail header ${name} must be set through its typed field`);
    }
    assertSingleLine(value, `Mail header ${name}`);
    headers[name] = value;
  }

  if (message.threading?.inReplyTo) {
    assertSingleLine(message.threading.inReplyTo, 'In-Reply-To');
    headers['In-Reply-To'] = message.threading.inReplyTo;
  }
  if (message.threading?.references) {
    const references = Array.isArray(message.threading.references)
      ? message.threading.references.join(' ')
      : message.threading.references;
    assertSingleLine(references, 'References');
    headers.References = references;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

export async function prepareOutgoingMessage(
  message: OutgoingMessage,
  defaultFrom: string,
  options: OutgoingMessagePreparationOptions = {},
): Promise<PreparedOutgoingMessage> {
  if (message.text === undefined && message.html === undefined) {
    throw new Error('Outgoing message requires text and/or html content');
  }

  for (const [field, value] of [
    ['To', message.to],
    ['Cc', message.cc],
    ['Bcc', message.bcc],
    ['From', message.from],
    ['Reply-To', message.replyTo],
    ['Subject', message.subject],
    ['Default From', defaultFrom],
  ] as const) {
    if (value !== undefined) assertSingleLine(value, field);
  }

  const attachments = message.attachments ?? [];
  if (attachments.length > MAX_OUTGOING_ATTACHMENTS) {
    throw new Error(`Outgoing message supports at most ${MAX_OUTGOING_ATTACHMENTS} attachments`);
  }

  const preparedAttachments = await Promise.all(
    attachments.map(attachment => prepareAttachment(attachment, options)),
  );
  const headers = prepareHeaders(message);

  return {
    from: message.from ?? defaultFrom,
    to: message.to,
    subject: message.subject,
    ...(message.text !== undefined ? { text: message.text } : {}),
    ...(message.html !== undefined ? { html: message.html } : {}),
    ...(message.cc ? { cc: message.cc } : {}),
    ...(message.bcc ? { bcc: message.bcc } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(preparedAttachments.length > 0 ? { attachments: preparedAttachments } : {}),
    ...(headers ? { headers } : {}),
  };
}
