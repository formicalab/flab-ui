// Health findings, BIRD protocol list, daemon details and memory use.

import { h } from '../../../core/dom.js';
import { icon } from '../../../core/icons.js';
import { badge, card, kv, chip, meter, muted } from '../../../core/ui.js';
import { fmtBytes, fmtNum, fmtSpan } from '../../../core/format.js';
import { peerDot } from './util.js';
import { reviewConfig, configOf, findBlock } from './configmodel.js';
import { localRoutesTable } from './announced.js';
import { flowView } from './flow.js';
import { showFilterSource } from './config.js';

// A protocol with this many routes of its own or fewer shows them open at first (the page remembers what the user folds).
const LOCAL_OPEN_MAX = 8;

// Icon per finding level (the levels produced by flab.bgp.uc: good, info, warn, bad).
const LEVEL_ICON = { good: 'check-circle', info: 'info-circle', warn: 'exclamation-triangle', bad: 'x-circle' };

// How many prefixes use each peer as an installed (active) next hop: shows how traffic is spread.
function nextHopShare(data) {
  const total = new Set(data.paths.map(p => p.prefix)).size;
  if (!total) return null;
  const installed = new Map();
  for (const r of data.paths) if (r.in_kernel) installed.set(r.peer, (installed.get(r.peer) ?? 0) + 1);
  return h('div', { className: 'share' },
    h('h3', { className: 'sec-title' }, 'Active next hops per peer'),
    data.peers.map(p => {
      const active = installed.get(p.name) ?? 0;
      return h('div', { className: 'share-row' },
        h('span', { className: 'peer-label' }, peerDot(data, p.name), p.name),
        meter(active, total, active ? 'good' : 'weak'),
        h('span', { className: 'mv', title: 'Prefixes for which this peer is an installed next hop' }, `${active} / ${total}`));
    }),
    h('div', { className: 'muted small' }, 'Prefixes whose traffic can leave through each peer (equal-cost multipath).'));
}

// Health card: the backend's findings list (data.findings, computed server-side) and the review of the configuration file
// (configmodel.js) under a verdict badge that summarizes the worst level, followed by the next-hop distribution.
export function healthCard(data) {
  const f = [...data.findings, ...reviewConfig(data)];
  const bad = f.filter(x => x.level === 'bad').length, warn = f.filter(x => x.level === 'warn').length;
  const verdict = bad ? badge(`${bad} problem${bad > 1 ? 's' : ''}`, 'danger') : warn ? badge(`${warn} warning${warn > 1 ? 's' : ''}`, 'warning') : badge('Healthy', 'success');
  return card([icon('activity'), 'Health', verdict],
    h('div', {},
      h('ul', { className: 'findings' }, f.length ? f.map(x => h('li', { className: x.level }, icon(LEVEL_ICON[x.level] ?? 'info-circle', 17), h('span', {}, x.text))) : h('li', { className: 'info' }, 'No findings.')),
      nextHopShare(data)),
    'h-100');
}

// "N in · N out · N best" for a channel's route counters, or a dash when BIRD reports none.
function routesText(ch) {
  const r = ch?.routes;
  return r && Object.keys(r).length ? `${r.imported ?? 0} in · ${r.exported ?? 0} out · ${r.preferred ?? 0} best` : '–';
}

// One line per channel; the address family prefixes the numbers when a protocol has several.
function channelLines(p, text) {
  if (!p.channels.length) return muted('–');
  return h('div', {}, p.channels.map(ch => h('div', {}, p.channels.length > 1 ? h('small', { className: 'muted' }, `${ch.afi} `) : null, text(ch))));
}

// What an import or export filter does, in words, for the protocol `p`: the direction's meaning, then what this filter says. A named
// filter is explained by the comment lines above it in the configuration file when there are any, otherwise by where it is defined.
// `config` is the parsed file or null. Returns { text, block } where block is the filter's block in the file (or undefined).
function filterHelp(p, dir, name, config) {
  const bgp = p.proto === 'BGP', kernel = p.proto === 'Kernel';
  const meaning = {
    in: bgp ? 'Import filter: applied to every route received from the peer before it enters the routing table.'
      : kernel ? 'Import filter: applied to the routes read from the Linux routing table before they enter BIRD\'s table.'
        : 'Import filter: applied to the routes this protocol puts into BIRD\'s table.',
    out: bgp ? 'Export filter: decides which routes of the table are announced to the peer.'
      : kernel ? 'Export filter: decides which routes of the table are installed in the Linux routing table.'
        : 'Export filter: decides which routes of the table are handed to this protocol (it does not decide what BGP peers are sent: each peer has its own export filter).',
  }[dir];
  if (name === 'ACCEPT') return { text: `${meaning} ACCEPT lets every route through.` };
  if (name === 'REJECT') return { text: `${meaning} REJECT lets no route through.` };
  const block = findBlock(config, 'filter', name);
  if (!block) return { text: `${meaning} "${name}" is a filter of the configuration file${config ? ', which does not define it' : ' (the file could not be read)'}.` };
  const doc = config.lines.slice(block.firstLine - 1, block.startLine - 1).map(l => l.replace(/^\s*#\s?/, '').trim()).filter(Boolean).join(' ');
  return { text: `${meaning} ${doc ? `Its comment in the file: ${doc}` : `"${name}" is defined in the file, lines ${block.startLine}–${block.endLine}; it has no comment.`}`, block };
}

// What each kind of BIRD protocol is for (the names `birdc show protocols` prints), from the BIRD 3.3.3 user's guide. The legend lists the
// kinds the router runs; a kind that is not here is listed without a description.
const TYPE_HELP = {
  Kernel: 'Keeps BIRD\'s table and the Linux routing table in step: reads the routes the system has and installs BIRD\'s best routes in it.',
  Device: 'Watches the network interfaces and their addresses and tells the other protocols; it carries no routes itself.',
  Direct: 'Makes a route for each network that is directly attached to an interface.',
  Static: 'The routes written in the configuration: a route via a gateway, a blackhole, an unreachable or a prohibit route.',
  BGP: 'One session with one neighbor: exchanges routes with another router, in another AS (eBGP) or the same one (iBGP).',
  OSPF: 'Link-state routing inside a network: exchanges routes with the neighboring routers.',
  RIP: 'Simple distance-vector routing inside a network.',
  Babel: 'Distance-vector routing for networks with wired and wireless links that change.',
  BFD: 'Detects a failed link fast for the sessions of the other protocols; it carries no routes.',
  RPKI: 'Fetches the signed route origins (ROAs) that BGP routes are validated against; it carries no routes of its own.',
  Pipe: 'Connects two routing tables and passes routes between them.',
  RAdv: 'Sends IPv6 router advertisements for the prefixes of a table.',
  Aggregator: 'Merges routes into aggregates by rules (experimental in BIRD).',
  MRT: 'Dumps the routing tables to files for analysis; it carries no routes.',
  BMP: 'Streams BGP monitoring data to a collector; it carries no routes.',
  L3VPN: 'Translates routes for layer 3 VPNs over MPLS.',
  Perf: 'BIRD\'s benchmarking protocol.',
};

// A remark added to the description of a type in the legend, underlined there. A BGP session is the one protocol that must have its
// filters written out, which is why the configuration file defines filters for it.
const TYPE_NOTE = {
  BGP: 'An external BGP session must have both filters written out (RFC 8212): without them BIRD accepts no route from the peer and announces none.',
};

// Table of every BIRD protocol instance (BGP sessions, kernel, direct, ...): state, routing table, and
// per-channel route counts, preference and import/export filters. A filter chip explains itself in its tooltip, and a filter
// defined in the configuration file jumps to its source there; the legend above the table says what the types and the chips mean.
export function protocolsCard(data, state, rerender) {
  const config = configOf(data.config);
  // Badge kind for a protocol state: only "up" is healthy.
  const stateKind = s => s === 'up' ? 'success' : 'warning';
  // One filter chip (ACCEPT good, REJECT fair, named filters neutral, none as a dash) with its explanation as the tooltip.
  const filterChip = (p, dir, name) => {
    if (!name) return muted('–');
    const { text, block } = filterHelp(p, dir, name, config);
    const kind = name === 'ACCEPT' ? 'good' : name === 'REJECT' ? 'fair' : 'info';
    if (!block || !state) return chip(name, kind, text);
    return h('button', {
      type: 'button', className: `alg-chip ${kind} cfg-chip-link`, title: `${text} Click to see it in the configuration.`,
      onclick: () => showFilterSource(state, rerender, name, block),
    }, name);
  };
  const filterChips = (p, ch) => h('span', { className: 'chips' }, filterChip(p, 'in', ch.input_filter), filterChip(p, 'out', ch.output_filter));
  // The routes of the protocols that are not BGP (direct, static, ...) belong under the row of the protocol that made them. A protocol
  // with few routes starts open; the choice is kept in the page state across the redraws of the poll.
  const known = new Set(data.protocols.map(p => p.name));
  const localOf = name => data.local.filter(r => r.protocol === name);
  const orphans = data.local.filter(r => !known.has(r.protocol));
  const isOpen = (name, count) => state?.protoOpen?.get(name) ?? count <= LOCAL_OPEN_MAX;
  // The name cell: a button that folds the protocol's routes when it has any. Every name starts at the same place: a protocol without
  // routes gets a blank where the arrow would be, so none looks like a child of the row above.
  const nameCell = (p, local) => {
    if (!local.length) return h('span', { className: 'bgp-fold bgp-nofold' }, h('span', { className: 'bgp-fold-gap' }), h('b', {}, p.name));
    const open = isOpen(p.name, local.length);
    return h('button', {
      type: 'button', className: 'bgp-fold', ariaExpanded: String(open), id: `bgp-proto-${p.name}`,
      title: `${open ? 'Hide' : 'Show'} the ${local.length} route${local.length === 1 ? '' : 's'} of ${p.name}`,
      onclick: () => { state.protoOpen.set(p.name, !open); rerender(); },
    }, icon(open ? 'chevron-down' : 'chevron-right', 14), h('b', {}, p.name), h('span', { className: 'muted small' }, ` ${local.length} route${local.length === 1 ? '' : 's'}`));
  };
  // The row of one protocol, followed by its routes when it has some and they are shown.
  const rowsOf = p => {
    const local = localOf(p.name);
    const row = h('tr', { id: `bgp-row-${p.name}` },
      h('td', {}, nameCell(p, local)),
      h('td', {}, h('span', { title: [TYPE_HELP[p.proto], TYPE_NOTE[p.proto]].filter(Boolean).join(' ') }, p.proto)),
      h('td', { className: 'mono' }, (p.table ?? [...new Set(p.channels.map(c => c.table).filter(Boolean))].join(', ')) || '–'),
      h('td', {}, badge(p.state, stateKind(p.state)), p.info ? ' ' : null, p.info ? h('small', { className: 'muted' }, p.info) : null),
      h('td', {}, p.since),
      h('td', {}, channelLines(p, routesText)),
      h('td', {}, channelLines(p, ch => ch.preference ?? '–')),
      h('td', {}, channelLines(p, ch => filterChips(p, ch))));
    return local.length && isOpen(p.name, local.length) ? [row, h('tr', { className: 'bgp-sub' }, h('td', { colSpan: 8 }, localRoutesTable(local)))] : [row];
  };
  const rows = data.protocols.flatMap(rowsOf);
  // Routes whose protocol BIRD no longer lists (it went away between two commands): kept visible rather than dropped.
  if (orphans.length) rows.push(h('tr', { className: 'bgp-sub' }, h('td', { colSpan: 8 }, h('div', { className: 'muted small' }, 'Routes of protocols that are not listed:'), localRoutesTable(orphans))));
  // Column headings with a tooltip each: what the column means is not obvious from the name.
  const heads = [
    ['Name', 'The protocol instance as named in the configuration'],
    ['Type', 'The kind of protocol: BGP session, Kernel (the Linux routing table), Device, Direct, Static, ...'],
    ['Table', 'The BIRD routing table the protocol imports into and exports from'],
    ['State', 'up: running. For a BGP session the Info column holds the session state (Established, Active, ...)'],
    ['Since', 'When the protocol last changed state (BIRD prints only the date for anything older than a day)'],
    ['Routes', 'Routes taken from the protocol · routes handed to it · routes of the protocol that are the best for their prefix'],
    ['Pref', 'Route preference: when two protocols offer the same prefix, the higher number wins before any other rule (BGP 100, static 200 unless configured otherwise)'],
    ['Filters (in · out)', 'Import filter first, export filter second: the rules a route must pass to come in from the protocol and to go out to it'],
  ];
  // The kinds of protocol this router runs, in the order the table lists them, each with what it is for.
  const kinds = [...new Set(data.protocols.map(p => p.proto))];
  const legend = h('div', { className: 'bgp-legend small' },
    h('div', {}, h('b', {}, 'Type: '), 'what each protocol on this router is for.'),
    h('dl', { className: 'bgp-types' }, kinds.flatMap(k => [h('dt', {}, chip(k, '')),
      h('dd', { className: 'muted' }, TYPE_HELP[k] ?? 'No description available.', TYPE_NOTE[k] ? [' ', h('span', { className: 'bgp-note' }, TYPE_NOTE[k])] : null)])),
    h('div', {}, h('b', {}, 'Routes of a protocol: '), 'a protocol that made routes of its own (Direct, Static, ...) has an arrow before its name: open it to see them, with the device each points at and whether the kernel has it. The routes learned from the BGP sessions are in ', h('b', {}, 'Learned routes'), ' below; the Routes column counts them all.'),
    h('div', {}, h('b', {}, 'Filters (in · out): '), 'the first chip is the ', h('b', {}, 'import'), ' filter of the protocol\'s channel to its routing table, the second the ', h('b', {}, 'export'), ' filter; the diagram above shows where each one sits and what BIRD does when the file names none. What a BGP peer is sent is decided by that peer\'s own export filter, not by the other protocols\' chips. Hover a chip for what it does.'),
    h('div', { className: 'bgp-legend-row' }, chip('ACCEPT', 'good'), h('span', { className: 'muted' }, 'every route passes'),
      chip('REJECT', 'fair'), h('span', { className: 'muted' }, 'no route passes'),
      chip('name', 'info'), h('span', { className: 'muted' }, 'a filter of the configuration file: its rules accept, change or reject routes one by one (a click shows its source)'),
      muted('–'), h('span', { className: 'muted' }, 'no filter on that side')));
  return card([icon('hdd-stack'), 'BIRD protocols', h('span', { className: 'sub' }, `${data.protocols.length} instances · ${data.local.length} local route${data.local.length === 1 ? '' : 's'}`)],
    h('div', {},
      flowView(data, state, rerender),
      legend,
      h('div', { className: 'table-responsive' }, h('table', { className: 'table table-hover' },
        h('thead', {}, h('tr', {}, heads.map(([c, tip]) => h('th', { title: tip }, c)))),
        h('tbody', {}, rows)))));
}

// BIRD daemon facts; `started` and `reconfigured` are epoch seconds shown in the browser's locale.
export function daemonCard(data) {
  const d = data.daemon;
  return card([icon('cpu'), 'BIRD daemon'], h('div', { className: 'card-body' }, kv([
    ['Status', badge(d.state ?? 'unknown', d.state === 'up and running' ? 'success' : 'warning')],
    ['Version', `BIRD ${d.version ?? '?'}`],
    ['Router ID', h('span', { className: 'mono' }, d.router_id ?? '–')],
    ['Hostname', d.hostname ?? '–'],
    ['Uptime', d.uptime ? fmtSpan(d.uptime) : '–'],
    ['Started', d.started ? new Date(d.started * 1000).toLocaleString() : '–'],
    ['Last reconfiguration', d.reconfigured ? new Date(d.reconfigured * 1000).toLocaleString() : '–'],
    ['Routing table', `${fmtNum(d.routes)} routes for ${fmtNum(d.prefixes)} prefixes`],
  ])), 'h-100');
}

// A bar width in percent of `max`, clamped to 0..100 so that a malformed number never reaches the style attribute as text.
const barPercent = (value, max) => Math.min(100, Math.max(0, Number(value) / max * 100)) || 0;

// BIRD memory by pool: stacked bars of effective (used) bytes plus allocator overhead, all scaled to the
// largest pool so they are comparable; the "Total" row has no bar, only the text.
export function memoryCard(data) {
  const rows = data.memory.filter(m => m.overhead != null);
  const max = Math.max(1, ...rows.filter(m => m.name !== 'Total').map(m => m.effective + m.overhead));
  const total = data.memory.find(m => m.name === 'Total');
  return card([icon('cpu'), 'BIRD memory', total ? h('span', { className: 'sub' }, `${fmtBytes(total.effective)} in use`) : null],
    h('div', { className: 'card-body' }, h('div', { className: 'membars' }, rows.map(m => h('div', { className: `membar ${m.name === 'Total' ? 'total' : ''}` },
      h('div', { className: 'ml' }, m.name),
      h('div', { className: 'track', title: `${fmtBytes(m.effective)} used · ${fmtBytes(m.overhead)} overhead` },
        m.name === 'Total' ? null : [h('i', { className: 'eff', style: `width:${barPercent(m.effective, max)}%` }), h('i', { className: 'ovh', style: `width:${barPercent(m.overhead, max)}%` })]),
      h('div', { className: 'mv' }, `${fmtBytes(m.effective)} + ${fmtBytes(m.overhead)}`)))),
    h('div', { className: 'muted small mt-2' }, 'Bars show used memory plus allocator overhead.')),
    'h-100');
}
