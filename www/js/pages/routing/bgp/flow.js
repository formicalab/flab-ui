// Draws the flow diagram of the BIRD protocols card from the geometry of flowmodel.js: the protocols in lanes, the routing tables on the
// right, what lies outside BIRD on the left, and a spline in each direction per channel, tagged with its filter (or with the default
// action, when the configuration file says nothing). Plain SVG, so it scales with the card; the reasoning is all in the model.

import { h } from '../../../core/dom.js';
import { icon } from '../../../core/icons.js';
import { badge, muted, mono } from '../../../core/ui.js';
import { openDrawer } from '../../../core/drawer.js';
import { buildFlow, edgeRoutes, FLOW } from './flowmodel.js';
import { configOf, findBlock } from './configmodel.js';
import { showFilterSource } from './config.js';
import { localRoutesTable } from './announced.js';
import { openRouteDetail } from './routedetail.js';
import { asPath, peerDot } from './util.js';

const NS = 'http://www.w3.org/2000/svg';

// An SVG element: `attrs` are attributes (a key that starts with "on" is an event listener; null and false are left out); the
// children are nodes or text.
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

// A text cut to `n` characters with an ellipsis.
const clip = (text, n) => text.length > n ? `${text.slice(0, n - 1)}…` : text;

// Makes `el` act as a button: focusable, Enter and Space run `run`.
function pressable(el, run, label) {
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  if (label) el.setAttribute('aria-label', label);
  el.addEventListener('click', run);
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } });
  return el;
}

// Brings the row of a protocol in the table into view and flashes it, so the lane and the row are seen to be the same thing.
function showRow(name) {
  const row = document.getElementById(`bgp-row-${name}`);
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('bgp-row-flash');
  setTimeout(() => row.classList.remove('bgp-row-flash'), 1600);
}

// A prefix that opens the explanation of BIRD's choice for it (the drawer of the Learned routes table).
const prefixButton = (prefix, data) => h('button', { type: 'button', className: 'link-prefix mono fw-semibold', title: 'How BIRD chose the route for this prefix', onclick: () => openRouteDetail(prefix, data) }, prefix);

// The list of the routes behind one edge, in a drawer: BGP paths with their next hop and AS path, the routes of a protocol such as Direct
// or Static, or what the table hands out. A prefix in the list opens the explanation of BIRD's choice for it.
function openEdgeRoutes(data, edge) {
  const list = edgeRoutes(data, edge);
  const status = r => r.best ? badge('Best', 'success') : r.in_kernel ? badge('ECMP', 'info') : badge('Backup', '');
  let table;
  if (list.kind === 'paths') {
    table = h('table', { className: 'table table-sm bgp-edge-list' },
      h('thead', {}, h('tr', {}, ['Prefix', 'Peer', 'Next hop', 'AS path'].map(c => h('th', {}, c)))),
      h('tbody', {}, list.rows.map(r => h('tr', {},
        h('td', {}, prefixButton(r.prefix, data), ' ', status(r)),
        h('td', {}, h('span', { className: 'peer-label' }, peerDot(data, r.peer), r.peer)),
        h('td', {}, mono(r.next_hop ?? '–')),
        h('td', {}, asPath(r.as_path))))));
  } else if (list.kind === 'local') {
    table = localRoutesTable(list.rows);
  } else {
    const several = edge.names.length > 1;
    table = h('table', { className: 'table table-sm bgp-edge-list' },
      h('thead', {}, h('tr', {}, ['Prefix', several ? 'To' : null, 'From', 'Type'].filter(Boolean).map(c => h('th', {}, c)))),
      h('tbody', {}, list.rows.map(r => h('tr', {},
        h('td', {}, prefixButton(r.prefix, data)),
        several ? h('td', {}, r.to) : null,
        h('td', {}, r.protocol ? badge(r.protocol, '') : '–'),
        h('td', {}, r.kind ?? '–')))));
  }
  const body = h('div', {},
    list.rows.length ? h('div', { className: 'table-responsive' }, table) : muted(edge.dir === 'out' && edge.type !== 'BGP' && list.total === 0 && edge.count > 0
      ? 'BIRD hands out too many routes for the page to list them.' : 'No routes.'),
    list.capped ? h('p', { className: 'muted small mt-2' }, `Showing the first ${list.rows.length} of ${list.total} routes.`) : null);
  openDrawer({ title: list.title, subtitle: `${list.total} route${list.total === 1 ? '' : 's'} · ${list.subtitle}`, icon: icon('signpost-split'), body });
}

// The diagram, or null when BIRD runs no protocol. `state.flowOpen` is the set of groups of BGP sessions shown one by one; a click on a
// group lane opens it and a click on one of its sessions closes it again, so the diagram stays as small as the picture needs.
export function flowView(data, state, rerender) {
  const config = configOf(data.config);
  const flow = buildFlow(data, config, state.flowOpen);
  if (!flow.lanes.length) return null;
  const x1 = FLOW.laneX + FLOW.laneW;

  const marker = (id, cls) => s('marker', { id, class: cls, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, s('path', { d: 'M0 0L10 5L0 10z' }));
  const defs = s('defs', {}, marker('bgp-flow-link', 'flow-arrow link'));

  // Outside BIRD, on the left: the neighbor, the interfaces, the kernel; and a short link to each lane that talks to it.
  const outside = flow.outside.map(o => s('g', { class: 'flow-outside', 'data-key': o.key },
    s('title', {}, o.key === 'linux' ? 'BIRD\'s tables are not the kernel\'s forwarding table: the Kernel protocol copies the routes there' : o.title),
    s('rect', { x: 0, y: o.y, width: o.w, height: o.h, rx: 8 }),
    s('text', { x: 10, y: o.y + o.h / 2 - 2, class: 'flow-title' }, o.title),
    s('text', { x: 10, y: o.y + o.h / 2 + 12, class: 'flow-sub' }, o.sub)));
  const links = flow.links.map(l => {
    const lane = flow.lanes.find(x => x.key === l.lane);
    const quiet = lane.type === 'Device';
    return s('path', { class: `flow-link${quiet ? ' quiet' : ''}`, d: l.path, 'marker-end': quiet ? null : 'url(#bgp-flow-link)', 'marker-start': l.both ? 'url(#bgp-flow-link)' : null });
  });

  // The splines, with the count of routes at the protocol's end; a blocked one ends in a stop mark.
  const edgePaths = flow.edges.map(e => s('g', { class: `flow-edge ${e.dir}${e.blocked ? ' blocked' : ''}`, id: `bgp-flow-edge-${e.id.replace(/[^A-Za-z0-9_-]/g, '_')}` },
    s('path', { d: e.path, 'stroke-width': e.blocked ? 1.6 : e.strokeWidth.toFixed(1) }),
    e.head ? s('polygon', { class: 'flow-head', points: `${e.head.x},${e.head.y} ${e.head.x - e.head.dir * e.head.len},${e.head.y - e.head.half} ${e.head.x - e.head.dir * e.head.len},${e.head.y + e.head.half}` }) : null,
    e.stop ? s('g', { class: 'flow-stop' }, s('path', { d: `M${e.stop.x - 4} ${e.stop.y - 4}l8 8M${e.stop.x + 4} ${e.stop.y - 4}l-8 8` })) : null,
    e.countText ? pressable(s('text', { x: x1 + 14, y: e.laneY - 5 - e.strokeWidth / 2, class: 'flow-count link', 'data-edge': e.id }, s('title', {}, `List the ${e.count} route${e.count === 1 ? '' : 's'}`), e.countText), () => openEdgeRoutes(data, e), `${e.countText}: list them`) : null));

  const lanes = flow.lanes.map(lane => {
    const toggles = lane.group || lane.member;
    const run = toggles
      ? () => { if (state.flowOpen.has(lane.groupKey)) state.flowOpen.delete(lane.groupKey); else state.flowOpen.add(lane.groupKey); rerender(); }
      : () => showRow(lane.names[0]);
    const tip = lane.group ? `Show the ${lane.sessions} sessions one by one` : lane.member ? 'Group the sessions again' : `Show ${lane.names[0]} in the table below`;
    const g = s('g', { class: `flow-lane ${lane.status}`, 'data-lane': lane.key },
      s('title', {}, `${lane.names.join(', ')} · ${lane.sub}. ${tip}.`),
      s('rect', { x: lane.x, y: lane.y, width: lane.w, height: lane.h, rx: 8 }),
      s('circle', { cx: lane.x + 12, cy: lane.y + 14, r: 4, class: 'flow-dot' }),
      s('text', { x: lane.x + 23, y: lane.y + 17, class: 'flow-title' }, clip(lane.label, 22)),
      s('text', { x: lane.x + 12, y: lane.y + 32, class: 'flow-sub' }, clip(lane.sub, 32)),
      toggles ? s('text', { x: lane.x + lane.w - 14, y: lane.y + 18, class: 'flow-toggle' }, lane.group ? '▸' : '▾') : null);
    return pressable(g, run, `${lane.label}: ${tip}`);
  });

  const tables = flow.tables.map(t => s('g', { class: 'flow-table', 'data-table': t.name },
    s('title', {}, `${t.name}: BIRD's own routing table. BIRD does not forward packets with it; the Kernel protocol copies routes to the kernel.`),
    s('rect', { x: t.x, y: t.y, width: t.w, height: t.h, rx: 10 }),
    s('text', { x: t.x + t.w / 2,     y: t.y + t.h / 2 - 4, class: 'flow-table-name', 'text-anchor': 'middle' }, t.name),
        s('text', { x: t.x + t.w / 2, y: t.y + t.h / 2 + 11, class: 'flow-sub', 'text-anchor': 'middle' }, t.routes == null ? 'BIRD routing table' : `${t.routes} route${t.routes === 1 ? '' : 's'}`)));

  // The tags last, so a line never runs over a filter's name. A named filter that the file defines opens its source.
  const tags = flow.edges.map(e => {
    const block = e.tag.filter && config ? findBlock(config, 'filter', e.tag.filter) : null;
    const g = s('g', { class: `flow-tag ${e.tag.kind}${block ? ' link' : ''}`, 'data-edge': e.id },
      s('title', {}, `${e.tag.title}${block ? ' Click to see the filter in the configuration.' : ''}`),
      s('rect', { x: e.tag.x - e.tag.w / 2,       y: e.tag.y - 8, width: e.tag.w, height: 16, rx: 5 }),
            s('text', { x: e.tag.x, y: e.tag.y + 3.5, 'text-anchor': 'middle' }, e.tag.text));
    return block ? pressable(g, () => showFilterSource(state, rerender, e.tag.filter, block), `${e.tag.text}: show the filter in the configuration`) : g;
  });

  const svg = s('svg', {
    id: 'bgp-flow', class: 'bgp-flow', viewBox: `0 0 ${flow.width} ${flow.height}`, preserveAspectRatio: 'xMidYMin meet', role: 'group',
    'aria-label': `How routes flow between ${flow.lanes.length} protocol lanes and ${flow.tables.map(t => t.name).join(', ')}`,
  }, defs, outside, links, edgePaths, lanes, tables, tags);

  const legend = h('div', { className: 'bgp-flow-legend small' },
    h('span', {}, h('b', {}, '→'), ' import: the protocol puts routes into the table'),
    h('span', {}, h('b', {}, '←'), ' export: the table hands routes to the protocol'),
    h('span', {}, h('b', {}, '✕'), ' nothing passes'),
    h('span', {}, h('b', {}, 'default'), ' the file has no such line, so BIRD\'s default applies'),
    h('span', {}, 'line width = number of routes (click the number to list them)'),
    h('span', {}, h('b', {}, '▸'), ' click a group to show its sessions'));
  const caption = h('p', { className: 'bgp-flow-caption small muted', id: 'bgp-flow-caption' },
    'Each protocol is joined to a routing table by a channel with two filters: the import filter is applied to the routes the protocol passes to the table, ',
    'the export filter to the routes the table passes to the protocol. Without an import line BIRD imports all routes (except for external BGP), ',
    'without an export line it exports none (except for external BGP and L3VPN). BIRD\'s tables are not the kernel\'s forwarding table: ',
    'the Kernel protocol copies them there. Device (and BFD) have no channels; they are services for the other protocols.');
  return h('div', { className: 'bgp-flow-wrap' }, h('div', { className: 'bgp-flow-scroll' }, svg), legend, caption);
}
