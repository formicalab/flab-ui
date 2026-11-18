// The Connected devices view of Devices and Interfaces: Ethernet devices learned through bridge ports and Wi-Fi clients,
// grouped by SSID. The search applies to both; the radio selector only filters Wi-Fi. Data comes from flab.network and
// flab.wifi. A MAC learned on a wired port can be behind an attached unmanaged switch, so the UI says "through port".
// This module is not a page of its own: pages/interfaces/index.js hosts it (its load, view, command-bar nodes and pause rule).
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { ubus, optional } from '../../core/ubus.js';
import { badge, button, card, emptyState, tile, tiles, muted, GRADE_KIND, SECURITY_KIND } from '../../core/ui.js';
import { disclosure } from '../../core/fold.js';
import { searchControl, selectControl } from '../../core/controls.js';
import { fmtRate, ipNum } from '../../core/format.js';
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

function wiredMatches(client, q) {
  if (!q) return true;
  const hay = [client.port, client.mac, client.ipv4, ...client.ipv6, client.hostname, client.bridge].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every(term => hay.includes(term));
}

const SVG = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function wiredDevice(client) {
  const address = [client.ipv4, ...client.ipv6.slice(0, 1)].filter(Boolean).join(' · ');
  return h('div', { className: 'cc-device' },
    h('div', { className: 'cc-device-icon' }, icon('laptop', 20)),
    h('div', { className: 'cc-device-body' },
      h('strong', {}, client.hostname || 'Unknown device'),
      h('span', { className: 'cc-device-address' }, address || 'No address learned'),
      h('span', { className: 'mono small' }, client.mac),
      client.ipv6.length > 1 ? h('span', { className: 'muted small', title: client.ipv6.join('\n') }, `+${client.ipv6.length - 1} more IPv6`) : null));
}

// One physical-port card connected to each device learned through it with cubic SVG curves. The FDB intentionally
// does not claim that a device is directly plugged in: several devices may share a port behind another switch.
function connectedTopology(source, devices, renderDevice, cls = '') {
  const deviceNodes = devices.map(renderDevice);
  const deviceGroup = h('div', { className: `cc-devices ${cls}` }, ...deviceNodes);
  const svg = svgEl('svg', { class: 'cc-wires', 'aria-hidden': 'true' });
  const row = h('div', { className: `cc-wire-row ${cls}` }, svg, source, deviceGroup);

  let queued = false;
  const draw = () => {
    if (!row.isConnected) return;
    svg.replaceChildren();
    if (getComputedStyle(svg).display === 'none') return;
    const bounds = row.getBoundingClientRect();
    svg.setAttribute('width', String(bounds.width));
    svg.setAttribute('height', String(bounds.height));
    const sourceBounds = source.getBoundingClientRect();
    const p1 = [sourceBounds.right - bounds.left, sourceBounds.top + sourceBounds.height / 2 - bounds.top];
    for (const node of deviceNodes) {
      const target = node.getBoundingClientRect();
      const p2 = [target.left - bounds.left, target.top + target.height / 2 - bounds.top];
      const dx = Math.max(24, (p2[0] - p1[0]) / 2);
      const d = `M${p1[0]},${p1[1]} C${p1[0] + dx},${p1[1]} ${p2[0] - dx},${p2[1]} ${p2[0]},${p2[1]}`;
      svg.append(svgEl('path', { d, class: 'cc-wire' }),
        svgEl('circle', { cx: p1[0], cy: p1[1], r: 3, class: 'cc-endpoint' }),
        svgEl('circle', { cx: p2[0], cy: p2[1], r: 3, class: 'cc-endpoint' }));
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  };
  let seen = false;
  const observer = new ResizeObserver(() => {
    if (row.isConnected) seen = true;
    else if (seen) { observer.disconnect(); return; }
    schedule();
  });
  observer.observe(row);
  observer.observe(deviceGroup);
  document.fonts?.ready.then(schedule);
  schedule();
  return row;
}

function wiredTopology(clients) {
  const byPort = new Map();
  for (const client of clients) {
    if (!byPort.has(client.port)) byPort.set(client.port, []);
    byPort.get(client.port).push(client);
  }
  const root = h('div', { className: 'cc-wired' });
  for (const [port, devices] of byPort) {
    const portNode = h('div', { className: 'cc-port' },
      icon('ethernet', 28),
      h('div', {}, h('strong', {}, port), h('span', { className: 'small muted' }, devices[0].speed ? `${devices[0].speed} Mbit/s${devices[0].duplex ? ` · ${devices[0].duplex}` : ''}` : 'link unavailable')));
    root.append(connectedTopology(portNode, devices, wiredDevice));
  }
  return root;
}

function wirelessDevice(client) {
  return h('div', { className: 'cc-device' },
    h('div', { className: 'cc-device-icon' }, icon('laptop', 20)),
    h('div', { className: 'cc-device-body' },
      h('strong', {}, client.hostname || 'Unknown device'),
      h('span', { className: 'cc-device-address' }, client.ipv4 || client.ipv6[0] || 'No address learned'),
      h('span', { className: 'mono small' }, client.mac),
      h('span', { className: 'cc-device-radio' }, client.signal == null ? 'signal unavailable' : `${client.signal} dBm`,
        client.standard ? ` · ${client.standard}` : '')));
}

function wirelessTopology(iface, radio, clients) {
  const source = h('div', { className: 'cc-port cc-access-point' },
    icon('wifi', 28),
    h('div', {},
      h('strong', {}, iface.ssid || 'Hidden SSID'),
      h('span', { className: 'small muted' }, `${radio.name} · ${radio.band ?? '?'} · ${clients.length} client${clients.length === 1 ? '' : 's'}`)));
  return connectedTopology(source, clients, wirelessDevice, 'cc-wifi');
}

// The filter box and the radio selector of the command bar, built once; the host shows them only on this view.
let filters = null;
let radioSelect = null;

export const connected = {
  css: ['css/connected.css'],
  // Nothing on this view holds unsaved input; the host adds the Pause button.
  isPaused: () => false,

  // Wired bridge members and the clients of every radio; either backend may be unavailable independently.
  load: async () => {
    const [clients, wired] = await Promise.all([
      optional(ubus('flab.wifi', 'clients')),
      optional(ubus('flab.network', 'clients')),
    ]);
    return { clients, wired };
  },

  // The filter box and the radio dropdown, as one command-bar node (hidden until the view is shown, see setActive).
  attach(rerender) {
    radioSelect = selectControl(state, 'radio', rerender, 'Radio');
    filters = h('span', { className: 'cc-filters', style: 'display: none' }, searchControl(state, 'q', rerender, 'Filter devices…'), radioSelect.node);
    return filters;
  },

  // Shows the filters on this view only.
  setActive(on) { if (filters) filters.style.display = on ? 'flex' : 'none'; },

  // The radio dropdown follows radios that appear or disappear.
  update(data) {
    radioSelect?.setOptions([['all', 'All radios'], ...(data.clients?.radios ?? []).map(r => [r.name, `${r.name} (${r.band ?? '?'})`])]);
  },

  // Summary tiles, one Ethernet card, then one client card per radio interface (SSID) and the Wi-Fi legend.
  // Client counts and averages cover all radios, regardless of the radio selector.
  view(data, rerender) {
    const all = data.clients?.radios ?? null;
    const wiredAll = data.wired?.clients ?? [];
    if (!all && !wiredAll.length) return [emptyState('No connected-device backend is available on this router.')];

    // Mesh interfaces and their peers are on the Wi-Fi radios page.
    const ifsOf = r => r.interfaces.filter(i => i.mode !== 'mesh');
    const radios = (all ?? []).filter(r => state.radio === 'all' || r.name === state.radio);
    const clientsAll = (all ?? []).flatMap(r => ifsOf(r).flatMap(i => i.clients));
    const wired = wiredAll.filter(client => wiredMatches(client, state.q));
    const signals = clientsAll.map(c => c.signal).filter(s => s != null);
    const avg = signals.length ? Math.round(signals.reduce((a, b) => a + b, 0) / signals.length) : null;
    const wpa3 = clientsAll.filter(c => /WPA3|OWE/.test(c.security)).length;
    const weak = clientsAll.filter(c => c.rating && ['C', 'D'].includes(c.rating.grade)).length;

    const summary = tiles(
      tile('Connected devices', clientsAll.length + wiredAll.length, `${clientsAll.length} wireless · ${wiredAll.length} Ethernet`),
      tile('Ethernet devices', wiredAll.length, `${new Set(wiredAll.map(c => c.port)).size} learned ports`),
      ...(all ?? []).map(r => tile(`${r.name} · ${r.band ?? '?'}`,
        ifsOf(r).reduce((n, i) => n + i.clients.length, 0), `channel ${r.channel}${r.htmode ? ' · ' + r.htmode : ''}`)),
      tile('Average signal', avg == null ? '–' : `${avg} dBm`, 'across all clients'),
      tile('WPA3 clients', `${wpa3} / ${clientsAll.length}`, 'SAE or OWE'),
      tile('Need attention', weak, 'security grade C or D', weak ? 'text-warning' : ''));

    const groups = [];
    if (wired.length) groups.push(card(
      [h('span', {}, 'Ethernet'), badge('bridge FDB'), h('span', { className: 'sub' }, 'Learned through each physical port; devices can be behind an attached switch'),
        h('span', { className: 'ms-auto' }, badge(`${wired.length} device${wired.length === 1 ? '' : 's'}`, 'info'))],
      wiredTopology(wired)));
    for (const r of radios) {
      for (const i of ifsOf(r)) {
        const clients = i.clients.filter(c => matches(c, i.ssid ?? '', state.q));
        if (state.q && !clients.length) continue;
        groups.push(card(
          [h('span', {}, i.ssid || 'Hidden'), badge(i.mode), badge(i.security, SECURITY_KIND(i.security)),
            h('span', { className: 'sub' }, `${i.ifname ?? 'N/A'} · ${r.name} ${r.band ?? ''} · ch ${r.channel}`),
            h('span', { className: 'ms-auto' }, badge(`${clients.length} client${clients.length === 1 ? '' : 's'}`, 'info'))],
          h('div', {},
            clients.length ? wirelessTopology(i, r, clients) : emptyState('No clients connected'),
            clients.length ? disclosure({ cls: 'cc-client-details', summary: 'Client details', body: clientTable(clients, rerender) }) : null)));
      }
    }
    if (!groups.length) groups.push(emptyState('No matching devices', button('Clear filters', 'x-lg', () => {
      state.q = '';
      state.radio = 'all';
      if (filters) filters.querySelector('input').value = '';
      radioSelect?.node && (radioSelect.node.value = 'all');
      rerender();
    })));

    const legend = clientsAll.length ? disclosure({ cls: 'legend card card-body', summary: 'Wi-Fi legend',
      body: h('div', { className: 'row mt-2' }, LEGEND.map(([title, items]) => h('div', { className: 'col-md-4' },
        h('div', { className: 'fw-semibold' }, title), h('ul', {}, items.map(t => h('li', {}, t)))))) }) : null;

    const wiredGroups = groups.filter(group => group.classList?.contains('card') && group.querySelector?.('.cc-wired'));
    const wirelessGroups = groups.filter(group => !wiredGroups.includes(group));
    return [summary, ...wiredGroups, legend, ...wirelessGroups].filter(Boolean);
  },
};