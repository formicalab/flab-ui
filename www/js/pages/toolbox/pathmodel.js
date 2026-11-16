// The path tools' model: the live table of mtr's raw output, and the autonomous-system data a traceroute with AS lookups
// collects. Pure functions with no DOM and no network, so they are unit-tested directly (tests/toolbox/path.test.mjs).
import { parseBlocks } from './diagmodel.js';

//#region mtr

// What `mtr --raw` has printed so far as one row per hop, in the order of the hops.
//   { hops: [{ n, addr, addrs, name, sent, recv, lossPct, last, avg, best, worst, stdev, history }], reached, error }
// mtr prints a line per event: `x <hop> <seq>` when a probe is sent, `h <hop> <address>` when a hop is first seen (and again
// with each reply), `d <hop> <name>` for a name and `p <hop> <microseconds> <seq>` for a reply. Hops are numbered from 0.
// The last unanswered probe of a hop is still in flight while the run goes on, so it is not counted as lost until the run
// has ended (`running` false). The destination repeats for every hop beyond it, and only its first appearance is kept.
// `history` holds the last 30 round-trip times in milliseconds, for the small trend chart of a row.
export function parseMtr(text, running = false) {
  const hops = new Map();
  let error = null;
  // The record of hop `i` (0-based), created on first use.
  const hop = i => {
    if (!hops.has(i)) hops.set(i, { n: i + 1, addrs: [], name: null, sent: 0, recv: 0, sum: 0, sumSq: 0, last: null, best: null, worst: null, history: [], answered: new Set(), lastSeq: null });
    return hops.get(i);
  };
  for (const line of String(text ?? '').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'x' && p.length >= 3) { const h = hop(+p[1]); h.sent++; h.lastSeq = p[2]; }
    else if (p[0] === 'h' && p.length >= 3) { const h = hop(+p[1]); if (!h.addrs.includes(p[2])) h.addrs.push(p[2]); }
    else if (p[0] === 'd' && p.length >= 3) { const h = hop(+p[1]); h.name ??= p[2]; }
    else if (p[0] === 'p' && p.length >= 4) {
      const h = hop(+p[1]);
      const ms = +p[2] / 1000;
      h.recv++;
      h.answered.add(p[3]);
      h.sum += ms; h.sumSq += ms * ms; h.last = ms;
      h.best = h.best == null ? ms : Math.min(h.best, ms);
      h.worst = h.worst == null ? ms : Math.max(h.worst, ms);
      h.history.push(ms);
      if (h.history.length > 30) h.history.shift();
    } else if (/^mtr[:-]/.test(line) || /failed|cannot|permission/i.test(line)) error = line.trim();
  }
  const rows = [...hops.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h);
  // Cut the hops after the destination: the first address that a later hop repeats is where the path ends.
  const cut = [];
  for (const h of rows) {
    const prev = cut.at(-1);
    if (prev && h.addrs[0] && prev.addrs[0] === h.addrs[0]) break;
    cut.push(h);
  }
  const out = cut.map(h => {
    const pending = running && h.lastSeq != null && !h.answered.has(h.lastSeq) ? 1 : 0;
    const counted = h.sent - pending;
    return {
      n: h.n, addr: h.addrs[0] ?? null, addrs: h.addrs, name: h.name && h.name !== h.addrs[0] ? h.name : null, sent: h.sent, recv: h.recv,
      lossPct: counted > 0 ? Math.round((counted - h.recv) / counted * 1000) / 10 : null,
      last: h.last, avg: h.recv ? h.sum / h.recv : null, best: h.best, worst: h.worst,
      stdev: h.recv > 1 ? Math.sqrt(Math.max(0, h.sumSq / h.recv - (h.sum / h.recv) ** 2)) : null,
      history: h.history,
    };
  });
  return { hops: out, reached: rows.length > cut.length, error };
}

// The kind of badge for a hop's loss: nothing for none, a warning for some, a danger for heavy loss. Two kinds of loss are
// not a fault of the path: a hop that never answers while a later one does is `silent` (it drops probes addressed to itself),
// and a hop that loses probes while the last hop loses less than half as many is `limited` (the router rate-limits its own
// replies; what matters is the loss that reaches the destination).
export function lossKind(hop, hops) {
  if (hop.lossPct == null) return '';
  const later = hops.filter(h => h.n > hop.n && h.recv > 0);
  if (hop.recv === 0 && later.length) return 'silent';
  if (hop.lossPct > 0 && later.length && (later.at(-1).lossPct ?? 0) < hop.lossPct / 2) return 'limited';
  return hop.lossPct >= 20 ? 'danger' : hop.lossPct > 0 ? 'warning' : '';
}

// The findings about a finished (or running) mtr table, in words: [{ level: 'ok' | 'warn' | 'bad', text }]. The loss that
// counts is the loss at the destination; a hop that loses probes while the destination does not is rate-limiting its own
// replies (not a fault); and a jump in the average delay between two answering hops marks where the path gets slower.
export function pathNotes(hops, running) {
  const notes = [];
  const answering = hops.filter(h => h.recv > 0);
  const dest = hops.at(-1);
  if (dest && dest.recv > 0 && dest.sent >= 3 && !running) {
    notes.push(dest.lossPct > 0
      ? { level: dest.lossPct >= 10 ? 'bad' : 'warn', text: `${dest.lossPct}% of the probes to the destination were lost.` }
      : { level: 'ok', text: 'No probe to the destination was lost.' });
  } else if (dest && dest.recv === 0 && dest.sent >= 3 && !running) {
    notes.push({ level: 'warn', text: 'The destination did not answer. It may block these probes; the path up to the last hop that answered is shown.' });
  }
  for (const h of hops) if (lossKind(h, hops) === 'limited') notes.push({ level: 'ok', text: `Hop ${h.n} (${h.addr}) shows ${h.lossPct}% loss but later hops do not: it limits its own replies, so the path is fine.` });
  for (let i = 1; i < answering.length; i++) {
    const a = answering[i - 1], b = answering[i];
    if (b.avg - a.avg >= 25 && b.avg >= 2 * a.avg) { notes.push({ level: 'warn', kind: 'jump', text: `The delay rises by ${Math.round(b.avg - a.avg)} ms between hop ${a.n} and hop ${b.n} (${b.addr}).` }); break; }
  }
  return notes;
}

//#endregion

//#region Autonomous systems

// The columns of a Team Cymru TXT answer, which is quoted text with the columns separated by "|": the first line, without
// the quotes, as trimmed columns.
function columns(output) {
  const line = String(output ?? '').split('\n').map(x => x.trim()).find(x => x.startsWith('"')) ?? '';
  return line.replace(/^"|"$/g, '').split('|').map(x => x.trim());
}

// What a traceroute with AS lookups found about the routers that answered.
//   { byAddr: Map(address -> { asn, prefix, country, registry, name, net }), asns: Map(number -> name), pending, any }
// `asn` blocks give the origin of an address (AS number, prefix, country, registry), `asname` blocks the name of an AS
// (the last column, "NAME - Organization, CC"), `net` blocks the registry's record of an address that has no origin
// ({ range, netname, country, descr }, null when the registry does not manage the range). An address with no origin record
// has an entry with `asn: null`. `pending` is true while lookups are still running, so the page can show that more is coming.
export function parseAsn(text) {
  const blocks = parseBlocks(text);
  const names = new Map();
  for (const b of blocks.filter(x => x.id === 'asname')) {
    const c = columns(b.output);
    if (c.length >= 5) names.set(b.detail.split(/\s+/)[0], c.slice(4).join(' | '));
  }
  const nets = new Map();
  for (const b of blocks.filter(x => x.id === 'net')) nets.set(b.detail.split(/\s+/)[0], netOf(b.output));
  const byAddr = new Map();
  for (const b of blocks.filter(x => x.id === 'asn')) {
    const c = columns(b.output);
    const addr = b.detail.split(/\s+/)[0];
    const asn = (c[0] ?? '').split(/\s+/).find(x => /^\d+$/.test(x)) ?? null;
    byAddr.set(addr, { asn, prefix: asn ? c[1] ?? null : null, country: asn ? c[2] ?? null : null, registry: asn ? c[3] ?? null : null, name: asn ? names.get(asn) ?? null : null, net: nets.get(addr) ?? null });
  }
  return { byAddr, asns: names, pending: blocks.some(b => ['asn', 'net', 'asname'].includes(b.id) && b.running), any: byAddr.size > 0 };
}

// The registry record in the output of a `net` block (the first whois object: inetnum or inet6num, netname, country,
// descr), or null when it names nothing or the range is one the registry does not manage (RIPE's "NON-RIPE-NCC-MANAGED").
function netOf(output) {
  // The first non-empty value of the whois field `key`, or null.
  const get = key => String(output ?? '').split('\n').map(l => l.match(new RegExp(`^${key}:\\s*(.+)$`))?.[1]?.trim()).find(Boolean) ?? null;
  const netname = get('netname');
  if (!netname || /^NON-RIPE-NCC-MANAGED/i.test(netname)) return null;
  return { range: get('inetnum') ?? get('inet6num'), netname, country: get('country'), descr: get('descr') };
}

// An AS name as "Organization" and the AS's own short name: "CLOUDFLARENET - Cloudflare, Inc., US" gives
// { short: 'CLOUDFLARENET', org: 'Cloudflare, Inc.' }; a name without the " - " part is the organization alone.
export function asName(name) {
  if (!name) return { short: null, org: null };
  const trimmed = name.replace(/, [A-Z]{2}$/, '');
  const i = trimmed.indexOf(' - ');
  return i < 0 ? { short: null, org: trimmed } : { short: trimmed.slice(0, i), org: trimmed.slice(i + 3) };
}

// The networks a path crosses, in order: one entry per run of hops in the same autonomous system, taken from the first
// router of each hop that has AS data. `hops` are parseTraceroute's or parseMtr's hops, `asn` is parseAsn's result.
//   [{ asn, name, country }]
export function asPath(hops, asn) {
  const out = [];
  for (const hop of hops) {
    const e = (hop.routers ?? hop.addrs.map(addr => ({ addr }))).map(r => asn.byAddr.get(r.addr)).find(x => x?.asn);
    if (!e) continue;
    if (out.at(-1)?.asn !== e.asn) {
      const n = asName(e.name);
      out.push({ asn: e.asn, name: n.org ?? n.short ?? null, country: e.country });
    }
  }
  return out;
}

//#endregion

//#region Networks along the path

// The network a hop's first address belongs to, as a key: "AS<n>" for an address an AS announces, "net:<name>" for one that
// no AS announces but the registry lists under a network name, null for a hop with neither (silent, or not looked up).
function networkKey(hop, asn) {
  const e = hop.addr ? asn.byAddr.get(hop.addr) : null;
  if (e?.asn) return `AS${e.asn}`;
  if (e?.net?.netname) return `net:${e.net.netname}`;
  return null;
}

// How a segment is named in words: "AS30722 Fastweb SpA", "VODAFONE-IT (not announced)" or "no reply".
export function segmentLabel(s) {
  if (s.gap) return 'no reply';
  if (s.unannounced) return `${s.netname} (not announced)`;
  return `AS${s.asn}${s.org ? ` ${s.org}` : ''}`;
}

// The hops of an mtr table grouped into the networks the path crosses, in order, with the delay each network adds.
//   [{ key, gap, unannounced, asn, org, short, country, netname, prefix, registry, hops, first, last, addMs, entryMs, innerMs,
//      prevMs, startMs, endMs, loss: { pct, hop } | null }]
// Consecutive hops of the same network form one segment. A hop with no network data (it never answers, or was not looked
// up) between two hops of the same network belongs to it; between different networks it forms a `gap` segment of its own,
// because there is no telling which side it is on. `addMs` is how much later the segment's last answering hop is than the
// last answering hop before it (never negative, as the averages jitter): the delay the network adds. `entryMs` is the part of
// it at the first answering hop (the handoff into the network) and `innerMs` the rest (inside the network). `endMs` is the
// average delay at the segment's last answering hop. `loss` is the first hop whose loss is real (reaches the destination).
export function networkSegments(hops, asn) {
  const keys = hops.map(h => networkKey(h, asn));
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] != null) continue;
    let j = i;
    while (j < keys.length && keys[j] == null) j++;
    const before = i > 0 ? keys[i - 1] : null, after = j < keys.length ? keys[j] : null;
    if (before != null && before === after) for (let k = i; k < j; k++) keys[k] = before;
    i = j;
  }
  const segments = [];
  hops.forEach((hop, i) => {
    const last = segments.at(-1);
    if (last && last.key === keys[i]) last.hops.push(hop);
    else segments.push({ key: keys[i], hops: [hop] });
  });
  let prev = 0;
  return segments.map(s => {
    const e = s.key ? asn.byAddr.get(s.hops.find(h => h.addr && networkKey(h, asn) === s.key)?.addr) : null;
    const name = asName(e?.name);
    const answering = s.hops.filter(h => h.avg != null);
    let addMs = null, entryMs = null, innerMs = null, endMs = null, startMs = null;
    const prevMs = prev;
    if (answering.length) {
      const first = answering[0], end = answering.at(-1);
      entryMs = Math.max(0, first.avg - prev);
      innerMs = Math.max(0, end.avg - first.avg);
      addMs = Math.max(0, end.avg - prev);
      startMs = first.avg;
      endMs = end.avg;
      prev = end.avg;
    }
    const bad = s.hops.find(h => ['warning', 'danger'].includes(lossKind(h, hops)));
    return {
      ...s, gap: s.key == null, unannounced: Boolean(s.key?.startsWith('net:')),
      asn: e?.asn ?? null, org: name.org, short: name.short, country: e?.country ?? e?.net?.country ?? null,
      netname: e?.net?.netname ?? null, prefix: e?.prefix ?? null, registry: e?.registry ?? null,
      first: s.hops[0].n, last: s.hops.at(-1).n, addMs, entryMs, innerMs, prevMs, startMs, endMs,
      loss: bad ? { pct: bad.lossPct, hop: bad.n } : null,
    };
  });
}

// What the path says in terms of networks: [{ level, kind, text }]. A jump in delay is placed at the handoff between two
// networks or inside one; most of the delay being added by one network is named; and loss that reaches the destination
// is placed in the network where it starts, with what that network usually is (the first one after the router is generally
// the ISP's, the last is the destination's own). Nothing is said while the run goes on, because the figures still move.
// A `jump` note replaces the hop-level one of pathNotes.
export function networkNotes(segments, hops, running) {
  const notes = [];
  const real = segments.filter(s => !s.gap);
  if (running || !real.length) return notes;
  const total = Math.max(0, ...segments.map(s => s.endMs ?? 0));
  real.forEach(s => {
    const index = real.indexOf(s);
    if (index > 0 && s.entryMs >= 25 && s.startMs >= 2 * s.prevMs) {
      const from = real[index - 1];
      notes.push({ level: 'warn', kind: 'jump', text: `The delay rises by ${Math.round(s.entryMs)} ms where the path passes from ${segmentLabel(from)} to ${segmentLabel(s)} (hop ${from.last} to hop ${s.first}).` });
    }
    if (s.innerMs >= 25 && s.endMs >= 2 * s.startMs) {
      notes.push({ level: 'warn', kind: 'jump', text: `The delay rises by ${Math.round(s.innerMs)} ms inside ${segmentLabel(s)} (hops ${s.first} to ${s.last}).` });
    }
  });
  if (real.length > 1 && total >= 20) {
    const top = real.reduce((a, b) => ((b.addMs ?? 0) > (a.addMs ?? 0) ? b : a));
    if (top.addMs >= total / 2) notes.push({ level: 'ok', kind: 'share', text: `${Math.round(top.addMs / total * 100)}% of the delay (${Math.round(top.addMs)} of ${Math.round(total)} ms) is added in ${segmentLabel(top)}.` });
  }
  const lossy = real.find(s => s.loss);
  const dest = hops.at(-1);
  if (lossy && dest?.recv > 0 && dest.lossPct > 0) {
    const where = lossy === real[0] ? 'the first network after the router, usually the ISP\'s access link' : lossy === real.at(-1) ? 'the destination\'s own network' : 'a network between the ISP and the destination';
    notes.push({ level: lossy.loss.pct >= 10 ? 'bad' : 'warn', kind: 'loss', text: `Loss of ${lossy.loss.pct}% starts at hop ${lossy.loss.hop} in ${segmentLabel(lossy)} and reaches the destination (${dest.lossPct}%). That is ${where}.` });
  }
  return notes;
}

// The plain-text report of an mtr run, for a support ticket or a chat: the host, the command and the time, one line per hop
// (address, name, network, loss and delays), the networks crossed with the delay each adds, and the findings in words.
// `asn` and `segments` may be empty; `when` is the start time already formatted.
export function mtrReport({ host, command, when, hops, asn, segments, notes }) {
  const ms = v => (v == null ? '-' : v.toFixed(1));
  const network = hop => {
    const e = hop.addr ? asn?.byAddr.get(hop.addr) : null;
    if (e?.asn) return `AS${e.asn} ${asName(e.name).org ?? ''}${e.country ? ` (${e.country})` : ''}`.trim();
    if (e?.net) return `${e.net.netname} (not announced${e.net.country ? `, ${e.net.country}` : ''})`;
    return '';
  };
  const rows = hops.map(h => [String(h.n), h.addr ? `${h.addr}${h.name ? ` (${h.name})` : ''}` : '???', network(h), h.lossPct == null ? '-' : `${h.lossPct}%`, String(h.sent), ms(h.last), ms(h.avg), ms(h.best), ms(h.worst), ms(h.stdev)]);
  const head = ['Hop', 'Address', 'Network', 'Loss', 'Sent', 'Last', 'Avg', 'Best', 'Worst', 'StDev'];
  const widths = head.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)));
  const line = cells => cells.map((c, i) => (i === 0 || i >= 3 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd();
  const out = [`MTR to ${host}`, `${command}`, when, '', line(head), ...rows.map(line)];
  if (segments?.some(s => !s.gap)) {
    out.push('', 'Networks: ' + segments.map(s => `${segmentLabel(s)} (hop${s.first === s.last ? ` ${s.first}` : `s ${s.first}-${s.last}`}${s.addMs != null && !s.gap ? `, +${s.addMs.toFixed(1)} ms` : ''})`).join(' > '));
  }
  const all = notes ?? [];
  if (all.length) out.push('', 'Findings:', ...all.map(n => `- ${n.text}`));
  return out.join('\n') + '\n';
}

//#endregion
