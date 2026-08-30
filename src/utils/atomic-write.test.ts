import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTextFileAtomic, writeTextFileAtomicSync } from './atomic-write.js';

describe('atomic text writes', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mail-mcp-atomic-write-'));
    filePath = join(tempDir, 'config.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('replaces an existing file asynchronously without leaving a temporary file', async () => {
    await writeFile(filePath, 'old', 'utf8');

    await writeTextFileAtomic(filePath, 'new');

    expect(await readFile(filePath, 'utf8')).toBe('new');
    expect(await readdir(tempDir)).toEqual(['config.json']);
  });

  it('creates a new file synchronously without leaving a temporary file', async () => {
    writeTextFileAtomicSync(filePath, 'created');

    expect(readFileSync(filePath, 'utf8')).toBe('created');
    expect(await readdir(tempDir)).toEqual(['config.json']);
  });
});
