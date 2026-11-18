// The Connected devices view of Devices and Interfaces: the Wi-Fi clients connected now, one table per wireless network (SSID), moved here from the
// old Wi-Fi page. The columns show MAC, addresses, hostname, signal, standard, bandwidth, bitrate, security, AKM/cipher/PMF details and the 0-100 score; the
// filter and the radio selector are in the command bar. Data comes from the flab.wifi plugin. Only Wi-Fi clients are listed for now; the view is the
// place for the other connected devices (wired clients, DHCP leases) later.
// This module is not a page of its own: pages/interfaces/index.js hosts it (its load, view, command-bar nodes and pause rule).
import { h } from '../../core/dom.js';
import { ubus, optional } from '../../core/ubus.js';
import { badge, button, card, emptyState, tile, tiles, muted, GRADE_KIND } from '../../core/ui.js';
import { disclosure } from '../../core/fold.js';
import { searchControl, selectControl } from '../../core/controls.js';
import { fmtRate, ipNum } from '../../core/format.js';
import { SECURITY_KIND } from '../radios/parts.js';
// Badge color for a client's signal strength in dBm: >= -50 strong, >= -70 usable, below that weak.
const SIGNAL_KIND = s => s == null ? '' : s >= -50 ? 'success' : s >= -70 ? 'warning' : 'danger';

// Filter text, selected radio ('all' or a radio name) and table sort: module-level so they survive the redraw on every poll.
const state = { q: '', radio: 'all', sort: { key: 'signal', dir: -1 } };

// A fixed-width monospace cell that is cut with an ellipsis; the full text is the tooltip.
const clip = (text, title) => h('span', { className: 'mono clip', title: title || text }, text);

// Each column pairs a header with a width (% of the fixed table layout, so every SSID table aligns),
// a sort key extractor and a cell renderer.
const COLS = [
  { key: 'mac', label: 'MAC address', w: 10, sort: c => c.mac, cell: c => h('span', { className: 'mono' }, c.mac) },
  { key: 'ipv4', label: 'IPv4', w: 8, sort: c => ipNum(c.ipv4), cell: c => c.ipv4 || muted('N/A') },
  { key: 'ipv6', label: 'IPv6', w: 14, sort: c => c.ipv6[0] || '', cell: c => !c.ipv6.length ? muted('N/A')
    : clip(c.ipv6[0] + (c.ipv6.length > 1 ? ` (+${c.ipv6.length - 1})` : ''), c.ipv6.join('\n')) },
  { key: 'hostname', label: 'Hostname', w: 9, sort: c => (c.hostname || '').toLowerCase(), cell: c => c.hostname || muted('Unknown') },
  { key: 'signal', label: 'Signal', w: 7, sort: c => c.signal ?? -999, cell: c => c.signal == null ? 'N/A' : badge(`${c.signal} dBm`, SIGNAL_KIND(c.signal)) },
  { key: 'standard', label: 'Wi-Fi std', w: 6, sort: c => c.standard || '', cell: c => c.standard || muted('Unknown') },
  { key: 'width', label: 'BW', w: 5, sort: c => c.width ?? 0, cell: c => c.width ? `${c.width} MHz` : '–' },
  { key: 'bitrate', label: 'Bitrate (↑/↓ Mbit/s)', w: 11, sort: c => Math.max(c.tx ?? 0, c.rx ?? 0), cell: c => `↑${fmtRate(c.tx)} / ↓${fmtRate(c.rx)}` },
  { key: 'security', label: 'Security', w: 10, sort: c => c.security, cell: c => badge(c.security, SECURITY_KIND(c.security)) },
  { key: 'details', label: 'Details', w: 14, wrap: true, sort: c => c.akm || '', cell: c => h('span', {},
    c.akm ? h('span', { className: 'chip' }, `AKM: ${c.akm}`) : null,
    c.sae_group != null ? h('span', { className: 'chip' }, `SAE-Grp: ${c.sae_group}`) : null,
    c.cipher ? h('span', { className: 'chip' }, `Cipher: ${c.cipher}`) : null,
    c.pmf != null ? h('span', { className: 'chip' }, `PMF: ${c.pmf}`) : null,
    !c.akm && !c.cipher ? '–' : null) },
  { key: 'score', label: 'Score', w: 6, sort: c => c.rating?.score ?? -1, cell: c => !c.rating ? muted('N/A')
    : badge(`${c.rating.grade} (${c.rating.score}${c.rating.partial ? '*' : ''})`, GRADE_KIND[c.rating.grade],
      c.rating.partial ? 'Some fields were unavailable; neutral defaults were used' : '') },
];

// True when every whitespace-separated search term occurs (case-insensitive) in one of the client's
// searchable fields or its SSID; an empty query matches everything.
function matches(c, ssid, q) {
  if (!q) return true;
  const hay = [c.mac, c.ipv4, ...c.ipv6, c.hostname, ssid, c.security, c.akm, c.cipher, c.standard].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every(t => hay.includes(t));
}

// Copy of `list` ordered by the active column of `state.sort` (dir 1 ascending, -1 descending).
function sortClients(list) {
  const col = COLS.find(c => c.key === state.sort.key);
  return [...list].sort((a, b) => {
    const x = col.sort(a), y = col.sort(b);
    return (x < y ? -1 : x > y ? 1 : 0) * state.sort.dir;
  });
}

// Table of one SSID's clients with the shared COLS layout; clicking a header sets or reverses the sort
// and calls `rerender` to redraw from the cached data.
function clientTable(clients, rerender) {
  // Clickable column headers; the active sort column shows an arrow for its direction.
  const head = COLS.map(col => {
    const active = state.sort.key === col.key;
    return h('th', {
      className: 'sortable', title: 'Sort',
      onclick: () => {
        state.sort = { key: col.key, dir: active ? -state.sort.dir : 1 };
        rerender();
      },
    }, col.label, active ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : '');
  });
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover fixed-grid' },
    h('colgroup', {}, COLS.map(col => h('col', { style: `width:${col.w}%` }))),
    h('thead', {}, h('tr', {}, head)),
    h('tbody', {}, clients.length
      ? sortClients(clients).map(c => h('tr', {}, COLS.map(col => h('td', { className: col.wrap ? 'wrap' : '' }, col.cell(c)))))
      : h('tr', {}, h('td', { colSpan: COLS.length, className: 'muted' }, 'No clients connected')))));
}

// Help text for the legend: [heading, explanations] for the AKM, cipher/PMF and score columns.
const LEGEND = [
  ['AKM (Authentication & Key Management)', [
    'SAE = WPA3 (password not sent, resistant to offline attacks, forward secrecy)',
    'FT-SAE = WPA3 with Fast Transition (802.11r roaming)',
    'PSK = WPA2 (traditional, vulnerable to offline dictionary attacks); PSK-SHA256 = enhanced hashing',
    'FT-xxx = Fast Transition add-on (802.11r), e.g. FT-PSK = WPA2 + fast roaming']],
  ['Encryption & security', [
    'SAE-Grp: 19 = 256-bit (standard), 20 = 384-bit (high), 21 = 521-bit (maximum)',
    'Cipher: CCMP = AES (standard), GCMP = AES-GCM (WPA3 preferred)',
    'PMF: 0 = disabled (weak), 1 = enabled/required (strong, mandatory for WPA3)']],
  ['Security score', [
    'A+ excellent, A very good, B good, C fair, D weak',
    '* means unavailable fields used neutral defaults']],
];

// The filter box and the radio selector of the command bar, built once; the host shows them only on this view.
let filters = null;
let radioSelect = null;

export const connected = {
  css: ['css/connected.css'],
  // Nothing on this view holds unsaved input; the host adds the Pause button.
  isPaused: () => false,

  // The clients of every radio, per wireless network; optional, so the other views work when the Wi-Fi plugin is missing.
  load: async () => ({ clients: await optional(ubus('flab.wifi', 'clients')) }),

  // The filter box and the radio dropdown, as one command-bar node (hidden until the view is shown, see setActive).
  attach(rerender) {
    radioSelect = selectControl(state, 'radio', rerender, 'Radio');
    filters = h('span', { className: 'cc-filters', style: 'display: none' }, searchControl(state, 'q', rerender, 'Filter clients…'), radioSelect.node);
    return filters;
  },

  // Shows the filters on this view only.
  setActive(on) { if (filters) filters.style.display = on ? 'flex' : 'none'; },

  // The radio dropdown follows radios that appear or disappear.
  update(data) {
    radioSelect?.setOptions([['all', 'All radios'], ...(data.clients?.radios ?? []).map(r => [r.name, `${r.name} (${r.band ?? '?'})`])]);
  },

  // Summary tiles, the legend, then one client card per radio interface (SSID). With a filter active, SSIDs without a matching client are hidden.
  // Client counts and averages cover all radios, regardless of the radio selector.
  view(data, rerender) {
    const all = data.clients?.radios;
    if (!all) return [emptyState('The Wi-Fi plugin (flab.wifi) is not available on this router, so connected clients are not listed.')];

    // Mesh interfaces and their peers are on the Wi-Fi radios page.
    const ifsOf = r => r.interfaces.filter(i => i.mode !== 'mesh');
    const radios = all.filter(r => state.radio === 'all' || r.name === state.radio);
    const clientsAll = all.flatMap(r => ifsOf(r).flatMap(i => i.clients));
    const signals = clientsAll.map(c => c.signal).filter(s => s != null);
    const avg = signals.length ? Math.round(signals.reduce((a, b) => a + b, 0) / signals.length) : null;
    const wpa3 = clientsAll.filter(c => /WPA3|OWE/.test(c.security)).length;
    const weak = clientsAll.filter(c => c.rating && ['C', 'D'].includes(c.rating.grade)).length;

    const summary = tiles(
      tile('Connected clients', clientsAll.length, `${all.length} radios`),
      ...all.map(r => tile(`${r.name} · ${r.band ?? '?'}`,
        ifsOf(r).reduce((n, i) => n + i.clients.length, 0), `channel ${r.channel}${r.htmode ? ' · ' + r.htmode : ''}`)),
      tile('Average signal', avg == null ? '–' : `${avg} dBm`, 'across all clients'),
      tile('WPA3 clients', `${wpa3} / ${clientsAll.length}`, 'SAE or OWE'),
      tile('Need attention', weak, 'security grade C or D', weak ? 'text-warning' : ''));

    const groups = [];
    for (const r of radios) {
      for (const i of ifsOf(r)) {
        const clients = i.clients.filter(c => matches(c, i.ssid ?? '', state.q));
        if (state.q && !clients.length) continue;
        groups.push(card(
          [h('span', {}, i.ssid || 'Hidden'), badge(i.mode), badge(i.security, SECURITY_KIND(i.security)),
            h('span', { className: 'sub' }, `${i.ifname ?? 'N/A'} · ${r.name} ${r.band ?? ''} · ch ${r.channel}`),
            h('span', { className: 'ms-auto' }, badge(`${clients.length} client${clients.length === 1 ? '' : 's'}`, 'info'))],
          clientTable(clients, rerender)));
      }
    }
    if (!groups.length) groups.push(emptyState('No matching clients', button('Clear filters', 'x-lg', () => {
      state.q = '';
      state.radio = 'all';
      if (filters) filters.querySelector('input').value = '';
      radioSelect?.node && (radioSelect.node.value = 'all');
      rerender();
    })));

    const legend = disclosure({ cls: 'legend card card-body', summary: 'Legend',
      body: h('div', { className: 'row mt-2' }, LEGEND.map(([title, items]) => h('div', { className: 'col-md-4' },
        h('div', { className: 'fw-semibold' }, title), h('ul', {}, items.map(t => h('li', {}, t)))))) });

    return [summary, legend, ...groups];
  },
};