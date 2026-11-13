// The path tools' views: the live mtr table (loss, delay and a trend for every hop, with plain-language findings) and the
// line that names the network of a traceroute hop. The meaning of the output comes from pathmodel.js; the views are repainted
// every time new output arrives, so the table fills in and the figures move while mtr runs.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, mono, muted, sparkline } from '../../core/ui.js';
import { fmtMs } from './diagmodel.js';
import { asName, asPath, lossKind, parseMtr, pathNotes } from './pathmodel.js';

// The cell of a hop's loss: the percentage with a small bar, in the color of its kind. A silent hop shows "no reply" and a
// rate-limited one says why its loss is not a fault.
function lossCell(hop, hops) {
  const kind = lossKind(hop, hops);
  if (hop.lossPct == null) return muted('–');
  if (kind === 'silent') return h('span', { className: 'muted', title: 'This router does not answer probes addressed to itself, but the hops after it do, so the path works' }, 'no reply');
  const tone = { danger: 'bad', warning: 'warn', limited: 'limited' }[kind] ?? '';
  return h('span', { className: `rt-loss ${tone}`, title: kind === 'limited' ? 'This router limits how fast it answers; the later hops lose less, so the path itself is fine' : '' },
    `${hop.lossPct}%`, h('span', { className: 'rt-lossbar' }, h('i', { style: `width:${Math.min(100, hop.lossPct)}%` })));
}

// A number of milliseconds, or a dash.
const ms = v => (v == null ? muted('–') : fmtMs(v));

// The mtr result: the findings, then a row per hop with its loss, last, average, best and worst delay and a trend chart.
// Without any hop yet it says it is waiting for the first.
export function mtrBody(job) {
  const m = parseMtr(job.text, job.running);
  if (m.error && !m.hops.length) return h('div', { className: 'rt-error' }, icon('x-circle'), `mtr failed: ${m.error}`);
  const notes = pathNotes(m.hops, job.running);
  const dest = m.hops.at(-1);
  const rows = m.hops.map(hop => h('tr', { className: hop === dest && m.reached ? 'rt-hit' : '' },
    h('td', { className: 'num mono' }, String(hop.n)),
    h('td', {}, hop.addr ? mono(hop.addr) : muted('no reply'), hop.addrs.length > 1 ? muted(` +${hop.addrs.length - 1}`) : null),
    h('td', {}, lossCell(hop, m.hops)),
    h('td', { className: 'num' }, String(hop.sent)),
    h('td', { className: 'num' }, ms(hop.last)), h('td', { className: 'num' }, ms(hop.avg)), h('td', { className: 'num' }, ms(hop.best)), h('td', { className: 'num' }, ms(hop.worst)),
    h('td', { className: 'num' }, ms(hop.stdev)),
    h('td', {}, hop.history.length > 2 ? sparkline([{ values: hop.history, cls: 'rx' }], { width: 110, height: 24 }) : null)));
  return h('div', { className: 'rt-mtr' },
    notes.length ? h('div', { className: 'rt-findings' }, notes.map(n => h('div', { className: `rt-finding ${n.level}` }, icon({ ok: 'check-circle', warn: 'exclamation-triangle', bad: 'x-circle' }[n.level]), n.text))) : null,
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover rt-trace rt-mtrtable' },
      h('thead', {}, h('tr', {}, ['Hop', 'Router', 'Loss', 'Sent', 'Last', 'Average', 'Best', 'Worst', 'Spread', 'Delay over time'].map((c, i) => h('th', { className: [0, 3, 4, 5, 6, 7, 8].includes(i) ? 'num' : '' }, c)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 10, className: 'muted' }, job.running ? 'Waiting for the first hop…' : 'No hops'))))));
}

// The line under a traceroute hop's address that names its network: the AS number with the organization and country; for
// an address no AS announces, the network name the registry lists it under ("not announced · VODAFONE-IT · IT"), or
// "no AS data" when even that is unknown. `asn` is parseAsn's result. Null for an address that was not looked up.
export function asnLine(asn, addr) {
  const e = asn?.byAddr.get(addr);
  if (!e) return asn?.pending ? h('span', { className: 'rt-asn muted' }, 'looking up…') : null;
  if (!e.asn && e.net) return h('span', { className: 'rt-asn muted', title: `No AS announces this address. The registry lists ${e.net.range ?? 'its range'} as ${e.net.netname}${e.net.descr ? ` (${e.net.descr})` : ''}.` }, 'not announced · ', h('strong', {}, e.net.netname), e.net.country ? ` · ${e.net.country}` : '');
  if (!e.asn) return h('span', { className: 'rt-asn muted' }, 'no AS data');
  const { org, short } = asName(e.name);
  return h('span', { className: 'rt-asn', title: [e.prefix, e.registry, short].filter(Boolean).join(' · ') }, badge(`AS${e.asn}`, 'info'), ' ', org ?? short ?? '', e.country ? h('span', { className: 'muted' }, ` · ${e.country}`) : null);
}

// The networks the traceroute crossed, as a chain of chips from the first to the last: "AS30722 Fastweb → AS13335 Cloudflare".
// Null until at least one hop has AS data.
export function asPathView(hops, asn) {
  const path = asPath(hops, asn);
  if (!path.length) return null;
  const parts = [];
  path.forEach((p, i) => {
    if (i) parts.push(h('span', { className: 'rt-aspath-arrow' }, '→'));
    parts.push(h('span', { className: 'rt-aspath-item', title: p.country ?? '' }, badge(`AS${p.asn}`, 'info'), ' ', p.name ?? ''));
  });
  return h('div', { className: 'rt-aspath' }, h('span', { className: 'muted' }, `Crosses ${path.length} network${path.length === 1 ? '' : 's'}:`), parts);
}
