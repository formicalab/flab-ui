// CPU utilization for the Overview page.
//
// The backend (flab.system cpu) returns cumulative time counters from /proc/stat. Utilization is the share
// of CPU time spent in each state between two successive samples, so a short history is kept here. Samples are cleared when
// the router uptime shows a gap (the page was paused or not open), because a delta over minutes would be a misleading average.

import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, sparkline } from '../../core/ui.js';
import { fmtNum, fmtSpan } from '../../core/format.js';

// Cpu-line fields of /proc/stat that make up the total, in the order the backend reports them.
const FIELDS = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'];
// History depth, and the largest uptime gap (seconds) between samples that still counts as continuous.
// The Overview polls every 5 s, so a longer gap means polling was paused or the page was closed.
const MAX_SAMPLES = 60;
const GAP_SECONDS = 20;

// Module-level so it survives the redraw on every poll: { uptime, cpus: { id: counters } } samples, oldest first.
let history = [];

//#region sampling
// Stores one flab.system cpu reply as a sample, restarting the history after a gap or an uptime reset (reboot).
export function record(data) {
  const last = history.at(-1);
  if (last && (data.uptime == null || data.uptime < last.uptime || data.uptime - last.uptime > GAP_SECONDS)) history = [];
  history.push({ uptime: data.uptime, cpus: Object.fromEntries(data.cpus.map(c => [c.id, c])) });
  if (history.length > MAX_SAMPLES) history.shift();
}

// True once two samples exist, i.e. a utilization can be computed.
export const hasDelta = () => history.length >= 2;

// Percent of CPU time per category between two samples of one cpu line, or null when it cannot be computed.
// "busy" excludes idle and I/O wait (waiting for I/O is not computation), like top and htop.
function shares(a, b) {
  if (!a || !b) return null;
  const d = {};
  let total = 0;
  for (const k of FIELDS) {
    d[k] = b[k] - a[k];
    if (d[k] < 0) return null;
    total += d[k];
  }
  if (total <= 0) return null;
  // Share of the interval spent in one field, as a percentage of all CPU time.
  const pct = k => d[k] / total * 100;
  const user = pct('user') + pct('nice');
  const system = pct('system');
  const irq = pct('irq') + pct('softirq');
  const iowait = pct('iowait');
  const steal = pct('steal');
  return { user, system, irq, iowait, steal, idle: pct('idle'), busy: user + system + irq + steal };
}

// Utilization of one cpu line ('cpu' = all cores, 'cpu0'…) over the last sample interval, or null until
// two samples exist.
export function current(id) {
  const n = history.length;
  return n >= 2 ? shares(history[n - 2].cpus[id], history[n - 1].cpus[id]) : null;
}

// One value per sample interval, oldest first; intervals that cannot be computed count as zero.
function series(id, pick) {
  const out = [];
  for (let i = 1; i < history.length; i++) {
    const s = shares(history[i - 1].cpus[id], history[i].cpus[id]);
    out.push(s ? pick(s) : 0);
  }
  return out;
}
//#endregion

//#region presentation
// Color level for a busy percentage: good below 60 %, fair below 85 %, weak above.
const level = busy => busy < 60 ? 'good' : busy < 85 ? 'fair' : 'weak';
// Text color class per level.
export const levelText = { good: 'text-success', fair: 'text-warning', weak: 'text-danger' };

// Stacked-bar segments as [key in shares(), label, tooltip]; idle is the unfilled remainder and is not listed.
const SEGMENTS = [
  ['user', 'User', 'Programs (including niced ones)'],
  ['system', 'System', 'Kernel work'],
  ['irq', 'Interrupts', 'Hardware and software interrupts: packet forwarding and Wi-Fi show up here on a router'],
  ['iowait', 'I/O wait', 'Waiting for storage or other I/O'],
  ['steal', 'Steal', 'Time taken by a hypervisor'],
];

// Horizontal bar with one segment per SEGMENTS entry, sized by its share of `s` (a shares() result).
const stack = (s, cls = '') => h('div', { className: `cpu-stack ${cls}` },
  SEGMENTS.map(([k]) => h('i', { className: k, style: `width:${s[k].toFixed(2)}%` })));

// Left column: overall busy percentage, stacked bar, legend (steal only when non-zero) and load/task chips.
function totalColumn(total, data) {
  const lvl = level(total.busy);
  return h('div', { className: 'cpu-total' },
    h('div', { className: `cpu-big ${levelText[lvl]}` }, `${total.busy.toFixed(0)}%`, h('small', {}, 'busy')),
    stack(total, 'big'),
    h('div', { className: 'cpu-legend' }, [...SEGMENTS, ['idle', 'Idle', 'Not used']].filter(([k]) => k !== 'steal' || total.steal > 0.05).map(([k, label, title]) =>
      h('div', { className: 'lg', title }, h('i', { className: `sw ${k}` }), h('span', {}, label), h('b', {}, `${total[k].toFixed(1)}%`)))),
    h('div', { className: 'chips' },
      data.load ? badge(`Load ${data.load.map(l => l.toFixed(2)).join(' · ')}`, '', 'Load average over 1, 5 and 15 minutes') : null,
      data.tasks != null ? badge(`${data.runnable} running · ${fmtNum(data.tasks)} tasks`, '', 'Runnable and total tasks right now') : null,
      data.procs_blocked ? badge(`${data.procs_blocked} blocked`, 'warning', 'Tasks waiting for I/O') : null));
}

// Middle column: one mini stacked bar per core, with the breakdown in its tooltip.
function coresColumn(data) {
  const cores = data.cpus.filter(c => c.id !== 'cpu');
  return h('div', { className: 'cpu-cores' }, cores.map(c => {
    const s = current(c.id);
    return h('div', { className: 'core', title: s ? `user ${s.user.toFixed(1)}% · system ${s.system.toFixed(1)}% · interrupts ${s.irq.toFixed(1)}% · I/O wait ${s.iowait.toFixed(1)}%` : '' },
      h('span', { className: 'cl' }, c.id.toUpperCase()),
      s ? stack(s) : h('div', { className: 'cpu-stack' }),
      h('span', { className: 'cv' }, s ? `${s.busy.toFixed(0)}%` : '–'));
  }));
}

// Right column: sparkline of total busy and interrupt share on a fixed 0-100 scale.
function historyColumn() {
  const span = history.length >= 2 ? history.at(-1).uptime - history[0].uptime : 0;
  return h('div', { className: 'cpu-history' },
    h('div', { className: 'muted small mb-1' }, span > 0 ? `Last ${fmtSpan(span)}` : 'History'),
    h('div', { className: 'cpu-spark' }, sparkline([
      { values: series('cpu', s => s.busy), cls: 'rx' },
      { values: series('cpu', s => s.irq), cls: 'tx' },
    ], { width: 360, height: 90, max: 100 })),
    h('div', { className: 'cpu-keys small muted' },
      h('span', {}, h('i', { className: 'key busy' }), 'busy'), h('span', {}, h('i', { className: 'key irq' }), 'interrupts')));
}

// The CPU load card; shows a placeholder until the first utilization can be computed.
export function cpuCard(data) {
  const total = current('cpu');
  const cores = data.cores;
  const body = total
    ? h('div', { className: 'card-body cpu-grid' }, totalColumn(total, data), coresColumn(data), historyColumn())
    : h('div', { className: 'card-body muted' }, 'Measuring… (utilization needs two samples)');
  return card([icon('cpu'), 'CPU load', h('span', { className: 'sub' }, `${cores} core${cores === 1 ? '' : 's'}`)], body);
}
//#endregion
