import { beforeEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
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

  it('requires STARTTLS by default on submission ports', async () => {
    const client = new SmtpClient(account);
    await client.connect();

    expect(vi.mocked(nodemailer.createTransport)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: 'smtp.test.com',
        port: 587,
        secure: false,
        requireTLS: true,
        ignoreTLS: false,
        tls: { rejectUnauthorized: true },
      })
    );
  });

  it('uses implicit TLS on port 465', async () => {
    const client = new SmtpClient({ ...account, smtpPort: 465 });
    await client.connect();

    expect(vi.mocked(nodemailer.createTransport)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        port: 465,
        secure: true,
        requireTLS: false,
        ignoreTLS: false,
        tls: { rejectUnauthorized: true },
      })
    );
  });

  it('uses the account SMTP security policy when no constructor override is provided', async () => {
    const client = new SmtpClient({
      ...account,
      smtpPort: 587,
      smtpSecurity: 'tls',
    });
    await client.connect();

    expect(vi.mocked(nodemailer.createTransport)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        port: 587,
        secure: true,
        requireTLS: false,
        ignoreTLS: false,
        tls: { rejectUnauthorized: true },
      })
    );
  });

  it('gives an explicit constructor security policy precedence over account configuration', async () => {
    const client = new SmtpClient(
      {
        ...account,
        smtpPort: 465,
        smtpSecurity: 'tls',
      },
      { securityMode: 'starttls' },
    );
    await client.connect();

    expect(vi.mocked(nodemailer.createTransport)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        port: 465,
        secure: false,
        requireTLS: true,
        ignoreTLS: false,
        tls: { rejectUnauthorized: true },
      })
    );
  });

  it('rejects plain SMTP for non-loopback hosts', async () => {
    const client = new SmtpClient(account, { securityMode: 'plain' });
    await expect(client.connect()).rejects.toThrow('Plain SMTP is allowed only for localhost');
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('allows explicitly requested plain SMTP on localhost only', async () => {
    const client = new SmtpClient(
      { ...account, smtpHost: 'localhost', smtpPort: 2525 },
      { securityMode: 'plain' }
    );
    await client.connect();

    expect(vi.mocked(nodemailer.createTransport)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: 'localhost',
        secure: false,
        requireTLS: false,
        ignoreTLS: true,
      })
    );
  });

  it('enforces a plain account policy through the loopback guard', async () => {
    const client = new SmtpClient({
      ...account,
      smtpHost: 'smtp.test.com',
      smtpPort: 2525,
      smtpSecurity: 'plain',
    });

    await expect(client.connect()).rejects.toThrow('Plain SMTP is allowed only for localhost');
    expect(mocks.verify).not.toHaveBeenCalled();
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

  it('keeps the authenticated sender as envelope from when the header from is overridden', async () => {
    mocks.compose.mockResolvedValueOnce({
      envelope: { from: 'alias@example.com', to: ['recipient@example.com'] },
      messageId: '<alias@example.com>',
      message: Buffer.from('From: Alias <alias@example.com>\r\n\r\nBody'),
    });
    const client = new SmtpClient(account);
    await client.connect();
    await client.sendMessage({
      to: 'recipient@example.com',
      subject: 'Subject',
      text: 'Body',
      from: 'Alias <alias@example.com>',
      replyTo: 'support@example.com',
    });

    expect(mocks.compose).toHaveBeenCalledWith(expect.objectContaining({
      from: 'Alias <alias@example.com>',
      replyTo: 'support@example.com',
    }));
    expect(mocks.send).toHaveBeenCalledWith({
      raw: expect.any(Buffer),
      envelope: {
        from: 'test@test.com',
        to: ['recipient@example.com'],
      },
    });
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
