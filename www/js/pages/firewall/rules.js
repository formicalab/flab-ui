// The rule tables: the traffic rules and the port forwards, each with the live hit counters nftables keeps
// for it. With editing on, a row has an enable switch, buttons to move it up or down (the order is the order the firewall evaluates), Edit and
// Remove (Undo after a removal), a button adds an item, and every row says in plain words what it does.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, muted } from '../../core/ui.js';
import { fmtBytes, fmtNum } from '../../core/format.js';
import { describeMatch, packetsPerSec, fmtPps, ruleKey } from './util.js';
import { addButton, enableSwitch, iconButton, pendingBadge } from './parts.js';

// Badge color per rule target: accepts are green, reject/drop amber, anything else (DNAT, MASQUERADE...) neutral.
const ACTION = { ACCEPT: 'success', REJECT: 'warning', DROP: 'warning' };
// Rule target as a colored badge, lowercased.
const actionBadge = t => badge(t.toLowerCase(), ACTION[t] ?? 'info');

// Zone name as a chip: "*" reads "any", and a missing side is the router itself (or `fallback`).
const zoneChip = (z, fallback) => h('span', { className: `fw-chip ${z ? '' : 'router'}` }, z === '*' ? 'any' : z ?? fallback);
// "src › dest" flow of a rule; the fallbacks label a missing zone on either side.
const fromTo = (a, b, fromFallback = 'router', toFallback = 'router') => h('div', { className: 'fw-flow' }, zoneChip(a, fromFallback), '›', zoneChip(b, toFallback));

// Packets and bytes seen, and a live rate while something is flowing.
function hitsCell(r) {
  if (r.pending || r.removed) return muted(r.removed ? '–' : 'not saved yet');
  if (!r.hits) return muted(r.enabled ? 'not loaded' : '–');
  const pps = fmtPps(packetsPerSec(ruleKey(r)));
  if (!r.hits.packets) return muted('no hits');
  return h('div', {}, h('div', {}, pps ? h('span', { className: 'dot up' }) : null, h('b', {}, fmtNum(r.hits.packets)), ' packets'),
    h('div', { className: 'muted small' }, fmtBytes(r.hits.bytes), pps ? ` · ${pps}` : ''));
}

// Rule name (or its key when unnamed) with "unnamed" and "time-restricted" notes, what it does in words, and whether it is unsaved.
const nameCell = r => h('div', {}, h('strong', {}, r.name ?? r.key), r.removed || r.pending ? [' ', pendingBadge(r)] : null,
  r.name ? null : h('div', { className: 'muted small' }, 'unnamed'),
  r.scheduled ? h('div', { className: 'muted small' }, 'time-restricted') : null,
  r.words ? h('div', { className: 'muted small fw-words-line' }, r.words) : null);

// The buttons of an editable row: the enable switch, up and down, Edit and Remove; or Undo for a removed row. `rows` are the rows of the
// table in order, to know where the row is.
function actionsCell(kind, r, rows, ctx) {
  if (r.readOnly) return h('td', { className: 'fw-actions' }, muted('edit in the file'));
  if (r.removed) return h('td', { className: 'fw-actions' }, iconButton('arrow-counterclockwise', 'Keep this one (undo the removal)', () => ctx.restore(kind, r.id)));
  const alive = rows.filter(x => !x.removed && !x.readOnly), at = alive.indexOf(r);
  return h('td', { className: 'fw-actions' },
    enableSwitch(r.enabled, r.enabled ? 'Enabled: click to disable' : 'Disabled: click to enable', on => ctx.setEnabled(kind, r.id, on), !ctx.canEdit),
    iconButton('arrow-up', 'Move up (evaluated earlier)', () => ctx.move(kind, r.id, -1), at <= 0 || !ctx.canEdit),
    iconButton('arrow-down', 'Move down (evaluated later)', () => ctx.move(kind, r.id, 1), at < 0 || at >= alive.length - 1 || !ctx.canEdit),
    iconButton('pencil', 'Edit', () => ctx.edit(kind, r.id), !ctx.canEdit),
    iconButton('x-lg', 'Remove', () => ctx.remove(kind, r.id), !ctx.canEdit));
}

// The row's class: dimmed when disabled, struck through when it is to be removed.
const rowClass = r => `${r.enabled ? '' : 'fw-off'}${r.removed ? ' fw-removed' : ''}`;

// Row of the traffic-rules table: position, name, zones, protocol/port match, action and hits.
function ruleRow(r, rows, ctx) {
  return h('tr', { className: rowClass(r) },
    h('td', { className: 'num muted' }, r.removed ? '–' : rows.filter(x => !x.removed).indexOf(r) + 1),
    h('td', {}, nameCell(r)),
    h('td', {}, fromTo(r.src, r.dest)),
    h('td', {}, describeMatch(r)),
    h('td', {}, actionBadge(r.target), r.enabled ? null : [' ', badge('disabled')]),
    h('td', {}, hitsCell(r)),
    ctx ? actionsCell('rules', r, rows, ctx) : null);
}

// Row of the port-forward table: "PROTO ports on address → target:port"; `kind` 'nat' marks a NAT (not DNAT) rule.
function redirectRow(r, rows, ctx) {
  const to = [].concat(r.dest_ip ?? []).join(', ');
  return h('tr', { className: rowClass(r) },
    h('td', { className: 'num muted' }, r.removed ? '–' : rows.filter(x => !x.removed).indexOf(r) + 1),
    h('td', {}, nameCell(r), r.kind === 'nat' ? h('div', { className: 'muted small' }, 'NAT rule') : null),
    h('td', {}, fromTo(r.src, r.dest, 'any', 'router')),
    h('td', {}, [r.proto.map(p => p.toUpperCase()).join('/'), r.src_dport.length ? ` ${r.src_dport.join(', ')}` : '', r.src_dip.length ? ` on ${r.src_dip.join(', ')}` : '',
      to ? ` → ${to}${r.dest_port.length ? `:${r.dest_port.join(', ')}` : ''}` : ''].join('')),
    h('td', {}, actionBadge(r.target), r.enabled ? null : [' ', badge('disabled')]),
    h('td', {}, hitsCell(r)),
    ctx ? actionsCell('redirects', r, rows, ctx) : null);
}

// Shared table markup: header row from `cols`, the rows (finished <tr> elements, unlike core table(), which builds the cells), or a
// single "empty" message row.
const table = (cols, rows, empty) => h('div', { className: 'grid-wrap' }, h('table', { className: 'table fw-table' },
  h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
  h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, empty)))));

// All traffic rules in configuration order (nftables evaluates them in this order); a rule with no
// destination is about the router itself.
export function rulesCard(fw, ctx = null) {
  const cols = ['#', 'Name', 'From › to', 'Match', 'Action', 'Hits', ...(ctx ? [''] : [])];
  const rows = fw.rows?.rules ?? fw.rules;
  return card([icon('list-ul'), h('span', {}, 'Traffic rules'), h('span', { className: 'sub' }, `${fw.rules.length} rules in configuration order · a rule with no destination is about the router itself`), ctx ? addButton('Add rule', () => ctx.edit('rules', null), ctx.canEdit) : null],
    table(cols, rows.map(r => ruleRow(r, rows, ctx)), 'No traffic rules are configured.'));
}

// Port forwards (DNAT) and other NAT rules (firewall `redirect` sections) with their hit counters.
export function redirectsCard(fw, ctx = null) {
  const cols = ['#', 'Name', 'From › to', 'Forwards', 'Action', 'Hits', ...(ctx ? [''] : [])];
  const rows = fw.rows?.redirects ?? fw.redirects;
  return card([icon('arrow-left-right'), h('span', {}, 'Port forwards and NAT'), h('span', { className: 'sub' }, `${fw.redirects.length} configured`), ctx ? addButton('Add port forward', () => ctx.edit('redirects', null), ctx.canEdit) : null],
    table(cols, rows.map(r => redirectRow(r, rows, ctx)), 'No port forwards or NAT rules are configured.'));
}
