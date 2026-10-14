import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLatestPackageVersion, isVersionNewer, startAutoUpdateMonitor } from './auto-update.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('automatic package updates', () => {
  it('checks the public package registry by default', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"version":"3.1.1"}'));
    const onUpdateAvailable = vi.fn();
    const monitor = startAutoUpdateMonitor({ currentVersion: '3.1.0', intervalMs: 60000, onUpdateAvailable });
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchSpy).toHaveBeenCalledWith('https://registry.npmjs.org/@1amsheldon%2fmail-mcp/latest', {
      headers: { accept: 'application/json' }, signal: expect.any(AbortSignal),
    });
    expect(onUpdateAvailable).toHaveBeenCalledWith('3.1.1');
    monitor.stop();
  });

  it.each(['{}', '{"version":42}', '{"version":"invalid"}'])('rejects malformed registry responses: %s', async body => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    await expect(fetchLatestPackageVersion()).rejects.toThrow('invalid package version');
  });

  it('reports registry HTTP failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(fetchLatestPackageVersion()).rejects.toThrow('HTTP 503');
  });

  it('does not restart after stopping during an in-flight check', async () => {
    vi.useFakeTimers();
    let complete!: (version: string) => void;
    const onUpdateAvailable = vi.fn();
    const monitor = startAutoUpdateMonitor({
      currentVersion: '3.1.0', intervalMs: 60000, onUpdateAvailable,
      fetchLatestVersion: () => new Promise(resolve => { complete = resolve; }),
    });
    await vi.advanceTimersByTimeAsync(60000);
    monitor.stop();
    complete('3.1.1');
    await Promise.resolve();
    expect(onUpdateAvailable).not.toHaveBeenCalled();
  });
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
