// Physical ports: a front-panel view (one tile per port, colored by link state, with live throughput)
// followed by a detail table. Ports are whatever the backend discovered; nothing is hard-coded.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, card, sparkline } from '../../core/ui.js';
import { fmtBytes, fmtNum } from '../../core/format.js';
import { fmtLine, fmtSpeed, traffic, newFlaps, newErrors, errorsOf, dropsOf, hwSummary, hwLines, STP_ROLE, stpKind } from './util.js';
import { diagnosticsPanel } from './diagnostics.js';

// Ports whose error breakdown is open; kept here so it survives the redraw on every poll.
const expanded = new Set();

const GROUPS = [
  ['switch', 'Switch ports', 'Front-panel ports of the built-in switch'],
  ['nic', 'Network adapters', 'Standalone Ethernet ports (typically the WAN uplink)'],
  ['conduit', 'CPU link', 'Internal link between the switch and the CPU (carries all switch traffic)'],
];

const muted = t => h('span', { className: 'muted' }, t);

function portState(p) {
  if (!p.carrier) return 'down';
  return p.downshifted || newFlaps(p) || newErrors(p) ? 'warn' : 'up';
}

function tile(p) {
  const t = traffic(p.name);
  const state = portState(p);
  const title = [`${p.name} · ${p.mac ?? ''}`, p.carrier ? `Link ${fmtSpeed(p.speed)} ${p.duplex ?? ''}` : 'No link', ...hwLines(p).map(([k, v]) => `${k}: ${v}`)].join('\n');
  return h('div', { className: `port ${state}`, title },
    h('div', { className: 'jack' }, icon('ethernet', 26)),
    h('div', { className: 'pname' }, p.name),
    hwSummary(p) ? h('div', { className: 'phw' }, hwSummary(p)) : null,
    h('div', { className: 'pspeed' }, p.carrier ? fmtSpeed(p.speed) : 'no link'),
    p.carrier
      ? h('div', { className: 'prate' }, h('span', {}, icon('arrow-down', 12), fmtLine(t.rxNow)), h('span', {}, icon('arrow-up', 12), fmtLine(t.txNow)))
      : h('div', { className: 'prate muted' }, p.up ? 'cable unplugged' : 'disabled'),
    p.carrier ? sparkline([{ values: t.rx, cls: 'rx' }, { values: t.tx, cls: 'tx' }], { width: 130, height: 26 }) : null,
    h('div', { className: 'ptags' },
      p.bridge ? badge(p.bridge, 'info') : null,
      p.brport?.role ? badge(STP_ROLE[p.brport.role], stpKind(p.brport.state_name)) : null,
      ...(p.vlans ?? []).map(v => badge(`VLAN ${v.vid}`, '', v.name))));
}

function panel(net) {
  const groups = GROUPS.map(([role, label, hint]) => [role, label, hint, net.ports.filter(p => p.role === role)]).filter(g => g[3].length);
  return card([icon('ethernet'), h('span', {}, 'Physical ports'), h('span', { className: 'sub' }, `${net.ports.filter(p => p.carrier).length} of ${net.ports.length} linked`)],
    h('div', { className: 'card-body port-groups' }, groups.map(([, label, hint, ports]) => h('div', { className: 'port-group' },
      h('div', { className: 'gtitle', title: hint }, label, h('small', {}, ` ${ports.length}`)),
      h('div', { className: 'port-row' }, ports.map(tile))))));
}

function negotiation(p) {
  if (!p.carrier) return muted('–');
  return h('div', { className: 'neg' },
    p.downshifted ? badge(`downshifted from ${fmtSpeed(Math.min(p.max_speed, p.partner_max))}`, 'warning', 'Both ends can do better than the negotiated speed') : null,
    h('div', { className: 'muted small' }, `max ${fmtSpeed(p.max_speed)} · partner ${fmtSpeed(p.partner_max)}${p.flow.length ? ` · pause ${p.flow.join('/')}` : ''}`));
}

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

const HEAD = ['Port', 'Hardware', 'Link', 'Negotiation', 'Throughput', 'Errors / drops', 'Link changes', 'Bridge / STP', 'MACs', 'VLAN devices'];
const COLS = HEAD.length;

let rerender = () => {};

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
  return [panel(net), details(net)];
}
