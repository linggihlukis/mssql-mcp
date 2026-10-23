// Syntax-check every JavaScript file under src/.
//
// `node --check` takes one file, and npm scripts do not expand globs on Windows, so this walks the
// tree itself. It exits non-zero on the first file that fails to parse.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src');

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

const files = walk(target).sort();
const failures = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures.push({ file: path.relative(root, file), message: String(error.stderr || error.message).trim() });
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stdout.write(`${failure.file}\n${failure.message}\n\n`);
  }
  process.stdout.write(`${failures.length} of ${files.length} files failed the syntax check.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${files.length} files under src/.\n`);
}
