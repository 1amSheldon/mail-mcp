import nodemailer from 'nodemailer';
import { z } from 'zod';
import { prepareOutgoingMessage, type OutgoingMessage } from '../../domain/outgoing-message.js';
import { ZimbraError } from './session.js';

const line = z.string().min(1).max(998).refine(v => !/[\r\n\0]/.test(v));
const attachmentFields = {
  filename: line.optional(), contentType: line.optional(),
  contentDisposition: z.enum(['attachment', 'inline']).optional(), cid: line.optional(),
};
export const attachmentsSchema = z.array(z.union([
  z.object({ ...attachmentFields, path: z.string().min(1).max(4096) }).strict(),
  z.object({ ...attachmentFields, filename: line, contentBase64: z.string().max(35 * 1024 * 1024) }).strict(),
])).max(20);
export const MAX_MIME_BYTES = 50 * 1024 * 1024;

/** Produces bytes only: the stream transport cannot open files, URLs or SMTP. */
export async function composeMime(message: OutgoingMessage, user: string, roots: readonly string[] = [], metadata: { messageId?: string; date?: Date } = {}): Promise<Buffer> {
  let prepared: Awaited<ReturnType<typeof prepareOutgoingMessage>>;
  try { prepared = await prepareOutgoingMessage(message, user, { allowedAttachmentRoots: roots }); }
  catch { throw new ZimbraError('INVALID_INPUT', 'Invalid message or attachment. Check base64, size, filenames and configured allowedAttachmentRoots.'); }
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows', disableFileAccess: true, disableUrlAccess: true });
  try {
    const result = await transport.sendMail({ ...prepared, ...metadata, keepBcc: true });
    if (!Buffer.isBuffer(result.message) || result.message.length > MAX_MIME_BYTES) {
      throw new ZimbraError('INVALID_INPUT', 'The composed message exceeds the 50 MiB limit.');
    }
    return result.message;
  } finally { transport.close(); }
}

/** fmt=raw is a three-field protocol, not executable JavaScript. */
export function parseUploadResponse(value: string, requestId: string): string {
  const match = /^\s*200\s*,\s*'([A-Za-z0-9_.-]+)'\s*,\s*'([A-Za-z0-9_:.-]{1,1024})'\s*$/.exec(value);
  if (!match || match[1] !== requestId) throw new ZimbraError('OUTCOME_UNKNOWN', 'Upload response is invalid or belongs to another request. No draft save was attempted.');
  return match[2];
}
