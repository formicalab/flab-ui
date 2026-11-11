// Wi-Fi page: radios (state, configuration, SSIDs; radios.js) followed by connected clients per radio and
// SSID, from the flab.wifi plugin, which ports utilities/list_connected_devices.uc. The table columns
// mirror that tool (MAC, addresses, hostname, signal, standard, bandwidth, bitrate, security,
// AKM/cipher/PMF details, 0-100 score).
// The channel of each radio can be changed through the picker of its card (picker.js, model in channels.js): the
// choice is staged in /etc/config/wireless and applied with the rollback countdown like every config change.
// Filter text, sort order, selected radio and the paused flag live in `state` so they survive refreshes.
import { h } from '../../core/dom.js';
import { ubus, optional } from '../../core/ubus.js';
import { badge, card, tile, tiles, muted, GRADE_KIND } from '../../core/ui.js';
import { searchControl, selectControl, pauseControl, refreshControl } from '../../core/controls.js';
import { fmtRate, ipNum } from '../../core/format.js';
import { createEditor } from '../../core/editpage.js';
import { uci } from '../../core/uci.js';
import { radiosSection, recordRadios, SECURITY_KIND } from './radios.js';
import { CONFIG, changesOf, checkApplied, draftFrom, isDirty, plan, problems, readChannels } from './channels.js';

// How long to wait, after a channel change is applied, for the radios to come back up (the router undoes the
// change by itself 30 seconds after the apply, so this must stay well below that), and how often to look.
const RADIO_WAIT_MS = 16000;
const RADIO_POLL_MS = 2000;

// Waits until every radio in `names` is up again after the change, or throws, which makes the change be undone.
async function waitForRadios(names) {
  const deadline = Date.now() + RADIO_WAIT_MS;
  for (;;) {
    const hw = await optional(ubus('flab.radio', 'status'));
    const down = names.filter(n => { const r = hw?.radios?.find(x => x.name === n); return !(r?.up && !r.pending && !r.retry_failed); });
    if (!down.length) return;
    if (Date.now() > deadline) throw new Error(`${down.join(', ')} did not come back up after the change, so it was undone.`);
    await new Promise(resolve => setTimeout(resolve, RADIO_POLL_MS));
  }
}

// The draft, the review banner, saving and discarding, shared with the other editing pages (core/editpage.js).
// What the page edits is the channel of each radio. It reads back only the radios' own sections, never the whole
// wireless config, because that holds the Wi-Fi keys.
const editor = createEditor({
  config: CONFIG,
  readAfter: async () => readChannels(Object.fromEntries(await Promise.all(
    editor.state.base.radios.map(async r => [r.name, await uci.get(CONFIG, r.name)])))),
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: async (base, draft, after) => {
    checkApplied(after, draft);
    const changed = changesOf(base, draft).map(c => c.key.split(':')[0]).filter(n => base.radios.find(r => r.name === n)?.enabled);
    await waitForRadios(changed);
  },
});

// Badge color for a client's signal strength in dBm: >= -50 strong, >= -70 usable, below that weak.
const SIGNAL_KIND = s => s == null ? '' : s >= -50 ? 'success' : s >= -70 ? 'warning' : 'danger';

// Filter text, selected radio ('all' or a radio name), table sort and the paused flag: module-level so
// they survive the redraw on every poll.
const state = { q: '', radio: 'all', sort: { key: 'signal', dir: -1 }, paused: false };

// A fixed-width monospace cell that is cut with an ellipsis; the full text is the tooltip.
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

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'wifi',
  label: 'Wi-Fi',
  title: 'Wi-Fi · radios and clients',
  icon: 'wifi',
  interval: 5000,
  css: ['css/forms.css', 'css/wifi.css'],

  // Clients and radio hardware are fetched together; the radio call is optional so the client tables still
  // work when flab.radio is not installed. Counters go to the rate tracker before rendering.
  load: async () => {
    const [clients, hw] = await Promise.all([ubus('flab.wifi', 'clients'), optional(ubus('flab.radio', 'status'))]);
    recordRadios(hw);
    return editor.withStaged({ ...clients, hw });
  },
  isPaused: () => state.paused || editor.paused('.rd-grid') || Boolean(document.querySelector('.rd-pick:hover')),

  // The radio dropdown is refreshed after every load so it follows radios that appear or disappear.
  controls({ rerender, reload }) {
    const radio = selectControl(state, 'radio', rerender, 'Radio');
    return {
      nodes: [searchControl(state, 'q', rerender, 'Filter clients…'), radio.node, pauseControl(state), refreshControl(reload), editor.attach(reload)],
      update: data => radio.setOptions([['all', 'All radios'], ...data.radios.map(r => [r.name, `${r.name} (${r.band ?? '?'})`])]),
    };
  },

  // Summary tiles, radio cards, legend, then one client card per radio interface (SSID). With a filter
  // active, SSIDs without a matching client are hidden. Client counts and averages cover all radios,
  // regardless of the radio selector.
  view(data, rerender) {
    // The channel pickers of the radio cards edit the draft; they are read-only for a login that may not write.
    const canEdit = editor.begin(data.hw ?? { radios: [] }, rerender);
    const edit = { canEdit, draft: editor.state.draft, inputs: {}, sync: () => {}, touched: () => {} };
    edit.sync = () => editor.markErrors(edit.inputs, canEdit);
    edit.touched = editor.touched(edit);

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

    edit.sync();
    return [summary, ...editor.notes(data), ...radiosSection(data.hw, data.hw?.radios?.length ? edit : null), legend, ...groups].filter(Boolean);
  },
};
