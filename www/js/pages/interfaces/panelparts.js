// DOM building blocks the side panels (panels.js) and the wizard (wizard.js) share: a numbered section, the list of devices to pick from, the
// protocol cards and the "used by" list. They only build nodes from the items panelmodel.js computes; styles are at the end of css/netedit.css (`np-`).
import { h } from '../../core/dom.js';
import { badge } from '../../core/ui.js';
import { PROTO_CARDS } from './panelmodel.js';

// A section of a panel: an optional number, a title, a plain-words lead and the body.
export function section(num, title, lead, ...body) {
  return h('section', { className: 'np-sec' },
    h('h3', { className: 'np-h' }, num ? h('span', { className: 'np-num' }, String(num)) : null, h('span', {}, title)),
    lead ? h('p', { className: 'muted small np-lead' }, lead) : null, ...body);
}

// What a kind of device item is called, for its badge.
const KIND_LABEL = { bridge: 'bridge device', port: 'network device', vlan: 'VLAN device', alias: 'another interface', conduit: 'CPU link', device: 'device', unknown: 'not found' };

// A list of choices, one radio each: `items` are { value, title, kind, what, usedBy, up?, warn? } (panelmodel.deviceItems), `value` the chosen one, `name`
// the radio group's name and `onPick(value)` is called on a change. `none` adds a first choice without a device ({ value: '', title, what }).
export function optionList({ name, items, value, disabled, onPick, none }) {
  const all = none ? [{ kind: 'none', usedBy: [], ...none }, ...items] : items;
  const list = h('div', { className: 'np-opts', role: 'radiogroup' }, all.map(item => {
    const on = item.value === value;
    const input = h('input', { className: 'form-check-input', type: 'radio', name, value: item.value, checked: on, disabled, onchange: () => onPick(item.value) });
    return h('label', { className: `np-opt${on ? ' on' : ''}${disabled ? ' off' : ''}` }, input,
      h('div', { className: 'np-opt-body' },
        h('div', { className: 'np-opt-head' }, h('strong', { className: 'mono' }, item.title), item.kind && item.kind !== 'none' ? badge(KIND_LABEL[item.kind] ?? item.kind, item.kind === 'unknown' ? 'warning' : '') : null,
          item.up != null ? h('span', { className: `dot ${item.up ? 'up' : 'idle'}`, title: item.up ? 'up' : 'down' }) : null),
        item.what ? h('div', { className: 'muted small' }, item.what) : null,
        item.kind === 'none' || !item.usedBy.length ? null : h('div', { className: 'muted small' }, `Used by: ${item.usedBy.join(', ')}`),
        item.warn ? h('div', { className: 'np-warn small' }, item.warn) : null));
  }));
  // The list scrolls when it is long: bring the chosen device into view once it is laid out.
  requestAnimationFrame(() => { const on = list.querySelector('.np-opt.on'); if (on) list.scrollTop = Math.max(0, on.offsetTop - list.offsetTop - 8); });
  return list;
}

// The protocol cards: one button per protocol with what it is for and what it asks for. `current` is the chosen protocol; `onPick(id)` is called on a
// click; `dropped(id)` (optional) gives the labels of the options a switch to that protocol drops.
export function protoCards({ current, disabled, onPick, dropped }) {
  return h('div', { className: 'np-protos', role: 'radiogroup', ariaLabel: 'Protocol' }, PROTO_CARDS.map(c => {
    const on = c.id === current;
    const drops = !on && dropped ? dropped(c.id) : [];
    const button = h('button', { type: 'button', className: `np-proto${on ? ' on' : ''}`, role: 'radio', disabled, onclick: () => { if (!on) onPick(c.id); } });
    button.dataset.proto = c.id;
    button.setAttribute('aria-checked', String(on));
    button.append(h('div', { className: 'np-proto-title' }, h('strong', {}, c.title), on ? badge('selected', 'info') : null),
      h('div', { className: 'muted small' }, c.blurb),
      h('div', { className: 'small' }, h('span', { className: 'muted' }, 'Asks for: '), c.asks),
      drops.length ? h('div', { className: 'np-warn small' }, `Switching drops: ${drops.join(', ')}.`) : null);
    return button;
  }));
}

// A list of "label, value" rows that wraps: `rows` are [label, node-or-text] pairs (null rows are skipped).
export const infoList = rows => h('dl', { className: 'kv np-info' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

// A link to another page of the UI.
export const pageLink = (href, text) => h('a', { href, className: 'np-link' }, text);
