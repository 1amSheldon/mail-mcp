import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

export function watchFileChanges(
  filePath: string,
  onChange: () => void,
  onError: () => void,
): FSWatcher | undefined {
  try {
    const targetName = basename(filePath);
    const watcher = watch(dirname(filePath), (_eventType, filename) => {
      if (filename == null || filename.toString() === targetName) {
        onChange();
      }
    });

    watcher.once('error', () => {
      watcher.close();
      onChange();
      onError();
    });
    return watcher;
  } catch {
    return undefined;
  }
}
