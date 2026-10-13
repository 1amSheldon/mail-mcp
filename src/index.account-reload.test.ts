import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./config.js', () => ({ getAccounts: vi.fn(), getConfiguredAccounts: vi.fn(async () => []) }));
vi.mock('./services/mail.js', () => ({ MailService: vi.fn().mockImplementation(function () {
  return { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), imap: { onClose: null } };
}) }));
import { getAccounts } from './config.js';
import { MailService } from './services/mail.js';
import { MailMCPServer } from './index.js';
const account = { id: 'fixture', name: 'fixture', user: 'fixture@example.test', host: 'localhost', port: 993, authType: 'login' as const, useTLS: true };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getAccounts).mockResolvedValue([{ ...account }]); });

it('disconnects and rejects a cached account after removal', async () => {
  const server = new MailMCPServer(true);
  const cached = await (server as any).getService(account.id);
  vi.mocked(getAccounts).mockResolvedValue([]);
  await expect((server as any).getService(account.id)).rejects.toThrow('not found');
  expect(cached.disconnect).toHaveBeenCalledOnce();
  await server.shutdown();
});

it('recreates a cached service using tightened account policies', async () => {
  const server = new MailMCPServer(false);
  const first = await (server as any).getService(account.id);
  const tightened = { ...account, allowedAttachmentRoots: [], allowedRecipients: ['trusted@example.test'] };
  vi.mocked(getAccounts).mockResolvedValue([tightened]);
  const next = await (server as any).getService(account.id);
  expect(first.disconnect).toHaveBeenCalledOnce();
  expect(next).not.toBe(first);
  expect(MailService).toHaveBeenLastCalledWith(tightened, false);
  await server.shutdown();
});

it('never caches a connection whose account was removed while connecting', async () => {
  const server = new MailMCPServer(false);
  vi.mocked(getAccounts).mockResolvedValueOnce([account]).mockResolvedValue([]);
  await expect((server as any)._createAndCacheService(account.id)).rejects.toThrow('configuration changed');
  expect((server as any).services.size).toBe(0);
  await server.shutdown();
});
