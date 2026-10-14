import { prepareAttachment, type OutgoingAttachment } from '../../domain/outgoing-message.js';
import { ZimbraError } from './session.js';

type Obj = Record<string, unknown>;
export type CalendarAttach = (message: Obj, attachments: OutgoingAttachment[]) => Promise<Obj>;
export const noCalendarUploads: CalendarAttach = async (message, attachments) => {
  if (attachments.length) throw new ZimbraError('INVALID_INPUT', 'Calendar attachment upload is unavailable.');
  return message;
};
export function calendarAttachmentWriter(upload: (bytes: Buffer, name: string, type: string) => Promise<string>, roots: readonly string[] = []): CalendarAttach {
  return async (message, attachments) => {
    // Validate the whole set before uploading anything, and bound aggregate
    // memory rather than preparing twenty maximum-sized files concurrently.
    const prepared: Awaited<ReturnType<typeof prepareAttachment>>[] = [];
    const cids = new Set<string>(); let bytes = 0;
    for (const input of attachments) {
      let part: Awaited<ReturnType<typeof prepareAttachment>>;
      try { part = await prepareAttachment(input, { allowedAttachmentRoots: roots }); }
      catch { throw new ZimbraError('INVALID_INPUT', 'Invalid calendar attachment. Check its encoding, size and allowedAttachmentRoots.'); }
      bytes += part.content.length;
      if (bytes > 25 * 1024 * 1024) throw new ZimbraError('INVALID_INPUT', 'Calendar attachments exceed the combined 25 MiB limit.');
      if (part.contentDisposition === 'inline' || part.cid) {
        if (!part.cid || /[<>\s]/.test(part.cid) || cids.has(part.cid) || part.contentDisposition === 'attachment') throw new ZimbraError('INVALID_INPUT', 'Inline calendar attachments need distinct bare CIDs and no conflicting attachment disposition.');
        cids.add(part.cid);
      }
      prepared.push(part);
    }
    const inline: Obj[] = []; const regular: string[] = [];
    for (const part of prepared) {
      const type = part.contentType ?? 'application/octet-stream';
      const aid = await upload(part.content, part.filename, type);
      if (part.cid) inline.push({ ct: type, ci: part.cid, attach: { aid } });
      else regular.push(aid);
    }
    return { ...message, ...(inline.length ? { mp: { ct: 'multipart/related', mp: [message.mp, ...inline] } } : {}),
      ...(regular.length ? { attach: { aid: regular.join(',') } } : {}) };
  };
}
