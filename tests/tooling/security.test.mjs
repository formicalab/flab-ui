// Static backend security contract: production plugins stay deferred and sensitive ubus writes stay serialized.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pluginsDir = path.join(root, 'rpcd', 'ucode');
const aclDir = path.join(root, 'rpcd', 'acl.d');
const plugins = readdirSync(pluginsDir).filter(file => file.endsWith('.uc'));
for (const file of plugins) {
  const source = readFileSync(path.join(pluginsDir, file), 'utf8');
  assert.match(source, /import \{ deferred \} from 'flab\.worker'/, `${file} imports the deferred worker wrapper`);
  assert.match(source, /return deferred\(/, `${file} registers only through deferred()`);
}

const worker = readFileSync(path.join(root, 'rpcd', 'lib', 'flab', 'worker.uc'), 'utf8');
const mutating = new Set(worker.match(/const MUTATING = \[([^\]]+)\]/)?.[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) ?? []);
const ignoredWriteMethods = new Set(['download']);
for (const file of readdirSync(aclDir).filter(file => file.endsWith('.json'))) {
  const acl = JSON.parse(readFileSync(path.join(aclDir, file), 'utf8'));
  for (const [object, methods] of Object.entries(acl.flab?.write?.ubus ?? {})) {
    if (!object.startsWith('flab.')) continue;
    for (const method of methods)
      if (!ignoredWriteMethods.has(method))
        assert.ok(mutating.has(method), `${file}: write method ${method} is serialized by flab.worker`);
  }
}

const diag = readFileSync(path.join(pluginsDir, 'flab.diag.uc'), 'utf8');
assert.doesNotMatch(diag, /join\(' ', built\.argv\)/, 'simple diagnostic commands use the shared quoting helper');
console.log('PASS production plugins are deferred and sensitive write methods are serialized');
