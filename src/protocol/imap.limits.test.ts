import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { ImapClient, MAX_PARSED_MESSAGE_BYTES } from './imap.js';
import type { EmailAccount } from '../config.js';

function fixture(overrides: Record<string, unknown>) {
  const client = new ImapClient({} as EmailAccount);
  const release = vi.fn();
  const flow = { mailbox: { uidValidity: 1n }, getMailboxLock: async () => ({ release }), ...overrides };
  (client as any).client = flow;
  return { client, release, flow };
}

it('rejects a large message before loading/parsing its source', async () => {
  const fetchOne = vi.fn(async () => ({ size: MAX_PARSED_MESSAGE_BYTES + 1 }));
  const { client, release } = fixture({ fetchOne });
  await expect(client.fetchMessageBody('1')).rejects.toThrow('byte limit');
  expect(fetchOne).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it('bounds raw FETCH even when size metadata is absent', async () => {
  const fetchOne = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ source: Buffer.alloc(9) });
  const { client } = fixture({ fetchOne });
  await expect(client.fetchRawMessage('1', 'INBOX', 8)).rejects.toThrow('byte limit');
  expect(fetchOne).toHaveBeenLastCalledWith('1', { source: { start: 0, maxLength: 9 } }, { uid: true });
});

const bodyStructure = { type: 'multipart/mixed', childNodes: [
  { part: '1', type: 'application/octet-stream', disposition: 'attachment', dispositionParameters: { filename: 'small.bin' } },
  { part: '2', type: 'application/octet-stream', dispositionParameters: { filename: 'large.bin' }, size: 1024 ** 3 },
] };

it('downloads only the requested attachment with an enforced decoded byte budget', async () => {
  const fetchOne = vi.fn(async () => ({ bodyStructure }));
  const download = vi.fn(async () => ({ content: Readable.from([Buffer.from('small')]), meta: { contentType: 'application/octet-stream' } }));
  const { client } = fixture({ fetchOne, download });
  expect((await client.fetchAttachment('7', 'small.bin', 'INBOX', 8, '1')).content.toString()).toBe('small');
  expect(fetchOne).toHaveBeenCalledOnce();
  expect(download).toHaveBeenCalledWith('7', '1', { uid: true, maxBytes: 9, chunkSize: 65536 });
});

it('rejects an oversized attachment stream regardless of metadata size', async () => {
  const { client, release } = fixture({ fetchOne: async () => ({ bodyStructure }),
    download: async () => ({ content: Readable.from([Buffer.alloc(9)]), meta: { contentType: 'application/octet-stream' } }) });
  await expect(client.fetchAttachment('7', 'small.bin', 'INBOX', 8)).rejects.toThrow('byte limit');
  expect(release).toHaveBeenCalledOnce();
});

it('checks actual decoded attachment bytes in the bounded MIME fallback', async () => {
  const raw = Buffer.from('Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=small.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nMTIzNDU2Nzg5\r\n--x--\r\n');
  const fetchOne = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ size: raw.length }).mockResolvedValueOnce({ source: raw });
  const { client } = fixture({ fetchOne });
  await expect(client.fetchAttachment('7', 'small.bin', 'INBOX', 8)).rejects.toThrow('byte limit');
  expect(fetchOne.mock.calls[2][1].source.maxLength).toBe(MAX_PARSED_MESSAGE_BYTES + 1);
});
