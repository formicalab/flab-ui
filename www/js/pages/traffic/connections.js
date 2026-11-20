// The Connections tab of the Traffic page: the router's connection tracking table (flab.traffic connections), what it
// holds by protocol, state and host, and the entries themselves with the translated address when NAT changed it.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, card, healthBanner, muted, tile, tiles } from '../../core/ui.js';
import { legend } from '../../core/forms.js';
import { fmtBytes, fmtNum } from '../../core/format.js';
import {
  connectionFindings, endpoint, fmtPct, fmtSize, fmtTimeout, hostName, natSummary, protoLabel, protocolSummary, stateBadges,
  stateCount, tableLoad,
} from './model.js';

// The most entries drawn before "Show all".
const ROW_LIMIT = 100;

// The summary tiles of the table.
function summary(data) {
  const a = data.aggregates;
  const ps = protocolSummary(a);
  const load = tableLoad(data.count, data.max);
  const top = a.sources.by_connections[0];
  const lostShare = data.parsed ? a.unreplied / data.parsed * 100 : 0;
  return tiles(
    tile('Connections', data.count != null ? fmtNum(data.count) : fmtNum(data.total), data.max ? `of ${fmtNum(data.max)} · ${fmtPct(load.pct)}% used` : 'no limit reported', load.level === 'bad' ? 'text-danger' : load.level === 'warn' ? 'text-warning' : ''),
    tile('By protocol', `${fmtNum(ps.tcp)} TCP`, `${fmtNum(ps.udp)} UDP · ${fmtNum(ps.icmp)} ICMP · ${fmtNum(ps.other)} other`),
    tile('Established', fmtNum(stateCount(a, 'ESTABLISHED')), `${fmtNum(stateCount(a, 'TIME_WAIT'))} waiting to close`),
    tile('Unanswered', fmtNum(a.unreplied), `${fmtPct(lostShare)}% never got a reply`, a.unreplied && lostShare >= 25 ? 'text-warning' : ''),
    tile('Translated (NAT)', fmtNum(a.nat), 'an address or port was rewritten'),
    tile('Busiest source', top ? hostName(data.names, top.addr) : '–', top ? `${fmtNum(top.connections)} connections` : 'nothing tracked'));
}

// One small list of hosts for a top-hosts card: the host (name above its address), its connections and, when the
// router keeps byte counters, its traffic. A click filters the table to that host.
function hostList(caption, list, names, acct, pick) {
  const rows = list.map(x => h('tr', { className: 'tr-pick', tabIndex: 0, title: 'Show only this host', onclick: () => pick(x.addr), onkeydown: e => { if (e.key === 'Enter') pick(x.addr); } },
    h('td', {}, names[x.addr] ? h('div', {}, h('strong', {}, names[x.addr]), h('div', { className: 'mono muted' }, x.addr)) : h('span', { className: 'mono' }, x.addr)),
    h('td', { className: 'tr-num' }, fmtNum(x.connections), x.unreplied ? h('div', {}, badge(`${fmtNum(x.unreplied)} unanswered`, 'warning')) : null),
    acct ? h('td', { className: 'tr-num' }, fmtBytes(x.bytes)) : null));
  return h('div', { className: 'col-12 col-lg-6' },
    h('h3', { className: 'tr-caption' }, caption),
    h('div', { className: 'table-responsive' }, h('table', { className: 'table table-hover tr-hosts' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Host'), h('th', { className: 'tr-num' }, 'Connections'), acct ? h('th', { className: 'tr-num' }, 'Traffic') : null)),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: acct ? 3 : 2, className: 'muted' }, 'Nothing to show'))))));
}

// A card with the busiest hosts as sources (who opens connections) or destinations (who is contacted): by number of
// connections and by traffic.
function topCard(title, lists, data, pick) {
  const acct = data.acct !== false;
  return card([icon(title === 'Busiest sources' ? 'arrow-up' : 'arrow-down'), title, h('span', { className: 'sub' }, `of the ${fmtNum(data.parsed)} entries analyzed`)],
    h('div', { className: 'card-body' },
      h('div', { className: 'row g-4' },
        hostList('By connections', lists.by_connections, data.names, acct, pick),
        acct ? hostList('By traffic', lists.by_bytes, data.names, acct, pick) : null)));
}

// The original-direction cell of an entry: both endpoints with their ports, and below them the names the router knows.
function flowCell(e, names) {
  const named = names[e.src] || names[e.dst];
  return h('div', {},
    h('div', { className: 'mono' }, `${endpoint(e.src, e.sport)} → ${endpoint(e.dst, e.dport)}`),
    named ? h('div', { className: 'muted small' }, `${names[e.src] ?? e.src} → ${names[e.dst] ?? e.dst}`) : null);
}

// The translated cell: which kind of NAT changed the entry and what the other side sees.
function natCell(e) {
  const n = natSummary(e);
  if (!n) return muted('–');
  const label = { source: 'SNAT', destination: 'DNAT', both: 'SNAT + DNAT' }[n.kind];
  const title = { source: 'Source NAT (masquerade): the source address or port was rewritten', destination: 'Destination NAT (port forward): the destination address or port was rewritten', both: 'Both the source and the destination were rewritten' }[n.kind];
  return h('div', {}, badge(label, 'info', title), h('div', { className: 'mono small' }, n.text));
}

// The packets and bytes cell of an entry (original direction ↑, reply ↓), or a dash when the router keeps no counters.
function sizeCell(e) {
  const s = fmtSize(e);
  if (!s) return muted('–');
  return h('div', {}, h('div', {}, s.bytes), h('div', { className: 'muted small' }, `${s.packets} packets`));
}

// The entries table card: the entries the router returned (already filtered, sorted and cut), at most ROW_LIMIT
// drawn until "Show all".
function entriesCard(data, state, rerender) {
  const shown = state.all ? data.entries : data.entries.slice(0, ROW_LIMIT);
  const rows = shown.map(e => h('tr', { className: (e.flags ?? []).includes('UNREPLIED') ? 'tr-lost' : '' },
    h('td', {}, h('div', {}, badge(e.family === 6 ? 'v6' : 'v4', ''), ' ', protoLabel(e))),
    h('td', {}, flowCell(e, data.names)),
    h('td', {}, natCell(e)),
    h('td', {}, h('div', { className: 'tr-badges' }, stateBadges(e).map(b => badge(b.text, b.kind)))),
    h('td', { className: 'tr-num' }, fmtTimeout(e)),
    h('td', {}, sizeCell(e))));
  const sorted = { bytes: 'most traffic first', packets: 'most packets first', timeout: 'longest remaining life first' }[data.request.sort];
  return card([icon('list-ul'), 'Connections', h('span', { className: 'sub' }, `${fmtNum(data.entries.length)} shown of ${fmtNum(data.matched)} matching · ${sorted}`)],
    h('div', {},
      legend([[
        'One row per tracked connection. ', h('strong', {}, 'Original'), ' is what the sender used (↑ is the direction of the first packet, ↓ the replies); ',
        h('strong', {}, 'Translated'), ' appears when the router rewrote an address or port: SNAT is the masquerade of the LAN behind the WAN address, DNAT a port forward from outside. ',
        h('strong', {}, 'UNREPLIED'), ' marks connections that never got an answer. The remaining life is the kernel timeout; a flow in the flow table is offloaded and has none.']]),
      h('div', { className: 'table-responsive' }, h('table', { className: 'table table-hover tr-conns' },
        h('thead', {}, h('tr', {}, ['Protocol', 'Original', 'Translated (NAT)', 'State', 'Time left', data.acct === false ? 'Size (counters off)' : 'Size'].map(c => h('th', {}, c)))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 6, className: 'muted' }, state.q || state.proto !== 'all' || state.scope !== 'all' ? 'No connection matches the filter' : 'The table is empty'))))),
      data.entries.length > shown.length ? h('div', { className: 'tr-more' },
        h('span', { className: 'muted' }, `Showing the first ${shown.length} of ${data.entries.length} entries.`),
        button(`Show all ${data.entries.length}`, null, () => { state.all = true; rerender(); })) : null,
      data.matched > data.entries.length ? h('div', { className: 'tr-more' },
        h('span', { className: 'muted' }, `The router returned ${fmtNum(data.entries.length)} of the ${fmtNum(data.matched)} matching entries; raise the row limit or narrow the filter to see others.`)) : null));
}

// The nodes of the Connections tab. `data` is the flab.traffic connections reply and `pick` filters the table to one
// host (a click on a host in the top lists).
export function connectionsView(data, state, rerender, pick) {
  if (!data.ok) return [healthBanner([{ level: 'bad', text: data.error }], '')];
  const findings = connectionFindings(data);
  if (!data.available) return [healthBanner(findings, '')];
  return [
    summary(data),
    healthBanner(findings, 'The connection table looks healthy.'),
    h('div', { className: 'row g-3' },
      h('div', { className: 'col-12 col-xxl-6' }, topCard('Busiest sources', data.aggregates.sources, data, pick)),
      h('div', { className: 'col-12 col-xxl-6' }, topCard('Busiest destinations', data.aggregates.destinations, data, pick))),
    entriesCard(data, state, rerender),
  ];
}
