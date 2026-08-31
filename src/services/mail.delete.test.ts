import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockImapConnect = vi.fn().mockResolvedValue(undefined);
const mockDeleteMessage = vi.fn().mockResolvedValue(undefined);
const mockMoveMessage = vi.fn().mockResolvedValue(undefined);
const mockFindSpecialUseFolder = vi.fn().mockResolvedValue('Deleted Items');
const mockListFolders = vi.fn().mockResolvedValue(['INBOX', 'Deleted Items']);

vi.mock('../protocol/imap.js', () => {
  return {
    ImapClient: vi.fn(function () {
      return {
        connect: mockImapConnect,
        deleteMessage: mockDeleteMessage,
        moveMessage: mockMoveMessage,
        findSpecialUseFolder: mockFindSpecialUseFolder,
        listFolders: mockListFolders,
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
    mockMoveMessage.mockClear();
    mockFindSpecialUseFolder.mockClear().mockResolvedValue('Deleted Items');
    service = new MailService(account, false);
    await service.connect();
  });

  it('moves the message to the special-use Trash folder instead of deleting it', async () => {
    await service.deleteEmail('42', 'INBOX');
    expect(mockMoveMessage).toHaveBeenCalledWith('42', 'INBOX', 'Deleted Items');
    expect(mockDeleteMessage).not.toHaveBeenCalled();
  });

  it('defaults the source folder to INBOX', async () => {
    await service.deleteEmail('99');
    expect(mockMoveMessage).toHaveBeenCalledWith('99', 'INBOX', 'Deleted Items');
  });

  it('invalidates the source body cache after moving to Trash', async () => {
    const invalidateSpy = vi.spyOn(service, 'invalidateBodyCache');
    await service.deleteEmail('55', 'INBOX');
    expect(invalidateSpy).toHaveBeenCalledWith('INBOX', '55');
  });

  it('requires the explicit permanent method for irreversible deletion', async () => {
    await service.permanentlyDeleteEmail('55', 'Deleted Items');
    expect(mockDeleteMessage).toHaveBeenCalledWith('55', 'Deleted Items');
    expect(mockMoveMessage).not.toHaveBeenCalled();
  });

  it('refuses to soft-delete a message that is already in Trash', async () => {
    await expect(service.deleteEmail('55', 'Deleted Items')).rejects.toThrow(
      'Use permanentlyDeleteEmail'
    );
    expect(mockDeleteMessage).not.toHaveBeenCalled();
    expect(mockMoveMessage).not.toHaveBeenCalled();
  });
});
