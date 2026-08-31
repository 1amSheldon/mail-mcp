import { z } from 'zod';

const portSchema = z.number().int().min(1).max(65535);
const nonEmptyString = z.string().min(1);

const secretFieldPattern = /(?:password|passphrase|secret|token|credential|api[_-]?key|authorization)$/i;

const secretFreeObjectSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  for (const key of Object.keys(value)) {
    if (secretFieldPattern.test(key)) {
      context.addIssue({
        code: 'custom',
        path: [key],
        message: 'Credentials and secrets must be stored in the system keychain',
      });
    }
  }
});

const httpsEndpointSchema = nonEmptyString.refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}, 'Endpoint must be an HTTPS URL without embedded credentials');

const commonAccountFields = {
  id: nonEmptyString,
  name: nonEmptyString,
};

const imapSmtpFields = {
  ...commonAccountFields,
  host: nonEmptyString,
  port: portSchema,
  smtpHost: nonEmptyString.optional(),
  smtpPort: portSchema.optional(),
  user: nonEmptyString,
  authType: z.enum(['login', 'oauth2']),
  useTLS: z.boolean(),
  smtpSecurity: z.enum(['tls', 'starttls', 'plain']).optional(),
  sentPolicy: z.enum(['auto', 'always', 'never']).optional(),
  fromAliases: z.array(nonEmptyString).optional(),
  allowedAttachmentRoots: z.array(nonEmptyString).optional(),
  signature: z.string().optional(),
  manageSievePort: portSchema.optional(),
  allowedRecipients: z.array(z.string()).optional(),
  sentFolder: nonEmptyString.optional(),
};

const legacyEmailAccountObjectSchema = z.object({
  backend: z.undefined().optional(),
  ...imapSmtpFields,
});

const imapSmtpAccountObjectSchema = z.object({
  backend: z.literal('imap-smtp'),
  ...imapSmtpFields,
});

export const legacyEmailAccountSchema = secretFreeObjectSchema.pipe(
  legacyEmailAccountObjectSchema,
);

export const imapSmtpAccountSchema = secretFreeObjectSchema.pipe(
  imapSmtpAccountObjectSchema,
);

export const emailAccountSchema = secretFreeObjectSchema.pipe(z.discriminatedUnion('backend', [
  legacyEmailAccountObjectSchema,
  imapSmtpAccountObjectSchema,
]));

export const appleMailAccountSchema = secretFreeObjectSchema.pipe(z.object({
  backend: z.literal('apple-mail'),
  ...commonAccountFields,
  nativeAccountName: nonEmptyString.optional(),
  nativeAccountUuid: nonEmptyString.optional(),
  allowedAttachmentRoots: z.array(nonEmptyString).optional(),
}));

export const microsoftGraphAccountSchema = secretFreeObjectSchema.pipe(z.object({
  backend: z.literal('microsoft-graph'),
  ...commonAccountFields,
  user: nonEmptyString,
  endpoint: httpsEndpointSchema.optional(),
}));

export const ewsAccountSchema = secretFreeObjectSchema.pipe(z.object({
  backend: z.literal('ews'),
  ...commonAccountFields,
  user: nonEmptyString,
  endpoint: httpsEndpointSchema,
}));

export const mailtrapAccountSchema = secretFreeObjectSchema.pipe(z.object({
  backend: z.literal('mailtrap'),
  ...commonAccountFields,
  accountId: nonEmptyString.optional(),
  sandboxId: nonEmptyString.optional(),
}));

export const configuredAccountSchema = z.union([
  emailAccountSchema,
  appleMailAccountSchema,
  microsoftGraphAccountSchema,
  ewsAccountSchema,
  mailtrapAccountSchema,
]);

export type LegacyEmailAccount = z.infer<typeof legacyEmailAccountSchema>;
export type ImapSmtpAccount = z.infer<typeof imapSmtpAccountSchema>;
export type EmailAccount = z.infer<typeof emailAccountSchema>;
export type AppleMailConfiguredAccount = z.infer<typeof appleMailAccountSchema>;
export type MicrosoftGraphConfiguredAccount = z.infer<typeof microsoftGraphAccountSchema>;
export type EwsConfiguredAccount = z.infer<typeof ewsAccountSchema>;
export type MailtrapConfiguredAccount = z.infer<typeof mailtrapAccountSchema>;
export type ConfiguredAccount = z.infer<typeof configuredAccountSchema>;
export type AccountBackend = Exclude<ConfiguredAccount['backend'], undefined>;

export interface AccountCapabilityDescriptor {
  readonly backend: AccountBackend;
  readonly credentialSource: 'keychain' | 'native';
  readonly readMail: boolean;
  readonly sendMail: boolean;
  readonly manageMailboxes: boolean;
  readonly manageRules: boolean;
  readonly providerApi: boolean;
}

export const ACCOUNT_BACKEND_CAPABILITIES = {
  'imap-smtp': {
    backend: 'imap-smtp',
    credentialSource: 'keychain',
    readMail: true,
    sendMail: true,
    manageMailboxes: true,
    manageRules: true,
    providerApi: false,
  },
  'apple-mail': {
    backend: 'apple-mail',
    credentialSource: 'native',
    readMail: true,
    sendMail: true,
    manageMailboxes: true,
    manageRules: true,
    providerApi: false,
  },
  'microsoft-graph': {
    backend: 'microsoft-graph',
    credentialSource: 'keychain',
    readMail: true,
    sendMail: true,
    manageMailboxes: false,
    manageRules: false,
    providerApi: true,
  },
  ews: {
    backend: 'ews',
    credentialSource: 'keychain',
    readMail: true,
    sendMail: true,
    manageMailboxes: false,
    manageRules: false,
    providerApi: true,
  },
  mailtrap: {
    backend: 'mailtrap',
    credentialSource: 'keychain',
    readMail: true,
    sendMail: true,
    manageMailboxes: false,
    manageRules: false,
    providerApi: true,
  },
} as const satisfies Record<AccountBackend, AccountCapabilityDescriptor>;

export function isImapSmtpAccount(account: ConfiguredAccount): account is EmailAccount {
  return account.backend === undefined || account.backend === 'imap-smtp';
}

export function isAppleMailAccount(
  account: ConfiguredAccount,
): account is AppleMailConfiguredAccount {
  return account.backend === 'apple-mail';
}

export function isMicrosoftGraphAccount(
  account: ConfiguredAccount,
): account is MicrosoftGraphConfiguredAccount {
  return account.backend === 'microsoft-graph';
}

export function isEwsAccount(account: ConfiguredAccount): account is EwsConfiguredAccount {
  return account.backend === 'ews';
}

export function isMailtrapAccount(
  account: ConfiguredAccount,
): account is MailtrapConfiguredAccount {
  return account.backend === 'mailtrap';
}

export function getAccountCapabilities(
  account: ConfiguredAccount,
): AccountCapabilityDescriptor {
  return ACCOUNT_BACKEND_CAPABILITIES[account.backend ?? 'imap-smtp'];
}
