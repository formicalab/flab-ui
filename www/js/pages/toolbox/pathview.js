// The path tools' views: the live mtr table (loss, delay and a trend for every hop, with plain-language findings) and the
// line that names the network of a traceroute hop. The meaning of the output comes from pathmodel.js; the views are repainted
// every time new output arrives, so the table fills in and the figures move while mtr runs.
import { copyButton } from '../../core/clipboard.js';
import { h } from '../../core/dom.js';
import { badge, mono, muted, sparkline } from '../../core/ui.js';
import { fmtMs } from './diagmodel.js';
import { asName, asPath, lossKind, mtrReport, networkNotes, networkSegments, parseAsn, parseMtr, pathNotes } from './pathmodel.js';
import { banner, findingList } from './parts.js';

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

// The mtr result: the findings, the networks the path crosses, then a row per hop with its loss, last, average, best and
// worst delay and a trend chart. Without any hop yet it says it is waiting for the first. With AS lookups the network of each
// router shows under its address, the route strip groups the hops by network with the delay each adds, the findings place
// delay and loss in a network, and a finished run can be copied as a plain-text report.
export function mtrBody(job) {
  const m = parseMtr(job.text, job.running);
  if (m.error && !m.hops.length) return banner(`mtr failed: ${m.error}`);
  const asn = job.asn ? parseAsn(job.text) : null;
  const segments = asn?.any ? networkSegments(m.hops, asn) : [];
  const netNotes = networkNotes(segments, m.hops, job.running);
  // A delay jump placed in a network replaces the one that only names two hops.
  const notes = [...pathNotes(m.hops, job.running).filter(n => !(n.kind === 'jump' && netNotes.some(x => x.kind === 'jump'))), ...netNotes];
  const dest = m.hops.at(-1);
  const rows = m.hops.map(hop => h('tr', { className: hop === dest && m.reached ? 'rt-hit' : '' },
    h('td', { className: 'num mono' }, String(hop.n)),
    h('td', {}, hop.addr ? h('div', { className: 'rt-hops' }, h('div', { className: 'rt-router' },
      hop.name ? [h('span', { className: 'rt-rname', title: hop.name }, hop.name), h('span', { className: 'rt-raddr mono' }, hop.addr, hop.addrs.length > 1 ? muted(` +${hop.addrs.length - 1}`) : null)] : h('span', {}, mono(hop.addr), hop.addrs.length > 1 ? muted(` +${hop.addrs.length - 1}`) : null),
      asn ? asnLine(asn, hop.addr) : null)) : muted('no reply')),
    h('td', {}, lossCell(hop, m.hops)),
    h('td', { className: 'num' }, String(hop.sent)),
    h('td', { className: 'num' }, ms(hop.last)), h('td', { className: 'num' }, ms(hop.avg)), h('td', { className: 'num' }, ms(hop.best)), h('td', { className: 'num' }, ms(hop.worst)),
    h('td', { className: 'num' }, ms(hop.stdev)),
    h('td', {}, hop.history.length > 2 ? sparkline([{ values: hop.history, cls: 'rx' }], { width: 110, height: 24 }) : null)));
  return h('div', { className: 'rt-mtr' },
    findingList(notes),
    routeStrip(segments, asn?.pending),
    h('div', { className: 'table-responsive' }, h('table', { className: 'table table-hover rt-trace rt-mtrtable' },
      h('thead', {}, h('tr', {}, ['Hop', 'Router', 'Loss', 'Sent', 'Last', 'Average', 'Best', 'Worst', 'Spread', 'Delay over time'].map((c, i) => h('th', { className: [0, 3, 4, 5, 6, 7, 8].includes(i) ? 'num' : '' }, c)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 10, className: 'muted' }, job.running ? 'Waiting for the first hop…' : 'No hops'))))),
    !job.running && m.hops.length ? h('div', { className: 'rt-actions rt-mtr-actions' }, copyButton(mtrReport({ host: job.host, command: job.command, when: new Date(job.t0).toLocaleString(), hops: m.hops, asn, segments, notes }), 'Copy report')) : null);
}

// The route strip: one card per network the path crosses, from the router to the destination, with the hops inside it, the
// delay it adds and a bar of its share of the whole delay. A card turns amber when loss starts inside it; hops that never
// answer between two networks are a dashed card of their own. Null until a hop has network data. `pending` says lookups
// are still running.
function routeStrip(segments, pending) {
  if (!segments.some(s => !s.gap)) return null;
  const total = Math.max(1, ...segments.map(s => s.endMs ?? 0));
  const range = s => (s.first === s.last ? `hop ${s.first}` : `hops ${s.first}–${s.last}`);
  const cards = segments.flatMap((s, i) => {
    const arrow = i ? [h('span', { className: 'rt-route-arrow' }, '→')] : [];
    if (s.gap) return [...arrow, h('div', { className: 'rt-route-card gap', title: 'These routers never answer, so their network is unknown' }, h('span', { className: 'muted' }, 'no reply'), h('span', { className: 'rt-route-sub' }, range(s)))];
    const tip = [s.prefix, s.registry, s.short, s.hops.map(x => x.addr).filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    return [...arrow, h('div', { className: `rt-route-card ${s.loss ? 'lossy' : ''}`, title: tip },
      h('div', { className: 'rt-route-name' }, s.unannounced ? muted('not announced') : badge(`AS${s.asn}`, 'info'), ' ', h('strong', {}, s.unannounced ? s.netname : s.org ?? s.short ?? ''), s.country ? h('span', { className: 'muted' }, ` · ${s.country}`) : null),
      h('div', { className: 'rt-route-sub' }, range(s), s.addMs >= 0.05 ? ` · +${fmtMs(s.addMs)}` : '', s.loss ? h('span', { className: 'rt-route-loss' }, ` · ${s.loss.pct}% loss`) : null),
      s.addMs >= 0.05 ? h('span', { className: 'rt-route-bar' }, h('i', { style: `width:${Math.max(3, s.addMs / total * 100).toFixed(0)}%` })) : null)];
  });
  return h('div', { className: 'rt-route' }, cards, pending ? muted('looking up…') : null);
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
