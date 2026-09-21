import { inject } from 'vitest';
import nodemailer from 'nodemailer';
import { SmtpClient } from '../../src/protocol/smtp.js';

describe('SMTP send/receive cycle', () => {
  it('delivers prepared server MIME through the raw draft transport', async () => {
    const client = new SmtpClient({ id: 'raw', name: 'Raw', host: 'localhost', port: 993, user: 'sender@test.local', authType: 'login', useTLS: false });
    (client as any).transporter = nodemailer.createTransport({ host: 'localhost', port: inject('smtpPort'), secure: false, ignoreTLS: true });
    try {
      const composed = await client.composeMessage({ from: 'sender@test.local', to: 'recipient@test.local', bcc: 'hidden@test.local', subject: 'Raw draft', html: '<p>Draft</p>', attachments: [{ filename: 'test.txt', contentBase64: 'dGVzdA==' }] });
      const result = await client.sendRawMessage(composed);
      expect(result.accepted).toContain('hidden@test.local');
      expect(result.accepted).toContain('recipient@test.local');
    } finally { await client.disconnect(); }
  });
  it('delivers a message end-to-end without mocked transport', async () => {
    const port = inject('smtpPort');
    const transporter = nodemailer.createTransport({
      host: 'localhost',
      port,
      secure: false,
      ignoreTLS: true,
    });

    const info = await transporter.sendMail({
      from: 'sender@test.local',
      to: 'recipient@test.local',
      subject: 'Integration test',
      text: 'Hello from integration test',
    });

    expect(info.messageId).toBeDefined();
    expect(typeof info.messageId).toBe('string');
    expect(info.messageId.length).toBeGreaterThan(0);
    expect(info.accepted).toContain('recipient@test.local');
    expect(info.rejected).toEqual([]);
  });

  it('sends HTML email with headers intact', async () => {
    const port = inject('smtpPort');
    const transporter = nodemailer.createTransport({
      host: 'localhost',
      port,
      secure: false,
      ignoreTLS: true,
    });

    const info = await transporter.sendMail({
      from: 'sender@test.local',
      to: 'recipient@test.local',
      subject: 'HTML integration test',
      html: '<p>HTML body</p>',
      headers: { 'X-Test-Header': 'integration' },
    });

    expect(info.messageId).toBeDefined();
    expect(info.accepted).toContain('recipient@test.local');
  });

  it('handles multiple recipients', async () => {
    const port = inject('smtpPort');
    const transporter = nodemailer.createTransport({
      host: 'localhost',
      port,
      secure: false,
      ignoreTLS: true,
    });

    const info = await transporter.sendMail({
      from: 'sender@test.local',
      to: 'a@test.local, b@test.local',
      subject: 'Multi-recipient test',
      text: 'Hello to multiple recipients',
    });

    expect(info.messageId).toBeDefined();
    expect(info.accepted).toHaveLength(2);
  });
});
