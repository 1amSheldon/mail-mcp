import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMTPServer } from 'smtp-server';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { DraftStore, DraftWorkflow, type DraftPort } from '../../src/services/drafts.js';
import { SmtpClient } from '../../src/protocol/smtp.js';
import { encodeMessageLocator } from '../../src/domain/message-locator.js';
import type { EmailAccount } from '../../src/config.js';

describe('draft workflow over a loopback SMTP connection', () => {
  it('updates MIME, delivers Bcc through the envelope, and does not resend after restart', async () => {
    const received: Buffer[] = [];
    const recipients: string[][] = [];
    const server = new SMTPServer({
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
    const root = await mkdtemp(join(tmpdir(), 'mail-draft-smtp-'));
    const account: EmailAccount = {
      id: 'loopback-drafts', name: 'Test', user: 'sender@example.test',
      host: '127.0.0.1', port: 993, useTLS: false, authType: 'login',
    };
    const smtp = new SmtpClient(account);
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = (server as unknown as { server: import('node:net').Server }).server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test port');
      (smtp as unknown as { transporter: unknown }).transporter = nodemailer.createTransport({
        host: '127.0.0.1', port: address.port, secure: false, ignoreTLS: true,
      });
      let uid = 1;
      const locator = (value: number) => encodeMessageLocator({
        accountId: account.id, mailbox: 'Drafts', uidValidity: '1', uid: value,
      });
      const draft = await smtp.composeMessage({
        to: 'recipient@example.test', bcc: 'hidden@example.test', subject: 'Before review',
        text: 'Reviewed body', attachments: [{ filename: 'test.txt', contentBase64: 'aGVsbG8=' }],
      }, { stripBcc: false });
      const messages = new Map([[locator(uid), draft.rawMessage]]);
      const port: DraftPort = {
        folder: async () => 'Drafts',
        read: async key => {
          const raw = messages.get(key);
          if (!raw) throw new Error('Missing test draft');
          return raw;
        },
        search: async id => {
          const found: string[] = [];
          for (const [key, raw] of messages) if ((await simpleParser(raw)).messageId === id) found.push(key);
          return found;
        },
        append: async raw => {
          const key = locator(++uid); messages.set(key, raw);
          return { locator: key, folder: 'Drafts', uid };
        },
        trash: async key => { messages.delete(key); },
        compose: message => smtp.composeMessage(message, { stripBcc: false }),
        send: async (_message, raw) => {
          const result = await smtp.sendRawMessage(raw);
          return { accepted: result.accepted, rejected: result.rejected, messageId: result.messageId,
            status: 'sent_and_saved', smtpAccepted: true,
            sentFolderSaved: true, retrySafe: false, nextAction: 'Do not resend.' };
        },
        verify: async () => undefined,
      };
      const workflow = new DraftWorkflow(account, port, new DraftStore(account.id, root));
      const updated = await workflow.update(locator(1), { subject: 'Approved subject' });
      const sent = await workflow.send(updated.draftId as string);
      expect(sent.status).toBe('sent_and_saved');
      const restarted = new DraftWorkflow(account, port, new DraftStore(account.id, root));
      expect(await restarted.send(updated.draftId as string)).toEqual(sent);
      expect(received).toHaveLength(1);
      expect(recipients[0]).toEqual(['recipient@example.test', 'hidden@example.test']);
      const parsed = await simpleParser(received[0]);
      expect(parsed.subject).toBe('Approved subject');
      expect(parsed.bcc).toBeUndefined();
      expect(parsed.text?.trim()).toBe('Reviewed body');
      expect(parsed.attachments[0].content.toString()).toBe('hello');
      expect(messages.size).toBe(0);
    } finally {
      smtp.disconnect();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
