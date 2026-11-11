// ubus JSON-RPC transport over uhttpd's /ubus endpoint, plus session handling.
//
// Session state lives in sessionStorage, so it ends with the tab and is never written to disk. The ACLs
// granted at login are cached next to the session id; `can()` answers "may this login call that method?"
// without a round trip, so a page can disable controls the login is not allowed to use.

const NULL_SID = '00000000000000000000000000000000';   // the anonymous session rpcd gives to unauthenticated calls
const SESSION_TIMEOUT_S = 900;

let sid = sessionStorage.getItem('sid');
let acls = JSON.parse(sessionStorage.getItem('acls') ?? '{}');

// Raised when the session is gone (expired or destroyed); the shell answers by showing the sign-in screen.
export class AuthError extends Error {}

// Whether a session id is stored; says nothing about whether the router still accepts it.
export const hasSession = () => Boolean(sid);

// One JSON-RPC `call` to ubus. Returns the method's result object; throws on a transport error, a JSON-RPC
// error (flagged `denied` for -32002, which is both "expired" and "not allowed") or a nonzero ubus status.
async function rpc(obj, method, args = {}, token = sid || NULL_SID) {
  const res = await fetch('/ubus', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [token, obj, method, args] }),
  });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { denied: j.error.code === -32002 });
  const [code, data] = j.result;
  if (code !== 0) throw new Error(`${obj}.${method} failed (ubus code ${code})`);
  return data;
}

// Calls a ubus method. A -32002 reply means either an expired session or an ACL denial;
// session.access tells them apart so the UI can react correctly.
export async function ubus(obj, method, args) {
  try {
    return await rpc(obj, method, args);
  } catch (e) {
    if (!e.denied) throw e;
    try {
      await rpc('session', 'access', { scope: 'ubus', object: obj, function: method });
    } catch {
      throw new AuthError('Session expired');
    }
    throw new Error(`Access denied by ACL: ${obj}.${method}`);
  }
}
// For data a page can do without (an optional plugin, an ACL that was not granted): resolves to null instead
// of failing the page. An expired session is still raised, because the whole page needs a new sign-in then.
export const optional = promise => promise.catch(e => {
  if (e instanceof AuthError) throw e;
  return null;
});

// Whether the signed-in login may call `obj.method`, from the ACLs rpcd returned at sign-in. "*" grants every
// method, and an object named "*" (root's ACL) every object.
export function can(obj, method) {
  const methods = [...(acls.ubus?.[obj] ?? []), ...(acls.ubus?.['*'] ?? [])];
  return methods.includes('*') || methods.includes(method);
}

// Signs in with the rpcd login, keeps the session id (and the granted ACLs) for this tab only.
export async function login(username, password) {
  const r = await rpc('session', 'login', { username, password, timeout: SESSION_TIMEOUT_S }, NULL_SID);
  sid = r.ubus_rpc_session;
  acls = r.acls ?? {};
  sessionStorage.setItem('sid', sid);
  sessionStorage.setItem('acls', JSON.stringify(acls));
}

// Forgets the session locally (the router-side session simply times out).
export function clearSession() {
  sid = null;
  acls = {};
  sessionStorage.removeItem('sid');
  sessionStorage.removeItem('acls');
}

// Destroys the session on the router, then forgets it locally.
export async function logout() {
  try { await rpc('session', 'destroy'); } catch { /* session already gone */ }
  clearSession();
}
