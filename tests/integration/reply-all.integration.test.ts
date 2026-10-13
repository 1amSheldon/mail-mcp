import { describe, expect, it, vi } from 'vitest';
import { SMTPServer } from 'smtp-server';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { MailMCPServer } from '../../src/index.js';
import { MailService } from '../../src/services/mail.js';
import { encodeMessageLocator } from '../../src/domain/message-locator.js';

describe('reply-all attachments through MCP and loopback SMTP', () => {
  it('delivers new and original attachments with the source thread and deduplicated recipients', async () => {
    const received: Buffer[] = [];
    const recipients: string[][] = [];
    const smtpServer = new SMTPServer({
      secure: false, authOptional: true, disabledCommands: ['STARTTLS'],
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
        stream.on('end', () => {
          received.push(Buffer.concat(chunks));
          recipients.push(session.envelope.rcptTo.map(recipient => recipient.address));
          callback();
        });
      },
    });
    const service = new MailService({
      id: 'loopback-reply', name: 'Test', user: 'me@example.test',
      host: '127.0.0.1', port: 993, useTLS: false, authType: 'login', sentPolicy: 'never',
    });
    const router = new MailMCPServer(false);
    try {
      await new Promise<void>(resolve => smtpServer.listen(0, '127.0.0.1', resolve));
      const address = (smtpServer as unknown as { server: import('node:net').Server }).server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test port');
      (service as any).smtpClient.transporter = nodemailer.createTransport({
        host: '127.0.0.1', port: address.port, secure: false, ignoreTLS: true,
      });
      const source = await simpleParser(Buffer.from([
        'From: sender@example.test', 'To: me@example.test, other@example.test',
        'Cc: other@example.test', 'Message-ID: <parent@example.test>',
        'References: <root@example.test>', 'Subject: Original', '', 'Original',
      ].join('\r\n')));
      source.attachments.push({ filename: 'original.txt', content: Buffer.from('old'),
        contentType: 'text/plain', contentDisposition: 'attachment', size: 3,
        checksum: '', related: false, headers: new Map(), type: 'attachment',
      });
      vi.spyOn(service.imap, 'getMailboxIdentity').mockResolvedValue({ path: 'INBOX', uidValidity: '1' });
      vi.spyOn(service.imap, 'fetchMessageBody').mockResolvedValue(source);
      vi.spyOn(router as any, 'getService').mockResolvedValue(service);
      const result = await router.dispatchTool('mail_mutate', false, {
        accountId: 'loopback-reply', operation: 'replyAll', input: {
          locator: encodeMessageLocator({ accountId: 'loopback-reply', mailbox: 'INBOX', uidValidity: '1', uid: 1 }),
          body: 'Reply', includeOriginalAttachments: true,
          attachments: [{ filename: 'new.txt', contentBase64: Buffer.from('new').toString('base64') }],
        },
      });
      expect(result.isError).not.toBe(true);
      expect(received).toHaveLength(1);
      expect(recipients[0]).toEqual(['sender@example.test', 'other@example.test']);
      const parsed = await simpleParser(received[0]);
      expect(parsed.inReplyTo).toBe('<parent@example.test>');
      expect(parsed.references).toEqual(['<root@example.test>', '<parent@example.test>']);
      expect(parsed.attachments.map(a => [a.filename, a.content.toString()])).toEqual([
        ['original.txt', 'old'], ['new.txt', 'new'],
      ]);
    } finally {
      (service as any).smtpClient.disconnect();
      await router.shutdown();
      await new Promise<void>(resolve => smtpServer.close(() => resolve()));
      vi.restoreAllMocks();
    }
  });
});
