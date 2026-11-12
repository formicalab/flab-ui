// The Forwarding card of the DNS page: where the resolver sends the queries it cannot answer itself. The card is folded
// until its header is clicked, and holds one flat table of every forwarder (the default "." zone first, then the
// conditional zones, which may be many: one router has about ninety) that a text filter narrows down.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, muted, section } from '../../core/ui.js';
import { fmtNum } from '../../core/format.js';
import { foldCard } from './fold.js';
import { defaultForwarders, engineName, filterForwards, flagWords, forwardSources, isPublicIp, serverAddress, sortForwards, subject, wanNote, wanResolvers } from './model.js';

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

// What happens to a query when no default forwarder is set; empty when the "." row has servers.
function noDefaultNote(data, engine) {
  if (defaultForwarders(data).length) return null;
  return engine === 'unbound'
    ? 'No default forwarders: Unbound resolves names itself, starting from the root servers.'
    : 'No default forwarders: dnsmasq asks the resolvers learned from the WAN (see Upstream from the WAN).';
}

// The zone cell of a row: the zone in mono type; the default zone says what it stands for.
const zoneCell = zone => h('td', {}, zone === '.' ? [h('span', { className: 'mono' }, '.'), ' ', muted('(default: every other name)')] : h('span', { className: 'mono' }, zone));

// The table body for the current filter.
function forwardRows(rows, state, engine) {
  const filtered = filterForwards(rows, state.fq);
  if (!filtered.length) return h('div', { className: 'muted dns-pad' }, state.fq ? 'No forwarder matches the filter.' : 'No forwarders.');
  const body = sortForwards(filtered).map(f =>
    h('tr', {}, zoneCell(f.zone), h('td', {}, serverList(f.servers, f.tls, engine)), h('td', {}, flagBadges(f.flags)), sourceCell(f, engine)));
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover dns-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Zone'), h('th', {}, 'Forwarded to'), h('th', {}, 'Flags'), h('th', {}, 'Defined in'))),
    h('tbody', {}, body)));
}

// The filter box and the table. The filter redraws only the table, so the text box keeps its focus while typing.
function forwardList(data, state, engine) {
  const rows = data.forwards ?? [];
  const note = noDefaultNote(data, engine);
  if (!rows.length) return h('div', { className: 'dns-pad' }, muted(note ?? 'No forwarders.'));
  const holder = h('div', {});
  const draw = () => holder.replaceChildren(forwardRows(rows, state, engine));
  const input = h('input', {
    className: 'form-control form-control-sm dns-input', type: 'search', placeholder: 'Filter zones or servers…', value: state.fq,
    oninput: e => { state.fq = e.target.value; draw(); },
  });
  draw();
  return h('div', { className: 'dns-pad' },
    h('div', { className: 'dns-toolbar dns-field' }, h('div', { className: 'search' }, icon('search'), input)),
    note ? h('p', { className: 'muted small' }, note) : null, holder);
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

// The resolvers the WAN connection handed to the router, each marked as in use or not, and a sentence that says whether the
// resolver really asks them.
function wanBlock(data) {
  const w = wanResolvers(data);
  const chips = w.servers.map(s => h('span', { className: 'dns-server' }, h('span', { className: 'mono' }, s.addr),
    s.used ? badge('in use', 'success', 'The resolver asks this server.') : badge('not used', '', 'The resolver does not ask this server.')));
  return section('Resolvers from the WAN',
    h('p', { className: 'muted small dns-area-legend' }, wanNote(data)),
    chips.length ? h('div', { className: 'dns-servers' }, chips) : null);
}

// The words for the header: whether the WAN resolvers are really asked.
const wanWords = { used: 'WAN resolvers in use', partly: 'some WAN resolvers in use', unused: 'WAN resolvers not used' };

// The Forwarding card: folded until the user opens it (see fold.js). The header holds the engine, the number of rules and
// whether the WAN's resolvers are used; the body the WAN resolvers and the table of forwarders.
export function forwardingCard(data, state) {
  const engine = subject(data);
  const count = (data.forwards ?? []).length;
  const wan = wanWords[wanResolvers(data).verdict];
  const body = [
    editBar(data, engine),
    data.engine === 'unbound' && data.engines?.unbound?.control === false
      ? h('div', { className: 'dns-legend' }, 'unbound-control is not available, so these forwarders come from Unbound\'s generated configuration and may not be what the running process uses.') : null,
    h('div', { className: 'dns-pad' }, wanBlock(data)),
    h('div', { className: 'dns-top' }, forwardList(data, state, engine)),
  ];
  return foldCard(state, 'forwarding', [icon('signpost-split'), 'Forwarding', h('span', { className: 'sub' }, `${engineName(engine)} · ${fmtNum(count)} forward ${count === 1 ? 'rule' : 'rules'}${data.truncated?.forwards ? ' (cut)' : ''}${wan ? ` · ${wan}` : ''}`)], h('div', {}, body));
}
