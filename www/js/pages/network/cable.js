// The cable test of the Ethernet ports view. `ethtool --cable-test` (the flab.network `cable_test` method) sends pulses down the pairs
// of a twisted-pair cable and reads the reflections; the PHY drops the link for a few seconds while it runs, so it is only
// started from a button, after a confirmation that says so. The result stays under the port's row until it is closed.
// Which PHY drivers support it varies: the plugin remembers a port that does not, and the button disappears for it.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { AuthError, can, ubus } from '../../core/ubus.js';
import { openDialog } from '../../core/modal.js';
import { badge, button } from '../../core/ui.js';
import { fmtSpeed } from './util.js';

// What the page hands over: its redraw and its reload (a call that finds the session ended reloads, which shows the sign-in screen).
export const hooks = { rerender: () => {}, reload: () => {} };

// The test of each port: name to { phase: 'running' | 'done', result }. Kept here so it survives the redraw of every poll.
const tests = new Map();

// How each code of a pair is shown: [badge kind, what it means].
const CODES = {
  OK: ['success', 'The pair is intact.'],
  'Open Circuit': ['warning', 'The pair is cut, or nothing is connected at the far end.'],
  'Short within Pair': ['danger', 'The two wires of the pair touch each other.'],
  'Short to another pair': ['danger', 'The pair touches another pair.'],
  Fault: ['danger', 'The pair is faulty.'],
};

// Whether port `p` can be tested: a physical twisted-pair port (not the internal link to a switch, a swconfig port or an optical
// cage), not known to lack support, and a login that may run it.
export const canTest = p => can('flab.network', 'cable_test') && p.cable_test !== false && p.role !== 'conduit' && p.type !== 'swconfig' && p.sfp == null && p.hardware != null;

// Starts the test of port `p` and keeps its result for the panel.
async function run(p) {
  tests.set(p.name, { phase: 'running' });
  hooks.rerender();
  let result;
  try {
    result = await ubus('flab.network', 'cable_test', { port: p.name });
  } catch (e) {
    if (e instanceof AuthError) { tests.delete(p.name); return hooks.reload(); }
    result = { ok: false, error: e.message };
  }
  tests.set(p.name, { phase: 'done', result });
  hooks.rerender();
}

// The confirmation before a test: what it does to the link, then the choices.
function confirm(p) {
  const dialog = openDialog({
    title: `Cable test of ${p.name}`,
    body: h('div', {},
      h('p', {}, 'The test sends pulses down each pair of the cable and reads the reflections: it finds a cut or a short and roughly how far away it is.'),
      h('p', {}, p.carrier
        ? `The PHY drops the link on ${p.name} for several seconds while it runs, so everything that uses this port is interrupted. If your connection to the router comes through ${p.name}, this page stops answering until the link is back.`
        : `${p.name} has no link, so nothing is interrupted. Without a cable (or without a device at the far end) every pair reads open.`),
      h('p', { className: 'muted small' }, 'Not every PHY driver supports the test; if this one does not, you are told and the button goes away.')),
    footer: [
      button('Cancel', 'x-lg', () => dialog.close()),
      button('Run the test', 'tools', () => { dialog.close(); run(p); }, 'btn-fl btn-brand'),
    ],
  });
  return dialog;
}

// The button in the row of port `p`, or null when the port cannot be tested.
export function cableButton(p) {
  if (!canTest(p)) return null;
  const busy = tests.get(p.name)?.phase === 'running';
  const b = button(busy ? 'Testing…' : 'Cable test', 'tools', () => confirm(p), 'btn-fl cable-btn');
  b.disabled = busy;
  b.title = 'Test the cable with the PHY (the link drops for a few seconds)';
  return b;
}

// What the pairs say, in words.
function summary(p, pairs) {
  const by = Object.fromEntries(pairs.map(x => [x.pair, x]));
  // Whether a pair reads intact.
  const ok = x => x?.code === 'OK';
  // Whether a pair reads open (cut, or nothing at the far end).
  const open = x => x?.code === 'Open Circuit';
  if (pairs.every(open)) return p.carrier ? 'Every pair reads open although the port has link: the PHY could not measure this cable.' : 'Nothing is connected: every pair reads open.';
  if (pairs.every(ok)) return 'All four pairs are intact.';
  if (ok(by.A) && ok(by.B) && open(by.C) && open(by.D)) {
    return p.carrier && p.speed && p.speed <= 100
      ? `Pairs A and B are intact and C and D are open. A ${fmtSpeed(p.speed)} link only uses A and B, so this cable cannot carry 1 Gbit/s: a cable with a cut or an unconnected pair, or a connector with two missing contacts.`
      : 'Pairs A and B are intact and C and D are open: enough for 10 and 100 Mbit/s, not for 1 Gbit/s and more.';
  }
  return 'At least one pair has a fault; the lengths are measured from this port.';
}

// The result panel of port `p` (under its row), or null when it has not been tested or the result was closed.
export function cablePanel(p) {
  const t = tests.get(p.name);
  if (!t) return null;
  const close = button('Close', 'x-lg', () => { tests.delete(p.name); hooks.rerender(); }, 'btn-fl cable-btn');
  let body;
  if (t.phase === 'running') body = h('div', { className: 'muted' }, h('span', { className: 'spinner-border spinner-border-sm me-2' }), 'Testing the cable…');
  else if (!t.result?.ok) body = h('div', { className: 'text-danger' }, icon('x-circle'), ` ${t.result?.error ?? 'The test failed.'}`);
  else {
    body = h('div', {},
      h('table', { className: 'table table-sm diag-table' }, h('tbody', {}, t.result.pairs.map(x => {
        const [kind, meaning] = CODES[x.code] ?? ['', ''];
        return h('tr', {}, h('td', {}, h('strong', {}, `Pair ${x.pair}`)), h('td', {}, badge(x.code, kind)),
          h('td', { className: 'muted small' }, x.length_m != null ? `fault at about ${x.length_m} m` : meaning));
      }))),
      h('div', { className: 'muted small' }, summary(p, t.result.pairs)));
  }
  return h('div', { className: 'diag cable-panel' }, h('div', { className: 'diag-head' }, icon('tools'), h('span', {}, `Cable test of ${p.name}`), close), body);
}
