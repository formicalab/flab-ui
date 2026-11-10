// Hardware temperature presentation: friendly names, health levels and the sensor grid.

import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card } from '../../core/ui.js';

// Health thresholds in °C. A sensor is also "hot" once it reaches its own throttle or critical limit.
const WARM = 75;
const HOT = 90;

export function sensorLabel(s) {
  const name = s.name ?? '';
  let m = name.match(/^mt79\d+_phy(\d+)$/);
  if (m) return { title: `Wi-Fi radio phy${m[1]}`, sub: 'MediaTek MT7915 radio' };
  if (/^cpu[-_]thermal$/.test(name)) return { title: 'CPU (SoC)', sub: 'Cortex-A53 cluster thermal zone' };
  m = name.match(/^mdio_bus:(\w+)$/);
  if (m) return { title: `Ethernet PHY ${m[1]}`, sub: s.driver ? s.driver.replace(/\s*PHY$/, '') : 'MDIO PHY' };
  return { title: s.label || name || s.id, sub: s.driver ?? s.kind };
}

export function sensorLevel(s) {
  if (s.temp >= HOT) return 'weak';
  if (s.throttle != null && s.temp >= s.throttle) return 'weak';
  if (s.crit != null && s.temp >= s.crit - 5) return 'weak';
  return s.temp >= WARM ? 'fair' : 'good';
}

export const levelText = lvl => ({ good: 'Normal', fair: 'Warm', weak: 'Hot' }[lvl]);
export const levelBadge = lvl => ({ good: 'success', fair: 'warning', weak: 'danger' }[lvl]);
export const hottest = sensors => sensors.reduce((a, s) => (!a || s.temp > a.temp ? s : a), null);
export const fmtTemp = t => `${t.toFixed(1)} °C`;

function gauge(s, lvl) {
  const limit = s.crit ?? s.max ?? 125;
  const pct = v => Math.min(100, Math.max(0, v / limit * 100));
  const marks = [];
  if (s.throttle != null) marks.push(['throttle', s.throttle, 'warn']);
  if (s.max != null && s.max !== s.crit) marks.push(['max', s.max, 'bad']);
  if (s.crit != null) marks.push(['critical', s.crit, 'bad']);
  return h('div', { className: `gauge ${lvl}` }, h('div', { className: 'track' },
    h('div', { className: 'fill', style: `width:${pct(s.temp)}%` }),
    ...marks.filter(([, v]) => v < limit).map(([label, v, cls]) => h('i', { className: `mark ${cls}`, style: `left:${pct(v)}%`, title: `${label} ${v} °C` }))));
}

function limitsText(s) {
  const parts = [];
  if (s.throttle != null) parts.push(`throttle ${s.throttle} °C`);
  if (s.max != null) parts.push(`max ${s.max} °C`);
  if (s.crit != null) parts.push(`critical ${s.crit} °C`);
  return parts.join(' · ') || 'no limits reported';
}

function sensorTile(s) {
  const lvl = sensorLevel(s);
  const label = sensorLabel(s);
  return h('div', { className: 'sensor' },
    h('div', { className: 'sensor-head' }, h('b', {}, label.title), badge(levelText(lvl), levelBadge(lvl))),
    h('div', { className: `sensor-temp ${lvl}` }, fmtTemp(s.temp)),
    gauge(s, lvl),
    h('div', { className: 'muted small' }, label.sub),
    h('div', { className: 'muted small' }, limitsText(s)));
}

export function temperatureCard(data) {
  const zoneTrips = data.sensors.find(s => s.kind === 'zone' && s.trips?.length);
  const throttled = data.cooling.filter(c => c.cur > 0);

  const footer = h('div', { className: 'sensor-foot muted small' },
    throttled.length
      ? badge(`Throttling: ${throttled.map(c => `${c.type} ${c.cur}/${c.max}`).join(', ')}`, 'warning')
      : badge(data.cooling.length ? 'No thermal throttling' : 'No cooling devices', 'success'),
    zoneTrips ? h('span', {}, `CPU trip points: ${[...zoneTrips.trips].sort((a, b) => a.temp - b.temp).map(t => `${t.type} ${t.temp} °C`).join(' · ')} · policy ${zoneTrips.policy ?? '–'}`) : null,
    data.cooling.length ? h('span', {}, `Cooling devices: ${data.cooling.map(c => `${c.type} (${c.cur}/${c.max})`).join(', ')} · passive only, no fan reported`) : null);

  return card([icon('activity'), 'Temperatures'],
    h('div', { className: 'card-body' }, h('div', { className: 'sensor-grid' }, data.sensors.map(sensorTile)), footer));
}
