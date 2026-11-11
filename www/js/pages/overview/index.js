// Overview page (default): uptime, CPU usage, load, memory and temperature tiles, the CPU load card
// (cpu.js), the temperature cards (temperatures.js), system information and the memory breakdown.
// System data comes from the standard system board/info calls. CPU counters come from the flab.system
// plugin and temperatures from flab.sensors; both are optional here so that a missing plugin or ACL only
// hides its own section.
import { h } from '../../core/dom.js';
import { ubus, optional } from '../../core/ubus.js';
import { card, tile, tiles, table } from '../../core/ui.js';
import { fmtBytes, fmtDur } from '../../core/format.js';
import { temperatureCard, sensorLabel, sensorLevel, hottest, fmtTemp } from './temperatures.js';
import { cpuCard, record, hasDelta, current, level, levelText } from './cpu.js';

// Text colour classes for the good/fair/weak levels.
const TEXT = { good: 'text-success', fair: 'text-warning', weak: 'text-danger' };

export default {
  id: 'overview',
  label: 'Overview',
  icon: 'speedometer2',
  interval: 5000,
  css: 'css/overview.css',

  // One round of calls. The flab.* calls are optional so the standard system data still renders without them.
  load: async () => {
    const [board, info, sensors, firstCpu] = await Promise.all([
      ubus('system', 'board'), ubus('system', 'info'), optional(ubus('flab.sensors', 'status')), optional(ubus('flab.system', 'cpu'))]);

    let cpu = firstCpu;
    if (cpu) {
      record(cpu);
      // Utilization needs two samples; on the first visit take the second one a moment later so the
      // numbers appear immediately instead of after one refresh period.
      if (!hasDelta()) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const again = await optional(ubus('flab.system', 'cpu'));
        if (again) { record(again); cpu = again; }
      }
    }
    return { board, info, sensors, cpu };
  },

  // Tiles, CPU card, temperature card and the system/memory cards. Memory "used" excludes buffers and cache,
  // like `free`; the standard system info reports load averages as fixed-point integers scaled by 65536.
  view({ board: b, info, sensors, cpu: cpuData }) {
    const mem = info.memory;
    const used = mem.total - mem.free - mem.buffered - mem.cached;
    const pct = Math.round(used / mem.total * 100);

    const list = sensors?.sensors ?? [];
    // The CPU thermal zone, shown as its own tile.
    const cpu = list.find(s => s.kind === 'zone' && /cpu/.test(s.name));
    const hot = hottest(list);
    const usage = cpuData ? current('cpu') : null;

    return [
      tiles(
        tile('Uptime', fmtDur(info.uptime), 'since last boot'),
        usage ? tile('CPU usage', `${usage.busy.toFixed(0)}%`, `${cpuData.cores} cores · ${usage.irq.toFixed(0)}% interrupts`, levelText[level(usage.busy)]) : null,
        tile('Load (1 / 5 / 15 min)', info.load.map(l => (l / 65536).toFixed(2)).join(' · ')),
        tile('Memory', `${pct}%`, `${fmtBytes(used)} of ${fmtBytes(mem.total)}`),
        cpu ? tile('CPU temperature', fmtTemp(cpu.temp), `critical at ${cpu.crit ?? '–'} °C`, TEXT[sensorLevel(cpu)]) : null,
        hot ? tile('Hottest sensor', fmtTemp(hot.temp), sensorLabel(hot).title, TEXT[sensorLevel(hot)]) : null),
      cpuData ? cpuCard(cpuData) : null,
      sensors ? temperatureCard(sensors) : null,
      h('div', { className: 'row g-3' },
        h('div', { className: 'col-xl-6' }, card('System', table(['Item', 'Value'], [
          ['Model', b.model], ['Hostname', b.hostname], ['Release', b.release.description], ['Kernel', b.kernel], ['Board', b.board_name],
        ]), 'h-100')),
        h('div', { className: 'col-xl-6' }, card('Memory usage', h('div', { className: 'card-body' },
          h('div', { className: 'progress mb-2' }, h('div', { className: 'progress-bar', style: `width:${pct}%` })),
          h('div', { className: 'muted' }, `Used ${fmtBytes(used)} · Cached ${fmtBytes(mem.cached)} · Buffers ${fmtBytes(mem.buffered)} · Free ${fmtBytes(mem.free)}`)), 'h-100'))),
    ];
  },
};
