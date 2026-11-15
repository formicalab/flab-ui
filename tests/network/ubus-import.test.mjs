// Node 22 has no Web Storage globals; explicitly remove newer Node versions' built-ins too.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const descriptors = new Map(['sessionStorage', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const realFetch = globalThis.fetch;
const core = file => pathToFileURL(path.resolve(import.meta.dirname, '..', '..', 'www', 'js', 'core', file));
let requests = 0;
try {
  for (const name of descriptors.keys()) {
    assert.equal(Reflect.deleteProperty(globalThis, name), true);
    assert.equal(name in globalThis, false);
  }
  globalThis.fetch = async () => { requests++; throw new Error('No network is allowed in this test'); };

  await import(core('uci.js').href);
  const { hasSession, can, login, clearSession } = await import(core('ubus.js').href);
  assert.equal(hasSession(), false);
  assert.equal(can('uci', 'set'), false);
  assert.doesNotThrow(clearSession);
  await assert.rejects(() => login('test', 'not-a-real-password'), /Browser session storage is required to sign in/);
  assert.equal(requests, 0, 'missing storage must reject login before sending credentials');
  assert.equal(hasSession(), false, 'pure imports must not fabricate a session');
  console.log('PASS  UCI/transport imports without Web Storage and login requires real storage');

  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() { throw new Error('Storage access denied'); },
  });
  const blocked = core('ubus.js');
  blocked.searchParams.set('storage-test', 'denied');
  await assert.rejects(() => import(blocked.href), /Storage access denied/, 'actual storage access errors must not be swallowed');
  console.log('PASS  unavailable storage is guarded, but actual storage access errors still propagate');
} finally {
  globalThis.fetch = realFetch;
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}
