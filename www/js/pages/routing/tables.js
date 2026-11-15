// The kernel-routing cards of the Routing page: the routing tables overview, the policy rules, and the route list
// (every route of the selected table, with its next hops, interface, protocol and metric).
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, mono, muted } from '../../core/ui.js';
import { fmtSpan } from '../../core/format.js';
import { deviceText } from './lookup.js';
import { DROPS, destination, filterRoutes, routeKey, ruleOrigin, sortRoutes, tableLabel, tablesOf } from './model.js';

// A small neutral tag (the `chip` style the BGP tables use for communities).
const tag = (text, title = '') => h('span', { className: 'chip', title }, text);

// Rows of the route list shown before "Show all": a router with a large routing table would otherwise draw thousands.
const ROW_LIMIT = 400;

// Badge kind per route type (a plain unicast route needs no badge).
const TYPE_KIND = { local: 'info', broadcast: 'info', multicast: 'info', anycast: 'info', blackhole: 'danger', unreachable: 'danger', prohibit: 'danger', throw: 'warning' };

//#region How the kernel decides

// The short explanation above the rules and tables: the order the kernel works in, and the cases that do not simply
// fall through to the next rule. Priority and table number are different things, which is easy to mix up because the
// well-known ones (0 and 255 for the local table, 32766 and 254 for main) are close.
export function howCard() {
  // One numbered step of the explanation.
  const item = (...kids) => h('li', {}, ...kids);
  return card([icon('info-circle'), 'How the kernel picks a route'],
    h('div', { className: 'card-body rt-how' },
      h('ol', {},
        item(h('strong', {}, 'Rules first. '), 'The policy rules are checked from the lowest priority number to the highest. The first rule whose conditions match names a routing table to consult. A priority is only an order; it is not a table number (rule 0 looks up table 255, ', mono('local'), ').'),
        item(h('strong', {}, 'Then the longest prefix. '), 'Within that table the most specific matching destination wins; equally specific alternatives use the lower metric. Static routes are not a separate stage before or after BGP, DHCP or connected routes: all installed routes compete in the same lookup. A daemon such as BIRD first chooses its own best paths before exporting them to the kernel.'),
        item(h('strong', {}, 'No route in that table? '), 'The kernel goes on to the next rule. If no rule produces a route, the destination is unreachable.'),
        item(h('strong', {}, 'Exceptions. '), 'A matching blackhole, unreachable or prohibit route, or a rule with such an action, ends the lookup at once. A throw route means "not in this table, keep going". ', mono('suppress_prefixlength'), ' counts a too-short match, such as a default route, as a miss.'))));
}

//#endregion

//#region Routing tables

// The routing tables as a list: how many routes each holds and which rules consult it. A click selects the table
// in the route list below (the selector in the command bar changes with it).
export function tablesCard(data, state, rerender) {
  const rows = tablesOf(data).map(t => {
    const active = state.table === t.name;
    return h('tr', {
      className: `rt-pick ${active ? 'active' : ''}`, tabIndex: 0, title: 'Show the routes of this table',
      onclick: () => { state.table = t.name; rerender(); },
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.table = t.name; rerender(); } },
    },
    h('td', {}, h('strong', {}, t.name), t.id != null && String(t.id) !== t.name ? h('span', { className: 'muted' }, ` (${t.id})`) : null),
    h('td', { className: 'muted' }, t.role || '–'),
    h('td', {}, t.rules.length ? t.rules.map(p => tag(`rule ${p}`, 'A policy rule that consults this table')) : muted('none')),
    h('td', { className: 'num' }, String(t.v4)),
    h('td', { className: 'num' }, String(t.v6)));
  });
  return card([icon('list-ul'), 'Routing tables', h('span', { className: 'sub' }, `${rows.length} table${rows.length === 1 ? '' : 's'} · installed + configured entries · click to list`)],
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover rt-tables' },
      h('thead', {}, h('tr', {}, ['Table', 'Used for', 'Consulted by', 'IPv4', 'IPv6'].map((c, i) => h('th', { className: i > 2 ? 'num' : '' }, c)))),
      h('tbody', {}, rows))));
}

//#endregion

//#region Policy rules

// One rule's matching conditions as chips ("from 192.168.1.0/24", "iif br-lan"); a rule matching every packet says so.
function conditions(rule) {
  const sel = rule.selectors.filter(([k, v]) => !(k === 'from' && v === 'all') && !(k === 'to' && v === 'all'));
  if (!sel.length) return muted('every packet');
  return h('span', { className: 'chips' }, sel.map(([k, v]) => tag(`${k} ${v}`)));
}

// What a rule does: consult a table, jump to another rule, or drop the packet.
function action(rule, ids) {
  if (rule.action === 'lookup') {
    return h('span', {}, 'look up ', mono(tableLabel(rule.table, ids)),
      rule.suppress_prefixlength != null ? ' ' : null,
      rule.suppress_prefixlength != null ? tag(`ignore prefixes /${rule.suppress_prefixlength} or shorter`, 'Routes with a prefix this short or shorter are ignored') : null);
  }
  if (rule.action === 'goto') return h('span', {}, 'continue at rule ', mono(String(rule.goto)));
  return badge(rule.action, rule.action === 'l3mdev' ? 'info' : 'danger', 'Matching packets are not routed');
}

// The policy rules in the order the kernel applies them (lowest priority number first; IPv4 and IPv6 each have
// their own list). The last column says who added each rule, as far as that can be told (see ruleOrigin).
export function rulesCard(data) {
  const rules = [...data.rules].sort((a, b) => a.priority - b.priority || a.family - b.family);
  // The "Added by" cell: muted text for the kernel's own rules, otherwise a badge with the inferred author.
  const origin = rule => {
    const o = ruleOrigin(rule, data);
    return o.kind === 'kernel' ? h('span', { className: 'muted', title: o.title }, 'kernel default') : badge(o.label, o.kind === 'unknown' ? 'warning' : 'info', o.title);
  };
  const rows = rules.map(r => h('tr', {},
    h('td', { className: 'num mono' }, String(r.priority)),
    h('td', {}, badge(`IPv${r.family}`, 'info')),
    h('td', {}, conditions(r)),
    h('td', {}, action(r, data.table_ids)),
    h('td', {}, origin(r))));
  return card([icon('signpost-split'), 'Policy rules', h('span', { className: 'sub' }, 'Checked in this order; the first rule that matches decides which table is consulted')],
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover rt-rules' },
      h('thead', {}, h('tr', {}, ['Priority', 'Family', 'Matches', 'Then', 'Added by'].map((c, i) => h('th', { className: i === 0 ? 'num' : '' }, c)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 5, className: 'muted' }, 'No policy rules'))))));
}

//#endregion

//#region Route list

// Columns of the route list: `sort` names the sort key (none: the column cannot be sorted) and `w` is the relative width.
const COLS = [
  { key: 'prefix', label: 'Destination', sort: 'prefix', w: 14 },
  { key: 'type', label: 'Type', sort: 'type', w: 7 },
  { key: 'next_hop', label: 'Next hop', sort: 'next_hop', w: 14 },
  { key: 'dev', label: 'Interface', sort: 'dev', w: 12 },
  { key: 'proto', label: 'Protocol', sort: 'proto', w: 8 },
  { key: 'metric', label: 'Metric', sort: 'metric', w: 8 },
  { key: 'src', label: 'Source address', w: 12 },
  { key: 'table', label: 'Table', sort: 'table', w: 7 },
  { key: 'details', label: 'Details', w: 18 },
];

// A flag of a next hop that means trouble is red, the rest are neutral.
const flagChip = flag => h('span', { className: `chip ${flag === 'dead' || flag === 'linkdown' ? 'bad' : ''}`, title: flag === 'linkdown' ? 'The link of this next hop is down' : flag === 'dead' ? 'The kernel considers this next hop dead' : '' }, flag);

// The cells of one route.
function cell(col, r, data, names) {
  switch (col.key) {
    case 'prefix':
      return h('span', {}, h('span', { className: `mono ${r.len === 0 ? 'fw-semibold' : ''}` }, destination(r)),
        r.from ? h('div', { className: 'muted small' }, `from ${r.from}`) : null);
    case 'type': return r.type === 'unicast' ? muted('unicast') : badge(r.type, TYPE_KIND[r.type] ?? '');
    case 'next_hop':
      if (DROPS.includes(r.type)) return muted('dropped');
      if (r.type === 'local') return muted('this router');
      if (['broadcast', 'multicast', 'anycast'].includes(r.type)) return muted('–');
      return r.nexthops.length
        ? h('div', { className: 'rt-hops' }, r.nexthops.map(n => h('div', {}, n.via ? mono(n.via) : muted('directly connected'),
          r.nexthops.length > 1 && n.weight != null ? muted(` ×${n.weight}`) : null)))
        : muted('–');
    case 'dev': return r.nexthops.length ? h('div', { className: 'rt-hops' }, r.nexthops.map(n => h('div', {}, deviceText(n.dev, names)))) : muted('–');
    case 'proto': return r.proto ?? muted('–');
    case 'metric': return r.metric ?? muted('–');
    case 'src': return r.src ? mono(r.src) : muted('–');
    case 'table': return tableLabel(r.table, data.table_ids);
    default: {
      const bits = [
        r.scope && r.scope !== 'universe' ? tag(`scope ${r.scope}`) : null,
        r.expires != null ? tag(`expires in ${fmtSpan(r.expires)}`) : null,
        r.pref ? tag(`pref ${r.pref}`) : null,
        r.mtu != null ? tag(`mtu ${r.mtu}`) : null,
        ...(r.configured ? [tag('configured static', r.configured.join(', ')), badge(r.configState ?? 'installed', r.configState === 'disabled' ? '' : r.configState ? 'warning' : 'success')] : []),
        ...[...new Set(r.nexthops.flatMap(n => n.flags))].map(flagChip),
      ].filter(Boolean);
      return bits.length ? h('span', { className: 'chips' }, bits) : muted('–');
    }
  }
}

// The route list card: the routes that pass the page's filters (family, table, text), sorted by the clicked
// column. `hitKey` is the key of the route the next-hop lookup matched; that row is highlighted.
export function routesCard(data, state, rerender, names, hitKey) {
  const filtered = sortRoutes(filterRoutes(data.routes, { q: state.rq, family: state.family, table: state.table }, names), state.rsort);
  const shown = state.all ? filtered : filtered.slice(0, ROW_LIMIT);
  const total = COLS.reduce((n, c) => n + c.w, 0);

  const head = COLS.map(col => {
    if (!col.sort) return h('th', {}, col.label);
    const active = state.rsort.key === col.sort;
    return h('th', { className: 'sortable', title: 'Sort', onclick: () => { state.rsort = { key: col.sort, dir: active ? -state.rsort.dir : 1 }; rerender(); } },
      col.label, active ? (state.rsort.dir > 0 ? ' ▲' : ' ▼') : '');
  });
  const rows = shown.map(r => h('tr', { className: `${!r.configState && hitKey === routeKey(r) ? 'rt-hit' : ''} ${r.nexthops.some(n => n.flags.includes('dead') || n.flags.includes('linkdown')) ? 'rt-down' : ''}` },
    COLS.map(c => h('td', { className: c.key === 'details' ? 'wrap' : '' }, cell(c, r, data, names)))));

  const scope = state.table === 'all' ? 'all tables' : `table ${tableLabel(state.table, data.table_ids)}`;
  return card([icon('signpost-split'), 'Routes', h('span', { className: 'sub' }, `${filtered.length} of ${data.routes.length} routes · ${scope}`)],
    h('div', {},
      h('div', { className: 'set-legend muted small' }, 'Installed routes of every origin, plus configured static routes. Entries labeled disabled, not installed or state unknown are configuration only, not active forwarding entries. The table and family filters also apply to static routes.'),
      h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover fixed-grid rt-routes', style: 'min-width:1100px' },
        h('colgroup', {}, COLS.map(c => h('col', { style: `width:${(c.w / total * 100).toFixed(2)}%` }))),
        h('thead', {}, h('tr', {}, head)),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: COLS.length, className: 'muted' }, 'No routes match the filter'))))),
      filtered.length > shown.length ? h('div', { className: 'rt-more' },
        h('span', { className: 'muted' }, `Showing the first ${shown.length} of ${filtered.length} routes.`),
        h('button', { type: 'button', className: 'btn btn-sm btn-fl', onclick: () => { state.all = true; rerender(); } }, `Show all ${filtered.length}`)) : null));
}

//#endregion
