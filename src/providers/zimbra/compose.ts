import addressparser from 'nodemailer/lib/addressparser/index.js';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { OutgoingAttachment } from '../../domain/outgoing-message.js';
import { ZimbraError } from './session.js';

export function addresses(field: AddressObject | AddressObject[] | undefined): string[] {
  return (Array.isArray(field) ? field : field ? [field] : []).flatMap(value =>
    addressparser(value.text, { flatten: true }).map(a => a.address ?? ''));
}
export function parsedAttachments(source: ParsedMail): OutgoingAttachment[] {
  return source.attachments.map(a => ({ filename: a.filename || 'attachment', contentBase64: a.content.toString('base64'), contentType: a.contentType,
    contentDisposition: a.contentDisposition === 'inline' ? 'inline' : 'attachment', ...(a.cid ? { cid: a.cid } : {}) }));
}
export const parseMime = (raw: Buffer) => simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function replyEnvelope(source: ParsedMail, ownAddresses: string[], replyAll: boolean) {
  if (!source.messageId || !/^<[^<>\s"\\]+>$/.test(source.messageId)) throw new ZimbraError('INVALID_INPUT', 'Original message has no usable Message-ID for a threaded reply.');
  const own = new Set(ownAddresses.map(a => a.toLowerCase()));
  const seen = new Set<string>();
  const unique = (values: string[]) => values.filter(a => {
    const key = a.toLowerCase();
    if (!a || own.has(key) || seen.has(key)) return false;
    seen.add(key); return true;
  });
  const senders = addresses(source.replyTo).length ? addresses(source.replyTo) : addresses(source.from);
  const sentBySelf = addresses(source.from).some(a => own.has(a.toLowerCase()));
  const to = unique(sentBySelf ? addresses(source.to) : senders);
  if (replyAll && !sentBySelf) to.push(...unique(addresses(source.to)));
  const cc = replyAll ? unique(addresses(source.cc)) : [];
  if (!to.length) throw new ZimbraError('INVALID_INPUT', 'No external reply recipients remain after removing own addresses.');
  // Received Bcc is deliberately never inferred into a reply.
  const references = [...(Array.isArray(source.references) ? source.references : source.references ? [source.references] : []), source.messageId];
  return { to, cc, subject: /^re:/i.test(source.subject ?? '') ? source.subject ?? '' : 'Re: ' + (source.subject ?? ''), references: [...new Set(references)].slice(-100) };
}
