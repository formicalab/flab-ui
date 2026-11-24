// node --test tests/shell/session.test.mjs
// The browser side of authentication (www/js/core/ubus.js): sign-in, the session id and its timing, and sign-out.
// The expired-versus-denied classification and optional() are covered in tests/network/uci.test.mjs.
// A fake /ubus replaces the router.
import assert from 'node:assert/strict';
import test from 'node:test';

const store = new Map();
globalThis.sessionStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const {
  login, logout, clearSession, hasSession, can, ubus, sessionStatus, sessionNotice, SESSION_TIMEOUT_S, SESSION_WARNING_S,
} = await import('../../www/js/core/ubus.js');

const NULL_SID = '0'.repeat(32);
const SID = 'a'.repeat(32);
const denied = { error: { code: -32002, message: 'Access denied' } };
const ok = (data = {}) => ({ result: [0, data] });

// Replaces fetch with a router; `answer({ token, obj, method, args })` returns the JSON-RPC reply (or throws to
// simulate an unreachable router). Returns the list of calls it received.
function router(answer) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const [token, obj, method, args] = JSON.parse(init.body).params;
    const call = { token, obj, method, args };
    calls.push(call);
    const reply = await answer(call);
    return { ok: true, json: async () => reply };
  };
  return calls;
}

const signIn = async (options, acls = { ubus: { uci: ['get'] } }) => {
  router(() => ok({ ubus_rpc_session: SID, acls }));
  await login('root', 'secret', options);
};

test.beforeEach(() => { clearSession(); store.clear(); });

test('login calls session.login anonymously and keeps the session id, ACLs and timing', async () => {
  const calls = router(() => ok({ ubus_rpc_session: SID, acls: { ubus: { uci: ['get'], 'flab.dns': ['*'] } } }));
  await login('root', 'secret');
  assert.deepEqual(calls[0], { token: NULL_SID, obj: 'session', method: 'login', args: { username: 'root', password: 'secret', timeout: SESSION_TIMEOUT_S } });
  assert.equal(hasSession(), true);
  assert.equal(store.get('sid'), SID);
  assert.ok(can('uci', 'get') && !can('uci', 'set') && can('flab.dns', 'status'));

  const later = router(() => ok());
  await ubus('system', 'board');
  assert.equal(later[0].token, SID, 'later calls carry the session id');
});

test('a refused login rejects as denied and leaves no session', async () => {
  router(() => denied);
  await assert.rejects(login('root', 'wrong'), e => e.denied === true);
  assert.equal(hasSession(), false);
  assert.equal(store.has('sid'), false);

  router(() => { throw new Error('offline'); });
  await assert.rejects(login('root', 'x'), /cannot be reached/);
  assert.equal(hasSession(), false);
});

test('login rejects an invalid timeout or maximum age before calling the router', async () => {
  const calls = router(() => ok({ ubus_rpc_session: SID }));
  await assert.rejects(login('root', 'x', { timeoutS: 0 }), /timeout/);
  await assert.rejects(login('root', 'x', { maxAgeS: -1 }), /maximum session age/);
  assert.equal(calls.length, 0);
});

test('logout destroys the session on the router and forgets it', async () => {
  await signIn();
  const calls = router(() => ok());
  const result = await logout();
  assert.equal(result.destroyed, true);
  assert.deepEqual(calls.map(c => [c.token, c.obj, c.method]), [[SID, 'session', 'destroy']]);
  assert.equal(hasSession(), false);
  assert.ok(!store.has('sid') && !store.has('acls') && !store.has('sessionMeta'));
  assert.equal(can('uci', 'get'), false);
});

test('logout retries once, and still signs out locally when the router cannot be told', async () => {
  await signIn();
  let n = 0;
  let calls = router(() => { if (++n === 1) throw new Error('offline'); return ok(); });
  assert.equal((await logout()).destroyed, true);
  assert.equal(calls.length, 2);

  await signIn();
  calls = router(() => { throw new Error('offline'); });
  const result = await logout();
  assert.equal(result.destroyed, false);
  assert.ok(result.idleLeftS > 0, 'the caller can say when the router session ends by itself');
  assert.equal(calls.length, 2);
  assert.equal(hasSession(), false);
});

test('logout of a session the router already dropped counts as destroyed, with no retry', async () => {
  await signIn();
  const calls = router(() => denied);
  assert.equal((await logout()).destroyed, true);
  assert.equal(calls.length, 1);
});

test('session timing: any accepted call restarts the idle countdown, a denied one does not', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  await signIn({ timeoutS: 600, maxAgeS: 3600 });
  assert.deepEqual(sessionStatus(), { idleLeftS: 600, ageLeftS: 3600 });

  t.mock.timers.tick(500_000);
  assert.deepEqual(sessionStatus(), { idleLeftS: 100, ageLeftS: 3100 });

  router(() => ({ result: [6, {}] }));
  await assert.rejects(ubus('uci', 'get', {}));
  assert.equal(sessionStatus().idleLeftS, 100, 'a permission-denied reply does not prove the session is alive');

  router(() => ok());
  await ubus('system', 'board');
  assert.deepEqual(sessionStatus(), { idleLeftS: 600, ageLeftS: 3100 }, 'activity extends the idle time but not the age');

  t.mock.timers.tick(700_000);
  assert.equal(sessionStatus().idleLeftS, 0);
  assert.equal(sessionStatus(Date.now() + 10_000_000).ageLeftS, 0);
});

test('without a maximum age only the idle time counts, and no session has no status', async () => {
  assert.equal(sessionStatus(), null);
  await signIn();
  assert.equal(sessionStatus().ageLeftS, null);
});

test('a stored session without timing data is treated as active just now', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  await signIn();
  store.delete('sessionMeta');
  const { sessionStatus: fresh } = await import(`../../www/js/core/ubus.js?reload=${Math.random()}`);
  assert.equal(fresh().idleLeftS, SESSION_TIMEOUT_S);
});

test('the session notice warns before the idle limit, and before a maximum age that cannot be extended', () => {
  assert.equal(sessionNotice(null), null);
  assert.equal(sessionNotice({ idleLeftS: 300, ageLeftS: null }), null);
  assert.deepEqual(sessionNotice({ idleLeftS: SESSION_WARNING_S, ageLeftS: null }), { kind: 'idle', seconds: SESSION_WARNING_S });
  assert.equal(sessionNotice({ idleLeftS: 0, ageLeftS: null }), null, 'already ended: the next call shows the sign-in');
  assert.deepEqual(sessionNotice({ idleLeftS: 30, ageLeftS: 45 }), { kind: 'age', seconds: 45 }, 'the age limit wins');
  assert.equal(sessionNotice({ idleLeftS: 800, ageLeftS: 3000 }), null);
});
