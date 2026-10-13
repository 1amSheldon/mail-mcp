import { chmodSync } from 'node:fs';

// tsc recreates the entrypoint without executable bits. A warm npx file-package
// cache reuses its existing symlink and does not run npm's bin chmod again.
if (process.platform !== 'win32') {
  chmodSync(new URL('../dist/index.js', import.meta.url), 0o755);
}
