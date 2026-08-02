import { describe, it, expect } from 'vitest';
import { ValidationError } from '../errors.js';
import { validateEmailAddresses, validateRecipients } from './validation.js';

describe('validateEmailAddresses', () => {
  it('throws ValidationError for a syntactically invalid address', () => {
    expect(() => validateEmailAddresses('notanemail')).toThrowError(ValidationError);
  });

  it('thrown message contains the invalid address', () => {
    expect(() => validateEmailAddresses('notanemail')).toThrowError(/notanemail/);
  });

  it('does not throw for a plain valid address', () => {
    expect(() => validateEmailAddresses('user@example.com')).not.toThrow();
  });

  it('does not throw for angle-bracket format', () => {
    expect(() => validateEmailAddresses('Name <user@example.com>')).not.toThrow();
  });

  it('throws ValidationError listing invalid entry in comma-separated list', () => {
    let thrown: unknown;
    try {
      validateEmailAddresses('a@b.com, notvalid, c@d.com');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).message).toMatch(/notvalid/);
  });

  it('does not throw when argument is undefined (optional field)', () => {
    expect(() => validateEmailAddresses(undefined)).not.toThrow();
  });

  it('does not throw for mixed present/absent fields', () => {
    expect(() => validateEmailAddresses('a@b.com', undefined, 'c@d.com')).not.toThrow();
  });

  it('throws ValidationError for address with whitespace in local part', () => {
    expect(() => validateEmailAddresses('user @example.com')).toThrowError(ValidationError);
  });

  it('does not throw for empty string (no addresses)', () => {
    expect(() => validateEmailAddresses('')).not.toThrow();
  });

  it('error message starts with "Invalid email address(es):"', () => {
    expect(() => validateEmailAddresses('bad')).toThrowError(/Invalid email address\(es\):/);
  });
});

describe('validateRecipients', () => {
  const allowlist = ['alice@company.com', '@company.com', 'bob@other.org'];

  it('throws ValidationError when address is not in allowlist', () => {
    expect(() =>
      validateRecipients(['external@gmail.com'], allowlist, 'work')
    ).toThrowError(ValidationError);
  });

  it('error message includes blocked address and account ID', () => {
    expect(() =>
      validateRecipients(['external@gmail.com'], allowlist, 'work')
    ).toThrowError(/external@gmail\.com.*work|work.*external@gmail\.com/);
  });

  it('does not throw for exact address match', () => {
    expect(() =>
      validateRecipients(['alice@company.com'], allowlist, 'work')
    ).not.toThrow();
  });

  it('does not throw for exact address match (case-insensitive)', () => {
    expect(() =>
      validateRecipients(['Alice@Company.com'], allowlist, 'work')
    ).not.toThrow();
  });

  it('does not throw for domain pattern match', () => {
    expect(() =>
      validateRecipients(['anyone@company.com'], allowlist, 'work')
    ).not.toThrow();
  });

  it('does not throw when all recipients are in the allowlist', () => {
    expect(() =>
      validateRecipients(['alice@company.com', 'bob@other.org'], allowlist, 'work')
    ).not.toThrow();
  });

  it('does not throw for empty recipients array', () => {
    expect(() =>
      validateRecipients([], allowlist, 'work')
    ).not.toThrow();
  });

  it('does not throw for undefined recipients entries', () => {
    expect(() =>
      validateRecipients([undefined], allowlist, 'work')
    ).not.toThrow();
  });

  it('handles comma-separated addresses (validates each individually)', () => {
    expect(() =>
      validateRecipients(['alice@company.com, external@gmail.com'], allowlist, 'work')
    ).toThrowError(ValidationError);
  });

  it('handles angle-bracket format', () => {
    expect(() =>
      validateRecipients(['Name <anyone@company.com>'], allowlist, 'work')
    ).not.toThrow();
  });

  it('throws for angle-bracket format when address not in allowlist', () => {
    expect(() =>
      validateRecipients(['Name <external@gmail.com>'], allowlist, 'work')
    ).toThrowError(ValidationError);
  });

  it('does not throw when allowlist is empty (no restriction)', () => {
    expect(() =>
      validateRecipients(['anyone@anywhere.com'], [], 'work')
    ).not.toThrow();
  });

  it('error message format: "Recipient {addr} is not in the allowed recipients list for account {id}"', () => {
    try {
      validateRecipients(['external@gmail.com'], allowlist, 'myaccount');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe(
        'Recipient external@gmail.com is not in the allowed recipients list for account myaccount'
      );
    }
  });
});
