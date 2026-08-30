import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SmtpClient, SmtpRecipientRejectedError } from './smtp.js';
import type { EmailAccount } from '../config.js';

const mocks = vi.hoisted(() => ({
  compose: vi.fn(),
  send: vi.fn(),
  verify: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../security/keychain.js', () => ({
  loadCredentials: vi.fn(() => Promise.resolve('test-password')),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn((options: Record<string, unknown>) => {
      if (options.streamTransport) {
        return { sendMail: mocks.compose };
      }
      return {
        verify: mocks.verify,
        sendMail: mocks.send,
        close: mocks.close,
      };
    }),
  },
}));

describe('SmtpClient', () => {
  const account: EmailAccount = {
    id: 'test-account',
    name: 'Test',
    host: 'imap.test.com',
    port: 993,
    smtpHost: 'smtp.test.com',
    smtpPort: 587,
    user: 'test@test.com',
    authType: 'login',
    useTLS: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockResolvedValue(true);
    mocks.compose.mockResolvedValue({
      envelope: { from: 'test@test.com', to: ['recipient@example.com'] },
      messageId: '<test@example.com>',
      message: Buffer.from('Message-ID: <test@example.com>\r\n\r\nBody'),
    });
    mocks.send.mockResolvedValue({
      accepted: ['recipient@example.com'],
      rejected: [],
      response: '250 queued',
    });
  });

  it('single-flights concurrent connect calls', async () => {
    let release!: () => void;
    mocks.verify.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const client = new SmtpClient(account);

    const first = client.connect();
    const second = client.connect();
    await Promise.resolve();
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
  });

  it('sends the exact MIME buffer produced for the Sent append', async () => {
    const client = new SmtpClient(account);
    await client.connect();
    const result = await client.send('recipient@example.com', 'Subject', 'Body');

    expect(mocks.compose).toHaveBeenCalledWith(expect.objectContaining({
      to: 'recipient@example.com',
      subject: 'Subject',
      text: 'Body',
    }));
    expect(mocks.send).toHaveBeenCalledWith({
      raw: result.rawMessage,
      envelope: { from: 'test@test.com', to: ['recipient@example.com'] },
    });
    expect(result.messageId).toBe('<test@example.com>');
    expect(result.accepted).toEqual(['recipient@example.com']);
  });

  it('passes cc, bcc, html, and threading headers to the MIME composer', async () => {
    const client = new SmtpClient(account);
    await client.connect();
    const headers = { 'In-Reply-To': '<original@example.com>' };
    await client.send(
      'to@example.com',
      'Subject',
      '<b>Body</b>',
      true,
      'cc@example.com',
      'bcc@example.com',
      headers
    );
    expect(mocks.compose).toHaveBeenCalledWith(expect.objectContaining({
      html: '<b>Body</b>',
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
      headers,
    }));
  });

  it('returns partial SMTP acceptance without hiding rejected recipients', async () => {
    mocks.send.mockResolvedValueOnce({
      accepted: ['ok@example.com'],
      rejected: ['bad@example.com'],
    });
    const client = new SmtpClient(account);
    await client.connect();
    const result = await client.send('ok@example.com,bad@example.com', 'Subject', 'Body');
    expect(result.accepted).toEqual(['ok@example.com']);
    expect(result.rejected).toEqual(['bad@example.com']);
  });

  it('reports an all-recipient RCPT rejection as a definitive result', async () => {
    mocks.send.mockRejectedValueOnce(Object.assign(
      new Error("Can't send mail - all recipients were rejected"),
      {
        code: 'EENVELOPE',
        command: 'RCPT TO',
        rejected: ['bad@example.com'],
      }
    ));
    const client = new SmtpClient(account);
    await client.connect();

    const rejection = client.send('bad@example.com', 'Subject', 'Body');
    await expect(rejection).rejects.toBeInstanceOf(SmtpRecipientRejectedError);
    await expect(rejection)
      .rejects.toMatchObject({
        name: 'SmtpRecipientRejectedError',
        messageId: '<test@example.com>',
        rejected: ['bad@example.com'],
      });

    await client.connect();
    await expect(client.send('recipient@example.com', 'Subject', 'Body'))
      .resolves.toMatchObject({ accepted: ['recipient@example.com'] });
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
  });

  it('marks send failures as outcome-unknown and resets the transport without retrying', async () => {
    mocks.send.mockRejectedValueOnce(new Error('connection closed after DATA'));
    const client = new SmtpClient(account);
    await client.connect();

    await expect(client.send('recipient@example.com', 'Subject', 'Body'))
      .rejects.toMatchObject({
        name: 'SmtpSendError',
        messageId: '<test@example.com>',
      });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);

    await client.connect();
    expect(mocks.verify).toHaveBeenCalledTimes(2);
  });
});
