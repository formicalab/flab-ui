// Services page (route #services): the init scripts of /etc/init.d (flab.services list) merged with the daemons
// procd reports (`service list`), each with Start, Stop, Restart and Enable or Disable (at boot) buttons
// (flab.services control). Stopping, restarting or disabling a service that can cut this page or the router's
// management access asks for confirmation first, and says in plain words what will happen. The outcome of the last
// action is shown above the list.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { AuthError, can, optional, ubus } from '../../core/ubus.js';
import { badge, button, card, mono, muted, tile, tiles } from '../../core/ui.js';
import { refreshControl, searchControl } from '../../core/controls.js';
import { note } from '../../core/forms.js';
import { fmtNum } from '../../core/format.js';
import { LABELS, PROGRESS, actionsFor, buildRows, describeOutcome, filterRows, readProcd, riskOf, summarize } from './model.js';

// What survives the redraw on every poll: the filter text, the call in progress ({ name, action }), the action
// waiting for confirmation ({ name, action }) and the outcome of the last call.
const state = { q: '', busy: null, pending: null, outcome: null };

// The shell's redraw and refresh functions, handed over by controls().
const shell = { rerender: () => {}, reload: () => {} };

// Milliseconds a background (detached) call needs before the list can show its effect.
const DETACHED_REFRESH_MS = 4000;
// The pending refresh after a detached call, cancelled when the page is opened again so that a stale one does not fire on another page.
let detachedRefresh = null;

// The icon of each action's button.
const ACTION_ICONS = { start: 'play-fill', stop: 'x-lg', restart: 'arrow-clockwise', enable: 'toggle-on', disable: 'toggle-off' };

// What each state means, shown above the table.
const STATE_HELP = 'running: procd reports every instance running. idle: procd knows the service but nothing runs. '
  + 'no instance: procd does not list it; it is stopped, a one-shot service (such as firewall or network) or not managed by procd. '
  + 'Listening: the TCP and UDP ports the service\'s processes have open (UDP ports the kernel picked for outgoing queries are left out); a dashed port is open on loopback only.';

// Reads procd's services and, when the plugin is installed, the init scripts (a missing plugin only costs the buttons).
async function load() {
  const [svc, list] = await Promise.all([ubus('service', 'list'), optional(ubus('flab.services', 'list'))]);
  return { procd: readProcd(svc), list };
}

// Runs one action on the router and shows the outcome. The buttons stay disabled meanwhile. A session that ends
// meanwhile (rpcd restarted, or it expired) goes back to the sign-in screen through a refresh.
async function perform(name, action) {
  state.pending = null;
  state.outcome = null;
  state.busy = { name, action };
  shell.rerender();
  let reply = null;
  let error = null;
  try {
    reply = await ubus('flab.services', 'control', { name, action });
  } catch (e) {
    if (e instanceof AuthError) {
      state.busy = null;
      return shell.reload();
    }
    error = e.message;
  }
  state.outcome = describeOutcome(name, action, reply, error);
  state.busy = null;
  shell.rerender();
  if (reply?.detached) detachedRefresh = setTimeout(() => shell.reload(), DETACHED_REFRESH_MS);
  else await shell.reload();
}

// A click on a button: asks first when the action is risky, otherwise runs it.
function request(name, action) {
  if (state.busy) return;
  if (riskOf(name, action)) {
    state.pending = { name, action };
    state.outcome = null;
    shell.rerender();
  } else {
    perform(name, action);
  }
}

// The confirmation for the pending action: what will happen, then the two choices.
function confirmNote() {
  const p = state.pending;
  if (!p) return null;
  const risk = riskOf(p.name, p.action);
  return h('div', { className: `svc-note ${risk.level}`, id: 'svc-confirm', role: 'alertdialog' },
    icon(risk.level === 'danger' ? 'shield-exclamation' : 'exclamation-triangle'),
    h('div', { className: 'svc-note-body' },
      h('strong', {}, risk.title),
      h('p', {}, risk.text)),
    h('div', { className: 'svc-note-actions' },
      button(`${LABELS[p.action]} ${p.name}`, 'check2', () => perform(p.name, p.action), risk.level === 'danger' ? 'btn-danger' : 'btn-brand', { id: 'svc-confirm-yes', disabled: Boolean(state.busy) }),
      button('Cancel', 'x-lg', () => { state.pending = null; shell.rerender(); }, 'btn-fl', { id: 'svc-confirm-no' })));
}

// The outcome of the last call: green when it worked, red with the script's own output when it failed.
function outcomeNote() {
  const o = state.outcome;
  if (!o) return null;
  return h('div', { className: `svc-note ${o.kind}`, id: 'svc-outcome', role: 'status' },
    icon(o.kind === 'ok' ? 'check-circle' : o.kind === 'bad' ? 'x-circle' : 'info-circle'),
    h('div', { className: 'svc-note-body' },
      h('span', {}, o.text),
      o.output ? h('pre', { className: 'svc-output' }, o.output) : null),
    h('div', { className: 'svc-note-actions' },
      button('Dismiss', 'x-lg', () => { state.outcome = null; shell.rerender(); }, 'btn-fl', { id: 'svc-outcome-dismiss' })));
}

// The State cell: a badge, with the meaning of "no instance" in its tooltip.
function stateBadge(row) {
  if (state.busy?.name === row.name) {
    return h('span', { className: 'svc-busy' }, h('span', { className: 'spinner-border spinner-border-sm' }), `${PROGRESS[state.busy.action]}…`);
  }
  if (row.state === 'running') return badge('running', 'success');
  if (row.state === 'idle') return badge('idle', '', 'Known to procd, no instance running');
  return badge('no instance', '', 'procd does not list it: stopped, a one-shot service or not managed by procd');
}

// The Start at boot cell: enabled (with its position at boot) or disabled; blank for a service without a script.
function bootCell(row) {
  if (!row.installed) return muted('–');
  return row.enabled ? badge('enabled', 'info', `Starts at boot, position ${row.start}`) : muted('disabled');
}

// The Actions cell: the buttons, or the reason there are none. All buttons are disabled while a call runs.
function actionCell(row) {
  if (!row.installed) return muted('no init script');
  if (row.protected) return muted('boot sequence');
  const titles = { enable: `Start ${row.name} at boot`, disable: `Do not start ${row.name} at boot` };
  return h('div', { className: 'svc-actions' }, actionsFor(row).map(a =>
    button(LABELS[a.action], ACTION_ICONS[a.action], () => request(row.name, a.action), 'btn-fl', {
      id: `svc-${row.name}-${a.action}`,
      disabled: a.disabled || Boolean(state.busy),
      title: titles[a.action] ?? `${LABELS[a.action]} ${row.name}`,
    })));
}

// The Listening cell: one chip per protocol and port the service's processes listen on. A port that is only open on
// loopback is dimmed, and the tooltip names the addresses.
function portsCell(row) {
  if (!row.ports.length) return muted('–');
  const SCOPE = { all: 'every address', local: 'this router only (loopback)', some: 'specific addresses' };
  return h('div', { className: 'svc-ports' }, row.ports.map(p =>
    h('span', { className: `chip svc-port ${p.scope}`, title: `${p.proto.toUpperCase()} port ${p.port}, listening on ${SCOPE[p.scope]}: ${p.addresses.join(', ')}` }, `${p.proto}/${p.port}`)));
}

// One table row per service.
function row(r, writable) {
  return h('tr', { id: `svc-row-${r.name}` },
    h('td', {}, mono(r.name)),
    h('td', {}, stateBadge(r)),
    h('td', {}, bootCell(r)),
    h('td', {}, r.pids.length ? r.pids.join(', ') : muted('–')),
    h('td', {}, portsCell(r)),
    writable ? h('td', {}, actionCell(r)) : null);
}

// The services table, with the explanation of the states at the top.
function servicesCard(rows, writable) {
  const cols = ['Service', 'State', 'Start at boot', 'PID', 'Listening', writable ? 'Actions' : null].filter(Boolean);
  return card('Services', [
    h('p', { className: 'svc-legend muted small' }, STATE_HELP),
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover svc-table' },
      h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
      h('tbody', {}, rows.length
        ? rows.map(r => row(r, writable))
        : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'Nothing to show'))))),
  ]);
}

export default {
  id: 'services',
  label: 'Services',
  icon: 'hdd-stack',
  interval: 5000,
  css: ['css/forms.css', 'css/services.css'],
  load,

  // The filter box and Refresh stay in the command bar across redraws.
  controls({ rerender, reload }) {
    clearTimeout(detachedRefresh);
    shell.rerender = rerender;
    shell.reload = reload;
    return { nodes: [searchControl(state, 'q', rerender, 'Filter services…'), refreshControl(reload)] };
  },

  // Tiles, the confirmation and outcome notes, then the table. Without the plugin, or without permission to
  // call `control`, the table is read-only and a note says why.
  view(data, rerender) {
    shell.rerender = rerender;
    const rows = buildRows(data.list, data.procd);
    const sum = summarize(rows);
    const writable = data.list != null && can('flab.services', 'control');
    return [
      data.list == null ? note('info', 'The services plugin is not installed on the router, so services can only be listed.') : null,
      data.list != null && !writable ? note('info', 'This login is not allowed to start or stop services, so the buttons are hidden.') : null,
      confirmNote(),
      outcomeNote(),
      tiles(
        tile('Running', fmtNum(sum.running), 'procd services with every instance up'),
        tile('Not running', fmtNum(sum.notRunning), 'idle, or no procd instance'),
        tile('Init scripts', fmtNum(sum.scripts), `${fmtNum(sum.enabled)} start at boot`)),
      servicesCard(filterRows(rows, state.q), writable),
    ].filter(Boolean);
  },
};
