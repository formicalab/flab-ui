// Physical ports: one table with a row per port (jack icon, hardware, link, traffic with a graph, errors, bridge). Ports are whatever the
// backend discovered; nothing is hard-coded, and nothing is assumed about how they are wired.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, card, muted, sparkline } from '../../core/ui.js';
import { fmtBytes, fmtLine, fmtNum } from '../../core/format.js';
import { fmtSpeed, traffic, newFlaps, newErrors, errorsOf, dropsOf, hwLines, jackOrder, switchLine, STP_ROLE, stpKind } from './util.js';
import { diagnosticsPanel } from './diagnostics.js';
import { cableButton, cablePanel, hooks } from './cable.js';
import { vlanCards } from './vlans.js';
import { portSettings } from '../interfaces/panels.js';

// Ports whose error breakdown is open, and ports whose settings form is open; kept here so they survive the redraw on every poll.
export const expanded = new Set();
const settingsOpen = new Set();

// Whether the port settings can be offered (the router gives the network config to this login: the table has Settings buttons) and the editing context of the
// page (interfaces/editor.js editContext), which exists only while a form is open or edits are pending. Set by portsPanel before the table is built.
let settingsAvailable = false;
let settingsCtx = null;

// Whether a settings form is open: the page then needs the editing context.
export const settingsFormOpen = () => settingsOpen.size > 0;

// Autoneg badge plus the speed limits of both ends and the EEE state; only meaningful while the link is up. A swconfig port
// reports neither autonegotiation nor the speeds of the ends, so only what it does report is shown.
export function negotiation(p) {
  if (!p.carrier) return muted('–');
  const flow = p.flow ?? [];
  const limits = p.max_speed != null || p.partner_max != null || flow.length
    ? `${p.max_speed != null ? `max ${fmtSpeed(p.max_speed)} · partner ${fmtSpeed(p.partner_max)}` : ''}${flow.length ? `${p.max_speed != null ? ' · ' : ''}pause ${flow.join('/')}` : ''}`
    : null;
  return h('div', { className: 'neg' },
    p.autoneg == null ? null : p.autoneg ? badge('auto-negotiated', '') : badge('forced', 'warning'),
    p.downshifted ? badge(`downshifted from ${fmtSpeed(Math.min(p.max_speed, p.partner_max))}`, 'warning', 'Both ends can do better than the negotiated speed') : null,
    p.eee ? badge(p.eee.enabled ? (p.eee.active ? 'EEE active' : 'EEE idle') : 'EEE off', p.eee.active ? 'info' : '',
      'Energy-Efficient Ethernet lets the link sleep between frames. "Idle" means it is on but the link is not sleeping now; turn it off if it causes dropped frames or latency.') : null,
    limits ? h('div', { className: 'muted small' }, limits) : null);
}

// PHY / switch / SoC / driver / medium lines from the device tree and sysfs (see hwLines).
export function hardwareCell(p) {
  const lines = hwLines(p);
  return lines.length
    ? h('div', { className: 'hw-lines' }, lines.map(([k, v]) => h('div', {}, h('span', { className: 'muted' }, `${k} `), v)))
    : muted('unknown');
}

// Errors and drops with a button that opens the breakdown row below (only when the backend has one).
export function errorsCell(p) {
  const errs = errorsOf(p), drops = dropsOf(p);
  if (!errs && !drops) return badge('clean', 'success');
  const open = expanded.has(p.name);
  return h('div', {},
    h('div', { className: 'd-flex flex-wrap gap-1' },
      errs ? badge(`${fmtNum(errs)} errors`, newErrors(p) ? 'danger' : 'warning') : null,
      drops ? badge(`${fmtNum(drops)} drops`, '') : null),
    p.diagnostics ? h('div', {}, button(open ? 'Hide details' : 'Details', open ? 'chevron-up' : 'chevron-down', () => {
      if (expanded.has(p.name)) expanded.delete(p.name); else expanded.add(p.name);
      rerender();
    }, 'btn-fl diag-btn')) : null);
}

// The Link column: link state and speed, how often the link changed state (and how many times since the page was opened), an alarm
// badge when the optical module raises one, and the cable-test button.
export function linkCell(p) {
  const alarms = p.sfp?.alarms ?? [];
  const cable = cableButton(p);
  return h('div', {},
    p.carrier
      ? h('div', {}, badge('link up', 'success'), h('div', { className: 'mt-1' }, `${fmtSpeed(p.speed)} ${p.duplex ?? ''}`))
      : badge(p.up ? 'no link' : 'disabled', ''),
    p.carrier_changes != null ? h('div', { className: 'muted small' }, `${fmtNum(p.carrier_changes)} link change${p.carrier_changes === 1 ? '' : 's'}`) : null,
    newFlaps(p) ? badge(`+${newFlaps(p)} now`, 'warning') : null,
    alarms.length ? badge('optical alarm', 'danger', alarms.join(', ')) : null,
    cable ? h('div', {}, cable) : null);
}

// The jack icon's color state: 'down' without carrier, 'warn' when downshifted, flapping/erroring since the page was opened or the
// optical module raises an alarm, else 'up'.
function portState(p) {
  if (!p.carrier) return 'down';
  return p.downshifted || newFlaps(p) || newErrors(p) || p.sfp?.alarms?.length ? 'warn' : 'up';
}

// The role under a port's name: LAN or WAN from the board, or what a switch's CPU link is (the SoC MAC that only feeds a switch).
function roleOf(p) {
  if (p.board?.role) return p.board.role.toUpperCase();
  return p.role === 'conduit' ? 'CPU link' : null;
}

// The Port column: the jack icon (green up, amber warning, gray no link), the name, its LAN/WAN role, its MAC and, for a front-panel
// port, a Settings button that opens the port's device settings (MTU, MAC address, speed, flow control, ...) under its row. The
// tooltip of the icon lists the hardware.
function portCell(p) {
  const title = [`${p.name} · ${p.mac ?? ''}`, p.carrier ? `Link ${fmtSpeed(p.speed)} ${p.duplex ?? ''}` : 'No link', ...hwLines(p).map(([k, v]) => `${k}: ${v}`)].join('\n');
  const role = roleOf(p);
  return h('td', {},
    h('div', { className: 'port-id' },
      h('span', { className: `port-ic ${portState(p)}`, title }, icon('ethernet', 22)),
      h('div', {},
        h('div', {}, h('strong', {}, p.name), role ? h('span', { className: 'port-role' }, role) : null,
          p.sfp?.present ? badge('SFP', p.sfp.alarms?.length ? 'danger' : 'info', [p.sfp.vendor, p.sfp.part].filter(Boolean).join(' ')) : null),
        h('div', { className: 'muted small mono' }, p.mac ?? ''),
        p.role === 'conduit' || !settingsAvailable ? null : button(settingsOpen.has(p.name) ? 'Hide settings' : 'Settings', settingsOpen.has(p.name) ? 'chevron-up' : 'gear', () => {
          if (settingsOpen.has(p.name)) settingsOpen.delete(p.name); else settingsOpen.add(p.name);
          rerender();
        }, 'btn-fl port-settings'))));
}

// The Throughput column: the live rate in each direction, the totals and a graph of the recent rates. A port without counters of its
// own (a swconfig port) says so instead of drawing an empty graph.
export function throughputBody(p) {
  const t = traffic(p.name);
  const counted = p.stats?.rx_bytes != null;
  return [
    p.carrier && counted ? h('div', {}, h('div', {}, icon('arrow-down', 12), fmtLine(t.rxNow)), h('div', {}, icon('arrow-up', 12), fmtLine(t.txNow))) : h('div', { className: 'muted' }, p.carrier ? 'no counters' : '–'),
    p.carrier && counted ? sparkline([{ values: t.rx, cls: 'rx' }, { values: t.tx, cls: 'tx' }], { width: 130, height: 26 }) : null,
    counted ? h('div', { className: 'muted small' }, `total ↓ ${fmtBytes(p.stats.rx_bytes)} ↑ ${fmtBytes(p.stats.tx_bytes)}`) : null,
  ];
}

// The Throughput column as a table cell.
const throughputCell = p => h('td', { className: 'num' }, ...throughputBody(p));

// The bridge a port belongs to, its spanning-tree state and role, and the MAC addresses learned on it; or "not bridged".
export function bridgeCell(p) {
  return p.bridge
    ? h('div', {}, badge(p.bridge, 'info'), p.brport ? badge(p.brport.state_name, stpKind(p.brport.state_name)) : null,
      p.brport?.role ? h('div', { className: 'muted small' }, `${STP_ROLE[p.brport.role]} · cost ${p.brport.path_cost}`) : null,
      p.macs != null ? h('div', { className: 'muted small' }, `${fmtNum(p.macs)} MAC${p.macs === 1 ? '' : 's'} learned`) : null)
    : muted('not bridged');
}

// The VLAN devices on a port, with their state.
export const vlansCell = p => ((p.vlans ?? []).length ? p.vlans.map(v => badge(`${v.name} (${v.vid})`, v.up ? 'success' : 'danger')) : muted('–'));

// The table row(s) of one port: the port itself, plus the breakdown row while its Details are open and the cable-test result.
function row(p) {
  const main = h('tr', {},
    portCell(p),
    h('td', {}, hardwareCell(p)),
    h('td', {}, linkCell(p)),
    h('td', {}, negotiation(p)),
    throughputCell(p),
    h('td', { className: 'num' }, errorsCell(p)),
    h('td', {}, bridgeCell(p)),
    h('td', {}, vlansCell(p)));
  const rows = [main];
  if (p.diagnostics && expanded.has(p.name)) rows.push(h('tr', { className: 'diag-row' }, h('td', { colSpan: COLS }, diagnosticsPanel(p))));
  const cable = cablePanel(p);
  if (cable) rows.push(h('tr', { className: 'diag-row' }, h('td', { colSpan: COLS }, cable)));
  if (settingsCtx && settingsOpen.has(p.name)) rows.push(h('tr', { className: 'diag-row' }, h('td', { colSpan: COLS, className: 'port-set' }, portSettings(settingsCtx, p.name))));
  return rows;
}

// Column headings of the details table; the breakdown row spans all of them.
const HEAD = ['Port', 'Hardware', 'Link', 'Negotiation', 'Throughput', 'Errors / drops', 'Bridge / STP', 'VLAN devices'];
const COLS = HEAD.length;

// Redraw callback handed in by the page; the Details buttons call it. Module-level because errorsCell
// is created fresh on every redraw.
let rerender = () => {};

// Points the Details buttons (and the cable test's redraw) at the redraw of the Ethernet ports page.
export function bindRedraw(redraw) {
  rerender = redraw;
  hooks.rerender = redraw;
}

// The "Ports" card: under the header one line per switch (its user ports, CPU ports and the state of its link to the SoC), then one
// row per port. The rows follow the order the board lists its ports (usually the order on the case) with each switch's ports kept
// together; the SoC MACs that only feed a switch (its conduits) come last. Nothing is assumed about how the ports are wired.
function details(net) {
  const { ordered } = jackOrder(net);
  const rest = net.ports.filter(p => !ordered.includes(p));
  const linked = ordered.filter(p => p.carrier).length;
  const lines = (net.switches ?? []).filter(sw => sw.ports.length).map(sw => switchLine(net, sw));
  return card([icon('ethernet'), h('span', {}, 'Ports'), h('span', { className: 'sub' },
    `${linked} of ${ordered.length} ports linked${rest.length ? ` · the last row${rest.length === 1 ? ' is' : 's are'} the internal CPU link${rest.length === 1 ? '' : 's'} to the switch, not a port` : ''}`)],
    h('div', {},
      ...lines.map(l => h('div', { className: `cpu-link small ${l.busy ? 'text-danger' : 'muted'}` }, l.text)),
      h('div', { className: 'grid-wrap' }, h('table', { className: 'table port-table' },
        h('thead', {}, h('tr', {}, HEAD.map(c => h('th', {}, c)))),
        h('tbody', {}, ordered.length || rest.length
          ? [...ordered, ...rest].flatMap(row)
          : h('tr', {}, h('td', { colSpan: COLS, className: 'muted' }, 'No Ethernet ports were reported.')))))));
}

// `redraw` repaints the page from cached data (used by the Details and cable-test buttons). Below the port table come the VLAN cards
// of the bridges and swconfig switches that have a VLAN table; `vlan` is the VLAN editor's context (vlanpage.js), null when the
// login may not change the config.
export function portsPanel(net, redraw, vlan, settings) {
  bindRedraw(redraw);
  settingsAvailable = Boolean(settings?.available);
  settingsCtx = settings?.ctx ?? null;
  // A port that vanished must not leave a stale open panel behind.
  for (const name of [...expanded, ...settingsOpen]) if (!net.ports.some(p => p.name === name)) { expanded.delete(name); settingsOpen.delete(name); }
  return [details(net), ...vlanCards(net, vlan)];
}
