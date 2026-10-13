import { afterEach, describe, expect, it, vi } from 'vitest';
import { simpleParser } from 'mailparser';
import { MailService } from './mail.js';
import { SmtpClient } from '../protocol/smtp.js';
import { encodeMessageLocator } from '../domain/message-locator.js';
import type { EmailAccount } from '../config.js';

afterEach(() => vi.restoreAllMocks());

async function fixture(overrides: Partial<EmailAccount> = {}) {
  const account: EmailAccount = {
    id: 'reply-test', name: 'Test', user: 'me@example.test', fromAliases: ['alias@example.test'],
    host: 'imap.example.test', port: 993, useTLS: true, authType: 'login', signature: 'Signature', ...overrides,
  };
  const source = await simpleParser(Buffer.from([
    'From: sender@example.test', 'Reply-To: reply@example.test',
    'To: me@example.test, friend@example.test',
    'Cc: FRIEND@example.test, alias@example.test, other@example.test',
    'Subject: re: Original', 'Message-ID: <parent@example.test>',
    'References: <root@example.test> <previous@example.test>',
    '', 'Original body',
  ].join('\r\n')));
  source.attachments.push({ filename: 'original.txt', content: Buffer.from('original'),
    contentType: 'text/plain', contentDisposition: 'attachment', size: 8, checksum: '',
    related: false, headers: new Map(), type: 'attachment',
  });
  const service = new MailService(account);
  const locator = encodeMessageLocator({ accountId: account.id, mailbox: 'INBOX', uidValidity: '1', uid: 1 });
  vi.spyOn(service.imap, 'getMailboxIdentity').mockImplementation(async path => ({ path, uidValidity: '1' }));
  vi.spyOn(service.imap, 'fetchMessageBody').mockResolvedValue(source);
  vi.spyOn(service.imap, 'findSpecialUseFolder').mockResolvedValue('Drafts');
  const append = vi.spyOn(service.imap, 'appendMessage').mockResolvedValue({ uid: 2 });
  vi.spyOn(service as any, 'draftWorkflow').mockReturnValue({ adopt: vi.fn().mockResolvedValue('stable-draft') });
  const send = vi.spyOn(SmtpClient.prototype, 'sendMessage').mockRejectedValue(new Error('Unexpected SMTP send'));
  const connect = vi.spyOn(SmtpClient.prototype, 'connect').mockRejectedValue(new Error('Unexpected SMTP connection'));
  return { service, locator, source, append, send, connect };
}

describe('threaded reply drafts with real MIME composition', () => {
  it('retains every Reply-To recipient for drafts and immediate replies', async () => {
    const f = await fixture();
    f.source.replyTo = { value: [{ address: 'one@example.test', name: '' }, { address: 'two@example.test', name: '' }, { address: 'ONE@example.test', name: '' }], text: '', html: '' };
    await f.service.createReplyDraft(f.locator, 'Reply');
    expect((await simpleParser(f.append.mock.calls[0][1])).to).toMatchObject({ value: [{ address: 'one@example.test' }, { address: 'two@example.test' }] });
    const send = vi.spyOn(f.service, 'sendMessage').mockResolvedValue({} as any);
    await f.service.replyEmail('1', 'INBOX', 'Reply');
    expect(send.mock.calls[0][0].to).toBe('one@example.test, two@example.test');
  });
  it('does not reuse cached bodies across UIDVALIDITY generations', async () => {
    const f = await fixture();
    await f.service.createReplyDraft(f.locator, 'Old reply');
    const next = await simpleParser('From: new@example.test\r\nMessage-ID: <new@example.test>\r\n\r\nNew');
    vi.mocked(f.service.imap.fetchMessageBody).mockResolvedValue(next);
    vi.mocked(f.service.imap.getMailboxIdentity).mockImplementation(async path => ({ path, uidValidity: '2' }));
    const locator = encodeMessageLocator({ accountId: 'reply-test', mailbox: 'INBOX', uidValidity: '2', uid: 1 });
    await f.service.createReplyDraft(locator, 'New reply');
    const draft = await simpleParser(f.append.mock.calls[1][1]);
    expect(draft.to).toMatchObject({ value: [{ address: 'new@example.test' }] });
    expect(draft.inReplyTo).toBe('<new@example.test>');
    expect(f.service.imap.fetchMessageBody).toHaveBeenCalledTimes(2);
  });
  it('saves a reply with Reply-To, a complete reference chain, HTML and a new attachment without SMTP', async () => {
    const f = await fixture();
    const result = await f.service.createReplyDraft(f.locator, '<p>Reviewed reply</p>', {
      isHtml: true, includeSignature: false, cc: 'copy@example.test', bcc: 'hidden@example.test',
      attachments: [{ filename: 'new.txt', contentBase64: Buffer.from('new file').toString('base64') }],
    });
    expect(result).toMatchObject({ draftId: 'stable-draft', folder: 'Drafts', uid: 2 });
    expect(result.locator).toBeTruthy();
    expect(f.append).toHaveBeenCalledOnce();
    expect(f.append.mock.calls[0][0]).toBe('Drafts');
    expect(f.append.mock.calls[0][2]).toEqual(['\\Draft']);
    const parsed = await simpleParser(f.append.mock.calls[0][1]);
    expect(parsed.to).toMatchObject({ value: [{ address: 'reply@example.test' }] });
    expect(parsed.cc).toMatchObject({ value: [{ address: 'copy@example.test' }] });
    expect(parsed.bcc).toMatchObject({ value: [{ address: 'hidden@example.test' }] });
    expect(parsed.subject).toBe('re: Original');
    expect(parsed.inReplyTo).toBe('<parent@example.test>');
    expect(parsed.references).toEqual(['<root@example.test>', '<previous@example.test>', '<parent@example.test>']);
    expect(parsed.html).toBe('<p>Reviewed reply</p>');
    expect(parsed.attachments.map(a => a.filename)).toEqual(['new.txt']);
    expect(parsed.attachments[0].content.toString()).toBe('new file');
    expect(f.send).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('saves reply-all with deduplicated participants, both attachment sets and one signature', async () => {
    const f = await fixture();
    await f.service.createReplyDraft(f.locator, 'Reply', {
      replyAll: true, includeOriginalAttachments: true,
      attachments: [{ filename: 'new.txt', contentBase64: 'bmV3' }],
    });
    const parsed = await simpleParser(f.append.mock.calls[0][1]);
    expect(parsed.to).toMatchObject({ value: [{ address: 'reply@example.test' }] });
    expect(parsed.cc).toMatchObject({ value: [{ address: 'friend@example.test' }, { address: 'other@example.test' }] });
    expect(parsed.inReplyTo).toBe('<parent@example.test>');
    expect(parsed.attachments.map(a => a.filename)).toEqual(['original.txt', 'new.txt']);
    expect(parsed.text?.match(/Signature/g)).toHaveLength(1);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('allows explicitly clearing inferred CC', async () => {
    const f = await fixture();
    await f.service.createReplyDraft(f.locator, 'Reply', { replyAll: true, cc: '' });
    expect((await simpleParser(f.append.mock.calls[0][1])).cc).toBeUndefined();
  });

  it('rejects missing Message-ID instead of silently creating an unthreaded draft', async () => {
    const f = await fixture();
    f.source.messageId = undefined;
    await expect(f.service.createReplyDraft(f.locator, 'Reply')).rejects.toThrow('no Message-ID');
    expect(f.append).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('enforces recipient restrictions on inferred reply-all recipients before saving', async () => {
    const f = await fixture({ allowedRecipients: ['reply@example.test'] });
    await expect(f.service.createReplyDraft(f.locator, 'Reply', { replyAll: true })).rejects.toThrow();
    expect(f.append).not.toHaveBeenCalled();
  });

  it('rejects a stale source locator without appending a draft', async () => {
    const f = await fixture();
    vi.mocked(f.service.imap.getMailboxIdentity).mockResolvedValue({ path: 'INBOX', uidValidity: '2' });
    await expect(f.service.createReplyDraft(f.locator, 'Reply')).rejects.toThrow();
    expect(f.append).not.toHaveBeenCalled();
  });
});
