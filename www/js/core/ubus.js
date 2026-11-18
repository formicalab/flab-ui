// ubus JSON-RPC transport over uhttpd's /ubus endpoint, plus session handling.
//
// Session state lives in sessionStorage, scoped to this tab (browser session restoration may preserve it). The ACLs
// granted at login are cached next to the session id; `can()` answers "may this login call that method?"
// without a round trip, so a page can disable controls the login is not allowed to use.

const NULL_SID = '00000000000000000000000000000000';   // the anonymous session rpcd gives to unauthenticated calls
const SESSION_TIMEOUT_S = 900;

// Leaves time for verification and confirmation in the 30s normal / 90s network rollback windows.
export const REQUEST_TIMEOUT_MS = 5000;
// Flab workers have a 24s deadline; allow their result to arrive before rpcd's own 30s request timeout.
export const PLUGIN_REQUEST_TIMEOUT_MS = 27000;

let sid = globalThis.sessionStorage?.getItem('sid') ?? null;
// The cached ACLs; unreadable stored data counts as none (the next sign-in stores them again).
let acls = (() => {
  try { return JSON.parse(globalThis.sessionStorage?.getItem('acls') ?? '{}') ?? {}; } catch { return {}; }
})();

// Raised when the session is gone (expired or destroyed); the shell answers by showing the sign-in screen.
export class AuthError extends Error {}

// An RPC target exists only when its ACL/object/method is installed. Optional page data may omit only this
// class of failure; timeouts, transport errors and backend failures must remain visible.
export class UnavailableError extends Error {}

// The session is alive, but its ACL does not permit the requested call.
export class AccessError extends Error {}

// Whether a session id is stored; says nothing about whether the router still accepts it.
export const hasSession = () => Boolean(sid);

const unavailable = (message, code) => {
  const error = new UnavailableError(message);
  error.code = code;
  return error;
};

// One JSON-RPC `call` to ubus. Returns the method's result object; throws on a transport error, a JSON-RPC
// error (flagged `denied` for -32002, which is both "expired" and "not allowed") or a nonzero ubus status.
async function rpc(obj, method, args = {}, token = sid || NULL_SID, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`The router did not answer ${obj}.${method} within ${timeoutMs / 1000} seconds.`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    // Include the response body in the deadline, not just receipt of the HTTP headers. Never retry a call:
    // an interrupted write may have succeeded on the router.
    return await Promise.race([deadline, (async () => {
      let res;
      try {
        res = await fetch('/ubus', {
          method: 'POST',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [token, obj, method, args] }),
          signal: controller.signal,
        });
      } catch {
        throw new Error('The router cannot be reached.');
      }
      if (!res.ok) throw new Error(`The router answered HTTP ${res.status} to ${obj}.${method}.`);
      let j;
      try { j = await res.json(); } catch { throw new Error(`The router sent an unreadable reply to ${obj}.${method}.`); }
      if (j?.error) {
        const message = j.error.message || 'The router rejected the ubus call.';
        if (j.error.code === -32601 || /not found|unknown (object|method)|method not found/i.test(message))
          throw unavailable(message, j.error.code);
        throw Object.assign(new Error(message), { denied: j.error.code === -32002 });
      }
      if (!Array.isArray(j?.result)) throw new Error(`The router sent an unexpected reply to ${obj}.${method}.`);
      const [code, data] = j.result;
      if (code !== 0) {
        const detail = typeof data?.error === 'string' ? data.error : '';
        const summary = detail.length > 500 ? `${detail.slice(0, 499)}…` : detail;
        const error = `${obj}.${method} failed (ubus code ${code})${summary ? `: ${summary}` : ''}`;
        // ubus 3 is METHOD_NOT_FOUND and 4 is NOT_FOUND. They represent an optional object/method that is
        // not installed, unlike NO_DATA, TIMEOUT or UNKNOWN_ERROR, which indicate a failing implementation.
        if (code === 3 || code === 4) throw unavailable(error, code);
        throw Object.assign(new Error(error), { denied: code === 6 });
      }
      return data;
    })()]);
  } finally {
    clearTimeout(timer);
  }
}

// Calls a ubus method. Flab workers may need 27s; native calls default to 5s. A caller may set timeoutMs,
// capped at 27s (always 5s for UCI writes/recovery). A -32002 reply means expiry or an ACL denial;
// session.access tells them apart without ever retrying the original call.
export async function ubus(obj, method, args, { timeoutMs = obj.startsWith('flab.') ? PLUGIN_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('The request deadline must be a positive finite number of milliseconds.');
  const deadlineMs = Math.min(timeoutMs, obj === 'uci' ? REQUEST_TIMEOUT_MS : PLUGIN_REQUEST_TIMEOUT_MS);
  try {
    return await rpc(obj, method, args, undefined, deadlineMs);
  } catch (e) {
    if (!e.denied) throw e;
    try {
      await rpc('session', 'access', { scope: 'ubus', object: obj, function: method });
    } catch (probeError) {
      if (probeError.denied) throw new AuthError('Session expired');
      throw probeError;
    }
    throw new AccessError(`Access denied by ACL: ${obj}.${method}`);
  }
}

// For an installed feature the page can do without: resolves to null only when an optional ACL, object or
// method is genuinely unavailable. Authentication, transport, protocol and backend failures remain visible.
export const optional = promise => promise.catch(e => {
  if (e instanceof AuthError) throw e;
  if (e instanceof AccessError || e instanceof UnavailableError) return null;
  throw e;
});

// Whether the signed-in login may call `obj.method`, from the ACLs rpcd returned at sign-in. "*" grants every
// method, and an object named "*" (root's ACL) every object.
export function can(obj, method) {
  const methods = [...(acls.ubus?.[obj] ?? []), ...(acls.ubus?.['*'] ?? [])];
  return methods.includes('*') || methods.includes(method);
}

// Signs in with the rpcd login, keeps the session id (and the granted ACLs) for this tab only.
export async function login(username, password) {
  const storage = globalThis.sessionStorage;
  if (!storage) throw new Error('Browser session storage is required to sign in.');
  const r = await rpc('session', 'login', { username, password, timeout: SESSION_TIMEOUT_S }, NULL_SID);
  sid = r.ubus_rpc_session;
  acls = r.acls ?? {};
  storage.setItem('sid', sid);
  storage.setItem('acls', JSON.stringify(acls));
}

// Forgets the session locally (the router-side session simply times out).
export function clearSession() {
  sid = null;
  acls = {};
  globalThis.sessionStorage?.removeItem('sid');
  globalThis.sessionStorage?.removeItem('acls');
}

// Destroys the session on the router, then forgets it locally.
export async function logout() {
  try { await rpc('session', 'destroy'); } catch { /* session already gone */ }
  clearSession();
}
