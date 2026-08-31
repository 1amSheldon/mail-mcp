import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_OUTGOING_ATTACHMENT_BYTES,
  prepareOutgoingMessage,
} from '../domain/outgoing-message.js';
import { stripBccHeader } from './smtp.js';

const temporaryDirectories: string[] = [];

async function composeRaw(options: Awaited<ReturnType<typeof prepareOutgoingMessage>>): Promise<Buffer> {
  const composer = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  });
  const result = await composer.sendMail(options);
  const raw = Buffer.isBuffer(result.message) ? result.message : Buffer.from(result.message);
  return stripBccHeader(raw);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe('outgoing MIME contract', () => {
  it('builds text and HTML alternatives with threading, Reply-To, and inline attachment bytes', async () => {
    const options = await prepareOutgoingMessage({
      to: 'to@example.com',
      cc: 'cc@example.com',
      bcc: 'hidden@example.com',
      from: 'Support <alias@example.com>',
      replyTo: 'replies@example.com',
      subject: 'MIME contract',
      text: 'Plain body',
      html: '<p>HTML body</p>',
      threading: {
        inReplyTo: '<parent@example.com>',
        references: ['<root@example.com>', '<parent@example.com>'],
      },
      attachments: [{
        filename: 'hello.txt',
        contentType: 'text/plain',
        contentBase64: Buffer.from('attachment bytes').toString('base64'),
      }],
    }, 'authenticated@example.com');

    const raw = await composeRaw(options);
    const rawText = raw.toString('utf8');
    const parsed = await simpleParser(raw);

    expect(parsed.from?.value).toEqual([{
      name: 'Support',
      address: 'alias@example.com',
    }]);
    expect(parsed.replyTo?.text).toBe('replies@example.com');
    expect(parsed.text?.trim()).toBe('Plain body');
    expect(parsed.html).toContain('<p>HTML body</p>');
    expect(parsed.headers.get('in-reply-to')).toBe('<parent@example.com>');
    expect(parsed.headers.get('references')).toEqual([
      '<root@example.com>',
      '<parent@example.com>',
    ]);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe('hello.txt');
    expect(parsed.attachments[0]?.content.toString()).toBe('attachment bytes');
    expect(rawText).not.toMatch(/^Bcc:/mi);
  });

  it('reads file attachments into the composed MIME bytes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-mcp-smtp-'));
    temporaryDirectories.push(directory);
    const attachmentPath = path.join(directory, 'report.txt');
    await fs.writeFile(attachmentPath, 'file attachment');

    const options = await prepareOutgoingMessage({
      to: 'to@example.com',
      subject: 'File attachment',
      text: 'Body',
      attachments: [{ path: attachmentPath }],
    }, 'authenticated@example.com', { allowedAttachmentRoots: [directory] });
    const parsed = await simpleParser(await composeRaw(options));

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe('report.txt');
    expect(parsed.attachments[0]?.content.toString()).toBe('file attachment');
  });

  it('rejects file attachments when roots are disabled or the real path is outside them', async () => {
    const allowedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-mcp-smtp-allowed-'));
    const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-mcp-smtp-outside-'));
    temporaryDirectories.push(allowedDirectory, outsideDirectory);
    const attachmentPath = path.join(outsideDirectory, 'outside.txt');
    await fs.writeFile(attachmentPath, 'outside');
    const message = {
      to: 'to@example.com',
      subject: 'Path policy',
      text: 'Body',
      attachments: [{ path: attachmentPath }],
    };

    await expect(prepareOutgoingMessage(
      message,
      'authenticated@example.com',
      { allowedAttachmentRoots: [] },
    )).rejects.toThrow('File attachments are disabled');
    await expect(prepareOutgoingMessage(
      message,
      'authenticated@example.com',
      { allowedAttachmentRoots: [allowedDirectory] },
    )).rejects.toThrow('outside the configured allowedAttachmentRoots');
  });

  it('rejects more than 20 attachments', async () => {
    await expect(prepareOutgoingMessage({
      to: 'to@example.com',
      subject: 'Too many',
      text: 'Body',
      attachments: Array.from({ length: 21 }, (_, index) => ({
        filename: `${index}.txt`,
        contentBase64: '',
      })),
    }, 'authenticated@example.com')).rejects.toThrow('at most 20 attachments');
  });

  it('rejects a file attachment larger than 25 MiB before reading it', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-mcp-smtp-'));
    temporaryDirectories.push(directory);
    const attachmentPath = path.join(directory, 'oversized.bin');
    const handle = await fs.open(attachmentPath, 'w');
    await handle.truncate(MAX_OUTGOING_ATTACHMENT_BYTES + 1);
    await handle.close();

    await expect(prepareOutgoingMessage({
      to: 'to@example.com',
      subject: 'Oversized',
      text: 'Body',
      attachments: [{ path: attachmentPath }],
    }, 'authenticated@example.com')).rejects.toThrow('exceeds the 26214400-byte limit');
  });
});
