// Pure model of the flow diagram of the BIRD protocols card: which protocol puts routes into which routing table, which table hands
// routes to which protocol, through which filter, and what lies outside BIRD. It follows the BIRD 3.3.3 user's guide ("Architecture",
// Protocols and channels; "Channel options"):
//   - a protocol is joined to a routing table by a channel; the import filter is applied to the routes passed from the protocol to the
//     table, the export filter to the routes passed from the table to the protocol;
//   - the default is import all (except for external BGP) and export none (except for external BGP and L3VPN), which an external BGP
//     session must therefore spell out; a channel with no `import` or `export` line in the file has the default;
//   - BIRD's tables are not kernel forwarding tables: the Kernel protocol synchronizes them with the kernel's;
//   - Device and BFD have no channels at all: they are services for the other protocols.
// buildFlow() returns plain geometry (lanes, tables, outside nodes, edges with their tags); flow.js only draws it.

import { channelPolicy, protocolBlocks } from './configmodel.js';

// Geometry, in the units of the SVG's viewBox.
export const FLOW = { width: 1040, outsideW: 130, laneX: 172, laneW: 172, tableW: 150, pad: 12, edgeGap: 22, laneMin: 50, laneGap: 7, tableMin: 78, tableGap: 18 };

// Width of a chip's text in the drawing (an estimate: the SVG has no layout engine to measure with), at the diagram's font size.
export const textWidth = s => Math.ceil(String(s).length * 5.4);

// "azure_xfrm" for azure_xfrm0..3: what the names have in common without their numbers, or the first name when nothing is shared.
function commonName(names) {
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix.replace(/[0-9_.-]+$/, '') || names[0];
}

// "1 route" / "10 routes".
const routes = n => `${n} route${n === 1 ? '' : 's'}`;

// The policy one side of a channel has, from what BIRD reports (`live`: ACCEPT, REJECT or a filter's name) and what the file says
// (`stmt`, or null when the file has no such line). `known` is whether the file defines the protocol at all, which decides whether
// "default" can be said. Returns { kind: accept | reject | filter, text, filter, source: file | default | null, blocked }.
function policyOf(live, stmt, known) {
  const source = known ? (stmt ? 'file' : 'default') : null;
  if (live === 'ACCEPT') return { kind: 'accept', text: 'accept all', filter: null, source, blocked: false };
  if (live === 'REJECT') return { kind: 'reject', text: 'reject all', filter: null, source, blocked: true };
  if (live) return { kind: 'filter', text: live, filter: live, source, blocked: false };
  return { kind: 'filter', text: '–', filter: null, source: null, blocked: false };
}

// The routes of a protocol that are the next hops of multihop BGP sessions: BIRD resolves those through a lookup in this table.
function nextHopRoutes(data, names, table) {
  const hops = new Set(data.peers.filter(p => /\bmultihop\b/.test(p.session ?? '') && p.neighbor).map(p => p.neighbor));
  const routes = (data.local ?? []).filter(r => names.includes(r.protocol) && r.table === table && hops.has(String(r.prefix).replace(/\/(32|128)$/, '')));
  return { routes: routes.length, sessions: hops.size };
}

// The tooltip of an edge: what the filter is for, which one it is, and, when it is the default, that nothing in the file chose it.
function explain(dir, policy, lane, table, external, proto, hops) {
  const who = lane.group ? `the ${lane.sessions} sessions ${lane.names.join(', ')}` : lane.names[0];
  const head = dir === 'in'
    ? `Import filter of ${who}: applied to the routes the protocol passes to ${table}.`
    : `Export filter of ${who}: applied to the routes ${table} passes to the protocol.`;
  const what = policy.kind === 'filter' ? `The filter "${policy.text}" decides route by route.`
    : policy.kind === 'accept' ? 'Every route passes.' : 'No route passes.';
  let note = '';
  if (policy.source === 'default') {
    note = dir === 'in' ? ' This is BIRD\'s default: the file has no import line for this channel, so it imports all routes.'
      : (proto === 'L3VPN' ? ' This is the default for L3VPN: the file has no export line, so it exports all routes.'
        : ' This is BIRD\'s default: the file has no export line for this channel, so it exports none.');
  } else if (policy.source === 'file') note = ' Set in the configuration file.';
  if (external && policy.source === 'default') note += ' (An external BGP session has no default: it must say it.)';
  if (dir === 'in' && hops?.routes && !policy.blocked) {
    note += ` ${hops.routes} of these routes are the addresses of the neighbors of the ${hops.sessions} multihop BGP sessions: BIRD finds the gateway of a multihop session's routes by looking its next hop up in ${table} (the guide's "gateway recursive", the default for multihop), so they are needed in the table even though no export filter sends them to a peer.`;
  }
  return `${head} ${what}${note}`;
}

// Which things outside BIRD a protocol talks to, as the guide describes the other side of a protocol: sockets (BGP), APIs (Kernel,
// Direct); Device watches the interfaces; Static, Pipe and the rest talk to nothing outside. Returns { key, title, sub, rank, both }
// or null. `both` is whether routes also go back (the Kernel protocol writes to the kernel; BGP speaks both ways).
function outsideOf(unit) {
  const p = unit.members[0].p, peer = unit.members[0].peer;
  if (p.proto === 'Kernel') return { key: 'linux', title: 'Linux kernel', sub: 'forwarding table (FIB)', rank: 0, both: true };
  if (p.proto === 'Device' || p.proto === 'Direct') return { key: 'ifaces', title: 'Network interfaces', sub: 'and their addresses', rank: 1, both: false };
  if (p.proto === 'BGP') {
    const as = peer?.neighbor_as ?? null;
    return { key: `as:${as}`, title: as == null ? 'BGP neighbors' : `AS ${as}`, sub: 'BGP neighbors', rank: 3, both: true, order: as ?? 0 };
  }
  return null;
}

// Builds the whole diagram. `data` is the flab.bgp status reply, `config` the parsed bird.conf or null, `open` the set of group keys
// the user expanded into one lane per session. Returns
//   { width, height, lanes, tables, outside, links, edges, groups }
// lane: { key, names, label, type, group, member, groupKey, sessions, sub, status, x, y, w, h, channels, outside }
// edge: { id, lane, table, dir: in | out, count, countText, tag: { text, kind, filter, source, title, x, y, w }, blocked, path, stop, strokeWidth }
// table: { name, x, y, w, h, routes }; outside: { key, title, sub, x, y, w, h, lanes }; link: { outside, lane, path, both }
export function buildFlow(data, config, open = new Set()) {
  const peers = new Map(data.peers.map(p => [p.name, p]));
  const units = data.protocols.map(p => ({ p, peer: peers.get(p.name), template: protocolBlocks(config, p.name).own?.from ?? null }));

  // BGP sessions that are alike (same channels, filters, neighbor AS and template) share one lane until the user opens the group.
  const groupKeyOf = u => ['bgp', u.p.channels.map(c => `${c.afi}:${c.table}:${c.input_filter}:${c.output_filter}`).join(','), u.peer?.neighbor_as ?? '', u.template ?? ''].join('|');
  const byGroup = new Map();
  for (const u of units) if (u.p.proto === 'BGP') { const k = groupKeyOf(u); byGroup.set(k, [...(byGroup.get(k) ?? []), u]); }
  const lanesIn = [];
  for (const u of units) {
    const k = u.p.proto === 'BGP' ? groupKeyOf(u) : null;
    const members = k ? byGroup.get(k) : null;
    if (members && members.length > 1) {
      if (open.has(k)) lanesIn.push({ members: [u], groupKey: k, sessions: members.length, group: false, member: true });
      else if (members[0] === u) lanesIn.push({ members, groupKey: k, sessions: members.length, group: true, member: false });
    } else lanesIn.push({ members: [u], groupKey: null, sessions: 1, group: false, member: false });
  }
  // Things that talk to the same outside neighbor sit together: the kernel, the interfaces, the others, then BGP by neighbor AS.
  lanesIn.forEach((l, i) => { l.outside = outsideOf(l); l.index = i; });
  lanesIn.sort((a, b) => ((a.outside?.rank ?? 2) - (b.outside?.rank ?? 2)) || ((a.outside?.order ?? 0) - (b.outside?.order ?? 0)) || (a.index - b.index));

  // The lanes, with the edges of every channel: first the import edge, then the export edge, as BIRD names them.
  const lanes = [];
  const edges = [];
  for (const l of lanesIn) {
    const first = l.members[0];
    const names = l.members.map(m => m.p.name);
    const up = l.members.filter(m => (m.p.proto === 'BGP' ? m.peer?.state === 'Established' : m.p.state === 'up')).length;
    const state = first.p.proto === 'BGP' ? (l.members.length > 1 ? `${up} of ${l.members.length} Established` : (first.peer?.state ?? first.p.info ?? first.p.state))
      : (first.p.state === 'up' ? 'up' : `${first.p.state}${first.p.info ? ` · ${first.p.info}` : ''}`);
    const lane = {
      key: l.group ? l.groupKey : names[0], names, group: l.group, member: l.member, groupKey: l.groupKey, sessions: l.sessions,
      label: l.group ? commonName(names) : names[0], type: first.p.proto, sub: `${first.p.proto} · ${state}`,
      status: up === l.members.length ? 'up' : up ? 'warn' : 'down', outside: l.outside, channels: [], edges: [],
    };
    if (l.group) lane.label = `${lane.label} ×${l.members.length}`;
    const known = protocolBlocks(config, first.p.name).own != null;
    const external = /\bexternal\b/.test(first.peer?.session ?? '');
    first.p.channels.forEach((c, ci) => {
      const pol = config ? channelPolicy(config, first.p.name, c.afi) : { known: false, import: null, export: null };
      const sum = key => l.members.reduce((n, m) => n + (m.p.channels[ci]?.routes?.[key] ?? 0), 0);
      const each = key => [...new Set(l.members.map(m => m.p.channels[ci]?.routes?.[key] ?? 0))];
      for (const dir of ['in', 'out']) {
        const policy = policyOf(dir === 'in' ? c.input_filter : c.output_filter, dir === 'in' ? pol.import : pol.export, known);
        const key = dir === 'in' ? 'imported' : 'exported';
        const count = sum(key);
        const same = each(key);
        const edge = {
          id: `${lane.key}:${c.afi}:${dir}`, lane: lane.key, names, type: first.p.proto, table: c.table ?? null, afi: c.afi, dir, count,
          countText: policy.blocked ? '' : (l.group && dir === 'out' && same.length === 1 && l.members.length > 1 ? `${same[0]} each` : routes(count)),
          blocked: policy.blocked, strokeWidth: Math.min(7, 1.6 + Math.log2(1 + count)),
          tag: { text: policy.text + (policy.source === 'default' ? ' · default' : ''), kind: policy.kind, filter: policy.filter, source: policy.source,
            title: explain(dir, policy, { ...lane, group: l.group, sessions: l.members.length }, c.table ?? 'its table', external, first.p.proto, first.p.proto === 'BGP' ? null : nextHopRoutes(data, names, c.table)) },
        };
        lane.edges.push(edge);
        edges.push(edge);
      }
      lane.channels.push({ afi: c.afi, table: c.table ?? null });
    });
    lanes.push(lane);
  }

  // Vertical layout of the lanes: each is as tall as its edges need.
  const F = FLOW;
  let y = F.pad;
  for (const lane of lanes) {
    lane.h = Math.max(F.laneMin, lane.edges.length * F.edgeGap + 10);
    lane.y = y;
    lane.x = F.laneX;
    lane.w = F.laneW;
    y += lane.h + F.laneGap;
  }
  const lanesBottom = y - F.laneGap;

  // The tables that edges end at, in order of first appearance, with the edges that really arrive there (a blocked edge stops short).
  const tableNames = [...new Set(edges.map(e => e.table).filter(Boolean))];
  const tables = tableNames.map(name => ({ name, x: F.width - F.tableW, w: F.tableW, flowing: edges.filter(e => e.table === name && !e.blocked) }));
  for (const t of tables) {
    t.h = Math.max(F.tableMin, t.flowing.length * F.edgeGap + 16);
    t.routes = data.local && data.paths ? data.paths.filter(r => r.table === t.name).length + data.local.filter(r => r.table === t.name).length : null;
  }
  const tablesH = tables.reduce((n, t) => n + t.h, 0) + Math.max(0, tables.length - 1) * F.tableGap;
  const lanesH = lanesBottom - F.pad;
  const bodyH = Math.max(lanesH, tablesH);
  // Both blocks are centered on the taller one.
  const laneShift = (bodyH - lanesH) / 2, tableShift = (bodyH - tablesH) / 2;
  for (const lane of lanes) lane.y += laneShift;
  let ty = F.pad + tableShift;
  for (const t of tables) { t.y = ty; ty += t.h + F.tableGap; }

  // The ends of every edge: along the lane's side and along the table's, one slot each.
  for (const lane of lanes) {
    const n = lane.edges.length;
    lane.edges.forEach((e, k) => { e.laneY = lane.y + lane.h / 2 + (k - (n - 1) / 2) * F.edgeGap; });
  }
  for (const t of tables) t.flowing.forEach((e, j) => { e.tableY = t.y + (j + 0.5) * (t.h / t.flowing.length); });
  const x1 = F.laneX + F.laneW, x2 = F.width - F.tableW;
  for (const e of edges) {
    // The tag says which way the edge goes, as the legend does: → into the table (import), ← out of it (export).
    e.tag.text = `${e.dir === 'in' ? '→' : '←'} ${e.tag.text}`;
    e.tag.w = textWidth(e.tag.text) + 14;
    if (e.blocked) {
      // Nothing passes: a short dashed stub next to the protocol that ends in a stop mark, so a blocked edge does not cross the drawing.
      const end = x1 + 12 + e.tag.w + 14;
      e.path = `M${x1} ${e.laneY}H${end}`;
      e.stop = { x: end, y: e.laneY };
      e.tag.x = x1 + 12 + e.tag.w / 2;
      e.tag.y = e.laneY;
    } else {
      // A flowing edge is a spline from the lane to where its tag begins, then a straight run through the tag to the table: the tag sits
      // against the table, right-aligned, where the edges are one slot apart and cannot touch, and away from the stubs by the lanes. An
      // export edge is the same run read from the table to the lane.
      const right = x2 - 22;
      const xc = right - e.tag.w - 12;
      const xm = (x1 + xc) / 2;
      // The head grows with the line, and the line stops at its base, so a thick line does not stick out around the tip.
      const len = +(8 + e.strokeWidth * 0.8).toFixed(1), half = +(e.strokeWidth / 2 + 3.5).toFixed(1);
      e.head = e.dir === 'in' ? { x: x2, y: e.tableY, dir: 1, len, half } : { x: x1, y: e.laneY, dir: -1, len, half };
      e.path = e.dir === 'in'
        ? `M${x1} ${e.laneY}C${xm} ${e.laneY} ${xm} ${e.tableY} ${xc} ${e.tableY}H${x2 - len}`
        : `M${x2} ${e.tableY}H${xc}C${xm} ${e.tableY} ${xm} ${e.laneY} ${x1 + len} ${e.laneY}`;
      e.stop = null;
      e.tag.x = right - e.tag.w / 2;
      e.tag.y = e.tableY;
    }
  }

  // What lies outside: one node per neighbor kind, as tall as the lanes that talk to it, with a short link to each lane.
  const outside = [];
  for (const lane of lanes) {
    if (!lane.outside) continue;
    let node = outside.find(o => o.key === lane.outside.key);
    if (!node) { node = { key: lane.outside.key, title: lane.outside.title, sub: lane.outside.sub, both: lane.outside.both, lanes: [], x: 0, w: F.outsideW }; outside.push(node); }
    node.lanes.push(lane);
  }
  const links = [];
  for (const o of outside) {
    const top = Math.min(...o.lanes.map(l => l.y)), bottom = Math.max(...o.lanes.map(l => l.y + l.h));
    o.y = top;
    o.h = bottom - top;
    if (o.key.startsWith('as:')) {
      const neighbors = o.lanes.reduce((n, l) => n + (l.group ? l.sessions : 1), 0);
      o.sub = `${neighbors} BGP neighbor${neighbors === 1 ? '' : 's'}`;
    }
    for (const l of o.lanes) links.push({ outside: o.key, lane: l.key, both: o.both, path: `M${F.outsideW} ${l.y + l.h / 2}H${F.laneX}`, y: l.y + l.h / 2 });
  }

  const height = F.pad * 2 + bodyH;
  return { width: F.width, height, lanes, tables, outside, links, edges };
}

// The routes behind one edge of the diagram, for the list that opens when its count is clicked. Returns
//   { kind, title, subtitle, rows, capped }
// where kind says what the rows are: 'paths' (BGP paths learned from the lane's sessions), 'local' (routes a protocol such as Direct
// or Static put into the table) or 'exported' (what the table hands to a protocol or a BGP peer); `rows` are the entries of
// data.paths, data.local or the exported lists, limited to LIST_MAX with `capped` set when there were more.
export const LIST_MAX = 500;
export function edgeRoutes(data, edge) {
  const names = new Set(edge.names);
  const who = edge.names.length > 1 ? `${edge.names.length} sessions (${edge.names.join(', ')})` : edge.names[0];
  const sameTable = r => r.table == null || edge.table == null || r.table === edge.table;
  let kind, rows;
  if (edge.dir === 'in') {
    if (edge.type === 'BGP') { kind = 'paths'; rows = data.paths.filter(r => names.has(r.peer) && sameTable(r)); }
    else { kind = 'local'; rows = (data.local ?? []).filter(r => names.has(r.protocol) && sameTable(r)); }
  } else {
    kind = 'exported';
    rows = [];
    for (const name of edge.names) {
      const entries = edge.type === 'BGP' ? data.peers.find(p => p.name === name)?.exported : data.protocols.find(p => p.name === name)?.exported;
      for (const r of entries ?? []) if (sameTable(r)) rows.push({ ...r, to: name });
    }
  }
  const subtitle = `${edge.dir === 'in' ? 'into' : 'out of'} ${edge.table ?? 'its table'} · ${edge.tag.text.slice(2)}`;
  return {
    kind, rows: rows.slice(0, LIST_MAX), capped: rows.length > LIST_MAX, total: rows.length,
    title: edge.dir === 'in' ? `Routes imported from ${who}` : `Routes exported to ${who}`, subtitle,
  };
}
