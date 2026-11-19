// "Learned routes" table: every BGP path in the table, grouped by prefix, with best/ECMP/backup status.

import { h } from '../../../core/dom.js';
import { icon } from '../../../core/icons.js';
import { badge, button, card, muted } from '../../../core/ui.js';
import { fmtNum } from '../../../core/format.js';
import { peerDot, peerClass, asPath, communityText, prefixKey, firstAddress } from './util.js';

// Paths drawn before "Show all": a router that learns a large table would otherwise draw tens of thousands of rows.
const ROW_LIMIT = 400;

// Best + installed -> Best (and ECMP when several next hops are installed); installed only -> ECMP; else Backup.
function status(r) {
  if (r.best && !r.in_kernel) return badge('Best · not in kernel', 'danger', 'BIRD selected this path but the kernel has no matching next hop');
  if (r.best) return badge(r.kernel_paths > 1 ? `Best · ECMP ×${r.kernel_paths}` : 'Best', 'success', r.kernel_paths > 1 ? 'Traffic is load-shared over all installed next hops' : 'Installed in the kernel');
  if (r.in_kernel) return badge('ECMP', 'info', 'Not the selected path, but installed as an equal-cost next hop');
  return badge('Backup', '', 'Valid path, used only if the better paths disappear');
}

// Routes table columns: `w` is the relative column width, `sort` returns the sort key of a path, and
// `optional` hides the column when no path has data for it (MED, communities).
const COLS = [
  { key: 'prefix', label: 'Prefix', w: 10, sort: r => prefixKey(r.prefix) },
  { key: 'status', label: 'Status', w: 12, sort: r => (r.best ? 0 : r.in_kernel ? 1 : 2) },
  { key: 'peer', label: 'Peer', w: 11, sort: r => r.peer },
  // Next hops sort numerically by reusing the prefix key on the first address (as a /0).
  { key: 'next_hop', label: 'Next hop', w: 9, sort: r => prefixKey(`${firstAddress(r.next_hop) || '0.0.0.0'}/0`) },
  { key: 'dev', label: 'Interface', w: 6, sort: r => r.dev ?? '' },
  { key: 'as_path', label: 'AS path', w: 15, sort: r => r.as_path.length },
  { key: 'origin', label: 'Origin', w: 5, sort: r => r.origin ?? '' },
  { key: 'local_pref', label: 'Local pref', w: 6, sort: r => r.local_pref ?? -1 },
  { key: 'med', label: 'MED', w: 5, sort: r => r.med ?? -1, optional: paths => paths.some(r => r.med != null) },
  { key: 'communities', label: 'Communities', w: 13, sort: r => r.communities.length + r.large_communities.length + r.ext_communities.length,
    optional: paths => paths.some(r => r.communities.length || r.large_communities.length || r.ext_communities.length) },
  { key: 'since', label: 'Since', w: 8, sort: r => r.since ?? '' },
];

// Cell content for column `col` of path `r`; `first` is true for the first row of a prefix, where the
// prefix is shown in bold and repeated rows of the same prefix are dimmed.
function cell(col, r, data, first) {
  switch (col.key) {
    case 'prefix': return h('span', { className: `mono ${first ? 'fw-semibold' : 'muted'}` }, r.prefix);
    case 'status': return status(r);
    case 'peer': return h('span', { className: 'peer-label', title: r.peer }, peerDot(data, r.peer), r.peer);
    case 'next_hop': return h('span', { className: 'mono' }, r.next_hop ?? '–');
    case 'dev': return h('span', { className: 'mono' }, r.dev ?? '–');
    case 'as_path': return asPath(r.as_path);
    case 'origin': return r.origin ?? '–';
    case 'local_pref': return r.local_pref ?? '–';
    case 'med': return r.med ?? '–';
    case 'communities': {
      // Standard communities plain, large ones prefixed "L", extended ones "E".
      const all = [...r.communities.map(communityText), ...r.large_communities.map(c => 'L ' + communityText(c)), ...r.ext_communities.map(c => 'E ' + communityText(c))];
      return all.length ? h('span', { className: 'chips' }, all.map(c => h('span', { className: 'chip', title: 'BGP community' }, c))) : muted('–');
    }
    default: return r.since ?? '–';
  }
}

// Applies the peer selector, best-only toggle and the free-text filter; every whitespace-separated term
// must appear (case-insensitive) in the prefix, peer, next hop, interface, AS path, communities or origin.
function filterPaths(paths, state) {
  const q = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  return paths.filter(r => {
    if (state.peer !== 'all' && r.peer !== state.peer) return false;
    if (state.best && !r.best) return false;
    if (!q.length) return true;
    const hay = [r.prefix, r.peer, r.next_hop, r.dev, r.as_path.join(' '), ...r.communities, r.origin].join(' ').toLowerCase();
    return q.every(t => hay.includes(t));
  });
}

// The paths sorted by the selected column (state.sort.dir is 1 or -1) into a new array; an unknown key falls back to
// the first column. Sort keys and prefix keys are computed once per path, not on every comparison.
function sortPaths(paths, state, cols) {
  const col = cols.find(c => c.key === state.sort.key) ?? cols[0];
  return paths.map(r => ({ r, x: col.sort(r), p: prefixKey(r.prefix) }))
    .sort((a, b) => {
      const primary = (a.x < b.x ? -1 : a.x > b.x ? 1 : 0) * state.sort.dir;
      // Ties keep each prefix together with its best path first.
      return primary || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0) || (b.r.best - a.r.best) || a.r.peer.localeCompare(b.r.peer);
    })
    .map(e => e.r);
}

// The sorted list of the last draw: changing the filter redraws from the same data, and sorting a large table again for each
// keystroke would be wasted work. Filtering a sorted list gives the same order as sorting the filtered list.
let sortMemo = { paths: null, key: '', dir: 0, cols: '', list: [] };

// `paths` sorted by the selected column, from the memo when the same list, column set and order were drawn last.
function sorted(paths, state, cols) {
  const colKeys = cols.map(c => c.key).join();
  if (sortMemo.paths !== paths || sortMemo.key !== state.sort.key || sortMemo.dir !== state.sort.dir || sortMemo.cols !== colKeys) {
    sortMemo = { paths, key: state.sort.key, dir: state.sort.dir, cols: colKeys, list: sortPaths(paths, state, cols) };
  }
  return sortMemo.list;
}

// The learned-routes card. Clicking a header sets the sort in the page's `state` (clicking the active
// column reverses it) and calls `rerender` to redraw from the cached data.
export function routesCard(data, state, rerender) {
  const cols = COLS.filter(c => !c.optional || c.optional(data.paths));
  const totalWeight = cols.reduce((n, c) => n + c.w, 0);
  const filtered = filterPaths(sorted(data.paths, state, cols), state);
  const shown = state.bgpAll ? filtered : filtered.slice(0, ROW_LIMIT);
  const prefixes = new Set(filtered.map(r => r.prefix)).size;

  // Clickable column headers; the active sort column shows an arrow for its direction.
  const head = cols.map(col => {
    const active = state.sort.key === col.key;
    return h('th', { className: 'sortable', title: 'Sort', onclick: () => { state.sort = { key: col.key, dir: active ? -state.sort.dir : 1 }; rerender(); } },
      col.label, active ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : '');
  });

  // A row starts a new group when its prefix differs from the previous row's; sorting by prefix (or ties
  // in another column) keeps a prefix's paths together.
  let previous = null;
  // One row per path, styled as the start of a prefix group or as a further path of the same prefix.
  const rows = shown.map(r => {
    const first = r.prefix !== previous;
    previous = r.prefix;
    return h('tr', { className: `${first ? 'group-start' : 'group-more'} ${r.best ? 'is-best' : ''} ${peerClass(data, r.peer)}` },
      cols.map(c => h('td', { className: c.key === 'communities' ? 'wrap' : '' }, cell(c, r, data, first))));
  });

  return card([icon('signpost-split'), 'Learned routes',
    h('span', { className: 'sub' }, `${filtered.length} of ${data.paths.length} paths · ${prefixes} prefixes`)],
  h('div', {},
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover fixed-grid routes-table', style: 'min-width:1200px' },
      h('colgroup', {}, cols.map(c => h('col', { style: `width:${(c.w / totalWeight * 100).toFixed(2)}%` }))),
      h('thead', {}, h('tr', {}, head)),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'No routes match the filter'))))),
    filtered.length > shown.length ? h('div', { className: 'rt-more' },
      h('span', { className: 'muted' }, `Showing the first ${fmtNum(shown.length)} of ${fmtNum(filtered.length)} paths.`),
      button(`Show all ${fmtNum(filtered.length)}`, null, () => { state.bgpAll = true; rerender(); })) : null));
}
