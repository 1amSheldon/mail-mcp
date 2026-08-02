import { describe, it, expect } from 'vitest';
import {
  MailErrorCode,
  MailMCPError,
  AuthError,
  NetworkError,
  ValidationError,
  QuotaError,
} from './errors.js';

describe('MailErrorCode enum', () => {
  it('has AuthError value', () => {
    expect(MailErrorCode.AuthError).toBe('AuthError');
  });

  it('has NetworkError value', () => {
    expect(MailErrorCode.NetworkError).toBe('NetworkError');
  });

  it('has ValidationError value', () => {
    expect(MailErrorCode.ValidationError).toBe('ValidationError');
  });

  it('has QuotaError value', () => {
    expect(MailErrorCode.QuotaError).toBe('QuotaError');
  });
});

describe('AuthError', () => {
  it('has .code === "AuthError"', () => {
    const err = new AuthError('bad creds');
    expect(err.code).toBe('AuthError');
  });

  it('has .name === "AuthError"', () => {
    const err = new AuthError('bad creds');
    expect(err.name).toBe('AuthError');
  });

  it('has .message === provided string', () => {
    const err = new AuthError('bad creds');
    expect(err.message).toBe('bad creds');
  });

  it('is instanceof MailMCPError', () => {
    const err = new AuthError('bad creds');
    expect(err).toBeInstanceOf(MailMCPError);
  });

  it('is instanceof Error', () => {
    const err = new AuthError('bad creds');
    expect(err).toBeInstanceOf(Error);
  });

  it('supports cause via ErrorOptions', () => {
    const original = new Error('original');
    const err = new AuthError('wrapped', { cause: original });
    expect(err.cause).toBe(original);
  });
});

describe('NetworkError', () => {
  it('has .code === "NetworkError"', () => {
    const err = new NetworkError('timeout');
    expect(err.code).toBe('NetworkError');
  });

  it('has .name === "NetworkError"', () => {
    const err = new NetworkError('timeout');
    expect(err.name).toBe('NetworkError');
  });

  it('has .message === provided string', () => {
    const err = new NetworkError('timeout');
    expect(err.message).toBe('timeout');
  });

  it('is instanceof MailMCPError', () => {
    const err = new NetworkError('timeout');
    expect(err).toBeInstanceOf(MailMCPError);
  });

  it('is instanceof Error', () => {
    const err = new NetworkError('timeout');
    expect(err).toBeInstanceOf(Error);
  });

  it('supports cause via ErrorOptions', () => {
    const original = new Error('original');
    const err = new NetworkError('wrapped', { cause: original });
    expect(err.cause).toBe(original);
  });
});

describe('ValidationError', () => {
  it('has .code === "ValidationError"', () => {
    const err = new ValidationError('bad field');
    expect(err.code).toBe('ValidationError');
  });

  it('has .name === "ValidationError"', () => {
    const err = new ValidationError('bad field');
    expect(err.name).toBe('ValidationError');
  });

  it('has .message === provided string', () => {
    const err = new ValidationError('bad field');
    expect(err.message).toBe('bad field');
  });

  it('is instanceof MailMCPError', () => {
    const err = new ValidationError('bad field');
    expect(err).toBeInstanceOf(MailMCPError);
  });

  it('is instanceof Error', () => {
    const err = new ValidationError('bad field');
    expect(err).toBeInstanceOf(Error);
  });

  it('supports cause via ErrorOptions', () => {
    const original = new Error('original');
    const err = new ValidationError('wrapped', { cause: original });
    expect(err.cause).toBe(original);
  });
});

describe('QuotaError', () => {
  it('has .code === "QuotaError"', () => {
    const err = new QuotaError('rate limited');
    expect(err.code).toBe('QuotaError');
  });

  it('has .name === "QuotaError"', () => {
    const err = new QuotaError('rate limited');
    expect(err.name).toBe('QuotaError');
  });

  it('has .message === provided string', () => {
    const err = new QuotaError('rate limited');
    expect(err.message).toBe('rate limited');
  });

  it('is instanceof MailMCPError', () => {
    const err = new QuotaError('rate limited');
    expect(err).toBeInstanceOf(MailMCPError);
  });

  it('is instanceof Error', () => {
    const err = new QuotaError('rate limited');
    expect(err).toBeInstanceOf(Error);
  });

  it('supports cause via ErrorOptions', () => {
    const original = new Error('original');
    const err = new QuotaError('wrapped', { cause: original });
    expect(err.cause).toBe(original);
  });
});

describe('all subclasses are instanceof MailMCPError and Error', () => {
  const errors = [
    new AuthError('a'),
    new NetworkError('b'),
    new ValidationError('c'),
    new QuotaError('d'),
  ];

  it('all 4 are instanceof MailMCPError', () => {
    for (const err of errors) {
      expect(err).toBeInstanceOf(MailMCPError);
    }
  });

  it('all 4 are instanceof Error', () => {
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});
