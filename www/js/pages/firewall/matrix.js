// The zone matrix card: who may talk to whom by default (green), what only works through rules (amber) and what
// is closed. Rows are the source, columns the destination; the router itself is both a source and a destination.
// With editing on, a cell between two different zones is a switch for the forwarding from the row's zone to the column's, and the forwardings
// themselves are listed under the matrix (so a disabled one, or one the matrix cannot show, can still be changed or removed).
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card } from '../../core/ui.js';
import { buildMatrix, ROUTER } from './model.js';
import { iconButton, pendingBadge } from './parts.js';

// Label of a matrix end: the router pseudo-zone reads "Router itself".
const label = end => end === ROUTER ? 'Router itself' : end;

// Short wording per cell state; the cell uses the "partial" text as its sub-line.
const STATE_TEXT = { open: 'allowed', partial: 'only by rule', closed: 'blocked' };

// What a click on a cell does, for its tooltip and for assistive technology.
const clickWords = c => `${c.policy === 'ACCEPT' ? 'Stop' : 'Allow'} forwarding from zone ${c.src} to zone ${c.dest}`;

// One matrix cell: the default policy (or the number of opening rules when only rules allow it), a note
// about rules that close part of an open path, and a tooltip listing the rules; null renders a dash. With `ctx`, a cell between two zones
// switches the forwarding, and says so when that was changed and not saved yet.
function cell(c, ctx, pending) {
  if (!c) return h('td', { className: 'fwm-na' }, '–');
  const detail = [
    `${label(c.src)} › ${label(c.dest)}: policy ${c.policy}`,
    c.accepts.length ? `Allowed by: ${c.accepts.join(', ')}` : null,
    c.blocks.length ? `Blocked by: ${c.blocks.join(', ')}` : null,
  ].filter(Boolean);
  const text = c.state === 'open' ? c.policy.toLowerCase() : c.state === 'partial' ? `${c.accepts.length} rule${c.accepts.length === 1 ? '' : 's'}` : c.policy === 'BLOCKED' ? 'blocked' : c.policy.toLowerCase();
  const changed = pending[`${c.src}>${c.dest}`];
  const sub = changed ? { added: 'forwarding added, not saved', removed: 'forwarding removed, not saved', edited: 'forwarding changed, not saved' }[changed]
    : c.state === 'partial' ? STATE_TEXT.partial : c.state === 'open' && c.blocks.length ? `${c.blocks.length} rule${c.blocks.length === 1 ? '' : 's'} block part` : null;
  const switchable = ctx && c.src !== ROUTER && c.dest !== ROUTER && c.src !== c.dest;
  if (switchable) detail.push(`Click: ${clickWords(c).toLowerCase()}`);
  const td = h('td', { className: `fwm-cell fwm-${c.state}${switchable ? ' fwm-click' : ''}${changed ? ' fwm-changed' : ''}`, title: detail.join('\n') },
    h('div', { className: 'fwm-main' }, text),
    sub ? h('div', { className: 'fwm-sub' }, sub) : null);
  if (switchable && ctx.canEdit) {
    td.setAttribute('role', 'button');
    td.tabIndex = 0;
    td.setAttribute('aria-label', clickWords(c));
    td.addEventListener('click', () => ctx.toggleForwarding(c.src, c.dest));
    td.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.toggleForwarding(c.src, c.dest); } });
  }
  return td;
}

// The forwardings under the matrix, one chip each with its switch and remove button.
function forwardingList(rows, ctx) {
  if (!rows.length) return h('div', { className: 'muted small fw-forwardings' }, 'There are no forwardings: no zone may send traffic to another.');
  return h('div', { className: 'fw-forwardings' }, h('div', { className: 'muted small' }, 'Forwardings: the first zone may send traffic to the second.'),
    h('div', { className: 'fw-chips' }, rows.map(r => {
      const v = r.values;
      return h('span', { className: `fw-chip fw-fwd${r.removed ? ' fw-removed' : ''}${v.enabled ? '' : ' fw-off'}`, title: r.words },
        `${v.src === '*' ? 'any zone' : v.src || '?'} › ${v.dest === '*' ? 'any zone' : v.dest || '?'}`,
        v.family && v.family !== 'any' ? badge(v.family === 'ipv4' ? 'IPv4' : 'IPv6', 'info') : null,
        v.enabled ? null : badge('disabled'),
        r.removed || r.pending ? pendingBadge(r) : null,
        r.removed ? iconButton('arrow-counterclockwise', 'Keep this forwarding (undo the removal)', () => ctx.restore('forwardings', r.id))
          : [iconButton(v.enabled ? 'toggle-on' : 'toggle-off', v.enabled ? 'Disable this forwarding' : 'Enable this forwarding', () => ctx.setEnabled('forwardings', r.id, !v.enabled), !ctx.canEdit),
            iconButton('trash', 'Remove this forwarding', () => ctx.remove('forwardings', r.id), !ctx.canEdit)]);
    })));
}

// The card: the matrix from buildMatrix (rows are sources, columns destinations) plus a color legend. `ctx` (null: read only) carries the
// edit actions and the forwardings (`ctx.forwardings`).
export function matrixCard(fw, ctx = null) {
  const m = buildMatrix(fw);
  const pending = fw.forwardPending ?? {};
  const table = h('table', { className: 'fwm' },
    h('thead', {}, h('tr', {}, h('th', {}, 'from ↓  to →'), m.ends.map(e => h('th', { className: e === ROUTER ? 'fwm-router' : '' }, label(e))))),
    h('tbody', {}, m.rows.map(r => h('tr', {}, h('th', { className: r.src === ROUTER ? 'fwm-router' : '' }, label(r.src)), r.cells.map(c => cell(c, ctx, pending))))));
  return card([icon('shield-check'), h('span', {}, 'Who can reach whom'), h('span', { className: 'sub' }, ctx ? 'default policy per zone pair; click a cell between two zones to allow or stop the forwarding' : 'default policy per zone pair; hover a cell for the rules')],
    h('div', {},
      h('div', { className: 'muted small fw-legend fw-matrix-legend' },
        h('span', { className: 'fwm-key fwm-open' }), ' allowed by policy   ',
        h('span', { className: 'fwm-key fwm-partial' }), ' blocked by policy, opened by specific rules   ',
        h('span', { className: 'fwm-key fwm-closed' }), ' blocked. A zone reaches another zone only through a forwarding, a rule or a port forward; the diagonal is traffic between interfaces of the same zone.'),
      h('div', { className: 'grid-wrap' }, table),
      ctx ? forwardingList(ctx.forwardings, ctx) : null));
}
