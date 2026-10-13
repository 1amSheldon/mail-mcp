import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { mkdir, open, stat } from 'node:fs/promises';
import { mkdirDurable, syncDirectory } from './directory-sync.js';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), open: vi.fn(), stat: vi.fn() }));
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
  it('refuses paths outside the anchor before creating directories', async () => {
    await expect(mkdirDurable(resolve('outside'), resolve('anchor'))).rejects.toThrow('outside');
    expect(mkdir).not.toHaveBeenCalled();
  });
  it('requires a preexisting custom durability anchor', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('missing anchor'));
    await expect(mkdirDurable(resolve('anchor/child'), resolve('anchor'))).rejects.toThrow('missing anchor');
    expect(mkdir).not.toHaveBeenCalled();
  });
  it.each([true, false])('flushes all ancestor links even after a concurrent or failed initializer (new=%s)', async created => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      const root = resolve('journal-fixture');
      const leaf = resolve(root, 'account');
      vi.mocked(mkdir).mockResolvedValue(created ? root : undefined);
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
      const paths: string[] = [];
      vi.mocked(open).mockImplementation(async path => {
        paths.push(String(path));
        return { sync: vi.fn(), close: vi.fn() } as any;
      });
      // Parents above root need not be readable (e.g. a traverse-only home parent).
      await mkdirDurable(leaf, root);
      expect(paths).toEqual([leaf, root]);
    } finally { platform.mockRestore(); }
  });
});
