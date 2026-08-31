import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_BACKEND_CAPABILITIES,
  configuredAccountSchema,
  getAccountCapabilities,
  isAppleMailAccount,
  isEwsAccount,
  isImapSmtpAccount,
  isMailtrapAccount,
  isMicrosoftGraphAccount,
} from './account-types.js';

const LEGACY_ACCOUNT = {
  id: 'legacy',
  name: 'Legacy IMAP',
  host: 'imap.example.com',
  port: 993,
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  user: 'user@example.com',
  authType: 'login',
  useTLS: true,
};

describe('configuredAccountSchema', () => {
  it.each([
    LEGACY_ACCOUNT,
    { ...LEGACY_ACCOUNT, id: 'explicit-imap', backend: 'imap-smtp' },
    {
      id: 'apple',
      name: 'Apple Mail',
      backend: 'apple-mail',
      nativeAccountName: 'iCloud',
      nativeAccountUuid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      allowedAttachmentRoots: ['C:\\mail-attachments'],
    },
    {
      id: 'graph',
      name: 'Microsoft Graph',
      backend: 'microsoft-graph',
      user: 'user@example.com',
      endpoint: 'https://graph.microsoft.com/v1.0/',
    },
    {
      id: 'ews',
      name: 'Exchange',
      backend: 'ews',
      user: 'user@example.com',
      endpoint: 'https://mail.example.com/EWS/Exchange.asmx',
    },
    {
      id: 'mailtrap',
      name: 'Mailtrap',
      backend: 'mailtrap',
      accountId: '12345678901234567890',
      sandboxId: 'sandbox-1',
    },
  ])('accepts a configured account without provider credentials', (account) => {
    expect(configuredAccountSchema.safeParse(account).success).toBe(true);
  });

  it('does not require IMAP fields for provider-only accounts', () => {
    const result = configuredAccountSchema.safeParse({
      id: 'apple',
      name: 'Apple Mail',
      backend: 'apple-mail',
    });

    expect(result.success).toBe(true);
  });

  it.each(['password', 'accessToken', 'refreshToken', 'clientSecret', 'apiKey']) (
    'rejects secret field %s',
    (secretField) => {
      const result = configuredAccountSchema.safeParse({
        id: 'graph',
        name: 'Microsoft Graph',
        backend: 'microsoft-graph',
        user: 'user@example.com',
        [secretField]: 'must-not-be-in-json',
      });

      expect(result.success).toBe(false);
    },
  );

  it('requires HTTPS endpoints and rejects embedded URL credentials', () => {
    const base = {
      id: 'ews',
      name: 'Exchange',
      backend: 'ews',
      user: 'user@example.com',
    };

    expect(configuredAccountSchema.safeParse({
      ...base,
      endpoint: 'http://mail.example.com/EWS/Exchange.asmx',
    }).success).toBe(false);
    expect(configuredAccountSchema.safeParse({
      ...base,
      endpoint: 'https://user:secret@mail.example.com/EWS/Exchange.asmx',
    }).success).toBe(false);
  });

  it('accepts optional standard IMAP/SMTP policy fields', () => {
    const result = configuredAccountSchema.safeParse({
      ...LEGACY_ACCOUNT,
      smtpSecurity: 'starttls',
      sentPolicy: 'always',
      fromAliases: ['alias@example.com'],
      allowedAttachmentRoots: ['C:\\mail-attachments'],
    });

    expect(result.success).toBe(true);
  });
});

describe('account type guards and capabilities', () => {
  const accounts = [
    configuredAccountSchema.parse(LEGACY_ACCOUNT),
    configuredAccountSchema.parse({ id: 'apple', name: 'Apple', backend: 'apple-mail' }),
    configuredAccountSchema.parse({
      id: 'graph',
      name: 'Graph',
      backend: 'microsoft-graph',
      user: 'user@example.com',
    }),
    configuredAccountSchema.parse({
      id: 'ews',
      name: 'EWS',
      backend: 'ews',
      user: 'user@example.com',
      endpoint: 'https://mail.example.com/EWS/Exchange.asmx',
    }),
    configuredAccountSchema.parse({ id: 'mailtrap', name: 'Mailtrap', backend: 'mailtrap' }),
  ];

  it('narrows every supported backend', () => {
    expect(isImapSmtpAccount(accounts[0])).toBe(true);
    expect(isAppleMailAccount(accounts[1])).toBe(true);
    expect(isMicrosoftGraphAccount(accounts[2])).toBe(true);
    expect(isEwsAccount(accounts[3])).toBe(true);
    expect(isMailtrapAccount(accounts[4])).toBe(true);
  });

  it('maps legacy IMAP accounts to the explicit imap-smtp capability descriptor', () => {
    expect(getAccountCapabilities(accounts[0])).toBe(ACCOUNT_BACKEND_CAPABILITIES['imap-smtp']);
    expect(getAccountCapabilities(accounts[1]).credentialSource).toBe('native');
    expect(getAccountCapabilities(accounts[2]).providerApi).toBe(true);
  });
});
