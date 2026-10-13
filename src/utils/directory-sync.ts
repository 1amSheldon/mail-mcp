import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

/** POSIX directory entries need their own flush. Node cannot fsync Windows
 * directories (EPERM); file flushes there provide process-restart protection,
 * not a portable guarantee against host/power failure.
 */
export async function syncDirectory(path: string, platform = process.platform): Promise<void> {
  if (platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Existing directories can come from another unfinished/failed initializer.
 * Flush through a caller-owned, preexisting durable anchor. Ancestors above that
 * anchor are outside this journal and may legitimately be traverse-only.
 */
export async function mkdirDurable(path: string, anchor: string): Promise<void> {
  const stop = resolve(anchor);
  const within = relative(stop, resolve(path));
  if (isAbsolute(within) || within === '..' || within.startsWith('..\\') || within.startsWith('../')) throw new Error('Journal path is outside its durability anchor');
  if (!(await stat(stop)).isDirectory()) throw new Error('Journal durability anchor must be an existing directory');
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  let current = resolve(path);
  for (;;) {
    await syncDirectory(current);
    if (current === stop) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
