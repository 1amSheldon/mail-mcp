import { describe, it, expect, vi } from 'vitest';
import { MailService } from './mail.js';
import { SmtpClient } from '../protocol/smtp.js';
import { replaceHeaders } from './drafts.js';
import type { EmailAccount } from '../config.js';

const account: EmailAccount = { id: 'archive-test', name: 'Test', host: 'imap.exmail.qq.com', smtpHost: 'smtp.exmail.qq.com', port: 993, user: 'test@example.com', authType: 'login', useTLS: true };
describe('draft archive policy and confirmation', () => {
  it('uses provider copies for Tencent unless explicitly overridden', () => {
    expect((new MailService(account) as any).sentCopyPolicy()).toBe('provider');
    expect((new MailService({ ...account, sentPolicy: 'always' }) as any).sentCopyPolicy()).toBe('manual');
    expect((new MailService({ ...account, sentPolicy: 'never' }) as any).sentCopyPolicy()).toBe('none');
  });
  it('waits for a delayed Tencent copy and verifies a rewritten ID', async () => {
    const service = new MailService(account) as any;
    vi.spyOn(service, 'resolveSentFolder').mockResolvedValue('Sent');
    const raw = (await new SmtpClient(account).composeMessage({ from: account.user, to: account.user, subject: 'Archive', text: 'Body' })).rawMessage;
    const now = new Date(); const id = '<archive@example.com>';
    const source = replaceHeaders(raw, { 'Message-ID': id, Date: now.toUTCString() });
    const copy = replaceHeaders(source, { 'Message-ID': '<ABC123+archive@example.com>' });
    let scans = 0;
    vi.spyOn(service.imapClient, 'searchMessageUids').mockImplementation(async (...args: unknown[]) => {
      if ((args[0] as any).header) return [];
      return ++scans === 1 ? [] : [2];
    });
    vi.spyOn(service.imapClient, 'fetchRawMessage').mockResolvedValue(copy);
    expect(await service.draftWorkflow().port.verify(source, id, now)).toEqual({ folder: 'Sent', uid: 2 });
    expect(scans).toBe(2);
  });
  it('does not confirm ambiguous Sent copies', async () => {
    const service = new MailService(account) as any;
    vi.spyOn(service, 'resolveSentFolder').mockResolvedValue('Sent');
    const composed = await new SmtpClient(account).composeMessage({ from: account.user, to: account.user, subject: 'Archive', text: 'Body' });
    vi.spyOn(service.imapClient, 'searchMessageUids').mockResolvedValue([1, 2]);
    vi.spyOn(service.imapClient, 'fetchRawMessage').mockResolvedValue(composed.rawMessage);
    expect(await service.draftWorkflow().port.verify(composed.rawMessage, composed.messageId, new Date())).toBeUndefined();
  });
});
