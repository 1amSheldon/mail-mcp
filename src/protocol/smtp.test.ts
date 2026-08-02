import { describe, it, expect, vi } from 'vitest';
import { SmtpClient } from './smtp.js';
import { EmailAccount } from '../types/index.js';

vi.mock('../security/keychain.js', () => ({
  loadCredentials: vi.fn(() => Promise.resolve('test-password'))
}));

const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<test@example.com>' });
const mockVerify = vi.fn().mockResolvedValue(true);

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      verify: mockVerify,
      sendMail: mockSendMail,
    })),
  },
}));

describe('SmtpClient', () => {
  const account: EmailAccount = {
    id: 'test-account',
    name: 'Test',
    host: 'smtp.test.com',
    port: 993,
    smtpHost: 'smtp.test.com',
    smtpPort: 587,
    user: 'test@test.com',
    authType: 'login',
    useTLS: true,
  };

  it('should connect to the SMTP server', async () => {
    const client = new SmtpClient(account);
    await client.connect();
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });

  it('should send email without CC/BCC', async () => {
    const client = new SmtpClient(account);
    await client.connect();
    mockSendMail.mockClear();
    await client.send('recipient@example.com', 'Test Subject', 'Test body');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.to).toBe('recipient@example.com');
    expect(callArgs.subject).toBe('Test Subject');
    expect(callArgs.cc).toBeUndefined();
    expect(callArgs.bcc).toBeUndefined();
  });

  it('should include CC in mail options when provided', async () => {
    const client = new SmtpClient(account);
    await client.connect();
    mockSendMail.mockClear();
    await client.send('to@example.com', 'Subject', 'Body', false, 'cc@example.com');
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.cc).toBe('cc@example.com');
    expect(callArgs.bcc).toBeUndefined();
  });

  it('should include BCC in mail options when provided', async () => {
    const client = new SmtpClient(account);
    await client.connect();
    mockSendMail.mockClear();
    await client.send('to@example.com', 'Subject', 'Body', false, undefined, 'bcc@example.com');
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.bcc).toBe('bcc@example.com');
    expect(callArgs.cc).toBeUndefined();
  });

  it('should include both CC and BCC when both provided', async () => {
    const client = new SmtpClient(account);
    await client.connect();
    mockSendMail.mockClear();
    await client.send('to@example.com', 'Subject', 'Body', false, 'cc@example.com', 'bcc@example.com');
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.cc).toBe('cc@example.com');
    expect(callArgs.bcc).toBe('bcc@example.com');
  });

  it('should send HTML body when isHtml=true', async () => {
    const client = new SmtpClient(account);
    await client.connect();
    mockSendMail.mockClear();
    await client.send('to@example.com', 'Subject', '<b>HTML body</b>', true);
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.html).toBe('<b>HTML body</b>');
    expect(callArgs.text).toBeUndefined();
  });

  it('passes extraHeaders to sendMail when provided', async () => {
    const client = new SmtpClient(account);
    await client.connect();
    mockSendMail.mockClear();
    const extraHeaders = {
      'In-Reply-To': '<original-msg-id@example.com>',
      'References': '<original-msg-id@example.com>',
    };
    await client.send('to@example.com', 'Subject', 'Body', false, undefined, undefined, extraHeaders);
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.headers).toEqual(extraHeaders);
  });

  it('does not set headers field when extraHeaders is not provided', async () => {
    const client = new SmtpClient(account);
    await client.connect();
    mockSendMail.mockClear();
    await client.send('to@example.com', 'Subject', 'Body');
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.headers).toBeUndefined();
  });

  it('does not set headers field when extraHeaders is empty object', async () => {
    const client = new SmtpClient(account);
    await client.connect();
    mockSendMail.mockClear();
    await client.send('to@example.com', 'Subject', 'Body', false, undefined, undefined, {});
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.headers).toBeUndefined();
  });
});
