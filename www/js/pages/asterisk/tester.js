// Dialplan tab, Number tester: where would a dialed number go? The page walks the loaded dialplan the way Asterisk searches it (own extensions in
// order, then the includes) and also asks Asterisk itself (`dialplan show <exten>@<context>`) so a difference shows. No call is placed.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { ubus } from '../../core/ubus.js';
import { badge, button, card, kv, mono, muted } from '../../core/ui.js';
import { describePattern, findExtension, stepDials } from './dialplanmodel.js';
import { endpointKind } from './pjsipmodel.js';
import { jumpTo, stepsTable } from './steps.js';
import { rerender, state } from './state.js';

// The numbers the form accepts, the same set the backend accepts.
const VALID = /^[A-Za-z0-9_+*#.-]{1,64}$/;

// The sources the number can be dialed from: each endpoint (its context) and each context.
export function sources(dp, endpoints) {
  const eps = [...endpoints.values()].filter(e => e.context).map(e => ({ value: `ep:${e.name}`, label: `Endpoint ${e.name} (${e.role}, context ${e.context})`, context: e.context }));
  const ctxs = dp.contexts.map(c => ({ value: `ctx:${c.name}`, label: `Context ${c.name}`, context: c.name }));
  return { eps, ctxs, all: [...eps, ...ctxs] };
}

// Runs the check: the local answer at once, then Asterisk's answer.
async function check(dp, list) {
  const t = state.test;
  const from = list.all.find(s => s.value === t.from) ?? list.all[0];
  const digits = t.digits.trim();
  t.error = null;
  t.server = null;
  if (!from) { t.error = 'There is no context to dial from.'; return rerender(); }
  if (!VALID.test(digits)) { t.local = undefined; t.error = 'Enter a number: digits, letters, + * # . or - (up to 64 characters).'; return rerender(); }
  t.source = from;
  t.dialed = digits;
  t.local = findExtension(dp, from.context, digits);
  t.invalid = t.local ? null : findExtension(dp, from.context, 'i');
  t.asking = true;
  rerender();
  try {
    t.server = await ubus('flab.asterisk', 'resolve', { context: from.context, exten: digits });
  } catch (e) {
    t.server = { found: false, error: e.message, failed: true };
  }
  t.asking = false;
  rerender();
}

// Whether Asterisk's answer agrees with ours, and a sentence about it.
function agreement(t) {
  if (t.asking) return { kind: 'info', text: 'Asking Asterisk…' };
  const s = t.server;
  if (!s) return null;
  if (s.failed || s.error) return { kind: 'warning', text: `Asterisk could not be asked: ${s.error}` };
  const ours = t.local;
  if (!!ours !== s.found) return { kind: 'danger', text: ours ? `Asterisk finds no extension, but this page matched ${ours.extension.pattern} in ${ours.context}.` : `Asterisk matches ${s.pattern} in ${s.in_context}, but this page found nothing.` };
  if (ours && (ours.context !== s.in_context || ours.extension.pattern !== s.pattern)) return { kind: 'danger', text: `Asterisk chooses ${s.pattern} in ${s.in_context}; this page chose ${ours.extension.pattern} in ${ours.context}.` };
  return { kind: 'success', text: s.found ? 'Asterisk agrees: it chooses the same extension.' : 'Asterisk agrees: nothing matches.' };
}

// What the call does after the match: the endpoints dialed (with their live state) and the contexts jumped to.
function outcome(map, local) {
  const dials = [];
  for (const s of local.extension.steps) for (const d of stepDials(s)) dials.push(d);
  const rows = [];
  for (const d of dials) {
    if (d.kind === 'endpoint') {
      const tg = map.targets.find(x => x.id === `tg:${d.endpoint}`);
      rows.push(h('li', {}, h('span', { className: `ast-dot ${tg?.known ? endpointKind({ state: tg.state, role: tg.role }) || 'neutral' : 'danger'}` }), ` calls endpoint `, mono(d.endpoint), tg?.known ? muted(` · ${tg.state}`) : badge('no such endpoint', 'warning')));
    } else if (d.kind === 'dynamic') rows.push(h('li', {}, 'calls an endpoint chosen at run time (the dialed number or a variable names it)'));
    else if (d.kind === 'local') rows.push(h('li', {}, `calls a Local channel into context ${d.context ?? '?'}`));
  }
  return rows.length ? h('ul', { className: 'ast-outcome' }, rows) : h('div', { className: 'muted' }, 'The extension places no call: it plays media, runs a script or jumps on.');
}

// The tester view; `list` comes from sources(), `map` from buildMap().
export function testerView(dp, map, list) {
  const t = state.test;
  if (!t.from || !list.all.some(s => s.value === t.from)) t.from = (list.eps.find(s => /phone/.test(s.label)) ?? list.eps[0] ?? list.ctxs[0])?.value ?? '';
  const select = h('select', { className: 'form-select form-select-sm', id: 'ast-from', title: 'Where the call enters the dialplan', onchange: e => { t.from = e.target.value; } },
    list.eps.length ? h('optgroup', { label: 'Endpoints' }, list.eps.map(s => h('option', { value: s.value, selected: s.value === t.from }, s.label))) : null,
    h('optgroup', { label: 'Contexts' }, list.ctxs.map(s => h('option', { value: s.value, selected: s.value === t.from }, s.label))));
  const input = h('input', { className: 'form-control form-control-sm mono', id: 'ast-digits', type: 'text', placeholder: 'e.g. 1002, 0612345678, +390612345678', value: t.digits, autocomplete: 'off', spellcheck: false,
    oninput: e => { t.digits = e.target.value; } });
  const form = h('form', { className: 'ast-tester-form', onsubmit: e => { e.preventDefault(); check(dp, list); } },
    h('label', { className: 'form-label small muted', htmlFor: 'ast-from' }, 'Dial from'), select,
    h('label', { className: 'form-label small muted', htmlFor: 'ast-digits' }, 'Number'), input,
    button('Where does it go?', 'search', () => {}, 'btn-primary btn-sm', { type: 'submit' }));

  const nodes = [card([icon('search'), 'Number tester'], h('div', { className: 'card-body ast-tester' }, form,
    h('div', { className: 'muted small mt-2' }, 'Nothing is dialed. The page follows the loaded dialplan the way Asterisk does: the context’s own extensions in the order Asterisk lists them (exact names first, then the most specific pattern), then the contexts it includes.'),
    t.error ? h('div', { className: 'text-danger mt-2' }, t.error) : null))];

  if (t.dialed && t.source && t.local !== undefined) {
    const ag = agreement(t);
    const r = t.local;
    nodes.push(card([icon('signpost-split'), `Dialing ${t.dialed} from ${t.source.label.replace(/ \(.*/, '')}`], h('div', { className: 'card-body' },
      ag ? h('div', { className: `alert alert-${ag.kind === 'danger' ? 'danger' : ag.kind === 'success' ? 'success' : ag.kind === 'warning' ? 'warning' : 'info'} py-2` }, ag.text) : null,
      r ? h('div', {},
        kv([
          ['Context searched', mono(t.source.context)],
          ['Found in', r.via.length ? h('span', {}, mono(r.context), muted(` through the include${r.via.length > 1 ? 's' : ''} ${r.via.join(' → ')}`)) : mono(r.context)],
          ['Extension', h('span', {}, h('span', { className: 'ast-pattern mono' }, r.extension.pattern), ' ', muted(describePattern(r.extension.pattern)))],
          ['Then', outcome(map, r)],
        ]),
        h('div', { className: 'mt-3 d-flex gap-2' }, button('Show it in the browser', 'diagram-3', () => jumpTo(r.context, r.extension.pattern, null), 'btn-outline-primary btn-sm')))
        : h('div', {}, h('div', { className: 'fw-semibold' }, `No extension in ${t.source.context} (or the contexts it includes) matches “${t.dialed}”.`),
          t.invalid ? h('div', { className: 'muted mt-1' }, `The caller would reach the invalid-number extension “i” in ${t.invalid.context}.`) : h('div', { className: 'muted mt-1' }, 'There is no “i” extension either, so Asterisk plays its invalid-number message and hangs up.')),
    )));
    if (r) nodes.push(card([icon('list-ul'), `Steps of ${r.extension.pattern} in ${r.context}`], h('div', { className: 'card-body p-0' }, stepsTable(dp, map, r.extension, { context: r.context, exten: r.extension.pattern }))));
  }
  return nodes;
}
