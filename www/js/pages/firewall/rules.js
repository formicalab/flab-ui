// The rule tables: what is reachable from the Internet, the traffic rules and the port forwards, each with the
// live hit counters nftables keeps for it.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card } from '../../core/ui.js';
import { fmtBytes, fmtNum } from '../../core/format.js';
import { describeMatch, packetsPerSec, fmtPps, ruleKey, wanZones } from './util.js';

const muted = t => h('span', { className: 'muted' }, t);

const ACTION = { ACCEPT: 'success', REJECT: 'warning', DROP: 'warning' };
const actionBadge = t => badge(t.toLowerCase(), ACTION[t] ?? 'info');

const zoneChip = (z, fallback) => h('span', { className: `fw-chip ${z ? '' : 'router'}` }, z === '*' ? 'any' : z ?? fallback);
const fromTo = (a, b, fromFallback = 'router', toFallback = 'router') => h('div', { className: 'fw-flow' }, zoneChip(a, fromFallback), '›', zoneChip(b, toFallback));

// Packets and bytes seen, and a live rate while something is flowing.
function hitsCell(r) {
  if (!r.hits) return muted(r.enabled ? 'not loaded' : '–');
  const pps = fmtPps(packetsPerSec(ruleKey(r)));
  if (!r.hits.packets) return muted('no hits');
  return h('div', {}, h('div', {}, pps ? h('span', { className: 'dot up' }) : null, h('b', {}, fmtNum(r.hits.packets)), ' packets'),
    h('div', { className: 'muted small' }, fmtBytes(r.hits.bytes), pps ? ` · ${pps}` : ''));
}

const nameCell = r => h('div', {}, h('strong', {}, r.name ?? r.key), r.name ? null : h('div', { className: 'muted small' }, 'unnamed'),
  r.scheduled ? h('div', { className: 'muted small' }, 'time-restricted') : null);

function ruleRow(r, i) {
  return h('tr', { className: r.enabled ? '' : 'fw-off' },
    h('td', { className: 'num muted' }, i + 1),
    h('td', {}, nameCell(r)),
    h('td', {}, fromTo(r.src, r.dest)),
    h('td', {}, describeMatch(r)),
    h('td', {}, actionBadge(r.target), r.enabled ? null : [' ', badge('disabled')]),
    h('td', {}, hitsCell(r)));
}

function redirectRow(r, i) {
  const to = [].concat(r.dest_ip ?? []).join(', ');
  return h('tr', { className: r.enabled ? '' : 'fw-off' },
    h('td', { className: 'num muted' }, i + 1),
    h('td', {}, nameCell(r), r.kind === 'nat' ? h('div', { className: 'muted small' }, 'NAT rule') : null),
    h('td', {}, fromTo(r.src, r.dest, 'any', 'router')),
    h('td', {}, [r.proto.map(p => p.toUpperCase()).join('/'), r.src_dport.length ? ` ${r.src_dport.join(', ')}` : '', r.src_dip.length ? ` on ${r.src_dip.join(', ')}` : '',
      to ? ` → ${to}${r.dest_port.length ? `:${r.dest_port.join(', ')}` : ''}` : ''].join('')),
    h('td', {}, actionBadge(r.target), r.enabled ? null : [' ', badge('disabled')]),
    h('td', {}, hitsCell(r)));
}

const table = (cols, rows, empty) => h('div', { className: 'grid-wrap' }, h('table', { className: 'table fw-table' },
  h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
  h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, empty)))));

// Everything a stranger on the Internet can reach: accepting rules with a WAN-facing source, and port forwards.
export function exposureCard(fw) {
  const wan = wanZones(fw).map(z => z.name);
  const exposed = [
    ...fw.rules.filter(r => r.enabled && r.target === 'ACCEPT' && wan.includes(r.src)),
    ...fw.redirects.filter(r => r.enabled && r.kind !== 'nat' && wan.includes(r.src)),
  ];
  const rows = exposed.map(r => h('tr', {},
    h('td', {}, nameCell(r)),
    h('td', {}, r.kind === 'redirect' ? 'port forward' : 'rule'),
    h('td', {}, r.kind === 'redirect' ? `${r.proto.map(p => p.toUpperCase()).join('/')} ${r.src_dport.join(', ')}` : describeMatch(r)),
    h('td', {}, r.kind === 'redirect' ? `${[].concat(r.dest_ip ?? []).join(', ') || r.dest || 'router'}${r.dest_port.length ? `:${r.dest_port.join(', ')}` : ''}` : (r.dest === '*' ? 'any zone' : r.dest ? `zone ${r.dest}` : 'the router')),
    h('td', {}, hitsCell(r))));
  const cols = ['Name', 'Kind', 'What', 'Reaches', 'Hits'];
  return card([icon('globe2'), h('span', {}, `Reachable from the Internet${wan.length ? ` (${wan.join(', ')})` : ''}`),
    h('span', { className: 'sub' }, wan.length ? `${exposed.length} entr${exposed.length === 1 ? 'y' : 'ies'} accept new traffic from outside` : 'no zone does NAT')],
  table(cols, rows, wan.length ? 'Nothing is open from the Internet.' : 'No zone masquerades traffic, so no zone is treated as facing the Internet.'));
}

export function rulesCard(fw) {
  const cols = ['#', 'Name', 'From › to', 'Match', 'Action', 'Hits'];
  return card([icon('list-ul'), h('span', {}, 'Traffic rules'), h('span', { className: 'sub' }, `${fw.rules.length} rules in configuration order · a rule with no destination is about the router itself`)],
    table(cols, fw.rules.map(ruleRow), 'No traffic rules are configured.'));
}

export function redirectsCard(fw) {
  const cols = ['#', 'Name', 'From › to', 'Forwards', 'Action', 'Hits'];
  return card([icon('arrow-left-right'), h('span', {}, 'Port forwards and NAT'), h('span', { className: 'sub' }, `${fw.redirects.length} configured`)],
    table(cols, fw.redirects.map(redirectRow), 'No port forwards or NAT rules are configured.'));
}
