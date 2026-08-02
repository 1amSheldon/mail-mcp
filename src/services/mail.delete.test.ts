import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockImapConnect = vi.fn().mockResolvedValue(undefined);
const mockDeleteMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('../protocol/imap.js', () => {
  return {
    ImapClient: vi.fn(function () {
      return {
        connect: mockImapConnect,
        deleteMessage: mockDeleteMessage,
        onClose: null,
      };
    }),
  };
});

vi.mock('../protocol/smtp.js', () => {
  return {
    SmtpClient: vi.fn(function () {
      return { connect: vi.fn().mockResolvedValue(undefined) };
    }),
  };
});

import { MailService } from './mail.js';

const account = {
  id: 'test',
  name: 'Test',
  user: 'test@example.com',
  imap: {} as any,
  smtp: {} as any,
};

describe('MailService.deleteEmail', () => {
  let service: MailService;

  beforeEach(async () => {
    mockImapConnect.mockClear();
    mockDeleteMessage.mockClear();
    service = new MailService(account, false);
    await service.connect();
  });

  it('calls imap.deleteMessage with the provided uid and folder', async () => {
    await service.deleteEmail('42', 'INBOX');
    expect(mockDeleteMessage).toHaveBeenCalledWith('42', 'INBOX');
  });

  it('defaults folder to INBOX when not provided', async () => {
    await service.deleteEmail('99');
    expect(mockDeleteMessage).toHaveBeenCalledWith('99', 'INBOX');
  });

  it('invalidates the body cache after deletion', async () => {
    // Pre-populate the cache by spying on invalidateBodyCache
    const invalidateSpy = vi.spyOn(service, 'invalidateBodyCache');
    await service.deleteEmail('55', 'Trash');
    expect(invalidateSpy).toHaveBeenCalledWith('Trash', '55');
  });
});
