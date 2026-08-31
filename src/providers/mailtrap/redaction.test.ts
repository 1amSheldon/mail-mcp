import { describe, expect, it } from 'vitest';
import { MAILTRAP_REDACTED, redactMailtrapSecrets } from './redaction.js';

describe('redactMailtrapSecrets', () => {
  it('redacts webhook secrets and token-like fields recursively without mutating input', () => {
    const input = {
      id: 7,
      signing_secret: 'whsec-secret',
      credentials: {
        api_token: 'api-secret',
        access_token: 'access-secret',
        smtp_password: 'smtp-secret',
      },
      pagination: { next_page_token: 'cursor-value' },
      events: [{ token: 'event-secret', type: 'delivery' }],
    };

    expect(redactMailtrapSecrets(input)).toEqual({
      id: 7,
      signing_secret: MAILTRAP_REDACTED,
      credentials: {
        api_token: MAILTRAP_REDACTED,
        access_token: MAILTRAP_REDACTED,
        smtp_password: MAILTRAP_REDACTED,
      },
      pagination: { next_page_token: 'cursor-value' },
      events: [{ token: MAILTRAP_REDACTED, type: 'delivery' }],
    });
    expect(input.signing_secret).toBe('whsec-secret');
  });
});
