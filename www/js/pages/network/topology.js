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
import { fmtSpeed, traffic } from './util.js';
import { chipNote } from './chips.js';
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

// A vertical connector, green when `on`, with an optional caption beside it.
const vline = (on, caption) => h('div', { className: `vl ${on ? 'on' : ''}` }, caption ? h('span', { className: 'vl-cap' }, caption) : null);

// The ports in jack order, each switch's ports contiguous, plus the conduits (SoC MACs) that feed a switch.
// Ports without a board index sort after the indexed ones, in discovery order.
function arrange(net) {
  const switches = net.switches ?? [];
  const fed = new Set(switches.flatMap(s => (s.cpu_ports ?? []).map(c => c.conduit).filter(Boolean)));
  const leaves = net.ports.filter(p => !fed.has(p.name));
  const rank = new Map(net.ports.map((p, i) => [p.name, p.board?.index ?? 1000 + i]));
  const sorted = [...leaves].sort((a, b) => rank.get(a.name) - rank.get(b.name));

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

// MAC box for port `p` (null draws an empty placeholder MAC); shows live speed and rate while the link is up.
function macBox(p, note) {
  const t = p ? traffic(p.name) : null;
  return h('div', { className: `topo-box mac ${p?.carrier ? 'on' : ''}` },
    h('div', { className: 'tb-title' }, p?.name ?? 'MAC'),
    h('div', { className: 'tb-sub' }, note ?? 'Ethernet MAC'),
    p?.carrier ? h('div', { className: 'tb-live' }, `${fmtSpeed(p.speed)} · ↓ ${fmtLine(t.rxNow)} ↑ ${fmtLine(t.txNow)}`) : null);
}

// External PHY box for a port that has `hardware.phy`; the chip description comes from chips.js.
function phyBox(p) {
  const phy = p.hardware?.phy;
  return h('div', { className: `topo-box phy ${p.carrier ? 'on' : ''}`, title: phy.id ? `PHY ID ${phy.id}` : '' },
    h('div', { className: 'tb-title' }, phy.name ?? 'PHY'),
    chipNote(phy.name) ? h('div', { className: 'tb-sub' }, chipNote(phy.name)) : null);
}

// The "Port topology" card: a CSS grid with one column per jack, built layer by layer. Each cell is placed
// explicitly (at/span) so connectors line up across rows.
export function topologyCard(net) {
  const { ordered, switches, switchOf } = arrange(net);
  const cols = ordered.length;
  const col = new Map(ordered.map((p, i) => [p.name, i + 1]));
  const byName = new Map(net.ports.map(p => [p.name, p]));
  const cells = [];
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

    const macs = h('div', { className: 'topo-row' }, cpu.map(c => c.conduit ? macBox(byName.get(c.conduit), `to ${sw.label ?? 'switch'}`) : h('div')));
    add(at(macs, GRID_ROWS.mac, from, to));
    add(at(h('div', { className: 'topo-row' }, cpu.map(c => {
      const mac = byName.get(c.conduit);
      return vline(mac?.carrier ?? true, [c.port != null ? `CPU port ${c.port}` : 'CPU port', c.mode, c.speed ? fmtSpeed(c.speed) : null].filter(Boolean).join(' · '));
    })), GRID_ROWS.cpu, from, to));

    add(at(h('div', { className: 'topo-box chip' },
      h('div', { className: 'tb-title' }, icon('diagram-2', 16), ` ${sw.label ?? 'Switch'} switch`),
      chipNote(sw.label) ? h('div', { className: 'tb-sub' }, chipNote(sw.label)) : null,
      h('div', { className: 'tb-sub' }, `${sw.ports.length} user port${sw.ports.length === 1 ? '' : 's'}${cpu[0].port != null ? ` · CPU port${cpu.length > 1 ? 's' : ''} ${cpu.map(c => c.port).join(', ')}` : ''}`)),
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
    add(at(portTile(p), GRID_ROWS.jack, c));
  }

  const linked = net.ports.filter(p => p.carrier).length;
  return card([icon('ethernet'), h('span', {}, 'Port topology'), h('span', { className: 'sub' }, `${linked} of ${net.ports.length} links up · wiring read from the device tree`)],
    h('div', { className: 'card-body topo-scroll' },
      cols ? h('div', { className: 'muted small topo-legend' }, h('span', { className: 'dot up' }), ' green line: link up · gray: no link · jacks follow the order the board lists its ports') : null,
      cols ? h('div', { className: 'topo', style: `grid-template-columns: repeat(${cols}, minmax(176px, 1fr))` }, cells) : h('div', { className: 'muted' }, 'No Ethernet ports were reported.')));
}
