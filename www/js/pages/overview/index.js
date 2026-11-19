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
        h('div', { className: `ov-internet-main ${network.unavailable ? 'unknown' : network.online ? 'online' : 'offline'}` },
          h('div', { className: 'ov-globe' }, icon(network.unavailable ? 'info-circle' : network.online ? 'globe2' : 'x-circle')),
          h('div', {},
            h('div', { className: 'muted small' }, connectivityNote(network)),
            h('div', { className: 'ov-internet-title' }, network.unavailable ? 'Unknown' : network.upstream ? 'Upstream router' : network.online ? 'Connected' : 'Offline'))),
        h('div', { className: 'ov-protocols' },
          protocol('IPv4', network.ipv4, network.unavailable),
          protocol('IPv6', network.ipv6, network.unavailable)),
        h('div', { className: 'ov-internet-foot muted small' },
          h('div', { className: 'ov-dns-row' }, icon('hdd-network', 14),
            h('b', {}, 'IPv4 DNS'), h('span', { className: 'mono' }, dnsText(network, 4))),
          h('div', { className: 'ov-dns-row' },
            h('span', { className: 'ov-dns-icon-spacer' }), h('b', {}, 'IPv6 DNS'),
            h('span', { className: 'mono' }, dnsText(network, 6)))
        )
      )
    );

    const prefix = h('section', { className: 'ov-prefix' },
      h('div', { className: 'ov-section-head' }, icon('diagram-3'), h('h2', {}, 'IPv6 delegation')),
      h('div', {},
        network.prefix && !network.unavailable ? [
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
              : [h('div', { className: 'muted small' }, 'None: no part of this prefix is delegated to the router\'s networks.')])),
        ] : h('div', { className: 'ov-prefix-empty' }, icon('diagram-3', 28),
          network.unavailable ? 'Delegation data is unavailable.' : 'No IPv6 prefix has been delegated to this router.')));

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
        // Behind another router there is nothing to delegate: show the uplink alone instead of an empty half.
        network.upstream && !network.prefix
          ? h('div', { className: 'card-body ov-network-grid ov-single' }, internet)
          : h('div', { className: 'card-body ov-network-grid' }, internet, prefix),
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

// Physical storage device: identity, wear, traffic since boot and partitions. eMMC reports its own wear estimate;
// raw NAND (UBI) has no wear gauge, so it shows the erase counter, bad blocks against the spare reserve and ECC activity.
function diskPanel(d) {
  const worn = d.wear?.worst;
  const nand = d.nand;
  const eol = d.eol && d.eol !== 'normal';
  let health = null;
  if (nand) {
    const exhausted = nand.reserved > 0 && nand.bad >= nand.reserved;
    health = nand.failures > 0 ? ['ECC failures', 'danger'] : exhausted ? ['no spare blocks left', 'danger']
      : nand.reserved > 0 && nand.bad * 4 >= nand.reserved * 3 ? ['few spare blocks left', 'warning'] : nand.bad != null ? ['spare blocks ok', 'success'] : null;
  } else if (worn || d.eol)
    health = eol ? [`end of life: ${d.eol}`, 'danger'] : worn?.to != null && worn.to >= 80 ? ['wearing out', 'warning'] : ['wear normal', 'success'];
  const healthTip = nand
    ? 'Bad blocks against UBI\'s spare reserve, and uncorrectable ECC errors. Raw NAND has no wear gauge; the erase count shows its most-worn block.'
    : 'The device\'s own wear estimate (JEDEC life-time and pre-EOL registers). It does not detect bad blocks, read errors or data corruption.';
  const fw = d.firmware?.replace(/(?:00)+$/, '');
  return h('div', { className: 'ov-disk' },
    h('div', { className: 'ov-disk-head' },
      h('b', {}, [d.vendor, d.model].filter(Boolean).join(' ') || d.name),
      badge(d.kind, 'info'), d.cell ? h('span', { className: 'chip' }, d.cell) : null, d.rotational ? h('span', { className: 'chip' }, 'spinning disk') : null,
      d.readonly ? h('span', { className: 'chip' }, 'read-only') : null,
      health ? h('span', { title: healthTip }, badge(health[0], health[1])) : null,
      h('span', { className: 'muted small mono ov-disk-dev' }, nand ? d.name : `/dev/${d.name}`)),
    h('div', { className: 'ov-disk-facts' },
      diskFact('Capacity', fmtBytes(d.size)),
      d.date ? diskFact('Manufactured', d.date) : null,
      fw ? diskFact('Firmware', fw) : null,
      worn ? diskFact('Life used', worn.to == null ? 'over 100%' : `${worn.from}–${worn.to}%`, 'estimate by the device') : null,
      nand?.maxErase != null ? diskFact('Most-worn block', `${nand.maxErase} erase cycles`, 'Highest erase counter of any block; SLC NAND is typically rated for tens of thousands') : null,
      nand?.bad != null ? diskFact('Bad blocks', `${nand.bad}${nand.reserved != null ? ` · ${nand.reserved} spare` : ''}`, `of ${nand.blocks ?? '?'} blocks; UBI keeps a reserve to replace them`) : null,
      nand ? diskFact('ECC', `${nand.corrected} corrected · ${nand.failures} failed`, 'Bit errors the controller fixed, and reads it could not fix') : null,
      d.written != null ? diskFact('Written since boot', fmtBytes(d.written),
        d.discarded ? `Excludes ${fmtBytes(d.discarded)} of discards (e.g. the overlay format) that the eMMC counts as writes` : 'Data written to the device') : null,
      d.read != null ? diskFact('Read since boot', fmtBytes(d.read)) : null,
      d.erase ? diskFact(nand ? 'Erase block' : 'Erase unit', fmtBytes(+d.erase)) : null),
    d.partitions?.length ? h('div', { className: 'chips ov-parts' },
      h('span', { className: 'muted small' }, nand ? 'UBI volumes' : 'Partitions'),
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

// A router-reported percentage as a width for a bar: a number clamped to 0-100, so an odd value cannot add CSS declarations to the style string.
const barWidth = v => `width:${Math.min(100, Math.max(0, Number(v) || 0))}%`;

// One KPI of the hero strip: icon, label, value and a caption; an optional bar shows a percentage.
function kpi(name, label, value, sub, valueClass = '', percent = null) {
  return h('div', { className: 'ov-kpi' },
    h('div', { className: 'ov-kpi-icon' }, icon(name, 18)),
    h('div', {},
      h('div', { className: 'muted small' }, label),
      h('div', { className: `ov-kpi-value ${valueClass}` }, value),
      percent != null ? h('div', { className: 'progress' }, h('div', {
        className: `progress-bar${percent >= 90 ? ' bg-danger' : percent >= 75 ? ' bg-warning' : ''}`, style: barWidth(percent) })) : null,
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
      style: barWidth(fs.percent),
    })),
    h('div', { className: 'ov-fs-meta muted small' },
      h('span', {}, `${fmtBytes(fs.used)} of ${fmtBytes(fs.total)} · ${fs.percent}%`),
      h('span', { className: 'mono' }, fs.device + (fs.deviceSize ? ` · ${fmtBytes(fs.deviceSize)}` : ''))));
}

// The line above the headline: which WAN carries traffic, or why there is none.
function connectivityNote(network) {
  if (network.unavailable) return 'Connection data is unavailable';
  if (network.upstream) return `Default route via ${network.ipv4.gateway} on ${network.ipv4.name}`;
  if (network.online) return `Via ${network.sources.join(' + ')}`;
  return network.sources.length ? `${network.sources.join(' + ')} has no usable address` : 'No WAN default route is installed';
}

// One address family: its address (flagged when private), or why the family is not available. Only addresses that
// came from a provider say "received"; a configured one says "static".
function protocol(label, wan, unknown) {
  const state = unknown ? ['unknown', ''] : !wan ? ['unavailable', ''] : !wan.address ? ['no address', 'warning']
    : wan.static ? ['static', 'info'] : ['received', 'success'];
  return h('div', { className: `ov-protocol ${wan ? 'active' : ''}` },
    h('div', { className: 'ov-protocol-head' }, h('b', {}, label), badge(...state)),
    unknown ? h('div', { className: 'muted' }, 'Not reported')
      : wan ? [
        h('div', { className: 'mono ov-address' }, wan.address ? `${wan.address}${wan.mask != null ? `/${wan.mask}` : ''}` : 'no address'),
        h('div', { className: 'muted small' }, `${wan.name} · ${wan.proto}${wan.private ? ' · private address' : ''}${wan.gateway ? ` · via ${wan.gateway}` : ''}`),
      ] : h('div', { className: 'muted' }, `No ${label} default route`));
}

// The DNS servers of one family, or why there are none.
function dnsText(network, family) {
  const wan = family === 4 ? network.ipv4 : network.ipv6;
  const active = family === 4 ? network.dns4 : network.dns6;
  const inactive = family === 4 ? network.inactiveDns4 : network.inactiveDns6;
  if (network.unavailable) return 'unknown';
  if (active.length) return active.join(' · ');
  if (inactive.length) return `${inactive.join(' · ')} — received, inactive because netifd is using another DNS data source`;
  return wan ? 'not received from provider' : `no IPv${family} connection`;
}
