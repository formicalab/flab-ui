import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const manifests = ['network', 'wireless', 'firewall', 'vpn', 'dhcp', 'dns', 'routing', 'traffic', 'services', 'toolbox', 'logs']
  .map(async name => JSON.parse(await readFile(path.join(root, 'www', 'modules', `${name}.json`), 'utf8')));
const resolved = await Promise.all(manifests);
globalThis.location = { hash: '#overview' };
const { basePages, installedPages } = await import(pathToFileURL(path.join(root, 'www', 'js', 'pages', 'index.js')));

test('installed feature manifests create one ordered, unique registry', () => {
  const pages = installedPages(resolved);
  assert.equal(pages[0].id, 'overview');
  assert.equal(pages.at(-1).id, 'settings');
  assert.equal(new Set(pages.map(p => p.id)).size, pages.length);
  assert.deepEqual(pages.slice(1, -1).map(p => p.id),
    ['network', 'radios', 'firewall', 'ipsec', 'wireguard', 'interfaces', 'dhcp', 'dns', 'ddns', 'routing', 'traffic', 'services', 'toolbox', 'logs']);
});

test('invalid and duplicate module entries are ignored and base pages remain', () => {
  assert.deepEqual(installedPages([{ entries: [
    { id: '../bad', label: 'Bad', icon: 'x', order: 1, module: './bad.js' },
    { id: 'overview', label: 'Duplicate', icon: 'x', order: 2, module: './bad.js' },
    { id: 'unsafe', label: 'Unsafe', icon: 'x', order: 3, module: 'https://example.invalid/x.js' },
    { id: 'escape', label: 'Escape', icon: 'x', order: 4, module: './../../elsewhere/index.js' },
  ] }]).map(p => p.id), basePages.map(p => p.id));
});
