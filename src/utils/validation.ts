import addressparser from 'nodemailer/lib/addressparser/index.js';
import { ValidationError } from '../errors.js';

// ReDoS-safe email regex — no nested quantifiers
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Use the same mailbox-list parser as Nodemailer when constructing its envelope.
// Splitting on commas corrupts quoted display names and RFC address groups.
function extractAddresses(field: string): string[] {
  if (/[\r\n\0]/.test(field)) throw new ValidationError('Invalid email address(es): control character');
  const parsed = addressparser(field, { flatten: true });
  const invalid = parsed.filter(entry => !EMAIL_RE.test(entry.address ?? ''));
  if (invalid.length) {
    throw new ValidationError('Invalid email address(es): ' + invalid.map(entry => entry.address || entry.name).join(', '));
  }
  return parsed.map(entry => entry.address!);
}

export function validateEmailAddresses(...addrFields: Array<string | undefined>): void {
  for (const field of addrFields) {
    if (field) extractAddresses(field);
  }
}

/**
 * Validates that all recipient addresses are permitted by the account's allowlist.
 * Each entry in allowlist is either an exact email address or a domain pattern like "@example.com".
 * Matching is case-insensitive. If allowlist is empty, no restriction is applied.
 *
 * @param recipients - Array of recipient field strings (may be undefined or comma-separated)
 * @param allowlist - Array of allowed addresses/domain patterns from account config
 * @param accountId - Account ID for error messages
 */
export function validateRecipients(
  recipients: Array<string | undefined>,
  allowlist: string[],
  accountId: string
): void {
  if (allowlist.length === 0) return;

  const normalizedAllowlist = allowlist.map((entry) => entry.toLowerCase());

  for (const field of recipients) {
    if (field === undefined || field === '') continue;

    const addresses = extractAddresses(field);

    for (const address of addresses) {
      const lowerAddr = address.toLowerCase();
      const domain = '@' + lowerAddr.split('@')[1];

      const allowed =
        normalizedAllowlist.includes(lowerAddr) || normalizedAllowlist.includes(domain);

      if (!allowed) {
        throw new ValidationError(
          `Recipient ${address} is not in the allowed recipients list for account ${accountId}`
        );
      }
    }
  }
}
