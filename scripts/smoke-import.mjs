import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
const source = `await import(${JSON.stringify(moduleUrl)}); console.log('import ok');`;
for (const args of [['--input-type=module', '-'], ['--input-type=module', '-e', source]]) {
  const result = spawnSync(process.execPath, args, {
    input: source, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.stdout.trim() !== 'import ok') {
    throw new Error(`Import unexpectedly started a server or failed: ${result.error ?? result.stderr}`);
  }
}
console.log('Import from stdin and eval passed without starting a server');
