import { afterEach, describe, expect, it, vi } from 'vitest';
import { isVersionNewer, startAutoUpdateMonitor } from './auto-update.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('automatic package updates', () => {
  it('compares stable semantic versions without downgrading', () => {
    expect(isVersionNewer('1.6.0', '1.5.5')).toBe(true);
    expect(isVersionNewer('2.0.0', '1.99.99')).toBe(true);
    expect(isVersionNewer('1.5.5', '1.5.5')).toBe(false);
    expect(isVersionNewer('1.5.4', '1.5.5')).toBe(false);
    expect(isVersionNewer('1.6.0-beta.1', '1.6.0')).toBe(false);
    expect(isVersionNewer('1.6.0', '1.6.0-beta.1')).toBe(true);
    expect(isVersionNewer('not-a-version', '1.5.5')).toBe(false);
  });

  it('asks the supervisor for a restart when npm has a newer release', async () => {
    vi.useFakeTimers();
    const onUpdateAvailable = vi.fn();
    const fetchLatestVersion = vi.fn().mockResolvedValue('1.6.0');

    const monitor = startAutoUpdateMonitor({
      currentVersion: '1.5.5',
      intervalMs: 60_000,
      fetchLatestVersion,
      onUpdateAvailable,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchLatestVersion).toHaveBeenCalledOnce();
    expect(onUpdateAvailable).toHaveBeenCalledWith('1.6.0');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchLatestVersion).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('keeps checking after a transient registry failure', async () => {
    vi.useFakeTimers();
    const onCheckError = vi.fn();
    const fetchLatestVersion = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('1.5.5');

    const monitor = startAutoUpdateMonitor({
      currentVersion: '1.5.5',
      intervalMs: 60_000,
      fetchLatestVersion,
      onUpdateAvailable: vi.fn(),
      onCheckError,
    });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchLatestVersion).toHaveBeenCalledTimes(2);
    expect(onCheckError).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('rejects an interval that would hammer the npm registry', () => {
    expect(() => startAutoUpdateMonitor({
      currentVersion: '1.5.5',
      intervalMs: 59_999,
      onUpdateAvailable: vi.fn(),
    })).toThrow('at least 60 seconds');
  });
});
