import { redactSensitiveContent } from '../utils/redact.js';

const REDACTED = '[REDACTED]';
const SECRET_KEY_PATTERN = /(?:password|passphrase|secret|token|credential|api[_-]?key|authorization|client[_-]?secret|refresh[_-]?token)$/i;

/**
 * Apply the server's content redaction policy to provider responses without
 * changing their shape. Provider responses are normally JSON, but binary
 * payloads are intentionally left untouched because rewriting them would
 * corrupt attachments and raw message sources.
 */
export function redactProviderResult<T>(value: T): T {
  const seen = new WeakSet<object>();

  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') return redactSensitiveContent(current);
    if (current === null || typeof current !== 'object') return current;
    if (current instanceof Uint8Array) return current;
    if (seen.has(current)) return '[circular provider response]';
    seen.add(current);
    if (Array.isArray(current)) {
      const result = current.map(item => visit(item));
      seen.delete(current);
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : visit(item);
    }
    seen.delete(current);
    return result;
  };

  return visit(value) as T;
}
