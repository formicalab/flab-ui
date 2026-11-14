// The card of the global defaults (the first `defaults` section of /etc/config/firewall): the default policies, the protections and flow
// offloading. It is folded until opened (they rarely change), and opened by itself when one of its controls has an error. The controls come
// from the option table in schema.js through core/forms.js; edits go straight into the page's draft.
import { h } from '../../core/dom.js';
import { chevron, foldable } from '../../core/fold.js';
import { icon } from '../../core/icons.js';
import { badge, card } from '../../core/ui.js';
import { fieldRow } from '../../core/forms.js';
import { DEFAULT_FIELDS, DEFAULT_GROUPS } from './schema.js';
import { isShown } from './edit.js';

// Whether the card is folded, and which groups are open: kept across redraws.
let folded = true;
const opened = new Map();

// The options whose value decides which other controls are shown, so changing one redraws the card.
const REDRAWS = new Set(['synflood_protect', 'flow_offloading']);

// The card. `ctx` is { draft, canEdit, inputs, touched(), redraw() }: the draft's `defaults` values are edited in place, `inputs` collects the
// controls by option name so the page can mark the ones that hold an error.
export function defaultsCard(ctx) {
  const values = ctx.draft.defaults;
  const groups = DEFAULT_GROUPS.map(g => {
    const fields = DEFAULT_FIELDS.filter(f => f.group === g.id && isShown(f, values));
    if (!fields.length) return null;
    const id = `defaults:${g.id}`;
    const nodes = fields.map(f => fieldRow(f.type === 'enum' && f.default != null ? { ...f, blank: `Default (${f.labels?.[f.default] ?? f.default})` } : f, {
      id: `defaults-${f.key}`,
      get: () => values[f.key],
      set: v => { values[f.key] = v; if (REDRAWS.has(f.key)) queueMicrotask(() => ctx.redraw()); },
      disabled: !ctx.canEdit,
      touched: ctx.touched,
      redraw: ctx.redraw,
      register: el => { ctx.inputs[`defaults:${f.key}`] = el; },
    }));
    return h('details', { className: 'fw-group', open: opened.get(id) ?? Boolean(g.open), ontoggle: e => opened.set(id, e.target.open) },
      h('summary', {}, g.title), h('div', { className: 'fw-group-body' }, h('p', { className: 'muted small' }, g.legend), h('div', { className: 'set-fields' }, nodes)));
  });
  const d = ctx.draft.defaults;
  const el = card(
    [chevron(), icon('gear'), h('span', {}, 'Global settings'),
      badge(`input ${(d.input || 'drop').toLowerCase()}`, 'info', 'Default policy for traffic to the router, for a zone with none of its own'),
      badge(`forward ${(d.forward || 'drop').toLowerCase()}`, 'info', 'Default policy for traffic between interfaces of a zone, for a zone with none of its own'),
      d.flow_offloading ? badge(d.flow_offloading_hw ? 'hardware offloading' : 'software offloading', 'success') : null,
      h('span', { className: 'sub' }, 'defaults section · default policies, protections, flow offloading')],
    h('div', { className: 'card-body fw-groups' }, groups),
    '');
  return foldable(el, folded, now => { folded = now; });
}
