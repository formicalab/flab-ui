// The Live tab of the Traffic page: how much each interface carries right now, and the totals.
//
// The counters come from flab.network (the same call, and the same rate tracker, as the Wired network page: see
// network/shared.js and network/util.js), so rates are derived in the browser from successive polls and a short
// history is kept per interface. Interfaces are whatever the router reports; nothing is named here.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, healthBanner, meter, muted, sparkline, tile, tiles } from '../../core/ui.js';
import { fmtBytes, fmtLine, fmtNum } from '../../core/format.js';
import { fmtSpeed, traffic } from '../network/util.js';
import { busiestRow, deviceRows, fmtPct, isLeaf, kindLabel, liveFindings, liveTotals, orderRows, tableLoad, utilization, wanLinks } from './model.js';

// The most interface rows drawn before "Show all".
const ROW_LIMIT = 40;

// The summary tiles: the WAN rate, everything the interfaces carry, the busiest interface, the connection table's
// fill and what the WAN moved since boot. `wan` is the WAN links, `rows` the device rows.
function summary(rows, wan, status) {
  const totals = liveTotals(rows, traffic);
  const busy = busiestRow(rows, traffic);
  const wanRows = wan.map(w => rows.find(r => r.name === w.row)).filter(Boolean);
  let wrx = 0, wtx = 0, sinceRx = 0, sinceTx = 0;
  for (const r of wanRows) {
    const t = traffic(r.name);
    wrx += t.rxNow ?? 0;
    wtx += t.txNow ?? 0;
    sinceRx += r.rxBytes ?? 0;
    sinceTx += r.txBytes ?? 0;
  }
  const load = tableLoad(status?.count, status?.max);
  const wanName = wan.map(w => w.iface).join(', ');
  return tiles(
    wanRows.length
      ? tile('WAN throughput', `↓ ${fmtLine(wrx)}`, `↑ ${fmtLine(wtx)} · ${wanName} (${wanRows.map(r => r.name).join(', ')})`)
      : tile('WAN throughput', wan.length ? 'not measured' : 'no WAN found', wan.length ? `${wanName}: its device has no counters here` : 'no interface has a default route'),
    tile('All interfaces', `↓ ${fmtLine(totals.rx)}`, `↑ ${fmtLine(totals.tx)} · ${totals.n} ports (routed traffic counts on both sides)`),
    tile('Busiest interface', busy ? busy.row.name : 'idle', busy ? `↓ ${fmtLine(busy.rx)} · ↑ ${fmtLine(busy.tx)}` : 'no traffic right now'),
    tile('Connections', status?.count != null ? fmtNum(status.count) : 'n/a', status?.max ? `of ${fmtNum(status.max)} · ${fmtPct(load.pct)}% used` : 'no connection tracking', load.level === 'bad' ? 'text-danger' : load.level === 'warn' ? 'text-warning' : ''),
    tile('WAN since boot', wanRows.length ? `↓ ${fmtBytes(sinceRx)}` : '–', wanRows.length ? `↑ ${fmtBytes(sinceTx)} · the counters of the WAN device` : 'no WAN counters'));
}

// The link cell of a row: a badge with the speed when the carrier is up, or a neutral "down" (an unplugged port is normal).
function linkCell(r) {
  if (r.kind === 'bridge' || r.kind === 'vlan') return badge(r.up ? 'up' : 'down', r.up ? 'success' : '');
  return r.carrier ? h('span', {}, badge('up', 'success'), r.speed ? h('span', { className: 'muted ms-2' }, fmtSpeed(r.speed)) : null) : badge('down', '');
}

// The interface cell: its name, the logical interfaces that use it, and what it is.
function nameCell(r, wanSet) {
  return h('div', { className: 'tr-if' },
    h('div', {}, h('strong', {}, r.name), wanSet.has(r.name) ? badge('WAN', 'info') : null, r.logical.map(n => h('span', { className: 'chip' }, n))),
    h('div', { className: 'muted small' }, kindLabel(r)));
}

// The load cell: the share of the link speed the busier direction uses, as a bar and a number.
function loadCell(r, rate) {
  const u = utilization(r, rate);
  if (u == null) return muted('–');
  return h('div', { className: 'tr-share' }, meter(u, 100, u >= 90 ? 'weak' : u >= 60 ? 'fair' : 'good'), h('span', {}, `${fmtPct(u)}%`));
}

// The interface table. A bridge, a VLAN device and the CPU port repeat what their ports carry, so they are dimmed and
// left out of the totals.
function interfaceTable(rows, wanSet, state, rerender) {
  const shown = state.liveAll ? rows : rows.slice(0, ROW_LIMIT);
  const body = shown.map(r => {
    const t = traffic(r.name);
    return h('tr', { className: isLeaf(r) ? '' : 'tr-dim' },
      h('td', {}, nameCell(r, wanSet)),
      h('td', {}, linkCell(r)),
      h('td', { className: 'tr-num' }, h('span', { className: 'tr-rx' }, t.rxNow == null ? '…' : fmtLine(t.rxNow))),
      h('td', { className: 'tr-num' }, h('span', { className: 'tr-tx' }, t.txNow == null ? '…' : fmtLine(t.txNow))),
      h('td', {}, sparkline([{ values: t.rx, cls: 'rx' }, { values: t.tx, cls: 'tx' }], { width: 150, height: 28 })),
      h('td', {}, loadCell(r, t)),
      h('td', { className: 'tr-num' }, r.rxBytes == null ? muted('–') : h('span', {}, `↓ ${fmtBytes(r.rxBytes)}`, h('br'), h('span', { className: 'muted' }, `↑ ${fmtBytes(r.txBytes)}`))));
  });
  return card([icon('speedometer2'), 'Interfaces', h('span', { className: 'sub' }, `${rows.length} devices · refreshed every few seconds`)],
    h('div', {},
      h('div', { className: 'tr-legend' },
        'Rates are measured in this browser from the interface counters between polls: ',
        h('span', { className: 'tr-rx' }, '↓ download'), ' and ', h('span', { className: 'tr-tx' }, '↑ upload'), ' as the router sees them on that port. ',
        'Dimmed rows (bridges, VLANs, the CPU port) repeat the traffic of the ports under them and are not added to the totals. The chart covers the last minutes the page was open.'),
      h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover tr-live' },
        h('thead', {}, h('tr', {}, ['Interface', 'Link', 'Download', 'Upload', 'History', 'Link load', 'Since boot'].map(c => h('th', {}, c)))),
        h('tbody', {}, body.length ? body : h('tr', {}, h('td', { colSpan: 7, className: 'muted' }, 'The router reports no network devices'))))),
      rows.length > shown.length ? h('div', { className: 'tr-more' },
        h('span', { className: 'muted' }, `Showing the first ${shown.length} of ${rows.length} devices.`),
        h('button', { type: 'button', className: 'btn btn-sm btn-fl', onclick: () => { state.liveAll = true; rerender(); } }, `Show all ${rows.length}`)) : null));
}

// The nodes of the Live tab for one poll: `wired` is { net, ifs } from loadWired(), `status` the flab.traffic status
// (null when the plugin is not installed).
export function liveView({ wired, status }, state, rerender) {
  const rows = deviceRows(wired.net, wired.ifs);
  const wan = wanLinks(wired.ifs, rows);
  const wanSet = new Set(wan.map(w => w.row).filter(Boolean));
  return [
    summary(rows, wan, status),
    healthBanner(liveFindings(status), 'Nothing needs attention.'),
    interfaceTable(orderRows(rows, wanSet), wanSet, state, rerender),
  ];
}
