import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const repositoryFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const cyrillic = /\p{Script=Cyrillic}/u;
const failures = [];
let textFileCount = 0;

for (const file of repositoryFiles) {
  if (!existsSync(file)) continue;
  const buffer = readFileSync(file);
  if (buffer.includes(0)) continue;

  textFileCount++;
  const content = buffer.toString('utf8');
  const match = cyrillic.exec(content);
  if (!match || match.index === undefined) continue;

  const line = content.slice(0, match.index).split(/\r?\n/).length;
  failures.push(`${file}:${line}`);
}

if (failures.length > 0) {
  console.error('Cyrillic text is not allowed in tracked repository files:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`English-only check passed (${textFileCount} text files).`);
}
