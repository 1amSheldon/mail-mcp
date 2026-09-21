import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleParser } from 'mailparser';
import { DraftStore, DraftWorkflow, replaceHeaders, contentFingerprint, matchesSentDraft, type DraftPort } from './drafts.js';
import { SmtpClient } from '../protocol/smtp.js';
import { encodeMessageLocator } from '../domain/message-locator.js';
import type { EmailAccount } from '../config.js';
import type { SendDeliveryResult } from './mail.js';

const account: EmailAccount = { id: 'test-drafts', name: 'Test', host: 'localhost', port: 993, user: 'me@example.com', authType: 'login', useTLS: true };
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const locator = (uid: number, mailbox = 'Drafts') => encodeMessageLocator({ accountId: account.id, mailbox, uidValidity: '1', uid });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'draft-workflow-')); roots.push(root);
  const store = new DraftStore(account.id, root);
  const smtp = new SmtpClient(account);
  let uid = 1;
  const raw = (await smtp.composeMessage({ from: account.user, to: 'to@example.com', cc: 'cc@example.com', bcc: 'hidden@example.com',
    subject: '\u4e2d\u6587 test', text: 'Plain body', html: '<p>HTML<img src="cid:logo"></p>',
    threading: { inReplyTo: '<parent@example.com>', references: ['<parent@example.com>'] },
    attachments: [{ filename: 'hello.txt', contentBase64: 'aGVsbG8=' }, { filename: 'logo.png', contentType: 'image/png', contentBase64: 'aGVsbG8=', cid: 'logo', contentDisposition: 'inline' }],
  }, { stripBcc: false })).rawMessage;
  const messages = new Map([[locator(1), raw]]);
  const port: DraftPort = {
    folder: async () => 'Drafts',
    read: vi.fn(async id => { const value = messages.get(id); if (!value) throw new Error('Missing'); return value; }),
    search: vi.fn(async id => { const found: string[] = []; for (const [key, value] of messages) if ((await simpleParser(value)).messageId === id) found.push(key); return found; }),
    append: vi.fn(async value => { const id = locator(++uid); messages.set(id, value); return { folder: 'Drafts', uid, locator: id }; }),
    trash: vi.fn(async id => { messages.delete(id); }),
    compose: msg => smtp.composeMessage(msg, { stripBcc: false }),
    send: vi.fn(async (_msg, value): Promise<SendDeliveryResult> => ({ status: 'sent_provider_managed', smtpAccepted: true, accepted: value.envelope.to, rejected: [], messageId: value.messageId, sentFolderSaved: false, retrySafe: false, nextAction: 'Do not resend' })),
    verify: vi.fn(async () => ({ folder: 'Sent', uid: 42 })),
  };
  const workflow = new DraftWorkflow(account, port, store);
  return { workflow, port, messages, raw, store, root };
}
describe('server draft workflow', () => {
  it('matches Tencent rewritten IDs only with matching content and a bounded date', async () => {
    const f = await fixture(); const now = new Date(); const id = '<test@example.com>';
    const raw = replaceHeaders(f.raw, { 'Message-ID': id, Date: now.toUTCString() });
    const expected = await contentFingerprint(raw);
    expect(await matchesSentDraft(raw, id, now, expected)).toBe(true);
    const rewritten = replaceHeaders(raw, { 'Message-ID': '<ABC123+test@example.com>' });
    expect(await matchesSentDraft(rewritten, id, now, expected)).toBe(true);
    expect(await matchesSentDraft(replaceHeaders(rewritten, { Subject: 'Different' }), id, now, expected)).toBe(false);
    expect(await matchesSentDraft(rewritten, '<other@example.com>', now, expected)).toBe(false);
    expect(await matchesSentDraft(rewritten, id, new Date(now.getTime() + 700000), expected)).toBe(false);
  });
  it('sends server MIME, hides Bcc, preserves attachments and threading, archives then trashes', async () => {
    const f = await fixture();
    const result = await f.workflow.send(locator(1));
    expect(result.status).toBe('sent_and_saved'); expect(result.draftCleanup).toBe('moved_to_trash');
    const outgoing = vi.mocked(f.port.send).mock.calls[0][1];
    const parsed = await simpleParser(outgoing.rawMessage);
    expect(parsed.bcc).toBeUndefined(); expect(outgoing.envelope.to).toContain('hidden@example.com');
    expect(parsed.inReplyTo).toBe('<parent@example.com>'); expect(parsed.attachments).toHaveLength(2);
    expect(outgoing.rawMessage.subarray(outgoing.rawMessage.indexOf('\r\n\r\n') + 4)).toEqual(f.raw.subarray(f.raw.indexOf('\r\n\r\n') + 4));
    expect(parsed.messageId).not.toBe((await simpleParser(f.raw)).messageId);
  });
  it('removes resend-only routing headers and canonicalizes From before SMTP', async () => {
    const f = await fixture();
    f.messages.set(locator(1), replaceHeaders(f.raw, {
      Sender: 'evil@example.com', 'Resent-From': 'evil@example.com', 'Resent-To': 'other@example.com',
      'Resent-Date': new Date().toUTCString(), 'Resent-Message-ID': '<evil@example.com>',
    }));
    await f.workflow.send(locator(1));
    const wire = vi.mocked(f.port.send).mock.calls[0][1].rawMessage.toString('latin1');
    expect(wire).toMatch(/^From: me@example\.com$/m);
    expect(wire).not.toMatch(/^Sender:/mi);
    expect(wire).not.toMatch(/^Resent-/mi);
  });
  it('deduplicates across process restarts and historical locators', async () => {
    const f = await fixture(); const first = await f.workflow.send(locator(1));
    const restarted = new DraftWorkflow(account, f.port, new DraftStore(account.id, f.root));
    expect(await restarted.send(first.draftId as string)).toEqual(first);
    expect(await restarted.send(locator(1))).toEqual(first); expect(f.port.send).toHaveBeenCalledTimes(1);
    await expect(restarted.update(first.draftId, { subject: 'after send' })).rejects.toThrow('recorded delivery attempt');
  });
  it('updates headers without changing MIME body, returning stable ID and new locator', async () => {
    const f = await fixture(); const id = await f.workflow.adopt(locator(1), (await simpleParser(f.raw)).messageId);
    const result = await f.workflow.update(id, { subject: '\u65b0\u4e3b\u9898', bcc: '' });
    const updated = f.messages.get(result.locator as string)!; const parsed = await simpleParser(updated);
    expect(parsed.subject).toBe('\u65b0\u4e3b\u9898'); expect(parsed.bcc).toBeUndefined(); expect(parsed.cc).toBeDefined();
    expect(updated.subarray(updated.indexOf('\r\n\r\n') + 4)).toEqual(f.raw.subarray(f.raw.indexOf('\r\n\r\n') + 4));
    expect(result.draftId).toBe(id); expect(f.messages.has(locator(1))).toBe(false);
  });
  it('switches body format, clears attachments explicitly and preserves reply headers', async () => {
    const f = await fixture(); const r = await f.workflow.update(locator(1), { textBody: 'New plain body', attachments: [] });
    const p = await simpleParser(f.messages.get(r.locator as string)!, { skipTextToHtml: true });
    expect(p.text?.trim()).toBe('New plain body'); expect(p.html).toBe(false); expect(p.attachments).toHaveLength(0); expect(p.inReplyTo).toBe('<parent@example.com>');
  });
  it('re-resolves web UID changes using retained Message-ID and uses latest body', async () => {
    const f = await fixture(); const id = await f.workflow.adopt(locator(1), (await simpleParser(f.raw)).messageId);
    f.messages.delete(locator(1)); f.messages.set(locator(9), replaceHeaders(f.raw, { Subject: 'Web edited' }));
    await f.workflow.send(id);
    expect((await simpleParser(vi.mocked(f.port.send).mock.calls[0][1].rawMessage)).subject).toBe('Web edited');
  });
  it('stops for missing or ambiguous replacement and never guesses by subject', async () => {
    const f = await fixture(); const id = await f.workflow.adopt(locator(1), (await simpleParser(f.raw)).messageId);
    f.messages.delete(locator(1)); await expect(f.workflow.send(id)).rejects.toThrow('missing or ambiguous');
    f.messages.set(locator(8), f.raw); f.messages.set(locator(9), f.raw);
    await expect(f.workflow.send(id)).rejects.toThrow('missing or ambiguous'); expect(f.port.send).not.toHaveBeenCalled();
  });
  it('preserves original on append failure and detects concurrent edits after append', async () => {
    const f = await fixture(); vi.mocked(f.port.append).mockRejectedValueOnce(new Error('Append failed'));
    await expect(f.workflow.update(locator(1), { subject: 'change' })).rejects.toThrow('Append failed'); expect(f.messages.has(locator(1))).toBe(true);
    await expect(f.workflow.update(locator(1), { subject: 'change' })).rejects.toThrow('pending cleanup'); expect(f.port.trash).not.toHaveBeenCalled();

    const g = await fixture();
    const append = g.port.append;
    g.port.append = async raw => { const result = await append(raw); g.messages.set(locator(1), replaceHeaders(g.raw, { Subject: 'Concurrent edit' })); return result; };
    await expect(g.workflow.update(locator(1), { subject: 'change' })).rejects.toThrow('concurrently'); expect(g.port.trash).not.toHaveBeenCalled();
  });
  it.each(['smtp_rejected','smtp_outcome_unknown','partially_sent_provider_managed'] as const)('retains and deduplicates %s', async status => {
    const f = await fixture(); vi.mocked(f.port.send).mockResolvedValue({ status, smtpAccepted: status === 'smtp_outcome_unknown' ? null : status !== 'smtp_rejected', accepted: [], rejected: ['to@example.com'], sentFolderSaved: false, retrySafe: false, nextAction: 'Inspect' });
    const result = await f.workflow.send(locator(1)); expect(result.draftCleanup).toBe('retained');
    await f.workflow.send(locator(1)); expect(f.port.send).toHaveBeenCalledTimes(1); expect(f.port.trash).not.toHaveBeenCalled();
  });
  it('retains draft when archive is unconfirmed; cleanup failure cannot cause a resend', async () => {
    const f = await fixture(); vi.mocked(f.port.verify).mockResolvedValue(undefined);
    expect((await f.workflow.send(locator(1))).draftCleanup).toBe('retained'); expect(f.port.trash).not.toHaveBeenCalled();
    const g = await fixture(); vi.mocked(g.port.trash).mockRejectedValue(new Error('Denied'));
    expect((await g.workflow.send(locator(1))).draftCleanup).toBe('retained_cleanup_failed');
    await g.workflow.send(locator(1)); expect(g.port.send).toHaveBeenCalledTimes(1);
  });
  it('rejects concurrent operations and leaves an interrupted sending record non-retryable', async () => {
    const f = await fixture(); const id = await f.workflow.adopt(locator(1));
    await f.store.run(async (state, save) => {
      state.records[0].attempt = { status: 'sending' }; await save();
      await expect(f.workflow.send(id)).rejects.toThrow('busy');
    });
    expect((await f.workflow.send(id)).status).toBe('smtp_outcome_unknown'); expect(f.port.send).not.toHaveBeenCalled();
  });
  it('rejects non-draft locator and unsupported patch fields', async () => {
    const f = await fixture(); await expect(f.workflow.send(locator(1, 'INBOX'))).rejects.toThrow('not an account draft');
    await expect(f.workflow.update(locator(1), { from: 'other@example.com' })).rejects.toThrow('Unsupported');
    await expect(f.workflow.update(locator(1), {})).rejects.toThrow('non-empty object');
    await expect(f.workflow.update(locator(1), { attachments: [{ filename: 'bad', contentBase64: 3 }] })).rejects.toThrow('Invalid attachments');
  });
  it('replaces attachments while retaining both body alternatives', async () => {
    const f = await fixture(); const r = await f.workflow.update(locator(1), { attachments: [{ filename: 'new.txt', contentBase64: 'bmV3' }] });
    const p = await simpleParser(f.messages.get(r.locator as string)!);
    expect(p.attachments.map(a => a.filename)).toEqual(['new.txt']);
    expect(p.text).toContain('Plain body'); expect(p.html).toContain('HTML');
  });
  it('does not clean up when SMTP omits an envelope recipient', async () => {
    const f = await fixture(); const send = f.port.send;
    f.port.send = async (message, raw) => ({ ...await send(message, raw), accepted: ['to@example.com'] });
    expect((await f.workflow.send(locator(1))).draftCleanup).toBe('retained');
    expect(f.port.verify).not.toHaveBeenCalled(); expect(f.port.trash).not.toHaveBeenCalled();
  });
  it('allows a fresh explicit attempt after pre-delivery connection failure', async () => {
    const f = await fixture(); vi.mocked(f.port.send).mockResolvedValueOnce({ status: 'smtp_connection_failed', smtpAccepted: false, accepted: [], rejected: [], sentFolderSaved: false, retrySafe: true, nextAction: 'Fix connection' });
    expect((await f.workflow.send(locator(1))).retrySafe).toBe(true);
    expect((await f.workflow.send(locator(1))).draftCleanup).toBe('moved_to_trash');
    expect(f.port.send).toHaveBeenCalledTimes(2);
  });
  it('fails closed on malformed persisted state', async () => {
    const f = await fixture();
    await writeFile((f.store as unknown as { file: string }).file, JSON.stringify({ records: [{ draftId: 'broken' }] }));
    await expect(f.workflow.send(locator(1))).rejects.toThrow('Invalid draft state');
    expect(f.port.send).not.toHaveBeenCalled();
  });
  it('checks the allowlist against the latest web-edited recipients before SMTP', async () => {
    const f = await fixture();
    const id = await f.workflow.adopt(locator(1), (await simpleParser(f.raw)).messageId);
    f.messages.delete(locator(1)); f.messages.set(locator(9), replaceHeaders(f.raw, { To: 'blocked@example.com' }));
    const restricted = new DraftWorkflow({ ...account, allowedRecipients: ['@allowed.example'] }, f.port, new DraftStore(account.id, f.root));
    await expect(restricted.send(id)).rejects.toThrow('not in the allowed recipients list');
    expect(f.port.send).not.toHaveBeenCalled();
  });
  it('preserves custom metadata when rebuilding MIME body or attachments', async () => {
    const f = await fixture();
    f.messages.set(locator(1), replaceHeaders(f.raw, { Importance: 'high', 'List-Unsubscribe': '<mailto:unsubscribe@example.com>', 'X-Trace': 'keep-me' }));
    const result = await f.workflow.update(locator(1), { textBody: 'Rebuilt body' });
    const updated = await simpleParser(f.messages.get(result.locator as string)!);
    const updatedHeaders = f.messages.get(result.locator as string)!.subarray(0, f.messages.get(result.locator as string)!.indexOf('\r\n\r\n')).toString('latin1');
    expect(updatedHeaders).toContain('Importance: high');
    expect(updatedHeaders).toContain('List-Unsubscribe: <mailto:unsubscribe@example.com>');
    expect(updated.headers.get('x-trace')).toBe('keep-me');
    expect(updated.text).toContain('Rebuilt body');
  });
  it('rejects duplicate singleton routing headers before SMTP', async () => {
    const f = await fixture();
    const at = f.raw.indexOf('\r\n\r\n');
    const duplicate = Buffer.concat([f.raw.subarray(0, at), Buffer.from('\r\nFrom: evil@example.com', 'latin1'), f.raw.subarray(at)]);
    f.messages.set(locator(1), duplicate);
    await expect(f.workflow.send(locator(1))).rejects.toThrow('Duplicate from header');
    expect(f.port.send).not.toHaveBeenCalled();
  });
  it('retains a generated Message-ID when updating a draft that had none', async () => {
    const f = await fixture();
    f.messages.set(locator(1), replaceHeaders(f.raw, { 'Message-ID': undefined }));
    const updated = await f.workflow.update(locator(1), { subject: 'Generated ID' });
    const updatedRaw = f.messages.get(updated.locator as string)!;
    const generatedId = (await simpleParser(updatedRaw)).messageId;
    expect(generatedId).toMatch(/^<.+@example\.com>$/);
    f.messages.delete(updated.locator as string); f.messages.set(locator(9), updatedRaw);
    await f.workflow.send(updated.draftId as string);
    expect(f.port.send).toHaveBeenCalledTimes(1);
    expect((await simpleParser(vi.mocked(f.port.send).mock.calls[0][1].rawMessage)).subject).toBe('Generated ID');
  });
});
