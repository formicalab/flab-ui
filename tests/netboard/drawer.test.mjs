// Unit tests of the pure parts of the drawer (www/js/core/drawer.js: when a key closes it, how a footer is normalized) and of the bridge live
// information (www/js/pages/interfaces/bridgelive.js: the mesh peers by interface). The drawer's DOM behavior (opening, replacing its content,
// Escape, the close button, closing on a route change) is checked in the browser by live.mjs.
// Usage: node drawer.test.mjs
import assert from 'node:assert/strict';
import { closesOnKey, footerNodes } from '../../www/js/core/drawer.js';
import { meshByIface } from '../../www/js/pages/interfaces/bridgelive.js';

let passed = 0;
const failures = [];
// Runs one named test and prints the outcome; the failures are counted for the exit code.
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failures.push(name); console.log(`FAIL  ${name}  -> ${e.message}`); }
}

test('Escape closes the drawer', () => {
  assert.equal(closesOnKey({ key: 'Escape' }), true);
});

test('another key does not', () => {
  for (const key of ['Enter', 'Tab', 'a', ' ', 'Esc']) assert.equal(closesOnKey({ key }), false, key);
});

test('Escape that a control already handled (a menu, an input method) does not close it', () => {
  assert.equal(closesOnKey({ key: 'Escape', defaultPrevented: true }), false);
  assert.equal(closesOnKey({ key: 'Escape', isComposing: true }), false);
});

test('Escape does not close the drawer while a modal dialog is open above it', () => {
  assert.equal(closesOnKey({ key: 'Escape' }, true), false);
  assert.equal(closesOnKey({ key: 'Escape' }, false), true);
});

test('a footer is a node, a list of nodes or nothing, and comes out as a flat list without holes', () => {
  const a = { n: 1 }, b = { n: 2 };
  assert.deepEqual(footerNodes(a), [a]);
  assert.deepEqual(footerNodes([a, [b, null], false, undefined]), [a, b]);
  assert.deepEqual(footerNodes(undefined), []);
  assert.deepEqual(footerNodes([]), []);
});

test('the mesh peers are found by interface name; no mesh gives an empty map', () => {
  const m = meshByIface({ nodes: [{ ifname: 'phy0-mesh0', mesh_id: 'm', peers: [{ mac: 'aa' }] }, { mesh_id: 'no-interface' }, { ifname: 'phy1-mesh0', mesh_id: 'n' }] });
  assert.deepEqual([...m.keys()], ['phy0-mesh0', 'phy1-mesh0']);
  assert.equal(m.get('phy0-mesh0').peers.length, 1);
  assert.deepEqual(m.get('phy1-mesh0').peers, []);
  assert.equal(meshByIface(null).size, 0);
  assert.equal(meshByIface({}).size, 0);
});

console.log(failures.length ? `\n${failures.length} test(s) FAILED: ${failures.join('; ')}` : `\nall ${passed} drawer checks passed`);
process.exit(failures.length ? 1 : 0);
