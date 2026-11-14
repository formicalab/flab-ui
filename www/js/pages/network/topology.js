// Port topology: how the Ethernet ports are wired, drawn from what the router reports (device tree,
// /etc/board.json, ethtool, sysfs), so it follows whatever board this runs on:
//
//   SoC  ->  MAC (eth0)  ->  CPU port N  ->  switch chip  ->  switch port n  ->  [external PHY]  ->  jack
//            MAC (eth1)  ------------------------------------------------>  [PHY]  ->  jack
//
// One grid column per jack, in the order the board lists its ports (usually the order on the case), with a
// switch's ports kept together. Lines are green while the link is up. Chips and ports that the router does
// not describe are simply left out; a router without a switch gets plain MAC -> PHY -> jack columns.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { card } from '../../core/ui.js';
import { fmtLine } from '../../core/format.js';
import { fmtSpeed, traffic, cpuLink } from './util.js';
import { portTile } from './tile.js';

// Grid row of each layer in the topology diagram, top to bottom (SoC, MACs, CPU links, switch chip,
// switch ports, PHYs, link lines, jacks).
const GRID_ROWS = { soc: 1, mac: 2, cpu: 3, chip: 4, swport: 5, phy: 6, link: 7, jack: 8 };

// Places `node` in one grid row, spanning columns `from`..`to` (1-based, inclusive).
const at = (node, row, from, to = from) => {
  node.style.gridRow = String(row);
  node.style.gridColumn = `${from} / ${to + 1}`;
  return node;
};
// Like `at`, but spanning rows `rowFrom`..`rowTo` too.
const span = (node, rowFrom, rowTo, from, to = from) => {
  node.style.gridRow = `${rowFrom} / ${rowTo + 1}`;
  node.style.gridColumn = `${from} / ${to + 1}`;
  return node;
};

// A vertical connector, green when `on`, with an optional caption beside it and an optional number in a circle on it (`num`,\n// with `numTitle` as its tooltip), the way a switch port is shown.
const vline = (on, caption, num, numTitle) => h('div', { className: `vl ${on ? 'on' : ''}` },
  num != null ? h('span', { className: 'swnum', title: numTitle }, num) : null,
  caption ? h('span', { className: 'vl-cap' }, caption) : null);

// The ports in jack order, each switch's ports contiguous, plus the conduits (SoC MACs) that feed a switch.
// Ports without a board index sort after the indexed ones, in discovery order.
function arrange(net) {
  const switches = net.switches ?? [];
  const fed = new Set(switches.flatMap(s => (s.cpu_ports ?? []).map(c => c.conduit).filter(Boolean)));
  const leaves = net.ports.filter(p => !fed.has(p.name));
  const rank = new Map(net.ports.map((p, i) => [p.name, p.board?.index ?? 1000 + i]));
  const sorted = [...leaves].sort((a, b) => rank.get(a.name) - rank.get(b.name));

  // The switch a port belongs to (matched by its switch node), if any.
  const switchOf = p => switches.find(s => s.node === p.hardware?.switch_node);
  const ordered = [], done = new Set();
  for (const p of sorted) {
    const sw = switchOf(p);
    if (!sw) { ordered.push(p); continue; }
    if (done.has(sw.node)) continue;
    done.add(sw.node);
    ordered.push(...sorted.filter(q => switchOf(q) === sw));
  }
  return { ordered, switches, switchOf };
}

// MAC box for port `p` (null draws an empty placeholder MAC); shows its address and, while the link is up, live speed and rate.
function macBox(p, note) {
  const t = p ? traffic(p.name) : null;
  return h('div', { className: `topo-box mac ${p?.carrier ? 'on' : ''}` },
    h('div', { className: 'tb-title' }, p?.name ?? 'MAC'),
    p?.mac ? h('div', { className: 'tb-mac' }, p.mac) : null,
    h('div', { className: 'tb-sub' }, note ?? 'Ethernet MAC'),
    p?.carrier ? h('div', { className: 'tb-live' }, `${fmtSpeed(p.speed)} · ↓ ${fmtLine(t.rxNow)} ↑ ${fmtLine(t.txNow)}`) : null);
}

// External PHY box for a port that has `hardware.phy`. The line under the name is what the router reports for the port: the
// fastest speed its PHY advertises (ethtool).
function phyBox(p) {
  const phy = p.hardware?.phy;
  return h('div', { className: `topo-box phy ${p.carrier ? 'on' : ''}`, title: phy.id ? `PHY ID ${phy.id}` : '' },
    h('div', { className: 'tb-title' }, phy.name ?? 'PHY'),
    p.max_speed ? h('div', { className: 'tb-sub' }, `up to ${fmtSpeed(p.max_speed)}`) : null);
}

// The line about the link between a switch and the SoC: its capacity, how much of it is in use now, and (when the linked user ports
// could send more than it carries) how many times it is oversubscribed.
function cpuLinkText(link) {
  const used = link.utilization == null ? null : `${link.utilization < 10 ? link.utilization.toFixed(1) : Math.round(link.utilization)}% used`;
  const over = link.oversubscription > 1 ? `linked ports can send up to ${fmtSpeed(link.potential)} (${link.oversubscription.toFixed(1)}× oversubscribed)` : null;
  return [`CPU link ${fmtSpeed(link.capacity)}`, used, over].filter(Boolean).join(' · ');
}

// The "Port topology" card: a CSS grid with one column per jack, built layer by layer. Each cell is placed
// explicitly (at/span) so connectors line up across rows.
export function topologyCard(net) {
  const { ordered, switches, switchOf } = arrange(net);
  const cols = ordered.length;
  const col = new Map(ordered.map((p, i) => [p.name, i + 1]));
  const byName = new Map(net.ports.map(p => [p.name, p]));
  const cells = [];
  // Appends a cell to the diagram and returns it so callers can reference it in edges.
  const add = n => { cells.push(n); return n; };

  const soc = net.ports.map(p => p.hardware?.soc).find(Boolean);
  if (soc || net.model) {
    add(at(h('div', { className: 'topo-soc' }, icon('cpu', 18), h('strong', {}, soc ? `${soc} SoC` : 'SoC'), net.model ? h('span', { className: 'muted' }, net.model) : null), GRID_ROWS.soc, 1, cols));
  }

  // Switch groups: MAC(s) above, CPU link, the chip, then one numbered port per column.
  for (const sw of switches) {
    const members = ordered.filter(p => switchOf(p) === sw);
    if (!members.length) continue;
    const from = col.get(members[0].name), to = col.get(members.at(-1).name);
    const cpu = sw.cpu_ports?.length ? sw.cpu_ports : [{ port: null }];
    // The fastest speed any user port of the switch advertises, as the router reports it (0 when none does).
    const fastest = Math.max(0, ...members.map(p => p.max_speed ?? 0));
    const link = cpuLink(net, sw);

    const macs = h('div', { className: 'topo-row' }, cpu.map(c => c.conduit ? macBox(byName.get(c.conduit), `to ${sw.label ?? 'switch'}`) : h('div')));
    add(at(macs, GRID_ROWS.mac, from, to));
    add(at(h('div', { className: 'topo-row' }, cpu.map(c => {
      const mac = byName.get(c.conduit);
      // The switch's port number sits on the link in a circle, like the numbers of the user ports below the chip.
      return vline(mac?.carrier ?? true, ['CPU port', c.mode, c.speed ? fmtSpeed(c.speed) : null].filter(Boolean).join(' · '), c.port, `CPU port ${c.port} of ${sw.label ?? 'the switch'}`);
    })), GRID_ROWS.cpu, from, to));

    add(at(h('div', { className: 'topo-box chip' },
      h('div', { className: 'tb-title' }, icon('diagram-2', 16), ` ${sw.label ?? 'Switch'} switch`),
      h('div', { className: 'tb-sub' }, `${sw.ports.length} user port${sw.ports.length === 1 ? '' : 's'}${fastest ? ` (up to ${fmtSpeed(fastest)})` : ''}${cpu[0].port != null ? ` · CPU port${cpu.length > 1 ? 's' : ''} ${cpu.map(c => c.port).join(', ')}` : ''}`),
      link ? h('div', { className: `tb-sub${link.utilization >= 90 ? ' text-danger' : ''}` }, cpuLinkText(link)) : null),
    GRID_ROWS.chip, from, to));
  }

  // Per column: the path from the chip or MAC down to the jack.
  for (const p of ordered) {
    const c = col.get(p.name), sw = switchOf(p), on = p.carrier;
    if (sw) {
      add(at(h('div', { className: `vl swport ${on ? 'on' : ''}` }, h('span', { className: 'swnum', title: `${sw.label ?? 'Switch'} port ${p.hardware.switch_port}` }, p.hardware.switch_port ?? '?')), GRID_ROWS.swport, c));
      if (p.hardware.external_phy && p.hardware.phy) add(at(phyBox(p), GRID_ROWS.phy, c));
      else add(at(vline(on, 'internal PHY'), GRID_ROWS.phy, c));
    }
    else {
      // A MAC wired straight to its PHY and jack.
      add(at(macBox(p, p.hardware?.soc ? `${p.hardware.soc} Ethernet MAC` : 'Ethernet MAC'), GRID_ROWS.mac, c));
      add(span(vline(on), GRID_ROWS.cpu, GRID_ROWS.swport, c));
      if (p.hardware?.phy) add(at(phyBox(p), GRID_ROWS.phy, c));
      else add(at(vline(on), GRID_ROWS.phy, c));
    }
    add(at(vline(on), GRID_ROWS.link, c));
    // A switch port with the same MAC as the SoC port that feeds its switch (the usual DSA default) does not repeat it: the MAC box above shows it once.
    const inherits = sw && (sw.cpu_ports ?? []).some(cp => p.mac && byName.get(cp.conduit)?.mac === p.mac);
    add(at(portTile(p, !inherits), GRID_ROWS.jack, c));
  }

  const linked = net.ports.filter(p => p.carrier).length;
  return card([icon('ethernet'), h('span', {}, 'Port topology'), h('span', { className: 'sub' }, `${linked} of ${net.ports.length} links up · wiring read from the device tree`)],
    h('div', { className: 'card-body topo-scroll' },
      cols ? h('div', { className: 'muted small topo-legend' }, h('span', { className: 'dot up' }), ' green line: link up · gray: no link · jacks follow the order the board lists its ports') : null,
      cols ? h('div', { className: 'topo', style: `grid-template-columns: repeat(${cols}, minmax(176px, 1fr))` }, cells) : h('div', { className: 'muted' }, 'No Ethernet ports were reported.')));
}
