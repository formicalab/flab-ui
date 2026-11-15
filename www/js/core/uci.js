// The one place the browser talks to rpcd's native `uci` object, for configuration changes. No page should
// call ubus('uci', ...) directly: going through here keeps every edit staged, reviewable and reversible.
//
// How a change flows (all of it is rpcd's own `uci` object):
//   1. stage     `set` / `add` / `delete` write into the session's staging area (/tmp/.uci); the real
//                configuration on flash is untouched until apply.
//   2. review    `changes` lists what is staged; `revert` throws it away.
//   3. apply     `apply` with `rollback: true` commits the staged changes and reloads the affected
//                services, and starts a countdown (`timeout` seconds).
//   4. confirm   the UI checks that it can still reach the router and calls `confirm` within the countdown;
//                if it cannot (the change cut the connection), rpcd restores the previous configuration by
//                itself. That rollback is what makes it safe to edit network and firewall settings remotely.
//
// What a login may change is decided by the router, not here: the UI signs in as root, so
// writing is allowed, and a login without the `uci` write methods gets "Access denied by ACL" from every
// method below. Pages do not call the steps one by one: applyChange() at the bottom runs stage, apply, verify
// and confirm with rollback protection and explicit recovery errors.
import { AuthError, REQUEST_TIMEOUT_MS, ubus } from './ubus.js';

// Seconds the router waits for `confirm` after an apply before it rolls the change back.
export const APPLY_TIMEOUT_S = 30;

// Builds the API on top of a ubus-like function `call(object, method, args)`; injectable so it can be tested
// without a router. The default export below uses the real transport.
export function createUci(call) {
  return {
    // The names of the configs the login may read.
    configs: async () => (await call('uci', 'configs', {})).configs ?? [],

    // A whole config ({ section: { '.type': ..., option: value } }), one section, or one option's value.
    // Staged changes are included: this reads what the configuration will look like after apply.
    async get(config, section, option) {
      const args = { config, ...(section ? { section } : {}), ...(option ? { option } : {}) };
      const r = await call('uci', 'get', args);
      return option ? r.value : r.values;
    },

    // Only the sections of one type ({ section: { '.type': ..., option: value } }), for a config that holds secrets elsewhere (the
    // network config keeps keys and passwords in its interface sections, so a page that needs bridge-vlan sections asks for
    // that type alone). Staged changes are included, as with get().
    async getByType(config, type) {
      return (await call('uci', 'get', { config, type })).values ?? {};
    },

    // Stages option values for an existing section: values = { option: value | [list] }. To remove an option use
    // delete(); rpcd rejects null values.
    set: (config, section, values) => call('uci', 'set', { config, section, values }),

    // Stages a new section and returns its name (named when `name` is given, else rpcd makes an anonymous one).
    async add(config, type, values = {}, name) {
      const r = await call('uci', 'add', { config, type, values, ...(name ? { name } : {}) });
      return r.section;
    },

    // Stages the deletion of a section, or of only some of its options.
    delete: (config, section, options) => call('uci', 'delete', { config, section, ...(options ? { options } : {}) }),

    // Stages the order of the sections of a config: `sections` lists section names (all of the config, in the order they should have).
    order: (config, sections) => call('uci', 'order', { config, sections }),

    // What is staged by this session: { config: [[operation, section, option, value], ...] }; empty when nothing
    // is pending. rpcd keeps the staging area per session, and puts the edits of a rolled-back apply back
    // into it. rpcd answers with a keyed table for all configs but a bare list when one config is named; both
    // are returned in the keyed form.
    async changes(config) {
      const r = (await call('uci', 'changes', config ? { config } : {}))?.changes;
      if (!r || typeof r !== 'object' || (Array.isArray(r) && !config && r.length)
        || (!Array.isArray(r) && Object.values(r).some(list => !Array.isArray(list)))) {
        throw new Error('The router sent an unreadable reply to uci.changes; staged changes could not be checked.');
      }
      return Array.isArray(r) ? (r.length ? { [config]: r } : {}) : r;
    },

    // The number of staged changes, for a "N changes pending" indicator.
    async pending(config) {
      return Object.values(await this.changes(config)).reduce((n, list) => n + list.length, 0);
    },

    // Throws away staged changes of one config (or of all configs when none is named).
    async revert(config) {
      const names = config ? [config] : Object.keys(await this.changes());
      for (const name of names) await call('uci', 'revert', { config: name });
    },

    // Commits the staged changes and starts the rollback countdown. Call confirm() within `timeout` seconds
    // after checking the router is still reachable, or the previous configuration comes back.
    apply: (timeout = APPLY_TIMEOUT_S) => call('uci', 'apply', { rollback: true, timeout }),

    // Keeps the applied configuration and cancels the rollback.
    confirm: () => call('uci', 'confirm', {}),

    // Restores the configuration from before the last apply, without waiting for the countdown.
    rollback: () => call('uci', 'rollback', {}),
  };
}

// The real thing: the same calls over the session's transport.
export const uci = createUci(ubus);

// How long to wait after `apply` before verifying, so services that reload because of the change have restarted.
const SETTLE_MS = 1500;
let applying = false;

// Runs a whole change with its safety net and is what pages should call instead of the steps above:
//   1. refuses to start when anything is already staged in this session (apply would commit it too);
//   2. `stage(uci)` stages the edits; if it fails, cleanup is attempted;
//   3. apply with the rollback countdown; if that fails, rollback and cleanup are attempted;
//   4. `verify()` must throw when the router does not look right after the change (read it back, check it
//      is still reachable); then rollback is requested instead of waiting for the countdown;
//   5. `confirm` keeps the change.
// Throws on failure. Only an acknowledged rollback is reported as confirmed; a lost reply leaves the outcome uncertain.
// rpcd stages per session and, after any rollback, puts the rolled-back edits back into
// the staging area so they can be retried; cleanup attempts to discard them before another save.
// `configs` scopes cleanup only: unrelated configurations must never be discarded by this page.
export async function applyChange(ed, configs, stage, verify, {
  timeoutS = APPLY_TIMEOUT_S, settleMs = SETTLE_MS, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => performance.now(),
} = {}) {
  if (applying) throw new Error('Another configuration change is already in progress; wait for it to finish.');
  applying = true;
  const failure = (message, errors) => new (errors.some(e => e instanceof AuthError) ? AuthError : Error)(message, { cause: errors[0] });
  const discard = async () => {
    const errors = [];
    for (const config of new Set(configs)) {
      try { await ed.revert(config); }
      catch (e) { errors.push({ config, error: e }); }
    }
    return errors;
  };
  const fail = async (e, outcome) => {
    const cleanup = await discard();
    const detail = cleanup.length
      ? ` Staged changes could not be discarded: ${cleanup.map(({ config, error }) => `"${config}": ${error.message}`).join('; ')}. Staged changes may remain; discard them before saving again.`
      : '';
    throw failure(`${outcome}${e.message}${detail}`, [e, ...cleanup.map(c => c.error)]);
  };
  const recover = async (e, phase) => {
    try { await ed.rollback(); }
    catch (rollbackError) {
      const uncertainty = phase === 'Confirmation'
        ? 'Confirmation may have succeeded despite a lost reply; automatic rollback is not guaranteed. '
        : 'The change may still be applied; automatic rollback may still be pending. ';
      const outcome = `${phase} failed; the outcome is uncertain. Rollback could not be confirmed: ${rollbackError.message}. `
        + `${uncertainty}Check the router before saving again. Original error: `;
      const combined = failure(`${outcome}${e.message}`, [e, rollbackError]);
      return fail(combined, '');
    }
    return fail(e, `The change was rolled back (confirmed by the router) after ${phase.toLowerCase()} failed: `);
  };
  try {
    let changes;
    try { changes = await ed.changes(); }
    catch (e) {
      throw failure(`Staged changes could not be checked for the entire session; no changes were staged or applied. ${e.message}`, [e]);
    }
    const staged = Object.entries(changes).filter(([, list]) => list.length);
    const n = staged.reduce((sum, [, list]) => sum + list.length, 0);
    if (n) throw new Error(`${n} change(s) are already staged in this session (${staged.map(([name]) => `"${name}"`).join(', ')}); saving would apply them too. Discard or resolve them first.`);
    try { await stage(ed); }
    catch (e) { await fail(e, ''); }
    // Start conservatively before the apply request, and reserve one whole request deadline for confirm.
    const confirmBy = now() + timeoutS * 1000 - REQUEST_TIMEOUT_MS;
    try { await ed.apply(timeoutS); }
    catch (e) { await recover(e, 'Apply'); }
    try {
      await sleep(settleMs);
      await verify();
      if (now() >= confirmBy) throw new Error('The rollback confirmation window is too short to safely confirm the change.');
    } catch (e) { await recover(e, 'Verification'); }
    try { await ed.confirm(); }
    catch (e) {
      // Confirmation may have succeeded despite a lost reply. Never resend it or claim automatic rollback happened.
      await recover(e, 'Confirmation');
    }
  } finally {
    applying = false;
  }
}
