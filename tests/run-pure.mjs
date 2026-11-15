// Pure tests and syntax checks, with no npm dependencies, router or package-feed checkout.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const tests = files(path.join(root, 'tests'));
for (const file of [...files(path.join(root, 'www')), ...tests].filter(file => /\.(m?js)$/.test(file))) {
  run(['--check', file]);
}
run(['--experimental-vm-modules', '--test', ...tests.filter(file => file.endsWith('.test.mjs'))]);
