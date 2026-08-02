import { describe, it, expect } from 'vitest';
import { redactSensitiveContent } from './redact.js';

describe('redactSensitiveContent', () => {
  // Credit card numbers
  describe('credit card numbers', () => {
    it('redacts a plain 16-digit credit card number', () => {
      expect(redactSensitiveContent('Your card 4111111111111111 was charged.')).not.toContain('4111111111111111');
      expect(redactSensitiveContent('Your card 4111111111111111 was charged.')).toContain('[REDACTED CC]');
    });

    it('redacts a credit card number with spaces', () => {
      const input = 'Card: 4111 1111 1111 1111';
      expect(redactSensitiveContent(input)).toContain('[REDACTED CC]');
      expect(redactSensitiveContent(input)).not.toContain('4111 1111 1111 1111');
    });

    it('redacts a credit card number with dashes', () => {
      const input = 'Card: 4111-1111-1111-1111';
      expect(redactSensitiveContent(input)).toContain('[REDACTED CC]');
      expect(redactSensitiveContent(input)).not.toContain('4111-1111-1111-1111');
    });

    it('does not redact a short number that is not a CC', () => {
      const input = 'Invoice #12345';
      expect(redactSensitiveContent(input)).toBe(input);
    });
  });

  // SSN
  describe('social security numbers', () => {
    it('redacts a standard SSN', () => {
      const input = 'SSN: 123-45-6789';
      expect(redactSensitiveContent(input)).toContain('[REDACTED SSN]');
      expect(redactSensitiveContent(input)).not.toContain('123-45-6789');
    });

    it('does not redact a phone number that happens to have dashes', () => {
      // Phone is 3-3-4 or 10 digits, not 3-2-4
      const input = 'Call me at 555-123-4567';
      expect(redactSensitiveContent(input)).toBe(input);
    });
  });

  // Password in context
  describe('passwords in context', () => {
    it('redacts "password: VALUE"', () => {
      const input = 'Your password: supersecret123 is set.';
      expect(redactSensitiveContent(input)).not.toContain('supersecret123');
      expect(redactSensitiveContent(input)).toContain('[REDACTED]');
    });

    it('redacts "pwd: VALUE"', () => {
      const input = 'pwd: mypassword';
      expect(redactSensitiveContent(input)).not.toContain('mypassword');
      expect(redactSensitiveContent(input)).toContain('[REDACTED]');
    });

    it('redacts "passwd: VALUE"', () => {
      const input = 'passwd: topsecret';
      expect(redactSensitiveContent(input)).not.toContain('topsecret');
      expect(redactSensitiveContent(input)).toContain('[REDACTED]');
    });

    it('redacts case-insensitive "Password: VALUE"', () => {
      const input = 'Password: MyP@ss123';
      expect(redactSensitiveContent(input)).not.toContain('MyP@ss123');
      expect(redactSensitiveContent(input)).toContain('[REDACTED]');
    });

    it('handles password= assignment style', () => {
      const input = 'password=hunter2';
      expect(redactSensitiveContent(input)).not.toContain('hunter2');
    });
  });

  // API keys
  describe('API keys', () => {
    it('redacts sk- prefixed keys', () => {
      const input = 'API key: sk-abcdefghijklmnopqrstuvwx';
      expect(redactSensitiveContent(input)).toContain('[REDACTED KEY]');
      expect(redactSensitiveContent(input)).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    });

    it('redacts api_ prefixed keys', () => {
      const input = 'Use api_1234567890abcdef to access the service.';
      expect(redactSensitiveContent(input)).toContain('[REDACTED KEY]');
      expect(redactSensitiveContent(input)).not.toContain('api_1234567890abcdef');
    });

    it('redacts token_ prefixed keys', () => {
      const input = 'token_abcdefghijklmnopqr';
      expect(redactSensitiveContent(input)).toContain('[REDACTED KEY]');
    });

    it('redacts secret_ prefixed keys', () => {
      const input = 'secret_xxxxxxxxxxxxxxxx';
      expect(redactSensitiveContent(input)).toContain('[REDACTED KEY]');
    });

    it('does not redact short sk- values (under 16 chars after prefix)', () => {
      const input = 'sk-short';
      // 5 chars after prefix — should NOT be redacted
      expect(redactSensitiveContent(input)).toBe(input);
    });
  });

  // No mutation
  describe('clean text', () => {
    it('returns the input unchanged when no patterns match', () => {
      const input = 'Hello, here is your order summary for March 2026.';
      expect(redactSensitiveContent(input)).toBe(input);
    });

    it('handles empty string without error', () => {
      expect(redactSensitiveContent('')).toBe('');
    });
  });

  // Multiple patterns
  describe('multiple patterns in one text', () => {
    it('redacts multiple sensitive items in a single string', () => {
      const input = 'SSN: 123-45-6789, CC: 4111111111111111, key: sk-abcdefghijklmnopqrstuvwx';
      const result = redactSensitiveContent(input);
      expect(result).not.toContain('123-45-6789');
      expect(result).not.toContain('4111111111111111');
      expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwx');
      expect(result).toContain('[REDACTED SSN]');
      expect(result).toContain('[REDACTED CC]');
      expect(result).toContain('[REDACTED KEY]');
    });
  });
});
