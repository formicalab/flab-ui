// The Forwarding card of the DNS page: where the resolver sends the queries it cannot answer itself. First the default
// forwarders (the "." zone), then the conditional zones, which may be many (one router has about ninety, nearly all to the
// same two servers). The zones can be grouped by the servers they share ("89 zones → a, b"), filtered by text and cut to a
// first screen with "Show all".
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, muted, section } from '../../core/ui.js';
import { fmtNum } from '../../core/format.js';
import { defaultForwarders, engineName, filterForwards, flagWords, forwardSources, groupForwards, isPublicIp, serverAddress, subject, zoneForwards } from './model.js';

// The most rows drawn before "Show all".
const ROW_LIMIT = 12;

// Whether the forwarders can be changed. Nothing is editable yet, so the buttons that would do it are drawn disabled; an
// editing page switches them on, opens the zone form (ZONE_FIELDS, drawn with core/forms.js) and saves through UCI.
const canEdit = false;

// Where a forwarder is defined and what can be done with it: a UCI one (an Unbound zone section, a dnsmasq `server` entry)
// has Edit and Remove buttons; one that only Unbound's extension file defines has none and says so. A row without a source
// (a reply from an older plugin) shows nothing.
function sourceNodes(item, engine) {
  if (item.source === 'file') {
    return [h('span', { className: 'dns-src-file', title: 'Defined in /etc/unbound/unbound_ext.conf. This page cannot change it: edit that file.' }, icon('lock'), 'unbound_ext.conf')];
  }
  if (item.source !== 'uci') return [];
  const where = engine === 'dnsmasq' ? 'A server entry of the dnsmasq section in /etc/config/dhcp.' : `The zone section ${item.section ?? ''} of /etc/config/unbound.`;
  const act = (name, label) => h('button', { type: 'button', className: 'btn btn-sm btn-fl dns-act-btn', disabled: !canEdit, title: label, 'aria-label': label }, icon(name));
  return [badge('UCI', 'info', where), act('pencil', 'Edit'), act('trash', 'Remove')];
}

// The "Defined in" cell of a table row.
const sourceCell = (item, engine) => h('td', { className: 'dns-src' }, sourceNodes(item, engine));

// A server address in mono type, with a TLS or clear-text badge when that is known.
function serverChip(addr, tls, engine) {
  const clear = isPublicIp(serverAddress(addr)) && (engine === 'dnsmasq' || tls === false);
  return h('span', { className: 'dns-server' }, h('span', { className: 'mono' }, addr),
    tls === true ? badge('TLS', 'success', 'Queries to this server are encrypted (DNS over TLS).') : null,
    clear ? badge('clear text', 'warning', 'Queries to this public server are not encrypted.') : null);
}

// The servers of one row as chips.
const serverList = (servers, tls, engine) => h('div', { className: 'dns-servers' }, servers.map(s => serverChip(s, tls, engine)));

// The flags of one row as badges (their meaning is the tooltip).
const flagBadges = flags => flags.map(f => badge(flagWords([f])[0], 'info'));

// The default forwarders block: the servers of the "." zone, or what happens without them.
function defaultBlock(data, engine) {
  const servers = defaultForwarders(data);
  const row = (data.forwards ?? []).find(f => f.zone === '.');
  const none = engine === 'unbound'
    ? 'None: Unbound resolves names itself, starting from the root servers.'
    : 'None configured: dnsmasq asks the resolvers learned from the WAN (see Upstream from the WAN).';
  return section('Default forwarders', servers.length ? serverList(servers, row.tls, engine) : muted(none),
    row ? h('div', { className: 'dns-src dns-src-block' }, sourceNodes(row, engine)) : null);
}

// The conditional-zone table body for the current filter: groups (or single zones) and the "Show all" row.
function zoneRows(rows, state, rerender, engine) {
  const filtered = filterForwards(rows, state.fq);
  if (!filtered.length) return h('div', { className: 'muted dns-pad' }, state.fq ? 'No zone matches the filter.' : 'No conditional zones.');
  const grouped = state.grouped && filtered.length > 1;
  const items = grouped ? groupForwards(filtered) : filtered;
  const shown = state.fall ? items : items.slice(0, ROW_LIMIT);
  const filtering = state.fq.trim() !== '';
  const body = [];
  for (const item of shown) {
    if (!grouped) {
      body.push(h('tr', {}, h('td', { className: 'mono' }, item.zone), h('td', {}, serverList(item.servers, item.tls, engine)), h('td', {}, flagBadges(item.flags)), sourceCell(item, engine)));
      continue;
    }
    if (item.zones.length === 1) {
      body.push(h('tr', {}, h('td', { className: 'mono' }, item.zones[0]), h('td', {}, serverList(item.servers, item.tls, engine)), h('td', {}, flagBadges(item.flags)), sourceCell(item, engine)));
      continue;
    }
    const open = filtering || state.open.has(item.key);
    const toggle = h('button', {
      type: 'button', className: 'btn btn-sm btn-fl dns-toggle', ariaExpanded: String(open),
      onclick: () => { if (state.open.has(item.key)) state.open.delete(item.key); else state.open.add(item.key); rerender(); },
    }, icon(open ? 'chevron-up' : 'chevron-down'), `${fmtNum(item.zones.length)} zones`);
    body.push(h('tr', { className: 'dns-group' }, h('td', {}, toggle), h('td', {}, serverList(item.servers, item.tls, engine)), h('td', {}, flagBadges(item.flags)), sourceCell(item, engine)));
    if (open) body.push(h('tr', { className: 'dns-zones-row' }, h('td', { colSpan: 4 }, h('div', { className: 'dns-zones mono' }, item.zones.map(z => h('span', {}, z))))));
  }
  const unit = grouped ? 'groups' : 'zones';
  return h('div', {},
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover dns-table' },
      h('thead', {}, h('tr', {}, h('th', {}, grouped ? 'Zones' : 'Zone'), h('th', {}, 'Forwarded to'), h('th', {}, 'Flags'), h('th', {}, 'Defined in'))),
      h('tbody', {}, body))),
    items.length > shown.length ? h('div', { className: 'dns-more' },
      h('span', { className: 'muted' }, `Showing the first ${shown.length} of ${fmtNum(items.length)} ${unit}.`),
      h('button', { type: 'button', className: 'btn btn-sm btn-fl', onclick: () => { state.fall = true; rerender(); } }, `Show all ${fmtNum(items.length)}`)) : null);
}

// The conditional zones block: a filter box, the grouping switch and the table. The filter redraws only the table, so the
// text box keeps its focus while typing.
function zonesBlock(data, state, rerender, engine) {
  const rows = zoneForwards(data);
  if (!rows.length) return section('Conditional zones', muted('None: every query that is not answered locally goes to the default forwarders.'));
  const holder = h('div', {});
  const draw = () => holder.replaceChildren(zoneRows(rows, state, rerender, engine));
  const input = h('input', {
    className: 'form-control form-control-sm dns-input', type: 'search', placeholder: 'Filter zones or servers…', value: state.fq,
    oninput: e => { state.fq = e.target.value; state.fall = false; draw(); },
  });
  const groupBtn = h('button', { type: 'button', className: 'btn btn-sm btn-fl', onclick: () => { state.grouped = !state.grouped; state.fall = false; rerender(); } },
    state.grouped ? 'List every zone' : 'Group by servers');
  draw();
  return section(`Conditional zones (${fmtNum(rows.length)})`,
    h('div', { className: 'dns-legend' }, 'A query for a name under one of these zones goes to that zone\'s own servers instead of the default forwarders. Zones that share the same servers can be grouped into one line.'),
    h('div', { className: 'dns-toolbar dns-field' }, h('div', { className: 'search' }, icon('search'), input), groupBtn), holder);
}

// The line at the top of the card: whether the forwarders can be changed, where they are defined, and the (disabled) button
// that will add one.
function editBar(data, engine) {
  const { uci, file } = forwardSources(data);
  const text = engine === 'dnsmasq'
    ? 'Read only for now. Every forwarder is a "server" entry of the dnsmasq section in /etc/config/dhcp, so each can be changed once editing is switched on.'
    : `Read only for now. ${fmtNum(uci)} forwarder${uci === 1 ? ' is' : 's are'} defined in UCI (zone sections of /etc/config/unbound) and can be changed once editing is switched on${file ? `; ${fmtNum(file)} only exist in /etc/unbound/unbound_ext.conf and stay read only here` : ''}.`;
  return h('div', { className: 'dns-legend dns-fwd-bar' }, h('span', {}, text),
    h('button', { type: 'button', className: 'btn btn-sm btn-fl', disabled: !canEdit, title: 'Add a forwarder' }, icon('plus-lg'), 'Add forwarder'));
}

// The Forwarding card.
export function forwardingCard(data, state, rerender) {
  const engine = subject(data);
  const count = (data.forwards ?? []).length;
  const body = [
    editBar(data, engine),
    data.engine === 'unbound' && data.engines?.unbound?.control === false
      ? h('div', { className: 'dns-legend' }, 'unbound-control is not available, so these forwarders come from Unbound\'s generated configuration and may not be what the running process uses.') : null,
    h('div', { className: 'dns-pad' }, defaultBlock(data, engine)),
    h('div', { className: 'dns-pad dns-top' }, zonesBlock(data, state, rerender, engine)),
  ];
  return card([icon('signpost-split'), 'Forwarding', h('span', { className: 'sub' }, `${engineName(engine)} · ${fmtNum(count)} forward ${count === 1 ? 'rule' : 'rules'}${data.truncated?.forwards ? ' (cut)' : ''}`)], h('div', {}, body));
}
