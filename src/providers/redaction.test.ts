import { describe, expect, it } from 'vitest';
import { redactProviderResult } from './redaction.js';

describe('redactProviderResult', () => {
  it('redacts sensitive content and secret-shaped fields without mutating provider data', () => {
    const input = {
      subject: 'password: hunter2',
      nested: { access_token: 'provider-token', note: 'Card 4111 1111 1111 1111' },
      bytes: new Uint8Array([1, 2, 3]),
    };

    const redacted = redactProviderResult(input);

    expect(redacted).toEqual({
      subject: 'password: [REDACTED]',
      nested: { access_token: '[REDACTED]', note: 'Card [REDACTED CC]' },
      bytes: input.bytes,
    });
    expect(input.subject).toBe('password: hunter2');
    expect(input.nested.access_token).toBe('provider-token');
  });
});
