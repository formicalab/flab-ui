// Wi-Fi page: radios (state, configuration, SSIDs; radios.js) followed by connected clients per radio and
// SSID, from the flab.wifi plugin, which ports utilities/list_connected_devices.uc. The table columns
// mirror that tool (MAC, addresses, hostname, signal, standard, bandwidth, bitrate, security,
// AKM/cipher/PMF details, 0-100 score).
// Filter text, sort order, selected radio and the paused flag live in `state` so they survive refreshes.
import { h } from '../../core/dom.js';
import { ubus } from '../../core/ubus.js';
import { badge, card, tile, tiles } from '../../core/ui.js';
import { searchControl, selectControl, pauseControl, refreshControl } from '../../core/controls.js';
import { fmtRate, ipNum } from '../../core/format.js';
import { radiosSection, recordRadios } from './radios.js';

const SIGNAL_KIND = s => s == null ? '' : s >= -50 ? 'success' : s >= -70 ? 'warning' : 'danger';
const GRADE_KIND = { 'A+': 'success', A: 'success', B: 'info', C: 'warning', D: 'danger' };
const SECURITY_KIND = s => /WPA3|OWE/.test(s) ? 'success' : /WPA2/.test(s) ? 'warning' : /Open|WEP|^WPA-/.test(s) ? 'danger' : '';

const state = { q: '', radio: 'all', sort: { key: 'signal', dir: -1 }, paused: false };

const muted = text => h('span', { className: 'muted' }, text);
const clip = (text, title) => h('span', { className: 'mono clip', title: title || text }, text);

// Each column pairs a header with a width (% of the fixed table layout, so every SSID table aligns),
// a sort key extractor and a cell renderer (same fields as utilities/list_connected_devices.uc).
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

function matches(c, ssid, q) {
  if (!q) return true;
  const hay = [c.mac, c.ipv4, ...c.ipv6, c.hostname, ssid, c.security, c.akm, c.cipher, c.standard].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every(t => hay.includes(t));
}

function sortClients(list) {
  const col = COLS.find(c => c.key === state.sort.key);
  return [...list].sort((a, b) => {
    const x = col.sort(a), y = col.sort(b);
    return (x < y ? -1 : x > y ? 1 : 0) * state.sort.dir;
  });
}

function clientTable(clients, rerender) {
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

// A missing plugin or ACL must not break the clients list.
const optional = promise => promise.catch(() => null);

export default {
  id: 'wifi',
  label: 'Wi-Fi',
  title: 'Wi-Fi · radios and clients',
  icon: 'wifi',
  interval: 5000,
  css: 'css/wifi.css',

  load: async () => {
    const [clients, hw] = await Promise.all([ubus('flab.wifi', 'clients'), optional(ubus('flab.radio', 'status'))]);
    recordRadios(hw);
    return { ...clients, hw };
  },
  isPaused: () => state.paused,

  controls({ rerender, reload }) {
    const radio = selectControl(state, 'radio', rerender, 'Radio');
    return {
      nodes: [searchControl(state, 'q', rerender, 'Filter clients…'), radio.node, pauseControl(state), refreshControl(reload)],
      update: data => radio.setOptions([['all', 'All radios'], ...data.radios.map(r => [r.name, `${r.name} (${r.band ?? '?'})`])]),
    };
  },

  view(data, rerender) {
    // Mesh interfaces and their peers have their own page (Mesh).
    const ifsOf = r => r.interfaces.filter(i => i.mode !== 'mesh');
    const radios = data.radios.filter(r => state.radio === 'all' || r.name === state.radio);
    const all = data.radios.flatMap(r => ifsOf(r).flatMap(i => i.clients));
    const signals = all.map(c => c.signal).filter(s => s != null);
    const avg = signals.length ? Math.round(signals.reduce((a, b) => a + b, 0) / signals.length) : null;
    const wpa3 = all.filter(c => /WPA3|OWE/.test(c.security)).length;
    const weak = all.filter(c => c.rating && ['C', 'D'].includes(c.rating.grade)).length;

    const summary = tiles(
      tile('Connected clients', all.length, `${data.radios.length} radios`),
      ...data.radios.map(r => tile(`${r.name} · ${r.band ?? '?'}`,
        ifsOf(r).reduce((n, i) => n + i.clients.length, 0), `channel ${r.channel}${r.htmode ? ' · ' + r.htmode : ''}`)),
      tile('Average signal', avg == null ? '–' : `${avg} dBm`, 'across all clients'),
      tile('WPA3 clients', `${wpa3} / ${all.length}`, 'SAE or OWE'),
      tile('Need attention', weak, 'security grade C or D', weak ? 'text-warning' : ''));

    const groups = [];
    for (const r of radios) {
      for (const i of ifsOf(r)) {
        const clients = i.clients.filter(c => matches(c, i.ssid ?? '', state.q));
        if (state.q && !clients.length) continue;
        groups.push(card(
          [h('span', {}, i.ssid || 'Hidden'), badge(i.mode), badge(i.security, SECURITY_KIND(i.security)),
            h('span', { className: 'sub' }, `${i.ifname ?? 'N/A'} · ${r.name} ${r.band ?? ''} · ch ${r.channel}`),
            h('span', { className: 'ms-auto fl-badge info' }, `${clients.length} client${clients.length === 1 ? '' : 's'}`)],
          clientTable(clients, rerender)));
      }
    }
    if (!groups.length) groups.push(card(null, h('div', { className: 'card-body muted' }, 'No matching clients')));

    const legend = h('details', { className: 'legend card card-body' }, h('summary', {}, 'Legend'),
      h('div', { className: 'row mt-2' }, LEGEND.map(([title, items]) => h('div', { className: 'col-md-4' },
        h('div', { className: 'fw-semibold' }, title), h('ul', {}, items.map(t => h('li', {}, t)))))));

    return [summary, ...radiosSection(data.hw), legend, ...groups];
  },
};
