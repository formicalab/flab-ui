// The settings cards of the DHCP page: one per interface pool (a `dhcp` section of /etc/config/dhcp) and one for
// the odhcpd daemon itself. Their controls come from the option tables in schema.js through core/forms.js; a
// pool's options are in collapsible groups (services, DHCPv4, DHCPv6, router advertisements, ...) so the page
// stays readable.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, muted } from '../../core/ui.js';
import { fieldRow, legend } from '../../core/forms.js';
import { DAEMON_FIELDS, POOL_FIELDS, POOL_GROUPS } from './schema.js';
import { poolRange, poolValue } from './model.js';

// Which option groups are expanded, kept across redraws: id `<section>:<group>` to open or closed.
const opened = new Map();

// Connects the control of one field to the draft, under the control name `id` (also used to mark errors).
function controlFor(ctx, f, id, values) {
  return fieldRow(f, {
    id,
    get: () => values[f.key],
    set: v => { values[f.key] = v; },
    disabled: !ctx.canEdit,
    touched: ctx.touched,
    redraw: ctx.redraw,
    register: (el, index) => { if (index == null) ctx.inputs[id] = el; else (ctx.inputs[id] ??= [])[index] = el; },
  });
}

// The one-line description of a pool in its header: subnet, then each service with its mode.
function describe(ctx, pool) {
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

// The card of one pool.
export function poolCard(ctx, pool) {
  const groups = POOL_GROUPS.map(g => {
    const id = `${pool.section}:${g.id}`;
    const fields = POOL_FIELDS.filter(f => f.group === g.id).map(f => controlFor(ctx, f, `pool:${pool.section}:${f.key}`, ctx.draft.pools[pool.section]));
    return h('details', { className: 'dhcp-group', open: opened.get(id) ?? Boolean(g.open), ontoggle: e => opened.set(id, e.target.open) },
      h('summary', {}, g.title),
      h('div', { className: 'dhcp-group-body' }, h('p', { className: 'muted small' }, g.legend), h('div', { className: 'set-fields' }, fields)));
  });
  return card(
    [icon('signpost-split'), h('span', {}, `Pool ${pool.iface}`), pool.info?.device ? badge(pool.info.device, '', 'the network device') : null, h('span', { className: 'sub' }, describe(ctx, pool))],
    h('div', { className: 'card-body dhcp-groups' }, groups));
}

// The card of the odhcpd daemon: its options and whether it runs.
export function daemonCard(ctx) {
  const fields = DAEMON_FIELDS.map(f => controlFor(ctx, f, `daemon:${f.key}`, ctx.draft.daemon));
  const running = ctx.data.daemonRunning;
  return card(
    [icon('hdd-stack'), h('span', {}, 'odhcpd daemon'), running == null ? muted('state not available') : badge(running ? 'running' : 'not running', running ? 'success' : 'danger')],
    h('div', {},
      legend(['The daemon that serves DHCPv4, DHCPv6 and router advertisements. These are the odhcpd section of /etc/config/dhcp; the interface pools above are its dhcp sections.']),
      h('div', { className: 'card-body set-fields' }, fields)));
}
