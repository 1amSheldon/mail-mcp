import { expect, it, vi } from 'vitest';
import { MailService } from './mail.js';
const account = { id: 'fixture', name: 'fixture', user: 'fixture@example.test', host: 'localhost', port: 993, authType: 'login' as const, useTLS: true };

it('reports a definite preflight failure without any SMTP transaction', async () => {
  const service = new MailService(account);
  const sendMail = vi.fn();
  const smtp = (service as any).smtpClient;
  vi.spyOn(smtp, 'connect').mockResolvedValue(undefined);
  smtp.transporter = { sendMail };
  expect(await service.sendMessage({ to: 'to@example.test', subject: 'Missing body' })).toMatchObject({
    status: 'smtp_preflight_failed', smtpAccepted: false, retrySafe: true,
  });
  expect(sendMail).not.toHaveBeenCalled();
});

it('retains unknown-outcome protection for a failure after entering SMTP send', async () => {
  const service = new MailService(account);
  const smtp = (service as any).smtpClient;
  vi.spyOn(smtp, 'connect').mockResolvedValue(undefined);
  smtp.transporter = { sendMail: vi.fn(async () => { throw new Error('Connection lost after DATA'); }) };
  expect(await service.sendMessage({ to: 'to@example.test', subject: 'fixture', text: 'body' })).toMatchObject({
    status: 'smtp_outcome_unknown', smtpAccepted: null, retrySafe: false,
  });
});
