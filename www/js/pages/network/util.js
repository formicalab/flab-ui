// Shared helpers of the three wired-network pages (Wired network, Bridges, Devices and Interfaces): rate
// tracking, formatting and the live "what changed" findings.
import { createTracker, latest } from '../../core/rates.js';

// One tracker for all pages, fed by record() on every poll.
const tracker = createTracker();

// What the page has seen since it was opened, so changes (link flaps, new errors) can be called out.
const baseline = new Map();

// Cumulative byte counters of a device, the input of the rate tracker.
const COUNTERS = d => ({ rx: d.stats?.rx_bytes, tx: d.stats?.tx_bytes });

// Cumulative error and drop totals from the kernel counters (receive + transmit; CRC errors are added to
// the errors total).
export const errorsOf = d => (d.stats?.rx_errors ?? 0) + (d.stats?.tx_errors ?? 0) + (d.stats?.rx_crc_errors ?? 0);
// Cumulative dropped packets (receive + transmit) of a device.
export const dropsOf = d => (d.stats?.rx_dropped ?? 0) + (d.stats?.tx_dropped ?? 0);

// Every device whose counters are tracked: ports, bridges, bridge members and VLAN devices.
export const devices = net => [...net.ports, ...net.bridges, ...net.bridges.flatMap(b => b.members), ...net.vlans];

// Feeds one poll into the tracker and drops series of devices that disappeared.
export function record(net) {
  const seen = new Set();
  for (const d of devices(net)) {
    seen.add(d.name);
    tracker.record(d.name, COUNTERS(d));
    if (!baseline.has(d.name)) baseline.set(d.name, { flaps: d.carrier_changes ?? 0, errors: errorsOf(d) });
  }
  tracker.keep(seen);
  for (const name of baseline.keys()) if (!seen.has(name)) baseline.delete(name);
}

// Current and historical rate of a device's traffic: { rx, tx } series (bytes/s, oldest first) and the
// latest value of each (rxNow, txNow; null until two samples exist).
export function traffic(name) {
  const rx = tracker.rates(name, 'rx'), tx = tracker.rates(name, 'tx');
  return { rx, tx, rxNow: latest(rx), txNow: latest(tx) };
}

// Link changes and new errors since the page was opened.
export const newFlaps = d => Math.max(0, (d.carrier_changes ?? 0) - (baseline.get(d.name)?.flaps ?? d.carrier_changes ?? 0));
// Errors accumulated since the baseline was taken.
export const newErrors = d => Math.max(0, errorsOf(d) - (baseline.get(d.name)?.errors ?? errorsOf(d)));

// A link speed in Mbit/s as "100 Mbit/s" or "2.5 Gbit/s".
export function fmtSpeed(mbit) {
  if (mbit == null) return '–';
  return mbit >= 1000 ? `${+(mbit / 1000).toFixed(1)} Gbit/s` : `${mbit} Mbit/s`;
}

// An optical power level in dBm as "-4.8 dBm"; "–" when the module does not report one.
export const fmtDbm = v => (v == null ? '–' : `${v.toFixed(1)} dBm`);

// The link between a switch and the SoC (its CPU port(s)): its capacity in Mbit/s (the CPU port's fixed speed, else what the
// conduit MAC negotiated), how much of it the busier direction uses right now (percent, null until the rates are known), and
// how many times the linked user ports could oversubscribe it (1 or less when the link can carry them all at line rate).
export function cpuLink(net, sw) {
  const byName = new Map(net.ports.map(p => [p.name, p]));
  const conduits = (sw.cpu_ports ?? []).map(c => byName.get(c.conduit)).filter(Boolean);
  const capacity = (sw.cpu_ports ?? []).reduce((sum, c) => sum + (c.speed ?? byName.get(c.conduit)?.speed ?? 0), 0);
  if (!capacity) return null;
  let rx = null, tx = null;
  for (const c of conduits) {
    const t = traffic(c.name);
    if (t.rxNow != null) rx = (rx ?? 0) + t.rxNow * 8 / 1e6;
    if (t.txNow != null) tx = (tx ?? 0) + t.txNow * 8 / 1e6;
  }
  const linked = sw.ports.map(n => byName.get(n)).filter(p => p?.carrier && p.speed);
  const potential = linked.reduce((sum, p) => sum + p.speed, 0);
  return {
    capacity,
    utilization: rx == null && tx == null ? null : Math.min(100, Math.max(rx ?? 0, tx ?? 0) / capacity * 100),
    oversubscription: potential / capacity,
    potential,
  };
}

// Spanning-tree port roles and their labels.
export const STP_ROLE = {
  root: 'Root port', designated: 'Designated', alternate: 'Alternate (blocked)', backup: 'Backup', disabled: 'Disabled',
};

// Badge kind for a spanning-tree port state ('' for unknown or disabled).
export const stpKind = state => ({ forwarding: 'success', learning: 'info', listening: 'info', blocking: 'warning' })[state] ?? '';

// Everything known about a port's hardware as [label, value] pairs (empty when nothing is known).
export function hwLines(p) {
  const hw = p.hardware;
  if (!hw) return [];
  return [
    hw.phy ? ['PHY', `${hw.phy.name ?? 'unknown PHY'}${hw.phy.id ? ` (ID ${hw.phy.id})` : ''} · address ${hw.phy.address} on ${hw.phy.bus}`] : null,
    hw.switch ? ['Switch', hw.switch] : null,
    hw.soc ? ['SoC MAC', `${hw.soc} Ethernet`] : null,
    hw.driver ? ['Driver', `${hw.driver}${hw.bus ? ` · ${hw.bus}` : ''}`] : null,
    hw.media ? ['Medium', hw.media === 'MII' ? 'MII (internal link)' : hw.media] : null,
    ...sfpLines(p.sfp),
  ].filter(Boolean);
}

// The lines about an optical module: what it is, then what its diagnostics read (only the values it reports).
function sfpLines(sfp) {
  if (!sfp) return [];
  if (!sfp.present) return [['Module', 'none inserted']];
  const what = [[sfp.vendor, sfp.part].filter(Boolean).join(' '), sfp.type, sfp.connector, sfp.wavelength_nm ? `${sfp.wavelength_nm} nm` : null].filter(Boolean).join(' · ');
  const optics = [
    sfp.tx_power_dbm != null ? `Tx ${fmtDbm(sfp.tx_power_dbm)}` : null,
    sfp.rx_power_dbm != null ? `Rx ${fmtDbm(sfp.rx_power_dbm)}` : null,
    sfp.temperature_c != null ? `${sfp.temperature_c.toFixed(1)} °C` : null,
    sfp.voltage_v != null ? `${sfp.voltage_v.toFixed(2)} V` : null,
    sfp.tx_bias_ma != null ? `${sfp.tx_bias_ma.toFixed(1)} mA` : null,
  ].filter(Boolean).join(' · ');
  return [['Module', what || 'inserted'], optics ? ['Optics', optics] : null];
}

// Problems worth surfacing immediately, computed from the current poll plus what changed since opening: a downshifted link,
// link flaps and new errors, optical module alarms, and a busy link between a switch and the SoC.
export function portFindings(net) {
  const out = [];
  for (const p of net.ports) {
    if (p.downshifted) out.push({ level: 'warn', text: `${p.name} runs at ${fmtSpeed(p.speed)} although both ends support ${fmtSpeed(Math.min(p.max_speed, p.partner_max))}: check the cable.${p.cable_test === false ? '' : ' A cable test on its row shows which pair is at fault.'}` });
    if (newFlaps(p)) out.push({ level: 'warn', text: `${p.name} changed link state ${newFlaps(p)} time${newFlaps(p) === 1 ? '' : 's'} since this page was opened.` });
    if (newErrors(p)) out.push({ level: 'bad', text: `${p.name} logged ${newErrors(p)} new error${newErrors(p) === 1 ? '' : 's'} since this page was opened.` });
    if (p.sfp?.alarms?.length) out.push({ level: 'bad', text: `The optical module in ${p.name} reports: ${p.sfp.alarms.join(', ')}.` });
    else if (p.sfp?.warnings?.length) out.push({ level: 'warn', text: `The optical module in ${p.name} warns about: ${p.sfp.warnings.join(', ')}.` });
  }
  for (const sw of net.switches ?? []) {
    const link = cpuLink(net, sw);
    if (link?.utilization >= CPU_LINK_BUSY) out.push({ level: 'warn', text: `The link between ${sw.label ?? 'the switch'} and the SoC is ${Math.round(link.utilization)}% used: traffic between the switch ports and the router itself shares it.` });
  }
  return out;
}

// The share of the CPU link (percent) above which the page calls it busy.
const CPU_LINK_BUSY = 90;

// Bridge problems: a bridge that is down, a topology change in progress, ports blocked or not yet forwarding
// despite having link, and STP disabled while more than one member has link (a loop would go unnoticed).
export function bridgeFindings(net) {
  const out = [];
  for (const b of net.bridges) {
    if (!b.up) out.push({ level: 'bad', text: `Bridge ${b.name} is down.` });
    if (b.topology_change) out.push({ level: 'warn', text: `Spanning tree topology change in progress on ${b.name}.` });
    for (const m of b.members) {
      if (m.brport?.role === 'alternate') out.push({ level: 'warn', text: `${m.name} is blocked by spanning tree on ${b.name} (a loop would otherwise form).` });
      else if (m.kind === 'ethernet' && m.carrier && m.brport && m.brport.state_name !== 'forwarding') out.push({ level: 'warn', text: `${m.name} has link but is ${m.brport.state_name} on ${b.name}.` });
    }
    if (!b.stp && b.members.filter(m => m.carrier).length > 1) out.push({ level: 'info', text: `Spanning tree is off on ${b.name}; a cabling loop would not be detected.` });
  }
  return out;
}
