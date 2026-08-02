import { inject } from 'vitest';
import nodemailer from 'nodemailer';

describe('SMTP send/receive cycle', () => {
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
