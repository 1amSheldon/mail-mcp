import type { JsonValue } from './types.js';

const SECRET_KEYS = new Set([
  'api_key',
  'api_token',
  'authorization',
  'password',
  'secret',
  'signing_secret',
  'smtp_password',
  'smtp_username',
  'token',
]);

export const MAILTRAP_REDACTED = '[REDACTED]';

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll('-', '_');
  return SECRET_KEYS.has(normalized)
    || /^(?:api|access|auth|bearer|refresh|private)_?token$/.test(normalized)
    || normalized.endsWith('_secret')
    || normalized.endsWith('_password');
}

export function redactMailtrapSecrets(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(item => redactMailtrapSecrets(item));
  if (value === null || typeof value !== 'object') return value;

  const redacted: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = isSecretKey(key) ? MAILTRAP_REDACTED : redactMailtrapSecrets(item);
  }
  return redacted;
}
