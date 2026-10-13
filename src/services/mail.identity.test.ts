import { describe, expect, it, vi } from 'vitest';
import { MailService } from './mail.js';
import { encodeMessageLocator } from '../domain/message-locator.js';

const account = { id: 'fixture', name: 'fixture', user: 'fixture@example.test', host: 'localhost', port: 993, authType: 'login' as const, useTLS: true };
const locator = encodeMessageLocator({ accountId: account.id, mailbox: 'INBOX', uidValidity: '1', uid: 7 });
const operations: Array<[string, (service: MailService) => Promise<unknown>]> = [
  ['move', service => service.moveLocatedEmail(locator, 'Archive')],
  ['trash', service => service.deleteLocatedEmail(locator)],
  ['permanent delete', service => service.permanentlyDeleteLocatedEmail(locator)],
  ['copy', service => service.copyEmail(locator, 'Archive')],
  ['labels', service => service.modifyLocatedLabels(locator, ['\\Seen'], [])],
  ['raw', service => service.readRawEmail(locator)],
  ['attachment', service => service.downloadLocatedAttachment(locator, 'fixture.txt')],
  ...(['move','delete','copy','label'] as const).map(type => [
    `batch ${type}`, async (service: MailService) => {
      const result = await service.batchLocatedOperations([locator], { type, targetFolder: 'Archive', addLabels: ['\\Seen'] });
      if (result.failed) throw new Error(result.items[0].error);
      return result;
    },
  ] as [string, (service: MailService) => Promise<unknown>]),
];

describe('locator generation at the IMAP operation boundary', () => {
  it.each(operations)('refuses %s when the selected generation changed after STATUS', async (_name, run) => {
    const service = new MailService(account);
    const release = vi.fn();
    const command = vi.fn();
    (service.imap as any).client = {
      mailbox: { uidValidity: 2n }, getMailboxLock: async () => ({ release }),
      messageMove: command, messageCopy: command, messageDelete: command,
      messageFlagsAdd: command, messageFlagsRemove: command, fetchOne: command,
    };
    vi.spyOn(service.imap, 'getMailboxIdentity').mockResolvedValue({ path: 'INBOX', uidValidity: '1' });
    vi.spyOn(service as any, 'resolveTrashFolder').mockResolvedValue('Trash');
    await expect(run(service)).rejects.toThrow('identity changed');
    expect(command).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('allows the requested UID when the locked generation still matches', async () => {
    const service = new MailService(account);
    const messageDelete = vi.fn();
    (service.imap as any).client = { mailbox: { uidValidity: 1n },
      getMailboxLock: async () => ({ release() {} }), messageDelete };
    vi.spyOn(service.imap, 'getMailboxIdentity').mockResolvedValue({ path: 'INBOX', uidValidity: '1' });
    await service.permanentlyDeleteLocatedEmail(locator);
    expect(messageDelete).toHaveBeenCalledWith('7', { uid: true });
  });
});
