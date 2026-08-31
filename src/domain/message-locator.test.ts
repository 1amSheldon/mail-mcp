import { describe, expect, it } from 'vitest';
import { decodeMessageLocator, encodeMessageLocator, isMessageLocator } from './message-locator.js';

describe('message locator', () => {
  it('round-trips Unicode mailbox names and normalizes UIDVALIDITY', () => {
    const encoded = encodeMessageLocator({
      accountId: 'work',
      mailbox: '\u041f\u0440\u043e\u0435\u043a\u0442\u044b/2026',
      uidValidity: 42n,
      uid: 987,
    });

    expect(encoded).toMatch(/^imap:v1:[A-Za-z0-9_-]+$/);
    expect(decodeMessageLocator(encoded)).toEqual({
      accountId: 'work',
      mailbox: '\u041f\u0440\u043e\u0435\u043a\u0442\u044b/2026',
      uidValidity: '42',
      uid: 987,
    });
  });

  it('is deterministic for the same mailbox identity', () => {
    const locator = { accountId: 'a', mailbox: 'INBOX', uidValidity: '123', uid: 7 };
    expect(encodeMessageLocator(locator)).toBe(encodeMessageLocator(locator));
  });

  it.each([
    '7',
    'imap:v1:',
    'imap:v1:***',
    `imap:v1:${Buffer.from('{"a":"a","m":"INBOX","v":"0","u":1}').toString('base64url')}`,
    `imap:v1:${Buffer.from('{"a":"a","m":"INBOX","v":"1","u":0}').toString('base64url')}`,
  ])('rejects malformed or unsafe locator %s', value => {
    expect(() => decodeMessageLocator(value)).toThrow('Invalid message locator');
    expect(isMessageLocator(value)).toBe(false);
  });

  it('rejects control characters in account and mailbox identity', () => {
    expect(() => encodeMessageLocator({ accountId: 'bad\naccount', mailbox: 'INBOX', uidValidity: 1n, uid: 1 }))
      .toThrow('accountId');
    expect(() => encodeMessageLocator({ accountId: 'a', mailbox: 'bad\0mailbox', uidValidity: 1n, uid: 1 }))
      .toThrow('mailbox');
  });
});
