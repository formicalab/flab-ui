// Dialplan tab, Routing map view: endpoints on the left enter contexts in the middle, which dial endpoints on the right. Drawn as one SVG
// with fixed geometry (no measuring), so it scales with the page. A click on a context highlights its wiring.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, card, healthBanner, kv, mono } from '../../core/ui.js';
import { openEndpointDrawer } from './pjsip.js';
import { endpointKind } from './pjsipmodel.js';
import { rerender, state } from './state.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return n;
};
const clip = (text, n) => text.length > n ? `${text.slice(0, n - 1)}…` : text;

// Geometry: three columns of nodes of fixed width and height, a gap between rows.
const W = 980, COL = { entry: [0, 250], ctx: [365, 250], target: [730, 250] }, H = { entry: 46, ctx: 66, target: 46 }, GAP = 16;

// Places the nodes of one column from the top, then centers the column against the tallest one.
function layout(nodes, kind) {
  let y = 0;
  const placed = nodes.map(n => { const p = { ...n, x: COL[kind][0], w: COL[kind][1], y, h: H[kind] }; y += H[kind] + GAP; return p; });
  return { placed, height: Math.max(0, y - GAP) };
}

// The routing map of `map` (dialplanmodel.buildMap) with the live endpoint data `endpoints` (Map name -> endpoint) for the side panel.
export function mapView(dp, map, endpoints) {
  if (!map.contexts.length) return card(null, h('div', { className: 'card-body muted' }, 'The dialplan has no context to draw.'));
  // Order: contexts that endpoints enter first, then the ones only reached from other contexts, then the unused ones.
  const rank = c => c.entries.length ? 0 : c.reached ? 1 : 2;
  const contexts = [...map.contexts].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const order = new Map(contexts.map((c, i) => [`ctx:${c.name}`, i]));
  const entries = [...map.entries].sort((a, b) => (order.get(`ctx:${a.context}`) ?? 99) - (order.get(`ctx:${b.context}`) ?? 99) || a.name.localeCompare(b.name));
  const firstUse = t => Math.min(99, ...map.edges.filter(e => e.to === t.id).map(e => order.get(e.from) ?? 99));
  const targets = [...map.targets].sort((a, b) => firstUse(a) - firstUse(b) || a.name.localeCompare(b.name));

  const L = { entry: layout(entries.map(e => ({ ...e, id: `ep:${e.name}` })), 'entry'), ctx: layout(contexts.map(c => ({ ...c, id: `ctx:${c.name}` })), 'ctx'), target: layout(targets, 'target') };
  const total = Math.max(L.entry.height, L.ctx.height, L.target.height);
  for (const col of Object.values(L)) { const off = (total - col.height) / 2; for (const n of col.placed) n.y += off; }
  const at = new Map([...L.entry.placed, ...L.ctx.placed, ...L.target.placed].map(n => [n.id, n]));

  const sel = state.mapSel && at.has(`ctx:${state.mapSel}`) ? `ctx:${state.mapSel}` : null;
  const touches = id => !sel || id === sel || map.edges.some(e => (e.from === sel && e.to === id) || (e.to === sel && e.from === id));

  const svg = el('svg', { viewBox: `0 0 ${W} ${total + 8}`, class: 'ast-svg', role: 'img', 'aria-label': 'Routing map: endpoints, contexts and the endpoints they dial' });
  // Column titles are HTML above the SVG; edges go first so nodes sit on top.
  for (const e of map.edges) {
    const a = at.get(e.from), b = at.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2;
    const unknown = e.kind === 'dial' && b.known === false;
    const dim = sel && e.from !== sel && e.to !== sel;
    const path = el('path', { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, class: `ast-edge ${e.kind} ${unknown ? 'bad' : ''} ${dim ? 'dim' : ''}`, style: e.kind === 'dial' ? `stroke-width:${1.5 + Math.min(e.count, 6) * 0.4}` : '' });
    path.append(el('title', {}, e.kind === 'dial' ? `${e.from.slice(4)} dials ${b.name} from: ${e.patterns.join(', ')}` : `${a.name} enters ${e.to.slice(4)}`));
    svg.append(path);
  }
  const node = (n, kind) => {
    const dim = !touches(n.id);
    const g = el('g', { class: `ast-n ${kind} ${n.id === sel ? 'sel' : ''} ${dim ? 'dim' : ''} ${kind === 'ctx' && !n.reached && map.entries.length ? 'unused' : ''} ${n.known === false ? 'bad' : ''}`, transform: `translate(${n.x},${n.y})`, tabindex: 0 });
    g.append(el('rect', { width: n.w, height: n.h, rx: 10 }));
    if (kind === 'ctx') {
      g.append(el('text', { x: 14, y: 24, class: 'nm' }, clip(n.name, 30)), el('text', { x: 14, y: 42, class: 'sub' }, `${n.extensions} extension${n.extensions === 1 ? '' : 's'}${n.includes.length ? ` · includes ${clip(n.includes.join(', '), 22)}` : ''}`),
        el('text', { x: 14, y: 58, class: 'sub' }, n.jumps.length ? `jumps to ${clip(n.jumps.join(', '), 28)}` : (n.dials ? `${n.dials} dial step${n.dials === 1 ? '' : 's'}` : '')));
      g.addEventListener('click', () => { state.mapSel = state.mapSel === n.name ? null : n.name; rerender(); });
    } else {
      const ep = endpoints.get(n.name);
      const kind2 = ep ? endpointKind(ep) : (n.state ? endpointKind({ state: n.state, role: n.role }) : '');
      g.append(el('circle', { cx: 16, cy: n.h / 2, r: 5, class: `ast-dot-svg ${kind2 || 'neutral'}` }),
        el('text', { x: 30, y: 20, class: 'nm' }, clip(n.name, 28)),
        el('text', { x: 30, y: 36, class: 'sub' }, kind === 'entry' ? (n.context ? `${n.role} · context ${clip(n.context, 16)}` : 'context unknown') : (n.known === false ? 'no such endpoint' : (n.state ?? (n.kind === 'dynamic' ? 'resolved when the call is placed' : ' ')))));
      if (ep) g.addEventListener('click', () => openEndpointDrawer(ep));
    }
    g.append(el('title', {}, kind === 'ctx' ? `Context ${n.name}` : n.name));
    return g;
  };
  for (const n of L.entry.placed) svg.append(node(n, 'entry'));
  for (const n of L.ctx.placed) svg.append(node(n, 'ctx'));
  for (const n of L.target.placed) svg.append(node(n, 'target'));

  const selected = sel ? map.contexts.find(c => `ctx:${c.name}` === sel) : null;
  const detail = selected ? h('div', { className: 'card-body ast-map-detail' },
    kv([
      ['Context', mono(selected.name)],
      ['Entered by', selected.entries.length ? selected.entries.map(n => mono(n)).flatMap((n, i) => i ? [', ', n] : [n]) : 'no endpoint'],
      ['Calls', map.edges.filter(e => e.from === sel && e.kind === 'dial').map(e => `${at.get(e.to)?.name} (${e.patterns.slice(0, 4).join(', ')}${e.patterns.length > 4 ? ', …' : ''})`).join(' · ') || 'nothing'],
      ['Includes / jumps to', [...selected.includes, ...selected.jumps].join(', ') || 'nothing'],
    ]),
    button('Open in the Dialplan browser', 'diagram-3', () => { state.ctx = selected.name; state.ext = null; state.hl = null; state.dpView = 'browse'; rerender(); }, 'btn-outline-primary btn-sm mt-2')) : null;

  const legend = h('div', { className: 'ast-legend muted small' }, 'Click a context to highlight its wiring. ',
    h('span', { className: 'ast-dot success' }), ' available ', h('span', { className: 'ast-dot warning' }), ' phone offline ', h('span', { className: 'ast-dot danger' }), ' trunk down ',
    badge('dashed red', 'danger'), ' dials an endpoint that does not exist. Line width grows with the number of dial steps.');
  return [
    healthBanner(map.findings, 'The dialplan and the endpoints fit together.'),
    card([icon('signpost-split'), 'Routing map'], h('div', {},
      h('div', { className: 'ast-map-cols' }, h('span', {}, 'Endpoints (where calls enter)'), h('span', {}, 'Contexts'), h('span', {}, 'Dialed endpoints')),
      h('div', { className: 'ast-map-wrap' }, svg), legend, detail)),
  ];
}
