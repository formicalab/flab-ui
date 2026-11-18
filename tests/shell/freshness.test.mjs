// node --test tests/shell/freshness.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureCurrent } from '../../www/js/core/freshness.js';

function setup({
  stored,
  reply = { id: 'b2', files: ['js/main.js', 'js/core/app.js'] },
  failing = [],
  bodyFailures = [],
  waitForBody,
} = {}) {
  const data = new Map(stored === undefined ? [] : [['flab.build', stored]]);
  const fetched = [];
  let reloads = 0;
  return {
    data, fetched, reloads: () => reloads,
    options: {
      call: async () => { if (reply instanceof Error) throw reply; return reply; },
      load: async file => {
        fetched.push(file);
        return {
          ok: !failing.includes(file),
          arrayBuffer: async () => {
            if (waitForBody) await waitForBody(file);
            if (bodyFailures.includes(file)) throw new Error('body failed');
            return new ArrayBuffer(0);
          },
        };
      },
      storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) },
      reload: () => { reloads++; },
    },
  };
}

test('an unchanged build downloads and reloads nothing', async () => {
  const t = setup({ stored: 'b2' });
  assert.equal(await ensureCurrent(t.options), false);
  assert.deepEqual(t.fetched, []);
  assert.equal(t.reloads(), 0);
});

test('a changed build refreshes every file and the page itself, remembers the build and reloads', async () => {
  const t = setup({ stored: 'b1' });
  assert.equal(await ensureCurrent(t.options), true);
  assert.deepEqual([...t.fetched].sort(), ['./', 'js/core/app.js', 'js/main.js']);
  assert.equal(t.data.get('flab.build'), 'b2');
  assert.equal(t.reloads(), 1);
});

test('the first run refreshes the files but does not reload', async () => {
  const t = setup();
  assert.equal(await ensureCurrent(t.options), false);
  assert.equal(t.fetched.length, 3);
  assert.equal(t.data.get('flab.build'), 'b2');
  assert.equal(t.reloads(), 0);
});

test('a failed download keeps the old build so the refresh is retried, and does not reload', async () => {
  const t = setup({ stored: 'b1', failing: ['js/core/app.js'] });
  assert.equal(await ensureCurrent(t.options), false);
  assert.equal(t.data.get('flab.build'), 'b1');
  assert.equal(t.reloads(), 0);
});

test('a response-body failure keeps the old build and does not reload', async () => {
  const t = setup({ stored: 'b1', bodyFailures: ['js/core/app.js'] });
  assert.equal(await ensureCurrent(t.options), false);
  assert.equal(t.data.get('flab.build'), 'b1');
  assert.equal(t.reloads(), 0);
});

test('the build is not recorded and the page is not reloaded until response bodies finish', async () => {
  let releaseBody;
  const body = new Promise(resolve => { releaseBody = resolve; });
  const t = setup({ stored: 'b1', waitForBody: () => body });
  const refreshing = ensureCurrent(t.options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.data.get('flab.build'), 'b1');
  assert.equal(t.reloads(), 0);
  releaseBody();
  assert.equal(await refreshing, true);
  assert.equal(t.data.get('flab.build'), 'b2');
  assert.equal(t.reloads(), 1);
});

test('a router that cannot answer or answers oddly leaves the page alone', async () => {
  for (const reply of [new Error('denied'), {}, { id: 3, files: [] }, { id: 'b2', files: 'js' }]) {
    const t = setup({ stored: 'b1', reply });
    assert.equal(await ensureCurrent(t.options), false);
    assert.deepEqual(t.fetched, []);
    assert.equal(t.reloads(), 0);
  }
});
