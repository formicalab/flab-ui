// Radios section of the Wi-Fi page: one card per radio with its live state (channel, width, tx power,
// noise, channel utilization), its configuration next to what is actually running, the channels the
// regulatory domain allows (a picker to change the channel, see picker.js), and a table of the SSIDs on it (mesh
// interfaces are on the Mesh page). When the configuration can be edited, each card also holds the radio's settings and a
// form per wireless network (editors.js). Data
// comes from the flab.radio plugin; counters (airtime, bytes) are turned into rates here, so the cards
// follow channel changes, DFS events and interfaces coming and going on every poll.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, kv, meter, sparkline, muted, mono } from '../../core/ui.js';
import { createTracker, latest } from '../../core/rates.js';
import { fmtBytes, fmtLine, fmtNum } from '../../core/format.js';
import { channelPicker } from './picker.js';
import { editable, runningBlock } from './channels.js';
import { networksEditor, radioSettings } from './editors.js';

// Module-level so rate history survives the redraw on every poll (keys: airtime per radio and channel,
// byte counters per interface).
const tracker = createTracker();

// Band code from the radio plugin -> label.
const BAND = { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz', '60g': '60 GHz' };
// Band label of a radio, derived from the live frequency (MHz) when the band code is unknown.
const bandOf = r => BAND[r.band] ?? (r.live?.freq ? `${(r.live.freq / 1000).toFixed(1)} GHz` : '–');

// Badge color of a security label: modern (WPA3, OWE) green, WPA2 amber, open or broken (WEP, WPA1) red.
export const SECURITY_KIND = s => /WPA3|OWE/.test(s) ? 'success' : /WPA2/.test(s) ? 'warning' : /Open|WEP|^WPA-/.test(s) ? 'danger' : '';

// The frequency is part of the key: airtime counters restart when the radio changes channel.
const airKey = r => `air:${r.name}:${r.survey?.freq}`;

// Feeds one poll into the tracker and drops series of radios or interfaces that disappeared.
export function recordRadios(hw) {
  const seen = new Set();
  for (const r of hw?.radios ?? []) {
    if (r.survey?.active != null) {
      seen.add(airKey(r));
      tracker.record(airKey(r), { active: r.survey.active, busy: r.survey.busy, rx: r.survey.rx, tx: r.survey.tx });
    }
    for (const i of r.interfaces) {
      if (!i.ifname) continue;
      seen.add(`if:${i.ifname}`);
      tracker.record(`if:${i.ifname}`, { rx: i.rx_bytes, tx: i.tx_bytes });
    }
  }
  tracker.keep(seen);
}

// Share of the channel's airtime that was busy / spent receiving / transmitting, from the survey counters.
const airtime = r => {
  const k = airKey(r);
  const busy = tracker.ratios(k, 'busy', 'active'), rx = tracker.ratios(k, 'rx', 'active'), tx = tracker.ratios(k, 'tx', 'active');
  return { busy, busyNow: latest(busy), rxNow: latest(rx), txNow: latest(tx) };
};

//#region findings
// Things that look wrong on a radio, as { level, text }: state problems, a channel differing from the
// configured one (radar avoidance), noise above -80 dBm, channel busy >= 70 %, non-enabled BSSs (DFS),
// open networks and a country that differs from the active regulatory domain `reg`.
function findings(r, reg) {
  const out = [];
  const cfgCh = /^[0-9]+$/.test(r.config.channel ?? '') ? +r.config.channel : null;
  const air = airtime(r);

  if (!r.enabled) out.push({ level: 'info', text: 'Radio is disabled in the configuration.' });
  else if (r.retry_failed) out.push({ level: 'bad', text: 'Radio setup failed and netifd keeps retrying.' });
  else if (r.pending) out.push({ level: 'warn', text: 'Radio is still being configured.' });
  else if (!r.up) out.push({ level: 'bad', text: 'Radio is enabled but not running.' });

  if (cfgCh != null && r.live?.channel != null && cfgCh !== r.live.channel) out.push({ level: 'warn', text: `Running on channel ${r.live.channel} but configured for ${cfgCh} (radar avoidance or a fallback).` });
  if (r.survey?.noise != null && r.survey.noise > -80) out.push({ level: 'warn', text: `High noise floor: ${r.survey.noise} dBm.` });
  if (air.busyNow != null && air.busyNow >= 70) out.push({ level: 'warn', text: `Channel is ${Math.round(air.busyNow)} % busy.` });
  for (const i of r.interfaces) {
    if (i.up && i.bss_status && i.bss_status !== 'ENABLED') out.push({ level: 'info', text: `${i.ssid ?? i.ifname} is ${i.bss_status}${i.bss_status === 'DFS' ? ' (radar channel availability check: clients cannot connect yet)' : ''}.` });
    if (i.enabled && i.security === 'Open/None' && i.mode === 'ap') out.push({ level: 'warn', text: `${i.ssid} is an open network.` });
  }
  if (reg && r.config.country && r.config.country !== reg.country) out.push({ level: 'info', text: `Configured country ${r.config.country} differs from the active regulatory domain ${reg.country}.` });
  return out;
}
//#endregion

//#region parts
// Card header: state dot, name, band, phy, state badge, supported standards, links to mesh interfaces on
// this radio and the hardware name.
function header(r) {
  const state = !r.enabled ? ['disabled', ''] : r.retry_failed ? ['failed', 'danger'] : r.pending ? ['starting', 'warning'] : r.up ? ['up', 'success'] : ['down', 'danger'];
  return h('div', { className: 'rd-head' },
    h('span', { className: `dot ${r.up ? 'up' : 'down'}` }),
    icon('wifi', 20),
    h('strong', { className: 'name' }, r.name),
    badge(bandOf(r), 'info'),
    r.phy ? badge(r.phy) : null,
    badge(state[0], state[1]),
    ...(r.standards ?? []).map(s => badge(s.replace('802.', ''), '', s)),
    ...(r.mesh ?? []).map(m => h('a', { href: '#mesh', className: 'fl-badge info', title: 'A mesh interface on this radio: see the Mesh page' }, `mesh · ${m.ssid ?? m.ifname ?? m.section}`)),
    r.hardware?.hardware ? h('span', { className: 'rd-hw muted' }, r.hardware.hardware) : null);
}

// Row of live figures: channel, width, TX power (dBm, also shown in mW), noise floor, antenna chains and
// the client count over the radio's non-mesh interfaces.
function hero(r) {
  const live = r.live ?? {};
  // One figure tile: label, value and an optional sub line.
  const stat = (label, value, sub) => h('div', { className: 'rd-stat' }, h('div', { className: 'label' }, label), h('div', { className: 'value' }, value), sub ? h('div', { className: 'sub' }, sub) : null);
  return h('div', { className: 'rd-hero' },
    stat('Channel', live.channel ?? '–', live.freq ? `${live.freq} MHz` : 'not running'),
    stat('Width', live.width ? `${live.width} MHz` : '–', live.center ? `center ${live.center} MHz` : ''),
    stat('TX power', live.txpower != null ? `${live.txpower} dBm` : '–', live.txpower != null ? `${Math.round(10 ** (live.txpower / 10))} mW` : ''),
    stat('Noise floor', r.survey?.noise != null ? `${r.survey.noise} dBm` : '–', 'on this channel'),
    stat('Antennas', r.antennas ? `${r.antennas.tx} × ${r.antennas.rx}` : '–', 'TX × RX chains'),
    stat('Clients', fmtNum(r.interfaces.reduce((n, i) => n + (i.clients ?? 0), 0)), `${r.interfaces.length} interface${r.interfaces.length === 1 ? '' : 's'}`));
}

// Channel utilization: busy share now (meter turns amber from 40 % and red from 70 %), this radio's own
// receive and transmit share, and the busy history as a sparkline.
function airtimeBlock(r) {
  const a = airtime(r);
  if (a.busyNow == null) return h('div', { className: 'rd-air' }, h('div', { className: 'label' }, 'Channel utilization'), muted('measuring…'));
  return h('div', { className: 'rd-air' },
    h('div', { className: 'label' }, 'Channel utilization'),
    h('div', { className: 'rd-air-top' },
      h('b', { className: 'big' }, `${a.busyNow.toFixed(1)} %`),
      h('span', { className: 'muted small' }, `busy · this radio ↓ ${(a.rxNow ?? 0).toFixed(1)} % ↑ ${(a.txNow ?? 0).toFixed(1)} %`)),
    meter(a.busyNow, 100, a.busyNow >= 70 ? 'weak' : a.busyNow >= 40 ? 'fair' : 'good'),
    sparkline([{ values: a.busy.map(v => v ?? 0), cls: 'rx' }], { width: 260, height: 40, max: 100 }));
}

// Configured values next to what is running (channel, width, TX power) plus the regulatory limit for the
// running channel; `reg` is the active regulatory domain.
function configBlock(r, reg) {
  const c = r.config, live = r.live ?? {};
  const allowed = r.channels?.find(ch => ch.freq === live.freq);
  const cfgCh = c.channel === 'auto' ? 'auto (ACS)' : c.channel;
  return kv([
    ['Channel', h('span', {}, `configured ${cfgCh}`, live.channel != null ? h('span', {}, ' · running ', h('b', {}, live.channel)) : null)],
    ['Mode', h('span', {}, `configured ${c.htmode ?? '–'}`, live.width ? ` · running ${live.width} MHz` : '')],
    ['TX power', h('span', {}, c.txpower != null ? `configured ${c.txpower} dBm` : 'configured: maximum allowed', live.txpower != null ? ` · running ${live.txpower} dBm` : '', allowed?.max_power != null ? muted(` · limit ${allowed.max_power} dBm`) : null)],
    ['Country', h('span', {}, c.country ?? '–', reg ? muted(` · regulatory domain ${reg.country} (${reg.dfs})`) : null)],
    ['Standards', (r.standards ?? []).join(' · ') || '–'],
    ['Hardware modes', r.hardware?.hwmodes ?? '–'],
    ['Cell density', c.cell_density ?? '–'],
    ['Beacon interval', c.beacon_int != null ? `${c.beacon_int} ms` : 'default (100 ms)'],
    ['Options', h('span', {}, c.noscan ? badge('no coexistence scan') : null, c.legacy_rates ? badge('legacy rates', 'warning') : badge('legacy rates off'))],
    ['Device path', mono(c.path ?? '–')],
  ]);
}

// Allowed channels with the running one and the 20 MHz channels of its block highlighted; radar (DFS) channels marked.
function channelStrip(r) {
  const live = r.live;
  if (!r.channels?.length) return null;
  const running = runningBlock(r);
  return h('div', { className: 'rd-chan' },
    h('div', { className: 'label' }, `Channels allowed in this regulatory domain (${r.channels.filter(c => !c.disabled).length})`),
    h('div', { className: 'chans' }, r.channels.map(ch => {
      const covered = running.channels.includes(ch.channel) || running.inside.includes(ch.channel);
      const cls = ['chn', ch.disabled ? 'off' : '', ch.dfs ? 'dfs' : '', covered ? 'span' : '', ch.freq === live?.freq ? 'cur' : ''].filter(Boolean).join(' ');
      const tip = [`${ch.freq} MHz`, ch.disabled ? 'disabled by regulations' : `max ${ch.max_power} dBm`, ch.dfs ? 'DFS: radar detection required' : '', ch.no_ir ? 'no initiating radiation' : ''].filter(Boolean).join(' · ');
      return h('span', { className: cls, title: tip }, ch.channel);
    })),
    h('div', { className: 'muted small' }, 'Highlighted: running channel and the span of its width · amber outline: radar (DFS) channel · struck: not allowed'));
}

// Badges for an interface's roaming (802.11r/k/v), WPS, OCV and access-control settings.
const featureChips = i => [
  i.features?.roaming_11r ? badge('802.11r', 'info', 'Fast BSS transition (roaming)') : null,
  i.features?.neighbor_11k ? badge('802.11k', 'info', 'Neighbor reports') : null,
  i.features?.bss_transition_11v ? badge('802.11v', 'info', 'BSS transition management') : null,
  i.features?.wps ? badge('WPS', 'warning', 'WPS push button enabled') : null,
  i.features?.ocv ? badge('OCV', '', 'Operating channel validation') : null,
  i.features?.proxy_arp ? badge('proxy ARP', '') : null,
  i.hidden ? badge('hidden SSID', '') : null,
  i.isolate ? badge('client isolation', 'info') : null,
  i.max_clients ? badge(`max ${i.max_clients} clients`, '') : null,
  i.macfilter ? badge(`MAC ${i.macfilter.policy} list (${i.macfilter.entries})`, '', 'Only the number of entries is shown') : null,
].filter(Boolean);

// Table row for one SSID: identity, networks, security, client count, current and total traffic, features
// and BSS state. Current throughput comes from the per-interface byte-counter series.
function interfaceRow(i) {
  const k = `if:${i.ifname}`;
  const rx = latest(tracker.rates(k, 'rx')), tx = latest(tracker.rates(k, 'tx'));
  const status = !i.enabled ? badge('disabled', '') : !i.up ? badge('not running', 'danger') : i.bss_status && i.bss_status !== 'ENABLED' ? badge(i.bss_status, 'warning') : badge(i.bss_status ?? 'up', 'success');
  return h('tr', {},
    h('td', {}, h('strong', {}, i.ssid ?? '(no SSID)'), ' ', badge(i.mode), h('div', { className: 'muted small mono' }, i.ifname ?? i.section)),
    h('td', {}, i.bssid ? mono(i.bssid) : muted('–')),
    h('td', {}, i.networks.length ? i.networks.map(n => badge(n, 'info')) : muted('–')),
    h('td', {}, badge(i.security, SECURITY_KIND(i.security)), h('div', { className: 'muted small mono' }, i.encryption)),
    h('td', { className: 'num' }, i.clients != null ? fmtNum(i.clients) : '–'),
    h('td', { className: 'num' }, i.ifname ? h('div', {}, h('div', {}, icon('arrow-down', 12), fmtLine(rx)), h('div', {}, icon('arrow-up', 12), fmtLine(tx))) : '–'),
    h('td', { className: 'num' }, i.rx_bytes != null ? h('div', {}, `↓ ${fmtBytes(i.rx_bytes)}`, h('div', {}, `↑ ${fmtBytes(i.tx_bytes)}`)) : '–'),
    h('td', {}, h('div', { className: 'rd-feat' }, featureChips(i))),
    h('td', {}, status));
}

// Table of the non-mesh wireless interfaces (SSIDs) of a radio.
function interfacesTable(r) {
  const cols = ['SSID', 'BSSID', 'Network', 'Security', 'Clients', 'Throughput now', 'Total', 'Features', 'State'];
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover' },
    h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
    h('tbody', {}, r.interfaces.length ? r.interfaces.map(interfaceRow) : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'No wireless interfaces are configured on this radio.')))));
}
//#endregion

// One card per radio: header, live figures, findings, configuration and airtime/channels, then (when the configuration can be
// edited) the radio's settings, and the interfaces with their editors. With `edit` (see picker.js) the channels are a picker the
// draft is edited through; without it, a plain strip.
function radioCard(r, reg, edit) {
  const list = findings(r, reg);
  const channels = edit?.canEdit && editable(r) ? channelPicker(r, edit) : channelStrip(r);
  const editing = Boolean(edit?.wifi?.editable);
  return h('div', { className: `card rd-card ${r.up ? 'is-up' : 'is-down'}` },
    header(r),
    hero(r),
    list.length ? h('ul', { className: 'rd-find' }, list.map(f => h('li', { className: f.level }, icon(f.level === 'bad' ? 'shield-exclamation' : f.level === 'warn' ? 'exclamation-triangle' : 'info-circle'), f.text))) : null,
    h('div', { className: 'rd-cols' }, h('div', {}, h('h3', {}, 'Configuration'), configBlock(r, reg)), h('div', {}, airtimeBlock(r), channels)),
    editing ? radioSettings(r.name, edit) : null,
    h('div', { className: 'rd-ifaces' }, h('h3', {}, `Interfaces (${r.interfaces.length})`), interfacesTable(r), editing ? networksEditor(r.name, edit) : null));
}

// Returns the nodes for the radios section; an empty list when the plugin is not available. Mesh interfaces
// are left out of the tables and shown as a link: they have their own page. `edit` is passed on to every card.
export function radiosSection(hw, edit) {
  if (!hw?.radios?.length) return [];
  const radios = hw.radios.map(r => ({ ...r, interfaces: r.interfaces.filter(i => i.mode !== 'mesh'), mesh: r.interfaces.filter(i => i.mode === 'mesh') }));
  return [h('div', { className: 'rd-grid' }, radios.map(r => radioCard(r, hw.regdomain, edit)))];
}
