/**
 * Sensitive content redaction utility.
 *
 * Masks credit card numbers, SSNs, contextual passwords, and API keys in
 * email body text before it is returned to the AI model. Enabled via the
 * --redact CLI flag; default off to avoid false positives.
 *
 * Zero external dependencies — regex only.
 */

/** Matches 16-digit credit card numbers with optional spaces or dashes between groups. */
const CC_PATTERN = /\b(?:\d[ -]?){15}\d\b/g;

/** Matches Social Security Numbers in XXX-XX-XXXX format. */
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Matches password labels followed by a value:
 *   password: VALUE  |  pwd: VALUE  |  passwd: VALUE  |  pass: VALUE
 *   password=VALUE   |  pwd=VALUE   ...
 *
 * Replacement: keeps the label keyword but replaces the value.
 */
const PASSWORD_PATTERN = /\b(password|passwd|pwd|pass)\s*[:=]\s*\S+/gi;

/**
 * Matches API keys identified by a well-known prefix followed by 16+ alphanumeric chars.
 * Prefixes: sk-, api_, token_, secret_
 */
const API_KEY_PATTERN = /\b(sk-|api_|token_|secret_)[A-Za-z0-9_\-]{16,}\b/g;

/**
 * Scan `text` for known sensitive patterns and replace each match with a
 * neutral redaction token. Returns the redacted string.
 *
 * Patterns applied:
 *   - 16-digit credit card numbers (with optional spaces/dashes) → [REDACTED CC]
 *   - SSNs (XXX-XX-XXXX) → [REDACTED SSN]
 *   - password/pwd/passwd/pass labels with values → label: [REDACTED]
 *   - API keys with sk-/api_/token_/secret_ prefixes → [REDACTED KEY]
 */
export function redactSensitiveContent(text: string): string {
  if (!text) return text;

  return text
    .replace(CC_PATTERN, '[REDACTED CC]')
    .replace(SSN_PATTERN, '[REDACTED SSN]')
    .replace(PASSWORD_PATTERN, (_, label) => `${label}: [REDACTED]`)
    .replace(API_KEY_PATTERN, '[REDACTED KEY]');
}
