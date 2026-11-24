// Dialplan tab, Browser view: the contexts on the left, the selected context's extensions on the right, each with its steps.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, chip, emptyState, mono } from '../../core/ui.js';
import { disclosure } from '../../core/fold.js';
import { openEndpointDrawer } from './pjsip.js';
import { describePattern, globalVars, stepDials } from './dialplanmodel.js';
import { extId, stepsTable } from './steps.js';
import { rerender, state } from './state.js';

// One line of counts over the whole dialplan (the daemon tiles above the tabs stay the same on every tab).
export function dialplanStats(dp) {
  const t = dp.totals;
  return h('div', { className: 'muted small mb-2' },
    `${t.contexts} contexts · ${t.extensions} extensions · ${t.steps} steps · ${dp.globals.length} global variables`,
    dp.redacted ? ` · ${dp.redacted} hidden value${dp.redacted > 1 ? 's' : ''} (PINs and passwords are not shown)` : '');
}

// Whether an extension matches the filter text (pattern, application or arguments).
function matches(ext, q) {
  if (!q) return true;
  const hay = [ext.pattern, ...ext.steps.flatMap(s => [s.app, s.data, s.label ?? ''])].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

// What an extension dials, as endpoint names (for the summary line of its card).
function dialled(dp, ext) {
  const names = new Set();
  const vars = globalVars(dp);
  for (const s of ext.steps) for (const d of stepDials(s, vars)) names.add(d.kind === 'endpoint' ? d.endpoint : d.kind === 'dynamic' ? 'any endpoint' : d.kind === 'local' ? 'Local' : d.tech);
  return [...names];
}

// The context list on the left.
function sidebar(dp, map) {
  const items = dp.contexts.map(c => {
    const node = map.contexts.find(x => x.name === c.name);
    return h('button', { type: 'button', className: `ast-ctx ${c.name === state.ctx ? 'active' : ''}`, onclick: () => { state.ctx = c.name; state.ext = null; state.hl = null; rerender(); } },
      h('span', { className: 'mono fw-semibold' }, c.name), h('span', { className: 'muted small' }, `${c.extensions.length} ext.`),
      node && !node.reached && map.entries.length ? badge('unused', 'warning') : null);
  });
  return card([icon('list-ul'), 'Contexts'], h('div', { className: 'ast-ctx-list' }, items));
}

// The header of the selected context: where calls come from and where they can go.
function contextHeader(ctx, map) {
  const node = map.contexts.find(x => x.name === ctx.name);
  const chips = (list, title, go) => list.length ? h('div', { className: 'ast-rel' }, h('span', { className: 'muted small' }, title),
    ...list.map(n => go ? h('button', { type: 'button', className: 'alg-chip info ast-chip-btn', onclick: () => go(n) }, n) : chip(n, ''))) : null;
  return h('div', { className: 'card-body ast-ctx-head' },
    h('div', { className: 'd-flex flex-wrap align-items-center gap-2' }, h('span', { className: 'name mono' }, ctx.name), badge(`created by ${ctx.creator}`, ''),
      ctx.included ? badge('included', 'info') : null),
    chips(node?.entries ?? [], 'Entered by endpoints', name => {
      const ep = map.endpointByName?.get(name);
      if (ep) openEndpointDrawer(ep);
    }),
    chips(ctx.includes ?? [], 'Includes', name => { state.ctx = name; state.ext = null; rerender(); }),
    chips(node?.jumps ?? [], 'Jumps to', name => { state.ctx = name; state.ext = null; rerender(); }),
    ctx.switches?.length ? chips(ctx.switches, 'Alternative switches') : null);
}

// One extension as a fold: the name with what it means, then its steps.
function extensionCard(dp, map, ctx, ext, idx) {
  const key = `${ctx.name}|${ext.pattern}`;
  const open = state.openExt.has(key) || state.ext === ext.pattern || (ctx.extensions.length <= 4 && !state.openExt.has(`!${key}`));
  const calls = dialled(dp, ext);
  return h('div', { className: `card ast-ext ${state.ext === ext.pattern ? 'focus' : ''}`, id: extId(ctx.name, ext.pattern) },
    disclosure({
      cls: 'ast-ext-fold', summaryCls: 'ast-ext-sum', open,
      summary: [h('span', { className: 'ast-pattern mono' }, ext.pattern), h('span', { className: 'muted ast-explain' }, describePattern(ext.pattern)),
        h('span', { className: 'ms-auto d-flex align-items-center gap-2' }, calls.length ? chip(`calls ${calls.join(', ')}`, 'info') : null, h('span', { className: 'muted small' }, `${ext.steps.length} step${ext.steps.length > 1 ? 's' : ''}`))],
      onToggle: isOpen => { if (isOpen) { state.openExt.add(key); state.openExt.delete(`!${key}`); } else { state.openExt.delete(key); state.openExt.add(`!${key}`); } },
      body: h('div', { className: 'ast-ext-body' }, stepsTable(dp, map, ext, { context: ctx.name, exten: ext.pattern })),
    }));
}

// The Browser view.
export function browseView(dp, map) {
  const ctx = dp.contexts.find(c => c.name === state.ctx) ?? dp.contexts[0];
  if (!ctx) return emptyState('The dialplan has no context.');
  state.ctx = ctx.name;
  const exts = ctx.extensions.filter(e => matches(e, state.dq));
  const globals = dp.globals.length ? disclosure({
    cls: 'card card-body mt-3', summary: `Global variables (${dp.globals.length})`,
    body: h('div', { className: 'mt-2' }, dp.globals.map(g => h('div', {}, mono(g.name), ' = ', h('span', { className: 'mono' }, g.value === '<redacted>' ? h('span', { className: 'ast-redacted' }, g.value) : g.value)))),
  }) : null;
  return h('div', { className: 'ast-split' },
    sidebar(dp, map),
    h('div', { className: 'ast-main' },
      card(null, contextHeader(ctx, map)),
      exts.length ? exts.map((e, i) => extensionCard(dp, map, ctx, e, i)) : emptyState(ctx.extensions.length ? 'No extension of this context matches the filter.' : 'This context has no extension of its own.'),
      globals,
      dp.truncated ? h('div', { className: 'alert alert-info mt-3' }, 'The dialplan is larger than the page reads; the end of it is missing.') : null));
}
