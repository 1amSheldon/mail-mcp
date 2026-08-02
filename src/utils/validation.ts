import { ValidationError } from '../errors.js';

// ReDoS-safe email regex — no nested quantifiers
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Matches angle-bracket format: "Name <user@example.com>"
const ANGLE_BRACKET_RE = /<([^>]+)>/;

/**
 * Extracts individual email addresses from a comma-separated field string.
 * Handles angle-bracket format ("Name <user@example.com>").
 */
function extractAddresses(field: string): string[] {
  return field
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '')
    .map((entry) => {
      const angleMatch = ANGLE_BRACKET_RE.exec(entry);
      return angleMatch ? angleMatch[1].trim() : entry;
    });
}

/**
 * Validates one or more email address fields (to, cc, bcc).
 * Each field may contain multiple comma-separated addresses or be undefined.
 * Throws ValidationError listing all invalid addresses if any are found.
 */
export function validateEmailAddresses(...addrFields: Array<string | undefined>): void {
  const invalid: string[] = [];

  for (const field of addrFields) {
    if (field === undefined || field === '') continue;

    const entries = field.split(',').map((e) => e.trim());

    for (const entry of entries) {
      if (entry === '') continue;

      // Extract address from angle-bracket format or use raw entry
      const angleMatch = ANGLE_BRACKET_RE.exec(entry);
      const address = angleMatch ? angleMatch[1].trim() : entry;

      if (!EMAIL_RE.test(address)) {
        invalid.push(entry);
      }
    }
  }

  if (invalid.length > 0) {
    throw new ValidationError('Invalid email address(es): ' + invalid.join(', '));
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
