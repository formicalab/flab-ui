// The settings cards of the DHCP page: one per interface pool (a `dhcp` section of /etc/config/dhcp) and one for
// the odhcpd daemon itself. Their controls come from the option tables in schema.js through core/forms.js; a
// pool's options are in collapsible groups (services, DHCPv4, DHCPv6, router advertisements, ...) so the page
// stays readable.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, card, muted } from '../../core/ui.js';
import { fieldRow, legend } from '../../core/forms.js';
import { DAEMON_FIELDS, GLOBAL_FIELDS, POOL_FIELDS, POOL_GROUPS } from './schema.js';
import { addPool, freeInterfaces, poolRange, poolValue, removePool, restorePool } from './model.js';

// Which option groups are expanded, kept across redraws: id `<section>:<group>` to open or closed.
const opened = new Map();

// The cards the user has opened (a pool's `dhcp` section name, or 'daemon'), kept across redraws. These cards start
// folded down to their header, which already summarizes them.
const unfolded = new Set();

// Makes a card foldable: its whole header becomes the toggle (mouse, Enter or Space), the card starts folded unless
// `key` was opened before, and the choice is remembered under `key`.
function foldable(el, key) {
  const header = el.querySelector('.card-header');
  el.classList.toggle('dhcp-folded', !unfolded.has(key));
  // Folds or unfolds the card and remembers the state.
  const toggle = () => {
    const isFolded = el.classList.toggle('dhcp-folded');
    if (isFolded) unfolded.delete(key); else unfolded.add(key);
    header.setAttribute('aria-expanded', String(!isFolded));
  };
  header.classList.add('dhcp-fold-header');
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-expanded', String(unfolded.has(key)));
  header.title = 'Click to fold or unfold';
  header.addEventListener('click', toggle);
  header.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  return el;
}

// Connects the control of one field to the draft, under the control name `id` (also used to mark errors). `off` grays
// it out (a pool that is going to be removed).
function controlFor(ctx, f, id, values, off = false) {
  return fieldRow(f, {
    id,
    get: () => values[f.key],
    set: v => { values[f.key] = v; },
    disabled: !ctx.canEdit || off,
    touched: ctx.touched,
    redraw: ctx.redraw,
    register: (el, index) => { if (index == null) ctx.inputs[id] = el; else (ctx.inputs[id] ??= [])[index] = el; },
  });
}

// The options of a section that the option tables do not describe, read only: options of other programs that read the same
// file, and ones odhcpd reads without documenting them. `file` names where to change them.
function extraOptions(extra, file) {
  if (!extra.length) return null;
  return h('div', { className: 'dhcp-extra' },
    h('p', { className: 'muted small' }, `Other options in this section of ${file}. This page has no control for them; change them in the file.`),
    h('dl', { className: 'kv' }, extra.flatMap(e => [h('dt', { className: 'mono' }, e.key), h('dd', { className: 'mono' }, e.value)])));
}

// The one-line description of a pool in its header: subnet, then each service with its mode.
function describe(ctx, pool) {
  // The draft value of one option of this pool.
  const val = key => poolValue(ctx.draft, pool.section, key);
  const parts = [];
  const v4 = pool.info?.v4;
  parts.push(v4 ? `${v4.address}/${v4.mask}` : 'no IPv4 address');
  if (val('dhcpv4') === 'server' && v4) {
    const r = poolRange(v4.address, v4.mask, +val('start'), +val('limit'));
    parts.push(r && !r.outside ? `DHCPv4 ${r.first} – ${r.last} (${r.count})` : 'DHCPv4 server');
  } else parts.push(`DHCPv4 ${val('dhcpv4')}`);
  parts.push(`DHCPv6 ${val('dhcpv6')}`, `RA ${val('ra')}`);
  if (val('ndp') !== 'disabled') parts.push(`NDP ${val('ndp')}`);
  return parts.join(' · ');
}

// The card of one pool. Clicking its header folds the whole card down to that header (which already summarizes
// the pool), and the choice survives redraws. A pool can be removed (until saved it can be restored) and its options
// the page does not describe are listed read only.
export function poolCard(ctx, pool) {
  const off = pool.removed;
  const groups = POOL_GROUPS.map(g => {
    const id = `${pool.section}:${g.id}`;
    const fields = POOL_FIELDS.filter(f => f.group === g.id).map(f => controlFor(ctx, f, `pool:${pool.section}:${f.key}`, ctx.draft.pools[pool.section], off));
    return h('details', { className: 'dhcp-group', open: opened.get(id) ?? Boolean(g.open), ontoggle: e => opened.set(id, e.target.open) },
      h('summary', {}, g.title),
      h('div', { className: 'dhcp-group-body' }, h('p', { className: 'muted small' }, g.legend), h('div', { className: 'set-fields' }, fields)));
  });
  const actions = off
    ? h('div', { className: 'dhcp-pool-actions' }, muted(`Pool ${pool.iface} is removed when you save.`), button('Undo', 'arrow-clockwise', () => { restorePool(ctx.draft, pool.section); ctx.touched(); ctx.redraw(); }))
    : h('div', { className: 'dhcp-pool-actions' },
      muted(pool.isNew ? 'Not saved yet.' : `The dhcp section "${pool.section}".`),
      h('button', { type: 'button', className: 'btn btn-sm btn-fl', disabled: !ctx.canEdit, title: `Stop serving ${pool.iface} and delete this pool`, onclick: () => { removePool(ctx.draft, pool.section); ctx.touched(); ctx.redraw(); } }, icon('trash'), pool.isNew ? 'Discard pool' : 'Remove pool'));
  const state = pool.isNew ? badge('new', 'info', 'not saved yet') : off ? badge('to be removed', 'danger') : null;
  const el = card(
    [h('span', { className: 'dhcp-chevron' }), icon('signpost-split'), h('span', {}, `Pool ${pool.iface}`), pool.info?.device ? badge(pool.info.device, '', 'the network device') : null, state, h('span', { className: 'sub' }, describe(ctx, pool))],
    h('div', { className: `card-body dhcp-groups${off ? ' dhcp-removed-pool' : ''}` }, actions, groups, extraOptions(pool.extra, '/etc/config/dhcp')),
    pool.isNew ? 'dhcp-new-pool' : '');
  return foldable(el, pool.section);
}

// Makes the card of a pool start unfolded (a pool that was just added: its options are what the user wants to see).
const unfold = section => unfolded.add(section);

// The row below the pools for adding one: the interfaces that have none, and Add pool.
export function addPoolBar(ctx) {
  const free = freeInterfaces(ctx.data, ctx.draft);
  if (!free.length) return h('p', { className: 'muted small dhcp-addpool' }, 'Every interface already has a pool.');
  const pick = h('select', { className: 'form-select form-select-sm', title: 'The interface to serve', disabled: !ctx.canEdit }, free.map(n => h('option', { value: n }, n)));
  const add = button('Add pool', 'plus-lg', () => { unfold(addPool(ctx.data, ctx.draft, pick.value)); ctx.touched(); ctx.redraw(); });
  add.disabled = !ctx.canEdit;
  return h('div', { className: 'dhcp-addpool' }, pick, add, h('span', { className: 'muted small' }, 'Starts as a server for DHCPv4, DHCPv6 and router advertisements; the options are then edited like the other pools.'));
}

// The card of the odhcpd daemon: its options, the server DUID (kept in the network config) and whether it runs.
// Foldable; the header sums up the main switches.
export function daemonCard(ctx) {
  const fields = [
    ...DAEMON_FIELDS.map(f => controlFor(ctx, f, `daemon:${f.key}`, ctx.draft.daemon)),
    ...GLOBAL_FIELDS.map(f => controlFor(ctx, f, `globals:${f.key}`, ctx.draft.globals)),
  ];
  const running = ctx.data.daemonRunning;
  const d = ctx.draft.daemon;
  const el = card(
    [h('span', { className: 'dhcp-chevron' }), icon('hdd-stack'), h('span', {}, 'odhcpd daemon'),
      running == null ? muted('state not available') : badge(running ? 'running' : 'not running', running ? 'success' : 'danger'),
      h('span', { className: 'sub' }, `${d.maindhcp ? 'main DHCPv4 server' : 'not the main DHCPv4 server'} · log level ${d.loglevel === '' ? `${DAEMON_FIELDS.find(f => f.key === 'loglevel').default} (default)` : d.loglevel}`)],
    h('div', {},
      legend(['The daemon that serves DHCPv4, DHCPv6 and router advertisements. These are the odhcpd section of /etc/config/dhcp, and the server DUID of /etc/config/network; the interface pools below are the dhcp sections.']),
      h('div', { className: 'card-body set-fields' }, fields),
      h('div', { className: 'card-body' }, extraOptions(ctx.data.daemon.extra, '/etc/config/dhcp'))));
  return foldable(el, 'daemon');
}
