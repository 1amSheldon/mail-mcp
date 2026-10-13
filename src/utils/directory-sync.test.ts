import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { mkdir, open } from 'node:fs/promises';
import { mkdirDurable, syncDirectory } from './directory-sync.js';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), open: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe('directory durability', () => {
  it('flushes and closes a POSIX directory, and propagates flush errors', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('disk error'));
    const close = vi.fn();
    vi.mocked(open).mockResolvedValue({ sync, close } as any);
    await expect(syncDirectory('/journal', 'linux')).rejects.toThrow('disk error');
    expect(close).toHaveBeenCalledOnce();
  });
  it('does not use unsupported directory fsync on Windows', async () => {
    await syncDirectory('C:/journal', 'win32');
    expect(open).not.toHaveBeenCalled();
  });
  it.each([true, false])('flushes all ancestor links even after a concurrent or failed initializer (new=%s)', async created => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      const root = resolve('journal-fixture');
      const leaf = resolve(root, 'account');
      vi.mocked(mkdir).mockResolvedValue(created ? root : undefined);
      const paths: string[] = [];
      vi.mocked(open).mockImplementation(async path => {
        paths.push(String(path));
        return { sync: vi.fn(), close: vi.fn() } as any;
      });
      await mkdirDurable(leaf);
      const expected = [leaf];
      while (dirname(expected.at(-1)!) !== expected.at(-1)) expected.push(dirname(expected.at(-1)!));
      expect(paths).toEqual(expected);
    } finally { platform.mockRestore(); }
  });
});
