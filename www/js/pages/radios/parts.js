// The display parts of a wireless radio, shared by the Wi-Fi radios page (radios/index.js, radios/card.js) and the block of a
// network (radios/networks.js): the rate tracker behind the channel utilization, the findings about a radio, the
// card header, the key figures (with the configured value of what is also a setting), the utilization block and the channel strip. Data comes from the flab.radio plugin;
// counters (airtime, bytes) are turned into rates here, so what is shown follows channel changes, DFS events and interfaces coming and going.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, meter, sparkline, muted } from '../../core/ui.js';
import { createTracker, latest } from '../../core/rates.js';
import { runningBlock } from '../wifi/channels.js';

// Module-level so rate history survives the redraw on every poll (keys: airtime per radio and channel, byte counters per interface).
export const tracker = createTracker();

// Band code from the radio plugin -> label.
const BAND = { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz', '60g': '60 GHz' };
// Band label of a radio, derived from the live frequency (MHz) when the band code is unknown.
const bandOf = r => BAND[r.band] ?? (r.live?.freq ? `${(r.live.freq / 1000).toFixed(1)} GHz` : '–');

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
export const airtime = r => {
  const k = airKey(r);
  const busy = tracker.ratios(k, 'busy', 'active'), rx = tracker.ratios(k, 'rx', 'active'), tx = tracker.ratios(k, 'tx', 'active');
  return { busy, busyNow: latest(busy), rxNow: latest(rx), txNow: latest(tx) };
};

// The state of a radio as [text, badge kind].
const stateOf = r => (!r.enabled ? ['disabled', ''] : r.retry_failed ? ['failed', 'danger'] : r.pending ? ['starting', 'warning'] : r.up ? ['up', 'success'] : ['down', 'danger']);

// Things that look wrong on a radio, as { level, text }: state problems, a channel differing from the configured one (radar avoidance), noise above
// -80 dBm, channel busy >= 70 %, non-enabled BSSs (DFS), open networks and a country that differs from the active regulatory domain `reg`.
export function findings(r, reg) {
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
    if (i.enabled && i.security === 'Open/None' && i.mode === 'ap') out.push({ level: 'warn', text: `${i.ssid ?? i.ifname} is an open network.` });
  }
  if (reg && r.config.country && r.config.country !== reg.country) out.push({ level: 'info', text: `Configured country ${r.config.country} differs from the active regulatory domain ${reg.country}.` });
  return out;
}

// The wireless chip of a radio as a name, from what iwinfo reports ("embedded [MediaTek MT7986]" is the chip of the SoC) or, failing that, the device-tree
// compatible string of the radio; null when nothing is known.
function chipName(r) {
  const hw = r.hardware ?? {};
  const named = /^embedded \[(.*)\]$/.exec(hw.hardware ?? '')?.[1] ?? hw.hardware;
  return named ?? (hw.compatible ? hw.compatible.replace(',', ' ') : null);
}

// The hardware of a radio for its header: the chip and, beside it, the kernel driver, the bus and the PCI or USB id; the tooltip adds the hardware modes and the
// device-tree compatible string. Null when nothing is known.
function hardwareLine(r) {
  const hw = r.hardware ?? {};
  const name = chipName(r);
  if (!name && !hw.driver) return null;
  const where = [hw.driver ? `driver ${hw.driver}` : null, hw.bus, hw.pci_id ?? hw.usb_id].filter(Boolean).join(' · ');
  const title = [hw.hwmodes ? `Hardware modes: ${hw.hwmodes}` : null, hw.compatible ? `Device tree: ${hw.compatible}` : null].filter(Boolean).join('\n');
  return h('span', { className: 'rd-hw', title }, icon('cpu', 14), name ? h('strong', {}, name) : null, where ? h('span', { className: 'muted' }, ` · ${where}`) : null);
}

// Card header: state dot, name, band, phy, state badge, supported standards and the hardware (chip, driver, bus).
export function header(r) {
  const state = stateOf(r);
  return h('div', { className: 'rd-head' },
    h('span', { className: `dot ${r.up ? 'up' : 'down'}` }),
    icon('wifi', 20),
    h('strong', { className: 'name' }, r.name),
    badge(bandOf(r), 'info'),
    r.phy ? badge(r.phy) : null,
    badge(state[0], state[1]),
    ...(r.standards ?? []).map(s => badge(s.replace('802.', ''), '', s)),
    hardwareLine(r));
}

// Row of live figures: channel, width, TX power (dBm, also shown in mW), noise floor, antenna chains. The clients are counted per network, in the block of each.
// The three figures that are also configured (channel, width, power) carry the configured value in their sub line, so the card shows what runs next to what
// is asked for in one place; the other configured options are only in the settings block.
export function hero(r) {
  const live = r.live ?? {}, c = r.config ?? {};
  const allowed = r.channels?.find(ch => ch.freq === live.freq);
  // One figure tile: label, value and an optional sub line.
  const stat = (label, value, sub) => h('div', { className: 'rd-stat' }, h('div', { className: 'label' }, label), h('div', { className: 'value' }, value), sub ? h('div', { className: 'sub' }, sub) : null);
  const txConfigured = c.txpower != null ? `configured ${c.txpower} dBm` : 'configured: maximum';
  return h('div', { className: 'rd-hero' },
    stat('Channel', live.channel ?? '–', [live.freq ? `${live.freq} MHz` : 'not running', `configured ${c.channel === 'auto' ? 'auto (ACS)' : c.channel ?? '–'}`].join(' · ')),
    stat('Width', live.width ? `${live.width} MHz` : '–', [live.center ? `center ${live.center} MHz` : null, `configured ${c.htmode ?? '–'}`].filter(Boolean).join(' · ')),
    stat('TX power', live.txpower != null ? `${live.txpower} dBm` : '–', [live.txpower != null ? `${Math.round(10 ** (live.txpower / 10))} mW` : null, txConfigured, allowed?.max_power != null ? `limit ${allowed.max_power} dBm` : null].filter(Boolean).join(' · ')),
    stat('Noise floor', r.survey?.noise != null ? `${r.survey.noise} dBm` : '–', 'on this channel'),
    stat('Antennas', r.antennas ? `${r.antennas.tx} × ${r.antennas.rx}` : '–', 'TX × RX chains'));
}

// Channel utilization: busy share now (meter turns amber from 40 % and red from 70 %), this radio's own receive and transmit share, and the busy history
// as a sparkline.
export function airtimeBlock(r) {
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

// The active regulatory domain as a caption under the channels (the country of the radio is a setting).
export const regulatoryNote = reg => (reg?.country ? h('div', { className: 'muted small rd-reg' }, `Regulatory domain ${reg.country}${reg.dfs ? ` · ${reg.dfs}` : ''}`) : null);

// Allowed channels with the running one and the 20 MHz channels of its block highlighted; radar (DFS) channels marked.
export function channelStrip(r) {
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
