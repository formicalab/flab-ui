// Pure editor regressions: fake DOM and UCI, no browser, router or additional dependencies.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const store = new Map([['sid', 'test'], ['acls', JSON.stringify({ ubus: { '*': ['*'] } })]]);
globalThis.sessionStorage = { getItem: k => store.get(k) ?? null };
function element(tag) {
  return {
    tag, children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {},
    classList: { add() {}, remove() {}, toggle() {} },
  };
}
globalThis.document = { createElement: element, createElementNS: (_, tag) => element(tag), activeElement: null };
let signIns = 0;
globalThis.location = { reload: () => { signIns++; } };
globalThis.fetch = () => { throw new Error('Tests must not access the network'); };
const core = f => import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/core', f)).href);
const { createEditor } = await core('editpage.js');
const { uci } = await core('uci.js');
const { AuthError } = await core('ubus.js');
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
const findButton = (node, label) => {
  if (node?.tag === 'button' && text(node) === label) return node;
  for (const child of node?.children ?? []) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return null;
};
const methods = ['changes', 'set', 'apply', 'confirm', 'rollback', 'revert'];
const original = Object.fromEntries(methods.map(m => [m, uci[m]]));
let calls = [];
function reset() {
  calls = [];
  for (const method of methods) {
    uci[method] = async (...args) => { calls.push([method, ...args]); return method === 'changes' ? {} : undefined; };
  }
}
function makeEditor(overrides = {}) {
  let reloads = 0;
  const editor = createEditor({
    config: 'system', settleMs: 0,
    model: {
      draftFrom: base => ({ value: base.value }),
      isDirty: (base, draft) => base.value !== draft.value,
      problems: () => ({ errors: [], warnings: [] }),
      changesOf: () => [],
      plan: (_, draft) => [{ op: 'set', config: 'system', section: 'main', values: { value: draft.value } }],
    },
    readAfter: async () => ({ value: 'new' }),
    verify: () => {},
    ...overrides,
  });
  const reload = async () => { reloads++; editor.begin({ value: 'new' }, () => {}); };
  editor.begin({ value: 'old' }, () => {});
  editor.state.draft.value = 'new';
  const bar = editor.attach(reload);
  return {
    editor, reloads: () => reloads,
    save: findButton(bar, 'Save and apply').onclick,
    discard: findButton(bar, 'Discard edits').onclick,
  };
}

try {
  reset();
  let approval = deferred(), confirmations = 0, otherConfirmations = 0;
  const first = makeEditor({ confirmSave: () => { confirmations++; return approval.promise; } });
  const other = makeEditor({ confirmSave: async () => { otherConfirmations++; return true; } });
  const pending = first.save();
  assert.equal(first.editor.state.busy, true, 'busy is acquired before awaiting the dialog');
  await first.save();
  await other.save();
  await first.discard();
  assert.equal(confirmations, 1, 'a repeated save cannot open another confirmation');
  assert.equal(otherConfirmations, 0, 'another editor cannot open a concurrent confirmation');
  assert.equal(first.editor.state.draft.value, 'new', 'discard cannot clear a draft while its dialog is pending');
  assert.equal(first.reloads(), 0);
  assert.equal(calls.length, 0, 'no preflight or writes before approval');
  approval.resolve(false);
  await pending;
  assert.equal(first.editor.state.busy, false, 'cancelling releases the editor lock');
  assert.equal(first.editor.state.message, null);
  assert.equal(first.reloads(), 0, 'cancelling does not reload or discard the draft');

  approval = deferred();
  const staging = deferred();
  uci.set = async (...args) => { calls.push(['set', ...args]); await staging.promise; };
  const approved = first.save();
  approval.resolve(true);
  for (let i = 0; i < 10 && !calls.some(c => c[0] === 'set'); i++) await new Promise(setImmediate);
  assert.equal(calls.filter(c => c[0] === 'set').length, 1, 'the approved save has begun staging');
  await first.save();
  await first.discard();
  await other.save();
  assert.equal(confirmations, 2, 'saving remains guarded after approval');
  assert.equal(otherConfirmations, 0);
  assert.equal(first.reloads(), 0, 'discard stays guarded during staging');
  staging.resolve();
  await approved;
  assert.deepEqual(calls.map(c => c[0]), ['changes', 'set', 'apply', 'confirm']);
  assert.equal(first.editor.state.busy, false);
  assert.equal(first.editor.state.message.kind, 'ok');
  assert.equal(first.editor.state.base.value, 'new', 'reload refreshes the form after success');
  assert.equal(first.editor.state.draft.value, 'new');
  assert.equal(first.editor.dirty(), false);
  await other.save();
  assert.equal(otherConfirmations, 1, 'completion releases the cross-editor lock');
  assert.equal(other.editor.state.message.kind, 'ok');
  console.log('PASS  confirmation, save and discard are exclusive across editors and unlock after cancellation/success');

  reset();
  const staged = { system: [], firewall: [['set', 'rule', 'enabled', '0']] };
  uci.changes = async (...args) => { calls.push(['changes', ...args]); return staged; };
  const page = makeEditor();
  let data = await page.editor.withStaged({});
  assert.equal(data.staged, 1, 'the banner counts unrelated configurations too');
  assert.equal(data.stagedHere, 0);
  assert.equal(calls[0].length, 1, 'staging is read for the whole session');
  let notes = page.editor.notes(data).filter(Boolean);
  assert.match(text(notes[0]), /saving would apply them too and is blocked/);
  assert.equal(findButton(notes[0], "Discard this page's staged changes"), null, 'unrelated changes are not offered for discard');
  await page.save();
  assert.match(page.editor.state.message.text, /already staged.*"firewall"/);
  assert.ok(calls.every(c => c[0] === 'changes'), 'unrelated staging blocks writes and is never reverted');

  staged.system = [['set', 'main', 'value', 'new']];
  uci.revert = async config => { calls.push(['revert', config]); staged[config] = []; };
  data = await page.editor.withStaged({});
  notes = page.editor.notes(data).filter(Boolean);
  await findButton(notes[0], "Discard this page's staged changes").onclick();
  assert.deepEqual(calls.filter(c => c[0] === 'revert'), [['revert', 'system']], 'manual discard only touches this editor');
  assert.equal(staged.firewall.length, 1, 'unrelated config is preserved');
  assert.equal(page.editor.state.message.kind, 'ok');
  uci.changes = async () => { throw new Error('preflight unavailable'); };
  await assert.rejects(() => page.editor.withStaged({}), /preflight unavailable/, 'failed staged reads are not silently changed to zero');
  console.log('PASS  session-wide staging is visible, fails closed and only owned configs can be discarded');

  reset();
  const expiredDialog = makeEditor({ confirmSave: async () => { throw new AuthError('Session expired'); } });
  await expiredDialog.save();
  assert.equal(signIns, 1, 'dialog AuthError triggers sign-in');
  assert.equal(expiredDialog.editor.state.busy, false, 'an expired session releases the dialog lock');
  const expiredVerify = makeEditor({ verify: () => { throw new AuthError('Session expired'); } });
  await expiredVerify.save();
  assert.equal(signIns, 2, 'verification AuthError survives recovery and triggers sign-in');
  assert.equal(expiredVerify.editor.state.busy, false);
  assert.equal(expiredVerify.editor.state.draft.value, 'new', 'expiry preserves the unsaved draft');
  const retry = makeEditor();
  await retry.save();
  assert.equal(retry.editor.state.message.kind, 'ok', 'the lock is released after session expiry');
  console.log('PASS  expired sessions during dialogs/verification retain sign-in behavior and release locks');
} finally {
  Object.assign(uci, original);
}
console.log('all editor safety checks passed');
