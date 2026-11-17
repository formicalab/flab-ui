// The "Next hop lookup" card of the Routing page: a destination (and optionally a source address and the
// interface a packet arrives on, which policy rules can match) goes in, and what the kernel would do with the
// packet comes out: the next hop, the interface, the source address, the route and routing table that answered
// and the policy rules that consulted that table. The answer comes from `ip route get` (flab.routing lookup).
//
// The lookup is part of the page's poll: once a query is set, every refresh asks the kernel again, so the answer
// follows route changes (a failover shows up on its own). The form is not redrawn while one of its fields has
// focus (the page pauses polling then), and its text lives in the page's state.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { disclosure } from '../../core/fold.js';
import { badge, button, card, kv, mono, muted } from '../../core/ui.js';
import { openTool } from '../index.js';
import { DROPS, interpret, isAddress, routeText, rulesFor, tableLabel } from './model.js';

// The device name with its logical interface (netifd name) next to it when that differs.
export function deviceText(dev, names) {
  if (!dev) return muted('–');
  const logical = names.get(dev);
  return h('span', { className: 'rt-dev' }, mono(dev), logical && logical !== dev ? badge(logical, 'info', 'network interface') : null);
}

// The rules that send lookups to a table, as text ("rule 220: from all").
function ruleText(rule) {
  const sel = rule.selectors.map(([k, v]) => (k === 'from' && v === 'all' ? 'from any source' : `${k} ${v}`)).join(', ');
  return `rule ${rule.priority}${sel ? `: ${sel}` : ''}`;
}

// Checks the form and, when it is valid, makes it the page's query and asks for a fresh poll; otherwise
// shows what is wrong. `state.rerender` and `state.reload` are set by the page's controls.
function submit(state) {
  const f = state.form;
  const dst = f.dst.trim(), src = f.src.trim();
  state.formError = !isAddress(dst) ? 'Enter an IPv4 or IPv6 address to look up.'
    : src && !isAddress(src) ? 'The source must be an IPv4 or IPv6 address.'
      : f.iif && !src ? 'A packet that arrives on an interface needs a source address.' : null;
  if (state.formError) return state.rerender();
  state.query = { dst, src, iif: f.iif };
  state.reload();
}

// Forgets the query and the form.
function clear(state) {
  state.form = { dst: '', src: '', iif: '' };
  state.query = null;
  state.formError = null;
  state.rerender();
}

// The form: destination, optional source and arrival interface, and the buttons.
function form(state, devices) {
  // A labeled text input bound to state.form[key]; Enter submits the lookup.
  const field = (key, label, placeholder, title) => h('label', { className: 'rt-field', title },
    h('span', {}, label),
    h('input', {
      className: 'form-control form-control-sm mono', type: 'text', placeholder, value: state.form[key], spellcheck: false, autocomplete: 'off',
      oninput: e => { state.form[key] = e.target.value; },
      onkeydown: e => { if (e.key === 'Enter') submit(state); },
    }));
  const iif = h('select', { className: 'form-select form-select-sm', onchange: e => { state.form.iif = e.target.value; } },
    h('option', { value: '' }, 'any / this router'), devices.map(d => h('option', { value: d }, d)));
  iif.value = state.form.iif;
  return h('div', { className: 'rt-form' },
    field('dst', 'Destination', 'e.g. 1.1.1.1 or 2606:4700:4700::1111', 'The address a packet is sent to'),
    field('src', 'From (optional)', 'source address', 'The source address of the packet; policy rules can depend on it'),
    h('label', { className: 'rt-field', title: 'The interface the packet arrives on, to simulate forwarded traffic' }, h('span', {}, 'Arrives on (optional)'), iif),
    h('div', { className: 'rt-actions' }, button('Look up', 'search', () => submit(state), 'btn-brand'), state.query ? button('Clear', 'x-lg', () => clear(state)) : null),
    state.formError ? h('div', { className: 'rt-error' }, icon('x-circle'), state.formError) : null);
}

// The answer: a headline with what happens to the packet, then the details.
function answer(data, state, names) {
  const res = data.lookup;
  const v = interpret(res, data.status.routes);
  const route = v.route ?? null;
  const verdictClass = { forward: 'ok', local: 'info', broadcast: 'info', multicast: 'info', anycast: 'info', drop: 'bad', none: 'bad', invalid: 'warn', error: 'warn' }[v.verdict];
  const headline = {
    forward: v.nextHop ? `Next hop ${v.nextHop}` : 'Directly connected',
    local: 'Local address', broadcast: 'Broadcast address', multicast: 'Multicast address', anycast: 'Anycast address',
    drop: 'Dropped', none: 'No route', invalid: 'Cannot look this up', error: 'The kernel refused the lookup',
  }[v.verdict];
  const icons = { ok: 'arrow-right', info: 'info-circle', bad: 'x-circle', warn: 'exclamation-triangle' }[verdictClass];

  const rows = [];
  if (v.verdict === 'forward') {
    rows.push(['Next hop', v.nextHop ? mono(v.nextHop) : muted('none: the destination is on the link')]);
    rows.push(['Interface', deviceText(v.dev, names)]);
    rows.push(['Source address', v.src ? mono(v.src) : muted('the packet keeps its own')]);
  } else if (['local', 'broadcast', 'multicast', 'anycast'].includes(v.verdict)) {
    rows.push(['Interface', deviceText(v.dev, names)]);
    if (v.src) rows.push(['Address', mono(v.src)]);
  }
  if (route) {
    rows.push([DROPS.includes(route.type) ? 'Dropping route' : 'Matched route', h('pre', { className: 'rt-route' }, routeText(route))]);
    const rules = rulesFor(data.status, route.table).filter(r => r.family === route.family);
    rows.push(['Routing table', h('span', { className: 'rt-table' },
      mono(tableLabel(route.table, data.status.table_ids)),
      state.table !== route.table ? button('Show this table', 'list-ul', () => { state.table = route.table; state.rerender(); }) : null)]);
    if (rules.length) rows.push(['Chosen by', h('span', {}, rules.map(r => h('div', {}, ruleText(r))))]);
  }
  if (v.paths > 1) {
    rows.push(['Equal-cost paths', h('span', {}, `${v.paths} next hops share the load: ${route.nexthops.map(n => n.via ?? n.dev).join(', ')}. The kernel picks one per flow; this answer is the one it chose for this packet.`)]);
  }
  // A packet that is forwarded can be tried for real: the Toolbox opens with the destination filled in.
  if (v.verdict === 'forward') {
    rows.push(['Try it', h('span', { className: 'rt-try' },
      button('Ping', 'activity', () => openTool('ping', res.dst)), button('Traceroute', 'diagram-3', () => openTool('traceroute', res.dst)))]);
  }
  if (res.src || res.iif) rows.push(['Looked up as', h('span', {}, `a packet${res.src ? ` from ${res.src}` : ''}${res.iif ? ` arriving on ${res.iif}` : ''}`)]);

  return h('div', { className: `rt-result ${verdictClass}` },
    h('div', { className: 'rt-headline' }, icon(icons), h('strong', {}, headline), h('span', { className: 'rt-for' }, `for ${res.dst ?? ''}`)),
    h('div', { className: 'rt-text' }, v.text),
    rows.length ? kv(rows) : null,
    res.raw ? disclosure({
      cls: 'rt-raw', summary: 'What the kernel said', open: state.rawOpen, onToggle: open => { state.rawOpen = open; },
      body: h('pre', {}, `ip route get:\n${res.raw.get}\n\nmatching route (fibmatch):\n${res.raw.match}`),
    }) : null);
}

// The card. `devices` are the interfaces offered as the arrival interface, `names` maps devices to interfaces.
export function lookupCard(data, state, devices, names) {
  return card([icon('search'), 'Next hop lookup', h('span', { className: 'sub' }, 'Where the kernel would send a packet, using every routing table and policy rule')],
    h('div', { className: 'card-body rt-lookup' },
      form(state, devices),
      state.query && data.lookup ? answer(data, state, names)
        : h('div', { className: 'rt-hint muted' }, 'Enter an address to see the next hop, the interface and the route that would be used.')));
}
