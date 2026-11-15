import assert from 'node:assert/strict';
import { MAX_DIAG_TEXT, retainOutput } from '../../www/js/pages/toolbox/output.js';

let text = '';
for (let i = 0; i < 10; i++) text = retainOutput(text, 'x'.repeat(65536)).text;
assert.equal(text.length, MAX_DIAG_TEXT, 'many legal chunks cannot accumulate without bound');
assert.equal(retainOutput('abc', 'def').text, 'abcdef');
assert.equal(retainOutput('abc', 'def').limited, false);
assert.equal(retainOutput('x'.repeat(MAX_DIAG_TEXT - 1), 'yz').limited, true);
assert.equal(retainOutput('x'.repeat(MAX_DIAG_TEXT), '').limited, true);
console.log('PASS browser output retention budget');

globalThis.sessionStorage = { getItem: () => null };
const { track } = await import('../../www/js/pages/toolbox/diag.js');
const original = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
const scheduled = new Map();
let sequence = 0, reads = 0, stops = 0, finished = false;
globalThis.setTimeout = (fn, delay) => { const id = ++sequence; scheduled.set(id, { fn, delay }); return id; };
globalThis.clearTimeout = id => scheduled.delete(id);
globalThis.fetch = async (url, options) => {
  const [, , method] = JSON.parse(options.body).params;
  if (method === 'stop') { stops++; return { ok: true, json: async () => ({ result: [0, { ok: true }] }) }; }
  reads++;
  const tail = finished && reads === 4;
  return {
    ok: true,
    json: async () => ({ result: [0, { ok: true, running: !finished, truncated: finished && !tail, text: tail ? 'the end' : 'x'.repeat(65536), size: tail ? 196615 : reads * 65536 }] }),
  };
};
const stateOf = () => {
  let connectedReads = 0;
  return {
    diag: {
      job: { id: 'budget-test', running: true, text: '', size: 0 },
      // The polling guard sees the mounted view; repaint is unnecessary in this transport/state test.
      resultEl: { get isConnected() { return ++connectedReads % 2 === 1; } },
      timer: null,
    },
    rerender() {},
  };
};
const tick = async () => {
  const [id, timer] = [...scheduled].find(([, v]) => v.delay < 1000);
  scheduled.delete(id);
  await timer.fn();
};
try {
  const state = stateOf();
  track(state);
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(state.diag.job.text.length, MAX_DIAG_TEXT);
  assert.equal(state.diag.job.running, false);
  assert.match(state.diag.job.error, /limit.*truncated/);
  assert.equal(stops, 1, 'reaching the browser budget stops the remote producer');
  assert.equal(scheduled.size, 0, 'no more polling is scheduled after the cap');
  reads = 0; stops = 0; finished = true;
  const backlog = stateOf();
  track(backlog);
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(backlog.diag.job.text.length, 196615, 'a completed job still drains every retained chunk');
  assert.equal(backlog.diag.job.running, false);
  assert.equal(stops, 0);
  assert.equal(scheduled.size, 0);
  console.log('PASS diagnostic polling stops at the total cap and drains completed-job backlogs');
} finally {
  Object.assign(globalThis, original);
}
