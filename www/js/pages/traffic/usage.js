// The Usage tab of the Traffic page: how much data each host and each protocol moved in one nlbwmon accounting period
// (flab.traffic usage_periods and usage). The numbers are what nlbwmon has counted since the period started.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { button, card, emptyState, healthBanner, meter, muted, tile, tiles } from '../../core/ui.js';
import { legend } from '../../core/forms.js';
import { fmtBytes, fmtNum } from '../../core/format.js';
import { describePeriod, filterHosts, fmtPct, mergeHosts, protocolRows, share, sortHosts, usageFindings, usageTotals } from './model.js';

// The most host rows drawn before "Show all".
const ROW_LIMIT = 50;

// The note above the tiles: the accounting period the numbers belong to (its dates, its length so far and, for the running
// one, when it ends and the counters start again from zero), then what the numbers are and what they depend on. `period` is the
// reply's accounting window; without one (no data yet) only the second part is shown.
const note = period => {
  const p = describePeriod(period);
  return h('div', { className: 'tr-note' }, icon('info-circle'),
    h('div', {},
      p ? h('div', { className: 'tr-note-period' }, h('strong', {}, 'Accounting period: '), `${p.title} (${p.days}). ${p.detail}`) : null,
      h('div', {},
        'These are the bytes nlbwmon has counted since the selected period started, per local host. ',
        h('strong', {}, 'Download'), ' is what a host received and ', h('strong', {}, 'upload'), ' what it sent. ',
        'nlbwmon must be running to count: nothing is recorded while it is stopped, and only traffic of the networks listed as local_network in /etc/config/nlbwmon is counted. ',
        'A new period begins on the day set by database_interval there.')));
};

// A share bar with its percentage.
const shareCell = fraction => h('div', { className: 'tr-share' }, meter(fraction, 1, 'good'), h('span', {}, `${fmtPct(fraction * 100)}%`));

// The summary tiles of a period. `days` is how many days the period covers so far.
function summary(usage, hosts) {
  const t = usageTotals(usage);
  const top = hosts[0];
  const days = usage.window?.days;
  return tiles(
    tile('Period total', fmtBytes(t.total), days ? `downloaded and uploaded by local hosts · ${fmtBytes(t.total / days)} a day on average` : 'downloaded and uploaded by local hosts'),
    tile('Download', fmtBytes(t.rx), `${fmtPct(share(t.rx, t.total) * 100)}% of the total`),
    tile('Upload', fmtBytes(t.tx), `${fmtPct(share(t.tx, t.total) * 100)}% of the total`),
    tile('Top host', top ? (top.name ?? top.ips[0] ?? top.mac ?? top.key) : '–', top ? `${fmtBytes(top.total)} · ${fmtPct(share(top.total, t.total) * 100)}% of the total` : 'nothing counted'),
    tile('Hosts', fmtNum(hosts.length), 'devices with traffic in this period'),
    tile('Connections', fmtNum(t.conns), 'counted in this period'));
}

// A sortable column header: a click sorts by the column and a second click reverses it.
function sortHead(label, key, state, rerender, numeric) {
  const active = state.hsort.key === key;
  return h('th', { className: `sortable ${numeric ? 'tr-num' : ''}`, title: 'Sort', onclick: () => { state.hsort = { key, dir: active ? -state.hsort.dir : (key === 'name' ? 1 : -1) }; rerender(); } },
    label, active ? (state.hsort.dir > 0 ? ' ▲' : ' ▼') : '');
}

// The host cell: its name above its MAC and addresses, with a warning when its counters cannot be right.
function hostCell(host) {
  return h('div', {},
    h('strong', {}, host.name ?? host.ips[0] ?? host.mac ?? host.key),
    host.name || host.mac ? h('div', { className: 'mono muted' }, host.mac ?? '') : null,
    host.suspect ? h('div', { className: 'tr-suspect', title: 'In at least one direction this device averages fewer bytes per packet than the smallest IP packet, so nlbwmon\'s counts for it are wrong.' }, icon('exclamation-triangle'), 'counters look wrong') : null);
}

// The hosts card: one row per device (its IPv4 and IPv6 rows merged by MAC), filtered by the page's filter text,
// sorted by the clicked column, at most ROW_LIMIT drawn until "Show all".
function hostsCard(usage, hosts, state, rerender) {
  const t = usageTotals(usage);
  const list = sortHosts(filterHosts(hosts, state.hq), state.hsort);
  const shown = state.hall ? list : list.slice(0, ROW_LIMIT);
  const rows = shown.map(x => h('tr', {},
    h('td', {}, hostCell(x)),
    h('td', {}, x.ips.length ? h('div', { className: 'tr-addrs mono' }, x.ips.map(ip => h('div', {}, ip))) : muted('–')),
    h('td', { className: 'tr-num' }, fmtBytes(x.rx)),
    h('td', { className: 'tr-num' }, fmtBytes(x.tx)),
    h('td', { className: 'tr-num' }, h('strong', {}, fmtBytes(x.total))),
    h('td', {}, shareCell(share(x.total, t.total))),
    h('td', { className: 'tr-num' }, fmtNum(x.conns))));
  return card([icon('hdd-stack'), 'Hosts', h('span', { className: 'sub' }, `${fmtNum(list.length)} of ${fmtNum(hosts.length)} · one row per device, its IPv4 and IPv6 addresses together`)],
    h('div', {},
      h('div', { className: 'table-responsive' }, h('table', { className: 'table table-hover tr-usage' },
        h('thead', {}, h('tr', {},
          sortHead('Host', 'name', state, rerender, false), h('th', {}, 'Addresses'),
          sortHead('Download', 'download', state, rerender, true), sortHead('Upload', 'upload', state, rerender, true),
          sortHead('Total', 'total', state, rerender, true), h('th', {}, 'Share of the total'), sortHead('Connections', 'conns', state, rerender, true))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 7, className: 'muted' }, state.hq ? 'No host matches the filter' : 'No host has traffic in this period'))))),
      list.length > shown.length ? h('div', { className: 'tr-more' },
        h('span', { className: 'muted' }, `Showing the first ${shown.length} of ${list.length} hosts.`),
        button(`Show all ${list.length}`, null, () => { state.hall = true; rerender(); })) : null));
}

// The protocol card: the traffic of the period by application protocol as nlbwmon recognizes it (HTTPS, DNS, ...),
// or by transport and port where it does not.
function protocolsCard(l7) {
  const rows = protocolRows(l7?.rows ?? [], 12);
  const body = rows.map(p => h('tr', {},
    h('td', {}, h('strong', {}, p.label)),
    h('td', { className: 'tr-num' }, fmtBytes(p.rx)),
    h('td', { className: 'tr-num' }, fmtBytes(p.tx)),
    h('td', { className: 'tr-num' }, h('strong', {}, fmtBytes(p.total))),
    h('td', {}, shareCell(p.share)),
    h('td', { className: 'tr-num' }, fmtNum(p.conns))));
  return card([icon('diagram-3'), 'Protocols', h('span', { className: 'sub' }, 'what the traffic was, by application protocol')],
    h('div', {},
      legend(['nlbwmon names a flow after its application protocol (HTTPS, DNS, ...) from /usr/share/nlbwmon/protocols; a flow it does not know is listed by transport and port ("TCP 8443").']),
      h('div', { className: 'table-responsive' }, h('table', { className: 'table table-hover tr-usage' },
        h('thead', {}, h('tr', {}, ['Protocol', 'Download', 'Upload', 'Total', 'Share of the total', 'Connections'].map((c, i) => h('th', { className: i === 1 || i === 2 || i === 3 || i === 5 ? 'tr-num' : '' }, c)))),
        h('tbody', {}, body.length ? body : h('tr', {}, h('td', { colSpan: 6, className: 'muted' }, 'Nothing counted in this period')))))));
}

// The nodes of the Usage tab. `data` is { status, periods, period, hosts, l7 } as loaded by the page; the tab is not
// offered without nlbw, but a poll can still arrive after nlbw was removed, so that case has its own message.
export function usageView(data, state, rerender) {
  if (!data.status?.nlbw) return [emptyState(
    'nlbw is not installed on this router, so per-host usage is not available.',
    h('a', { href: '#services', className: 'btn btn-sm btn-outline-secondary' }, 'Open Services'))];
  const findings = usageFindings(data.status, data.hosts);
  if (!data.periods?.running || !data.hosts?.ok) return [healthBanner(findings, ''), note()];
  const hosts = mergeHosts(data.hosts.rows, data.hosts.names);
  return [
    note(data.hosts.window),
    summary(data.hosts, hosts),
    healthBanner(findings, `nlbwmon is counting: ${data.period === 'current' ? 'the current period' : `the period from ${data.period}`} holds traffic of ${fmtNum(hosts.length)} hosts.`),
    hostsCard(data.hosts, hosts, state, rerender),
    protocolsCard(data.l7),
  ];
}
