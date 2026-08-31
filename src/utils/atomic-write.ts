import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

function temporaryPath(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
}

export async function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array
): Promise<void> {
  const tempPath = temporaryPath(filePath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(tempPath, 'wx', 0o600);
    if (typeof content === 'string') {
      await handle.writeFile(content, 'utf8');
    } else {
      await handle.writeFile(content);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  await writeFileAtomic(filePath, content);
}

export function writeTextFileAtomicSync(filePath: string, content: string): void {
  const tempPath = temporaryPath(filePath);
  let descriptor: number | undefined;

  try {
    descriptor = openSync(tempPath, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}
