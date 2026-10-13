import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

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
 * Flush their entire ancestor chain rather than treating existence as durability.
 */
export async function mkdirDurable(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  let current = resolve(path);
  for (;;) {
    await syncDirectory(current);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
