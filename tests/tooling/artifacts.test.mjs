// Pure package-artifact contract: the source mapping covers every shipped file and each rpcd plugin has an ACL fragment.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'tools', 'artifact-manifest.json'), 'utf8'));
const files = directory => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const relative = file => path.relative(root, file).replaceAll('\\', '/');

for (const entry of manifest.entries) {
  const source = path.join(root, entry.source);
  assert.ok(statSync(source).isDirectory(), `${entry.source} exists as a directory`);
  assert.ok(entry.target.startsWith('/'), `${entry.source} has an absolute target`);
  assert.doesNotMatch(entry.target, /\s/, `${entry.source} target has no whitespace`);
  const shipped = files(source).map(relative);
  assert.ok(shipped.length > 0, `${entry.source} ships files`);
  for (const file of shipped)
    assert.equal(entry.exclusive || !entry.glob || new RegExp(`^${entry.glob.replaceAll('.', '\\.').replaceAll('*', '.*')}$`).test(path.basename(file)), true,
      `${file} matches its artifact glob`);
}

const plugins = files(path.join(root, 'rpcd', 'ucode')).filter(file => file.endsWith('.uc')).map(file => path.basename(file, '.uc'));
const aclNames = new Set(files(path.join(root, 'rpcd', 'acl.d')).map(file => path.basename(file, '.json')));
for (const plugin of plugins) {
  const acl = plugin.replace('flab.', 'flab-');
  assert.ok(aclNames.has(acl), `${plugin} has ${acl}.json`);
}
for (const forbidden of ['tests', 'tools', 'artifacts'])
  assert.equal(manifest.entries.some(entry => entry.source === forbidden || entry.source.startsWith(`${forbidden}/`)), false,
    `${forbidden} is not part of the package contract`);
console.log('PASS package artifact manifest covers shipped files and every plugin ACL');
