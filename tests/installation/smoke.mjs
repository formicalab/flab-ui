// Called only by run.sh against an ephemeral, loopback-only installed image.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const base = new URL(process.env.FLAB_SMOKE_URL);
assert.equal(base.hostname, '127.0.0.1');
assert.ok(Number(base.port) > 1024);
const installed = process.env.FLAB_INSTALLED_ROOT;
assert.ok(installed, 'Installed rootfs path is required; do not run against a router.');
const anonymous = '0'.repeat(32);
let sequence = 0;
async function rpc(sid, object, method, args = {}) {
  const response = await fetch(new URL('/ubus', base), {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'call', params: [sid, object, method, args] }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
function data(reply) {
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.equal(reply.result?.[0], 0, JSON.stringify(reply));
  return reply.result[1];
}
const login = async (username, password = 'flab-ci-only') => data(await rpc(anonymous, 'session', 'login', { username, password }));
const denied = reply => assert.ok(reply.error?.code === -32002 || reply.result?.[0] === 6, JSON.stringify(reply));
denied(await rpc(anonymous, 'uci', 'get', { config: 'network' }));
denied(await rpc(anonymous, 'session', 'login', { username: 'root', password: 'wrong-password' }));
const root = await login('root');
const editor = await login('flab-editor');
const reader = await login('flab-reader');
assert.notEqual(editor.ubus_rpc_session, anonymous);

// Independently assert important capabilities so a missing fragment cannot simply weaken the expected union.
for (const [object, method] of [['uci', 'get'], ['uci', 'changes'], ['uci', 'apply'], ['uci', 'confirm'], ['uci', 'rollback'], ['flab.network', 'config']]) {
  assert.ok(editor.acls.ubus[object]?.includes(method), `Installed editor ACL missing ${object}.${method}`);
}
for (const config of ['network', 'firewall', 'dhcp', 'system']) {
  assert.ok(editor.acls.uci[config]?.includes('read'), `${config} read ACL missing`);
  assert.ok(editor.acls.uci[config]?.includes('write'), `${config} write ACL missing`);
}
assert.equal(editor.acls.ubus['*'], undefined, 'Role must not inherit root wildcard access.');
assert.equal(reader.acls.ubus.uci?.includes('apply'), false);

// Compare rpcd's real login ACLs with the fragments installed by the actual package, not checkout files.
const aclDirectory = path.join(installed, 'usr/share/rpcd/acl.d');
const fragments = (await readdir(aclDirectory)).filter(file => /^flab-.*\.json$/.test(file));
const expectedFiles = (await readdir(new URL('../../rpcd/acl.d/', import.meta.url))).filter(file => /^flab-.*\.json$/.test(file));
assert.deepEqual(fragments.sort(), expectedFiles.sort(), 'Every packaged ACL fragment must actually be installed.');
for (const file of fragments) {
  const acl = JSON.parse(await readFile(path.join(aclDirectory, file), 'utf8')).flab;
  assert.ok(acl, `${file} missing flab role`);
  for (const grants of [acl.read, acl.write]) {
    for (const [object, methods] of Object.entries(grants?.ubus ?? {})) {
      for (const method of methods) assert.ok(editor.acls.ubus[object]?.includes(method), `${file}: missing ${object}.${method}`);
    }
  }
}
data(await rpc(editor.ubus_rpc_session, 'uci', 'get', { config: 'network' }));
data(await rpc(editor.ubus_rpc_session, 'flab.network', 'config'));
data(await rpc(reader.ubus_rpc_session, 'uci', 'get', { config: 'network' }));
denied(await rpc(reader.ubus_rpc_session, 'uci', 'set', { config: 'network', section: 'missing', values: { metric: '1' } }));
denied(await rpc(editor.ubus_rpc_session, 'uci', 'get', { config: 'rpcd' }));
denied(await rpc(editor.ubus_rpc_session, 'file', 'exec', { command: '/bin/true' }));
denied(await rpc(editor.ubus_rpc_session, 'session', 'grant', { objects: [['*', '*']] }));
data(await rpc(editor.ubus_rpc_session, 'session', 'destroy'));
denied(await rpc(editor.ubus_rpc_session, 'uci', 'get', { config: 'network' }));
data(await rpc(root.ubus_rpc_session, 'session', 'destroy'));
data(await rpc(reader.ubus_rpc_session, 'session', 'destroy'));
console.log(`PASS installed package, ${fragments.length} real ACL fragments, root/editor/reader login and denials`);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const modules = new Set();
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('.js')) modules.add(new URL(request.url()).pathname); });
  await page.goto(new URL('/flab/#settings', base).href);
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal([...modules].filter(url => url.includes('/pages/') && !url.endsWith('/pages/index.js')).length, 0, 'Login must not fetch page implementations.');
  assert.ok(modules.size < 20, `Unexpected eager module graph: ${modules.size}`);
  await page.getByPlaceholder('User name', { exact: true }).fill('root');
  await page.getByPlaceholder('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Sign-in failed' }).waitFor();
  await page.getByPlaceholder('Password', { exact: true }).fill('flab-ci-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'System settings', exact: true }).waitFor();
  await page.locator('.settings-form #hostname').waitFor();
  await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .spinner-border'));
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Unable to load System settings' }).count(), 0);
  assert.ok([...modules].some(url => url.endsWith('/pages/settings/index.js')));
  assert.equal([...modules].some(url => url.endsWith('/pages/toolbox/index.js')), false, 'Settings must not preload Toolbox.');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  console.log(`PASS installed browser login/logout and native lazy loading (${modules.size} modules after navigation)`);
} finally {
  await browser.close();
}
