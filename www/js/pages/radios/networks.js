// The "Wireless networks" part of a radio card on the Wi-Fi radios page: the access points, client networks and 802.11s mesh points on the radio, one
// foldable block each. The block's summary line says what it is and how it is doing (security, state, clients or peers), its body shows what the
// interface is doing now (BSSID and traffic of a network; peers, paths and parameters of a mesh point) above the settings, which are the
// editor of wifi/editors.js. What is configured is shown once, in the settings. A router whose plugin cannot report the configuration gets the
// same blocks without settings. Data comes from the flab.radio status (the interfaces of a radio) and the flab.mesh status (the mesh points).
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, mono } from '../../core/ui.js';
import { latest } from '../../core/rates.js';
import { disclosure } from '../../core/fold.js';
import { fmtBytes, fmtLine, fmtNum } from '../../core/format.js';
import { networksEditor, MODE_BADGE } from '../wifi/editors.js';
import { tracker } from './parts.js';
import { meshBadges, meshLive } from './mesh.js';
import { wpsControls } from './wps.js';

// One fact of a block's live line: a muted label and its value.
const fact = (label, value) => h('span', { className: 'rd-fact' }, h('span', { className: 'muted' }, `${label} `), value);

// What an access point or a client network (`i`, an interface of the radio's status) is doing now: its interface, BSSID, the traffic now and the totals.
// The rates come from the byte counters the page records on every poll.
function networkLive(i) {
  const k = `if:${i.ifname}`;
  const rx = latest(tracker.rates(k, 'rx')), tx = latest(tracker.rates(k, 'tx'));
  const facts = [
    i.ifname ? fact('Interface', mono(i.ifname)) : null,
    i.bssid ? fact('BSSID', mono(i.bssid)) : null,
    i.ifname ? fact('Traffic now', h('span', {}, icon('arrow-down', 12), fmtLine(rx), ' ', icon('arrow-up', 12), fmtLine(tx))) : null,
    i.rx_bytes != null ? fact('Total', `↓ ${fmtBytes(i.rx_bytes)} ↑ ${fmtBytes(i.tx_bytes)}`) : null,
  ].filter(Boolean);
  return facts.length ? h('div', { className: 'rd-facts' }, facts) : null;
}

// The summary badges of an access point or a client network: the clients connected, a BSS state other than enabled (a DFS availability check) and, for an
// access point whose WPS push button is enabled, the button to open it (wps.js).
function networkBadges(i, redraw) {
  if (!i?.up) return [];
  return [
    i.mode === 'ap' ? badge(`${fmtNum(i.clients ?? 0)} client${i.clients === 1 ? '' : 's'}`, '', 'Connected clients (the Connected devices tab of Devices and Interfaces lists them)') : null,
    i.bss_status && i.bss_status !== 'ENABLED' ? badge(i.bss_status, 'warning', i.bss_status === 'DFS' ? 'Radar channel availability check: clients cannot connect yet' : '') : null,
    ...wpsControls(i, redraw),
  ].filter(Boolean);
}

// The live part (summary badges and body) of the network `i` (an entry of ifaceList, or an interface of the status): the mesh node of its section for a
// mesh point, else its interface of the status. `ctx` is { mesh: Map(section -> flab.mesh node), net }; `redraw` repaints the page.
function liveOf(i, ctx, redraw) {
  if (i.isNew) return null;
  if (i.mode === 'mesh') {
    const node = ctx.mesh.get(i.section);
    return { badges: meshBadges(node), body: meshLive(node, ctx.net) };
  }
  const status = i.live ?? i;
  return { badges: networkBadges(status, redraw), body: networkLive(status) };
}

// A block for a network the page cannot edit (the configuration is not available): the summary line and the live part, read only.
function readOnlyBlock(i, ctx, redraw) {
  const mesh = i.mode === 'mesh';
  const live = liveOf(i, ctx, redraw);
  const state = !i.enabled ? badge('disabled') : i.up ? badge('running', 'success') : badge('not running', 'danger');
  return disclosure({ cls: 'wf-iface',
    summary: [icon(mesh ? 'diagram-2' : 'wifi'), h('strong', {}, i.ssid ?? ctx.mesh.get(i.section)?.mesh_id ?? i.section), badge(MODE_BADGE[i.mode] ?? i.mode), badge(i.security ?? 'unknown'), state, ...live.badges],
    body: h('div', { className: 'wf-iface-body' }, live.body) });
}

// The section of radio `r`: its wireless networks with their settings (`edit`, see wifi/editors.js) or, without the configuration, read only. Mesh points are
// found by the section of their interface in `ctx.mesh`.
export function networksSection(r, edit, ctx) {
  const count = r.interfaces.length + r.mesh.length;
  const redraw = () => edit?.redraw?.();
  const body = edit?.wifi?.editable
    ? networksEditor(r.name, edit, i => liveOf(i, ctx, redraw))
    : h('div', { className: 'wf-nets-editor' }, count ? [...r.interfaces, ...r.mesh].map(i => readOnlyBlock(i, ctx, redraw)) : h('p', { className: 'muted' }, 'No wireless network is configured on this radio.'));
  return h('div', { className: 'rd-ifaces' }, h('h3', {}, `Wireless networks (${count})`), body);
}
