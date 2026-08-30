import { rmSync } from 'node:fs';

const distDirectory = new URL('../dist/', import.meta.url);

rmSync(distDirectory, { recursive: true, force: true });
