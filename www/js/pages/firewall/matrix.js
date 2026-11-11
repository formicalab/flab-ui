// The zone matrix card: who may talk to whom by default (green), what only works through rules (amber) and what
// is closed. Rows are the source, columns the destination; the router itself is both a source and a destination.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { card } from '../../core/ui.js';
import { buildMatrix, ROUTER } from './model.js';

// Label of a matrix end: the router pseudo-zone reads "Router itself".
const label = end => end === ROUTER ? 'Router itself' : end;

// Short wording per cell state; the cell uses the "partial" text as its sub-line.
const STATE_TEXT = { open: 'allowed', partial: 'only by rule', closed: 'blocked' };

// One matrix cell: the default policy (or the number of opening rules when only rules allow it), a note
// about rules that close part of an open path, and a tooltip listing the rules; null renders a dash.
function cell(c) {
  if (!c) return h('td', { className: 'fwm-na' }, '–');
  const detail = [
    `${label(c.src)} › ${label(c.dest)}: policy ${c.policy}`,
    c.accepts.length ? `Allowed by: ${c.accepts.join(', ')}` : null,
    c.blocks.length ? `Blocked by: ${c.blocks.join(', ')}` : null,
  ].filter(Boolean).join('\n');
  const text = c.state === 'open' ? c.policy.toLowerCase() : c.state === 'partial' ? `${c.accepts.length} rule${c.accepts.length === 1 ? '' : 's'}` : c.policy === 'BLOCKED' ? 'blocked' : c.policy.toLowerCase();
  const sub = c.state === 'partial' ? STATE_TEXT.partial : c.state === 'open' && c.blocks.length ? `${c.blocks.length} rule${c.blocks.length === 1 ? '' : 's'} block part` : null;
  return h('td', { className: `fwm-cell fwm-${c.state}`, title: detail },
    h('div', { className: 'fwm-main' }, text),
    sub ? h('div', { className: 'fwm-sub' }, sub) : null);
}

// The card: the matrix from buildMatrix (rows are sources, columns destinations) plus a color legend.
export function matrixCard(fw) {
  const m = buildMatrix(fw);
  const table = h('table', { className: 'fwm' },
    h('thead', {}, h('tr', {}, h('th', {}, 'from ↓  to →'), m.ends.map(e => h('th', { className: e === ROUTER ? 'fwm-router' : '' }, label(e))))),
    h('tbody', {}, m.rows.map(r => h('tr', {}, h('th', { className: r.src === ROUTER ? 'fwm-router' : '' }, label(r.src)), r.cells.map(cell)))));
  return card([icon('shield-check'), h('span', {}, 'Who can reach whom'), h('span', { className: 'sub' }, 'default policy per zone pair; hover a cell for the rules')],
    h('div', {},
      h('div', { className: 'muted small fw-legend fw-matrix-legend' },
        h('span', { className: 'fwm-key fwm-open' }), ' allowed by policy   ',
        h('span', { className: 'fwm-key fwm-partial' }), ' blocked by policy, opened by specific rules   ',
        h('span', { className: 'fwm-key fwm-closed' }), ' blocked. A zone reaches another zone only through a forwarding, a rule or a port forward; the diagonal is traffic between interfaces of the same zone.'),
      h('div', { className: 'grid-wrap' }, table)));
}
