// Physical ports: the wiring diagram (topology.js) followed by a detail table. Ports are whatever the
// backend discovered; nothing is hard-coded.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, card, muted } from '../../core/ui.js';
import { fmtBytes, fmtLine, fmtNum } from '../../core/format.js';
import { fmtSpeed, traffic, newFlaps, newErrors, errorsOf, dropsOf, hwLines, STP_ROLE, stpKind } from './util.js';
import { diagnosticsPanel } from './diagnostics.js';
import { topologyCard } from './topology.js';

// Ports whose error breakdown is open; kept here so it survives the redraw on every poll.
const expanded = new Set();

// Autoneg badge plus the speed limits of both ends; only meaningful while the link is up.
function negotiation(p) {
  if (!p.carrier) return muted('–');
  return h('div', { className: 'neg' },
    p.autoneg ? badge('auto-negotiated', '') : badge('forced', 'warning'),
    p.downshifted ? badge(`downshifted from ${fmtSpeed(Math.min(p.max_speed, p.partner_max))}`, 'warning', 'Both ends can do better than the negotiated speed') : null,
    h('div', { className: 'muted small' }, `max ${fmtSpeed(p.max_speed)} · partner ${fmtSpeed(p.partner_max)}${p.flow.length ? ` · pause ${p.flow.join('/')}` : ''}`));
}

// PHY / switch / SoC / driver / medium lines from the device tree and sysfs (see hwLines).
function hardwareCell(p) {
  const lines = hwLines(p);
  return lines.length
    ? h('div', { className: 'hw-lines' }, lines.map(([k, v]) => h('div', {}, h('span', { className: 'muted' }, `${k} `), v)))
    : muted('unknown');
}

// Errors and drops with a button that opens the breakdown row below (only when the backend has one).
function errorsCell(p) {
  const errs = errorsOf(p), drops = dropsOf(p);
  if (!errs && !drops) return badge('clean', 'success');
  const open = expanded.has(p.name);
  return h('div', {},
    errs ? badge(`${fmtNum(errs)} errors`, newErrors(p) ? 'danger' : 'warning') : null,
    drops ? badge(`${fmtNum(drops)} drops`, '') : null,
    p.diagnostics ? h('div', {}, button(open ? 'Hide details' : 'Details', open ? 'chevron-up' : 'chevron-down', () => {
      if (expanded.has(p.name)) expanded.delete(p.name); else expanded.add(p.name);
      rerender();
    }, 'btn-fl diag-btn')) : null);
}

// The table row(s) of one port: the port itself, plus the breakdown row while its Details are open.
function row(p) {
  const t = traffic(p.name);
  const main = h('tr', {},
    h('td', {}, h('span', { className: `dot ${p.carrier ? 'up' : 'idle'}` }), h('strong', {}, ' ' + p.name),
      h('div', { className: 'muted small mono' }, p.mac ?? '')),
    h('td', {}, hardwareCell(p)),
    h('td', {}, p.carrier
      ? h('div', {}, badge('link up', 'success'), h('div', { className: 'mt-1' }, `${fmtSpeed(p.speed)} ${p.duplex ?? ''}`))
      : badge(p.up ? 'no link' : 'disabled', '')),
    h('td', {}, negotiation(p)),
    h('td', { className: 'num' }, p.carrier ? h('div', {}, h('div', {}, icon('arrow-down', 12), fmtLine(t.rxNow)), h('div', {}, icon('arrow-up', 12), fmtLine(t.txNow))) : h('div', { className: 'muted' }, '–'),
      h('div', { className: 'muted small' }, `total ↓ ${fmtBytes(p.stats.rx_bytes)} ↑ ${fmtBytes(p.stats.tx_bytes)}`)),
    h('td', { className: 'num' }, errorsCell(p)),
    h('td', { className: 'num' }, h('div', {}, fmtNum(p.carrier_changes)), newFlaps(p) ? badge(`+${newFlaps(p)} now`, 'warning') : null),
    h('td', {}, p.bridge
      ? h('div', {}, badge(p.bridge, 'info'), p.brport ? badge(p.brport.state_name, stpKind(p.brport.state_name)) : null,
        p.brport?.role ? h('div', { className: 'muted small' }, `${STP_ROLE[p.brport.role]} · cost ${p.brport.path_cost}`) : null)
      : muted('not bridged')),
    h('td', { className: 'num' }, p.macs != null ? fmtNum(p.macs) : '–'),
    h('td', {}, (p.vlans ?? []).length ? p.vlans.map(v => badge(`${v.name} (${v.vid})`, v.up ? 'success' : 'danger')) : muted('–')));
  if (!p.diagnostics || !expanded.has(p.name)) return [main];
  return [main, h('tr', { className: 'diag-row' }, h('td', { colSpan: COLS }, diagnosticsPanel(p)))];
}

// Column headings of the details table; the breakdown row spans all of them.
const HEAD = ['Port', 'Hardware', 'Link', 'Negotiation', 'Throughput', 'Errors / drops', 'Link changes', 'Bridge / STP', 'MACs', 'VLAN devices'];
const COLS = HEAD.length;

// Redraw callback handed in by the page; the Details buttons call it. Module-level because errorsCell
// is created fresh on every redraw.
let rerender = () => {};

// The "Port details" card with one row per port.
function details(net) {
  return card([icon('hdd-stack'), h('span', {}, 'Port details')],
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table port-table' },
      h('thead', {}, h('tr', {}, HEAD.map(c => h('th', {}, c)))),
      h('tbody', {}, net.ports.flatMap(row)))));
}

// `redraw` repaints the page from cached data (used by the Details buttons).
export function portsPanel(net, redraw) {
  rerender = redraw;
  // A port that vanished must not leave a stale open panel behind.
  for (const name of expanded) if (!net.ports.some(p => p.name === name)) expanded.delete(name);
  return [topologyCard(net), details(net)];
}
