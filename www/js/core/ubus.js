// ubus JSON-RPC transport over uhttpd's /ubus endpoint, plus session handling.

const NULL_SID = '00000000000000000000000000000000';
const SESSION_TIMEOUT_S = 900;

let sid = sessionStorage.getItem('sid');

export class AuthError extends Error {}

export const hasSession = () => Boolean(sid);

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

export async function login(username, password) {
  const r = await rpc('session', 'login', { username, password, timeout: SESSION_TIMEOUT_S }, NULL_SID);
  sid = r.ubus_rpc_session;
  sessionStorage.setItem('sid', sid);
}

export function clearSession() {
  sid = null;
  sessionStorage.removeItem('sid');
}

export async function logout() {
  try { await rpc('session', 'destroy'); } catch { /* session already gone */ }
  clearSession();
}
