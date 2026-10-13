import { describe, expect, it } from 'vitest';
import { ZIMBRA_READ_SCHEMAS, ZIMBRA_WRITE_SCHEMAS } from './operations.js';

const mailboxId = '01234567-89ab-cdef-0123-456789abcdef';

describe('Zimbra native conversation IDs', () => {
  it.each(['1', '12345', '-1', '-12345', `${mailboxId}:12345`, `${mailboxId}:-12345`])(
    'preserves conversation ID %s for GetConv', value => {
      expect(ZIMBRA_READ_SCHEMAS.getThread.parse({ conversationId: value })).toEqual({ conversationId: value });
    },
  );

  it.each([
    '', '0', '-0', '+1', '--1', '-01', '01', ' 1', '1 ', '1.5',
    '12345678901234567', `${mailboxId}:0`, `${mailboxId}:-0`,
    `${mailboxId}:--1`, `${mailboxId}:1:2`, `${'-'.repeat(36)}:-1`,
    'not-a-mailbox:-1',
  ])('rejects malformed or zero conversation ID %s', value => {
    expect(ZIMBRA_READ_SCHEMAS.getThread.safeParse({ conversationId: value }).success).toBe(false);
  });

  it.each(['-12345', `${mailboxId}:-12345`])('keeps negative IDs out of message and mutation inputs: %s', value => {
    expect(ZIMBRA_READ_SCHEMAS.readMessage.safeParse({ messageId: value }).success).toBe(false);
    expect(ZIMBRA_READ_SCHEMAS.getAttachment.safeParse({ messageId: value, partId: '1' }).success).toBe(false);
    expect(ZIMBRA_WRITE_SCHEMAS.sendDraft.safeParse({ draftId: value }).success).toBe(false);
    expect(ZIMBRA_WRITE_SCHEMAS.markRead.safeParse({ messageIds: [value], read: true }).success).toBe(false);
    expect(ZIMBRA_WRITE_SCHEMAS.createDraft.safeParse({
      to: ['recipient@example.test'], subject: 'Reply', body: 'Text', originalMessageId: value,
    }).success).toBe(false);
  });
});
