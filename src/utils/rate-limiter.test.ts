import { describe, it, expect } from 'vitest';
import { QuotaError } from '../errors.js';
import {
  AccountRateLimiter,
  DEFAULT_RATE_LIMIT_POINTS,
  DEFAULT_RATE_LIMIT_DURATION,
  TieredRateLimiter,
  DEFAULT_READ_RATE_LIMIT_POINTS,
  DEFAULT_WRITE_RATE_LIMIT_POINTS,
} from './rate-limiter.js';

describe('DEFAULT_RATE_LIMIT_POINTS', () => {
  it('is 100', () => {
    expect(DEFAULT_RATE_LIMIT_POINTS).toBe(100);
  });
});

describe('DEFAULT_RATE_LIMIT_DURATION', () => {
  it('is 60', () => {
    expect(DEFAULT_RATE_LIMIT_DURATION).toBe(60);
  });
});

describe('AccountRateLimiter', () => {
  it('consume() resolves without error when under limit', async () => {
    const limiter = new AccountRateLimiter({ points: 3, duration: 60 });
    await expect(limiter.consume('acct1')).resolves.toBeUndefined();
  });

  it('consume() throws QuotaError after limit is exceeded', async () => {
    const limiter = new AccountRateLimiter({ points: 3, duration: 60 });
    // Exhaust the 3 points
    await limiter.consume('acct1');
    await limiter.consume('acct1');
    await limiter.consume('acct1');
    // 4th call should throw QuotaError
    await expect(limiter.consume('acct1')).rejects.toBeInstanceOf(QuotaError);
  });

  it('QuotaError message contains "Rate limit exceeded" and account id', async () => {
    const limiter = new AccountRateLimiter({ points: 1, duration: 60 });
    await limiter.consume('acct-test');
    let thrown: unknown;
    try {
      await limiter.consume('acct-test');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(QuotaError);
    const msg = (thrown as QuotaError).message;
    expect(msg).toMatch(/Rate limit exceeded/);
    expect(msg).toMatch(/acct-test/);
  });

  it('QuotaError message contains "Retry after" with seconds value', async () => {
    const limiter = new AccountRateLimiter({ points: 1, duration: 60 });
    await limiter.consume('acct-retry');
    let thrown: unknown;
    try {
      await limiter.consume('acct-retry');
    } catch (err) {
      thrown = err;
    }
    expect((thrown as QuotaError).message).toMatch(/Retry after \d+ second/);
  });

  it('exhausting account A does not affect account B (per-account isolation)', async () => {
    const limiter = new AccountRateLimiter({ points: 2, duration: 60 });
    // Exhaust account A
    await limiter.consume('account-a');
    await limiter.consume('account-a');
    // account-a is now exhausted
    await expect(limiter.consume('account-a')).rejects.toBeInstanceOf(QuotaError);
    // account-b should still be fine
    await expect(limiter.consume('account-b')).resolves.toBeUndefined();
  });

  it('constructor accepts custom points and duration', async () => {
    // With points=1, second call should fail immediately
    const limiter = new AccountRateLimiter({ points: 1, duration: 1 });
    await limiter.consume('acct-custom');
    await expect(limiter.consume('acct-custom')).rejects.toBeInstanceOf(QuotaError);
  });
});

describe('DEFAULT_READ_RATE_LIMIT_POINTS', () => {
  it('is 100', () => {
    expect(DEFAULT_READ_RATE_LIMIT_POINTS).toBe(100);
  });
});

describe('DEFAULT_WRITE_RATE_LIMIT_POINTS', () => {
  it('is 20', () => {
    expect(DEFAULT_WRITE_RATE_LIMIT_POINTS).toBe(20);
  });
});

describe('TieredRateLimiter', () => {
  it('consumeRead() resolves without error when under read limit', async () => {
    const limiter = new TieredRateLimiter({ readPoints: 3, writePoints: 2, duration: 60 });
    await expect(limiter.consumeRead('acct1')).resolves.toBeUndefined();
  });

  it('consumeWrite() resolves without error when under write limit', async () => {
    const limiter = new TieredRateLimiter({ readPoints: 3, writePoints: 2, duration: 60 });
    await expect(limiter.consumeWrite('acct1')).resolves.toBeUndefined();
  });

  it('consumeRead() throws QuotaError after read limit exceeded', async () => {
    const limiter = new TieredRateLimiter({ readPoints: 2, writePoints: 5, duration: 60 });
    await limiter.consumeRead('acct1');
    await limiter.consumeRead('acct1');
    await expect(limiter.consumeRead('acct1')).rejects.toBeInstanceOf(QuotaError);
  });

  it('consumeWrite() throws QuotaError after write limit exceeded', async () => {
    const limiter = new TieredRateLimiter({ readPoints: 5, writePoints: 2, duration: 60 });
    await limiter.consumeWrite('acct1');
    await limiter.consumeWrite('acct1');
    await expect(limiter.consumeWrite('acct1')).rejects.toBeInstanceOf(QuotaError);
  });

  it('exhausting write does not block read (tiers are independent)', async () => {
    const limiter = new TieredRateLimiter({ readPoints: 5, writePoints: 1, duration: 60 });
    await limiter.consumeWrite('acct1');
    // Write is now exhausted
    await expect(limiter.consumeWrite('acct1')).rejects.toBeInstanceOf(QuotaError);
    // Read should still work
    await expect(limiter.consumeRead('acct1')).resolves.toBeUndefined();
  });

  it('exhausting read does not block write (tiers are independent)', async () => {
    const limiter = new TieredRateLimiter({ readPoints: 1, writePoints: 5, duration: 60 });
    await limiter.consumeRead('acct1');
    // Read is now exhausted
    await expect(limiter.consumeRead('acct1')).rejects.toBeInstanceOf(QuotaError);
    // Write should still work
    await expect(limiter.consumeWrite('acct1')).resolves.toBeUndefined();
  });

  it('read tier is per-account isolated', async () => {
    const limiter = new TieredRateLimiter({ readPoints: 1, writePoints: 5, duration: 60 });
    await limiter.consumeRead('account-a');
    await expect(limiter.consumeRead('account-a')).rejects.toBeInstanceOf(QuotaError);
    // account-b should be unaffected
    await expect(limiter.consumeRead('account-b')).resolves.toBeUndefined();
  });

  it('write tier is per-account isolated', async () => {
    const limiter = new TieredRateLimiter({ readPoints: 5, writePoints: 1, duration: 60 });
    await limiter.consumeWrite('account-a');
    await expect(limiter.consumeWrite('account-a')).rejects.toBeInstanceOf(QuotaError);
    // account-b should be unaffected
    await expect(limiter.consumeWrite('account-b')).resolves.toBeUndefined();
  });

  it('QuotaError from consumeRead contains account id', async () => {
    const limiter = new TieredRateLimiter({ readPoints: 1, writePoints: 5, duration: 60 });
    await limiter.consumeRead('acct-read-err');
    let thrown: unknown;
    try {
      await limiter.consumeRead('acct-read-err');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(QuotaError);
    expect((thrown as QuotaError).message).toMatch(/acct-read-err/);
  });

  it('QuotaError from consumeWrite contains account id', async () => {
    const limiter = new TieredRateLimiter({ readPoints: 5, writePoints: 1, duration: 60 });
    await limiter.consumeWrite('acct-write-err');
    let thrown: unknown;
    try {
      await limiter.consumeWrite('acct-write-err');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(QuotaError);
    expect((thrown as QuotaError).message).toMatch(/acct-write-err/);
  });

  it('uses DEFAULT_READ_RATE_LIMIT_POINTS and DEFAULT_WRITE_RATE_LIMIT_POINTS when no options given', () => {
    // Just verifying the class can be instantiated with no args — default values are used
    const limiter = new TieredRateLimiter();
    expect(limiter).toBeDefined();
  });
});
