// Overview page (default): uptime, load, memory, CPU and hottest-sensor temperature tiles, the
// temperature cards (temperatures.js), system information and the memory breakdown.
// System data comes from the standard system board/info calls; temperatures come from the flab.sensors
// plugin, which is optional here so that a missing plugin or ACL only hides the temperature section.
import { h } from '../../core/dom.js';
import { ubus, AuthError } from '../../core/ubus.js';
import { card, tile, tiles, table } from '../../core/ui.js';
import { fmtBytes, fmtDur } from '../../core/format.js';
import { temperatureCard, sensorLabel, sensorLevel, hottest, fmtTemp } from './temperatures.js';

const TEXT = { good: 'text-success', fair: 'text-warning', weak: 'text-danger' };

// Sensors are optional: a missing plugin or ACL must not break the rest of the page.
const optional = promise => promise.catch(e => {
  if (e instanceof AuthError) throw e;
  return null;
});

export default {
  id: 'overview',
  label: 'Overview',
  icon: 'speedometer2',
  interval: 5000,
  css: 'css/overview.css',

  load: async () => {
    const [board, info, sensors] = await Promise.all([
      ubus('system', 'board'), ubus('system', 'info'), optional(ubus('flab.sensors', 'status'))]);
    return { board, info, sensors };
  },

  view({ board: b, info, sensors }) {
    const mem = info.memory;
    const used = mem.total - mem.free - mem.buffered - mem.cached;
    const pct = Math.round(used / mem.total * 100);

    const list = sensors?.sensors ?? [];
    const cpu = list.find(s => s.kind === 'zone' && /cpu/.test(s.name));
    const hot = hottest(list);

    return [
      tiles(
        tile('Uptime', fmtDur(info.uptime), 'since last boot'),
        tile('Load (1 / 5 / 15 min)', info.load.map(l => (l / 65536).toFixed(2)).join(' · ')),
        tile('Memory', `${pct}%`, `${fmtBytes(used)} of ${fmtBytes(mem.total)}`),
        cpu ? tile('CPU temperature', fmtTemp(cpu.temp), `critical at ${cpu.crit ?? '–'} °C`, TEXT[sensorLevel(cpu)]) : null,
        hot ? tile('Hottest sensor', fmtTemp(hot.temp), sensorLabel(hot).title, TEXT[sensorLevel(hot)]) : null,
        tile('Kernel', b.kernel)),
      sensors ? temperatureCard(sensors) : null,
      h('div', { className: 'row g-3' },
        h('div', { className: 'col-xl-6' }, card('System', table(['Item', 'Value'], [
          ['Model', b.model], ['Hostname', b.hostname], ['Release', b.release.description], ['Board', b.board_name],
        ]), 'h-100')),
        h('div', { className: 'col-xl-6' }, card('Memory usage', h('div', { className: 'card-body' },
          h('div', { className: 'progress mb-2' }, h('div', { className: 'progress-bar', style: `width:${pct}%` })),
          h('div', { className: 'muted' }, `Used ${fmtBytes(used)} · Cached ${fmtBytes(mem.cached)} · Buffers ${fmtBytes(mem.buffered)} · Free ${fmtBytes(mem.free)}`)), 'h-100'))),
    ];
  },
};
