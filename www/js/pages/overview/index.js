// Overview page (default): a hero card (device identity plus uptime, load, memory and temperature), the
// Network card (WAN connectivity and IPv6 delegation), the CPU load card (cpu.js), the temperature card
// (temperatures.js) and the Storage card (mount points with their backing hardware).
// System data comes from the standard system board/info calls. CPU counters come from the flab.system
// plugin and temperatures from flab.sensors; both are optional here so that a missing plugin or ACL only
// hides its own section.
import { h, sleep } from '../../core/dom.js';
import { ubus, optional } from '../../core/ubus.js';
import { icon } from '../../core/icons.js';
import { badge, card } from '../../core/ui.js';
import { fmtBytes, fmtDur } from '../../core/format.js';
import { temperatureCard, sensorLabel, sensorLevel, hottest, fmtTemp, readable } from './temperatures.js';
import { cpuCard, record, hasDelta, current, levelText } from './cpu.js';
import { readOverviewNetwork } from './model.js';

export default {
  id: 'overview',
  label: 'Overview',
  icon: 'speedometer2',
  interval: 5000,
  css: 'css/overview.css',

  // One round of calls. The flab.* calls are optional so the standard system data still renders without them.
  load: async () => {
    const [board, info, sensors, firstCpu, network, storage] = await Promise.all([
      ubus('system', 'board'), ubus('system', 'info'), optional(ubus('flab.sensors', 'status')),
      optional(ubus('flab.system', 'cpu')), optional(ubus('network.interface', 'dump')),
      optional(ubus('flab.system', 'storage'))]);

    let cpu = firstCpu;
    if (cpu) {
      record(cpu);
      // Utilization needs two samples; on the first visit take the second one a moment later so the
      // numbers appear immediately instead of after one refresh period.
      if (!hasDelta()) {
        await sleep(1000);
        const again = await optional(ubus('flab.system', 'cpu'));
        if (again) { record(again); cpu = again; }
      }
    }
    return { board, info, sensors, cpu, network: readOverviewNetwork(network), storage };
  },

  // Tiles, CPU card, temperature card and the system/memory cards. Memory "used" excludes buffers and cache,
  // like `free`; the standard system info reports load averages as fixed-point integers scaled by 65536.
  view({ board: b, info, sensors, cpu: cpuData, network, storage }) {
    const mem = info.memory;
    const used = mem.total - mem.free - mem.buffered - mem.cached;
    const pct = Math.round(used / mem.total * 100);

    const list = readable(sensors?.sensors);
    // The CPU thermal zone, shown as its own tile.
    const cpu = list.find(s => s.kind === 'zone' && /cpu/.test(s.name));
    const hot = hottest(list);
    const usage = cpuData ? current('cpu') : null;
    // The writable root filesystem: what is left for packages and configuration.
    const rootfs = storage?.filesystems?.find(f => f.mount === '/') ?? storage?.filesystems?.find(f => f.mount === '/overlay');

    const internet = h('section', { className: 'ov-internet' },
      h('div', { className: 'ov-section-head' }, icon('globe2'), h('h2', {}, 'Internet connectivity')),
      h('div', {},
        h('div', { className: `ov-internet-main ${network.online ? 'online' : 'offline'}` },
          h('div', { className: 'ov-globe' }, icon(network.online ? 'globe2' : 'x-circle')),
          h('div', {},
            h('div', { className: 'muted small' }, network.sources.length ? `Via ${network.sources.join(' + ')}` : 'No WAN default route is installed'),
            h('div', { className: 'ov-internet-title' }, network.online ? 'Connected' : 'Offline'))),
        h('div', { className: 'ov-protocols' },
          protocol('IPv4', network.ipv4),
          protocol('IPv6', network.ipv6)),
        h('div', { className: 'ov-internet-foot muted small' },
          h('div', { className: 'ov-dns-row' }, icon('hdd-network', 14),
            h('b', {}, 'IPv4 DNS'), h('span', { className: 'mono' }, dnsText(network.dns4, network.inactiveDns4))),
          h('div', { className: 'ov-dns-row' },
            h('span', { className: 'ov-dns-icon-spacer' }), h('b', {}, 'IPv6 DNS'),
            h('span', { className: 'mono' }, dnsText(network.dns6, network.inactiveDns6)))
        )
      )
    );

    const prefix = h('section', { className: 'ov-prefix' },
      h('div', { className: 'ov-section-head' }, icon('diagram-3'), h('h2', {}, 'IPv6 delegation')),
      h('div', {},
        network.prefix ? [
          h('div', { className: 'ov-protocol ov-prefix-provider' },
            h('div', { className: 'ov-protocol-head' }, h('b', {}, 'Provider prefix'),
              badge('received', 'success')),
            h('div', { className: 'mono ov-address' }, `${network.prefix.address}/${network.prefix.mask}`),
            h('div', { className: 'muted small' }, `${network.prefix.source}${network.prefix.valid ? ` · valid ${fmtDur(network.prefix.valid)}` : ''}`)),
          h('div', { className: 'ov-assignments' },
            h('div', { className: 'muted small ov-assignment-label' }, 'Delegated to router networks'),
            ...(network.prefix.assigned.length
              ? network.prefix.assigned.map(a => h('div', { className: 'ov-assignment' },
                h('b', {}, a.name), h('span', { className: 'mono' }, `${a.address}/${a.mask}`)))
              : [h('div', { className: 'muted small' }, 'No LAN prefix assignment reported')])),
        ] : h('div', { className: 'ov-prefix-empty' }, icon('diagram-3', 28), 'No global IPv6 prefix is currently delegated.')));

    return [
      h('div', { className: 'card ov-hero' },
        h('div', { className: 'ov-hero-id' },
          h('div', { className: 'ov-hero-logo' }, icon('router', 28)),
          h('div', { className: 'ov-hero-name' },
            h('h2', {}, b.model),
            h('div', { className: 'muted small' }, [b.system, b.release.target].filter(Boolean).join(' · '))),
          h('div', { className: 'ov-hero-facts' },
            fact(`Build · ${b.release.version ?? 'OpenWrt'}`, b.release.revision ?? b.release.description, buildTitle(b.release)),
            fact('Kernel', b.kernel))),
        h('div', { className: 'ov-kpis' },
          kpi('clock', 'Uptime', fmtDur(info.uptime), 'since last boot'),
          kpi('activity', 'Load (1 / 5 / 15 min)', info.load.map(l => (l / 65536).toFixed(2)).join(' · '),
            usage ? `CPU ${usage.busy.toFixed(0)}% busy · ${cpuData.cores} cores` : `${info.load.length} averages`),
          kpi('memory', 'Memory', `${pct}%`, `${fmtBytes(used)} of ${fmtBytes(mem.total)}`, null, pct),
          rootfs ? kpi('hdd-stack', 'Free storage', fmtBytes(rootfs.available), `${fmtBytes(rootfs.used)} of ${fmtBytes(rootfs.total)} used on ${rootfs.mount}`, null, rootfs.percent) : null,
          kpi('thermometer-half', cpu ? 'CPU temperature' : 'Hottest sensor', fmtTemp((cpu || hot)?.temp),
            cpu ? `critical at ${cpu.crit ?? '–'} °C` : (hot ? sensorLabel(hot).title : ''),
            (cpu || hot) ? levelText[sensorLevel(cpu || hot)] : ''))),
      card(null,
        h('div', { className: 'card-body ov-network-grid' }, internet, prefix),
        'ov-network'),
      cpuData ? cpuCard(cpuData) : null,
      sensors ? temperatureCard(sensors) : null,
      card([icon('hdd-stack'), 'Storage', storage?.filesystems?.length
          ? h('span', { className: 'sub' }, `${storage.filesystems.length} mount point${storage.filesystems.length === 1 ? '' : 's'}`) : null],
        h('div', { className: 'card-body ov-storage-body' },
          ...(storage?.disks ?? []).map(diskPanel),
          h('div', { className: 'ov-storage' },
            storage?.filesystems?.length
              ? storage.filesystems.map(storageRow)
              : h('div', { className: 'muted' }, 'Filesystem capacity is unavailable.')))),
    ];
  },
};

// Physical storage device: identity, wear estimate, traffic since boot and partition table.
function diskPanel(d) {
  const worn = d.wear?.worst;
  const eol = d.eol && d.eol !== 'normal';
  const health = eol ? [`end of life: ${d.eol}`, 'danger'] : worn?.to != null && worn.to >= 80 ? ['worn', 'warning'] : ['healthy', 'success'];
  const fw = d.firmware?.replace(/(?:00)+$/, '');
  return h('div', { className: 'ov-disk' },
    h('div', { className: 'ov-disk-head' },
      h('b', {}, [d.vendor, d.model].filter(Boolean).join(' ') || d.name),
      badge(d.kind, 'info'), d.rotational ? h('span', { className: 'chip' }, 'spinning disk') : null,
      d.readonly ? h('span', { className: 'chip' }, 'read-only') : null,
      (worn || d.eol) ? badge(health[0], health[1]) : null,
      h('span', { className: 'muted small mono ov-disk-dev' }, `/dev/${d.name}`)),
    h('div', { className: 'ov-disk-facts' },
      diskFact('Capacity', fmtBytes(d.size)),
      d.date ? diskFact('Manufactured', d.date) : null,
      fw ? diskFact('Firmware', fw) : null,
      worn ? diskFact('Life used', worn.to == null ? 'over 100%' : `${worn.from}–${worn.to}%`, 'estimate by the device') : null,
      d.written != null ? diskFact('Written since boot', fmtBytes(d.written),
        d.discarded ? `Excludes ${fmtBytes(d.discarded)} of discards (e.g. the overlay format) that the eMMC counts as writes` : 'Data written to the device') : null,
      d.read != null ? diskFact('Read since boot', fmtBytes(d.read)) : null,
      d.erase ? diskFact('Erase unit', fmtBytes(+d.erase)) : null),
    d.partitions?.length ? h('div', { className: 'chips ov-parts' },
      h('span', { className: 'muted small' }, 'Partitions'),
      d.partitions.map(p => h('span', { className: 'chip', title: p.name }, `${p.label || p.name} · ${fmtBytes(p.size)}`))) : null);
}

function diskFact(label, value, title) {
  return h('div', { className: 'ov-disk-fact', title: title ?? '' },
    h('div', { className: 'muted small' }, label), h('div', { className: 'mono' }, value));
}

// One identity fact (label above value) in the hero card.
function fact(label, value, title = '') {
  return h('div', { className: 'ov-fact', title }, h('div', { className: 'muted small' }, label), h('div', { className: 'mono' }, value ?? '–'));
}

// Hover text of the build fact: the full description and, when known, when the image was built.
function buildTitle(release) {
  const built = +release.builddate;
  return [release.description, built ? `built ${new Date(built * 1000).toLocaleString()}` : ''].filter(Boolean).join(' · ');
}

// One KPI of the hero strip: icon, label, value and a caption; an optional bar shows a percentage.
function kpi(name, label, value, sub, valueClass = '', percent = null) {
  return h('div', { className: 'ov-kpi' },
    h('div', { className: 'ov-kpi-icon' }, icon(name, 18)),
    h('div', {},
      h('div', { className: 'muted small' }, label),
      h('div', { className: `ov-kpi-value ${valueClass}` }, value),
      percent != null ? h('div', { className: 'progress' }, h('div', {
        className: `progress-bar${percent >= 90 ? ' bg-danger' : percent >= 75 ? ' bg-warning' : ''}`, style: `width:${percent}%` })) : null,
      h('div', { className: 'muted small' }, sub)));
}

// One mount point: where it is mounted, what hardware backs it, and how full it is.
function storageRow(fs) {
  const hw = fs.hardware || {};
  return h('div', { className: 'ov-protocol ov-fs' },
    h('div', { className: 'ov-fs-head' },
      h('b', { className: 'mono ov-fs-mount' }, fs.mount),
      h('span', { className: 'muted small' }, fs.readonly ? 'read-only' : `${fmtBytes(fs.available)} free`)),
    h('div', { className: 'chips' },
      hw.kind ? badge(hw.kind, 'info') : null,
      hw.model ? h('span', { className: 'chip' }, hw.model) : null,
      hw.partition ? h('span', { className: 'chip' }, hw.partition) : null,
      fs.fstype ? h('span', { className: 'chip' }, fs.fstype) : null),
    h('div', { className: 'progress' }, h('div', {
      className: `progress-bar${fs.readonly ? ' bg-secondary' : fs.percent >= 90 ? ' bg-danger' : fs.percent >= 75 ? ' bg-warning' : ''}`,
      style: `width:${fs.percent}%`,
    })),
    h('div', { className: 'ov-fs-meta muted small' },
      h('span', {}, `${fmtBytes(fs.used)} of ${fmtBytes(fs.total)} · ${fs.percent}%`),
      h('span', { className: 'mono' }, fs.device + (fs.deviceSize ? ` · ${fmtBytes(fs.deviceSize)}` : ''))));
}

function protocol(label, wan) {
  return h('div', { className: `ov-protocol ${wan ? 'active' : ''}` },
    h('div', { className: 'ov-protocol-head' }, h('b', {}, label), badge(wan ? 'received' : 'unavailable', wan ? 'success' : '')),
    wan ? [
      h('div', { className: 'mono ov-address' }, `${wan.address ?? 'no address'}${wan.mask != null ? `/${wan.mask}` : ''}`),
      h('div', { className: 'muted small' }, `${wan.name} · ${wan.proto}${wan.gateway ? ` · via ${wan.gateway}` : ''}`),
    ] : h('div', { className: 'muted' }, 'No default route'));
}

function dnsText(active, inactive) {
  if (active.length) return active.join(' · ');
  if (inactive.length) return `${inactive.join(' · ')} — received, inactive because netifd is using another DNS data source`;
  return 'not received from provider';
}
