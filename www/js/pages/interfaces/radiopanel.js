// The drawer of a radio on the board: its hardware, what it does now, the settings it is configured with and the wireless interfaces on it. It is read
// only: the radio's settings and its networks are edited on the Wi-Fi page (the footer links to it). Every panel is { title, subtitle, body, footer }.
import { h } from '../../core/dom.js';
import { badge, mono, muted } from '../../core/ui.js';
import { section, infoList } from './panelparts.js';

const BAND = { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz', '60g': '60 GHz' };

// A link button to another page.
const pageLink = (href, label) => h('a', { href, className: 'btn btn-sm btn-fl' }, label);

// The state of a radio as a badge.
const stateBadge = r => (!r.enabled ? badge('disabled', '') : r.retry_failed ? badge('failed', 'danger') : r.pending ? badge('starting', 'warning') : r.up ? badge('up', 'success') : badge('down', 'danger'));

// The rows of what the radio is built from.
const hardwareRows = r => [
  r.hardware?.hardware ? ['Hardware', r.hardware.hardware] : null,
  r.hardware?.hwmodes ? ['Modes', r.hardware.hwmodes] : null,
  r.phy ? ['PHY', mono(r.phy)] : null,
  (r.standards ?? []).length ? ['Standards', r.standards.join(' · ')] : null,
  r.antennas ? ['Antennas', `${r.antennas.tx} × ${r.antennas.rx} (TX × RX chains)`] : null,
  r.config?.path ? ['Device path', mono(r.config.path)] : null,
];

// The rows of what the radio does now.
function nowRows(r) {
  const live = r.live ?? {};
  return [
    ['State', stateBadge(r)],
    live.channel != null ? ['Channel', `${live.channel}${live.freq ? ` · ${live.freq} MHz` : ''}`] : null,
    live.width ? ['Width', `${live.width} MHz${live.center ? ` · center ${live.center} MHz` : ''}`] : null,
    live.txpower != null ? ['TX power', `${live.txpower} dBm · ${Math.round(10 ** (live.txpower / 10))} mW`] : null,
    r.survey?.noise != null ? ['Noise floor', `${r.survey.noise} dBm`] : null,
    ['Clients', String(r.interfaces.reduce((n, i) => n + (i.clients ?? 0), 0))],
  ];
}

// The rows of the radio's configuration next to what is running.
function settingsRows(r) {
  const c = r.config ?? {}, live = r.live ?? {};
  const channel = c.channel === 'auto' || c.channel == null ? 'auto (ACS)' : c.channel;
  return [
    ['Channel', h('span', {}, `configured ${channel}`, live.channel != null && String(live.channel) !== String(c.channel) ? muted(` · running ${live.channel}`) : null)],
    ['Mode', c.htmode ?? '–'],
    ['TX power', c.txpower != null ? `${c.txpower} dBm` : 'maximum allowed'],
    ['Country', c.country ?? '–'],
    ['Cell density', c.cell_density ?? '–'],
    ['Beacon interval', c.beacon_int != null ? `${c.beacon_int} ms` : 'default (100 ms)'],
    ['Options', h('span', {}, c.noscan ? badge('no coexistence scan') : null, c.legacy_rates ? badge('legacy rates', 'warning') : badge('legacy rates off'))],
  ];
}

// One wireless interface of the radio: SSID and mode, the networks it is on, its clients and state.
function interfaceRow(i) {
  const state = !i.enabled ? badge('disabled', '') : !i.up ? badge('not running', 'danger') : badge('up', 'success');
  return h('div', { className: 'rp-if' },
    h('div', {}, h('strong', {}, i.ssid ?? i.ifname ?? i.section), ' ', badge(i.mode), ' ', state),
    h('div', { className: 'muted small' }, [i.ifname, i.networks?.length ? `network ${i.networks.join(', ')}` : null, i.clients != null ? `${i.clients} client${i.clients === 1 ? '' : 's'}` : null, i.security].filter(Boolean).join(' · ')));
}

// The panel of the radio `item` (a board item); `data.radios` holds what flab.radio reports.
export function radioPanel(item, data) {
  const r = (data.radios ?? []).find(x => x.name === item.name);
  if (!r) return { title: item.name, subtitle: 'Radio', body: h('div', { className: 'nb-panel' }, muted('The router reports no radio of this name.')), footer: [pageLink('#wifi', 'Wi-Fi page')] };
  return {
    title: r.name, subtitle: `Radio · ${BAND[r.band] ?? r.band ?? 'Wi-Fi'}${r.phy ? ` · ${r.phy}` : ''}`,
    body: h('div', { className: 'nb-panel' },
      section(null, 'Hardware', null, infoList(hardwareRows(r))),
      section(null, 'Now', null, infoList(nowRows(r))),
      section(null, 'Settings', 'As configured; the radio is edited on the Wi-Fi page.', infoList(settingsRows(r))),
      section(null, `Interfaces (${r.interfaces.length})`, null,
        r.interfaces.length ? h('div', { className: 'rp-ifs' }, r.interfaces.map(interfaceRow)) : muted('No wireless interface is configured on this radio.'))),
    footer: [pageLink('#wifi', 'Wi-Fi page: radio settings'), ...(r.interfaces.some(i => i.mode === 'mesh') ? [pageLink('#mesh', 'Mesh page')] : [])],
  };
}
