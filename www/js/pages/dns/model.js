// Pure model of the DNS page: what the reply of flab.dns status means. No DOM access, unit-tested in
// tests/dns/model.test.mjs. The tiles, the findings, the forwarders (grouped and filtered), the activity rows and the
// configuration fields are all worked out here; the view only draws them.
import { fmtNum, fmtSpan } from '../../core/format.js';
import { valueOf } from '../../core/fields.js';
import { DNSMASQ_FIELDS, DNSMASQ_GROUPS, UNBOUND_FIELDS, UNBOUND_GROUPS, ZONE_FIELDS } from './schema.js';

// Display name of each engine.
const NAMES = { unbound: 'Unbound', dnsmasq: 'dnsmasq' };
// The minimum number of answers (or forwarded queries) before a percentage is called a problem.
const MIN_SAMPLE = 20;

//#region Addresses and percentages

// The engine's name for display ("Unbound"), or "None".
export const engineName = engine => NAMES[engine] ?? 'None';

// The address of a forwarder entry without its port or TLS name: "1.1.1.1@853#cloudflare-dns.com" and
// "127.0.0.1#5053" give the bare address.
export function serverAddress(s) {
  return String(s ?? '').replace(/[@#].*$/, '');
}

// Whether an address is a public one: not private, loopback, link-local, shared (CGNAT), multicast or unique-local.
// A host name (it is not an address) is not called public, since nothing is known about where it leads.
export function isPublicIp(addr) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (!addr.includes(':')) return false;
  const v6 = addr.toLowerCase();
  if (v6 === '::' || v6 === '::1') return false;
  return !/^(fe[89ab]|f[cd]|ff)/.test(v6);
}

// Percentage (0 to 100) of n in d, or null when either is unknown or d is zero.
export function pct(n, d) {
  return n == null || !d ? null : n / d * 100;
}

// A percentage as text: one decimal below 10, whole numbers above ("4.2%", "59%"), "<0.1%" for a trace.
export function fmtPct(p) {
  if (p == null) return '–';
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`;
}

// Milliseconds as text: whole above 100, one decimal below.
export function fmtMs(ms) {
  return ms >= 100 ? String(Math.round(ms)) : ms.toFixed(1);
}

// The effective value of a configuration option: the one that is set, else the known default.
export function effective(data, key) {
  return data.config?.[key] ?? data.defaults?.[key];
}

// The engine the page describes: the running one, else the installed engine that is configured.
export const subject = data => data.engine ?? data.configured ?? null;

//#endregion

//#region Tiles

// Queries answered in total: Unbound counts them; dnsmasq's total is what it forwarded plus what it answered itself.
export function totalQueries(data) {
  const s = data.stats;
  if (!s) return null;
  if (data.engine === 'unbound') return s.queries;
  if (s.forwarded == null || s.local_answered == null) return null;
  return s.forwarded + s.local_answered + (s.auth_answered ?? 0);
}

// Queries per minute since the counters started, or null when the age is not known.
export function perMinute(total, since) {
  return total == null || !(since > 0) ? null : total / (since / 60);
}

// The share of answers that needed no upstream query: { label, pct, sub }. Unbound: cache hits against hits and misses;
// dnsmasq: its own answers (cache and local names) against those and the forwarded queries.
export function cacheShare(data) {
  const s = data.stats;
  if (data.engine === 'dnsmasq') {
    const p = s ? pct(s.local_answered, s.forwarded + s.local_answered) : null;
    return { label: 'Answered locally', pct: p, sub: s ? `from the cache and local names · ${fmtNum(s.forwarded)} forwarded` : 'counters not available' };
  }
  const p = s ? pct(s.cache_hits, s.cache_hits + s.cache_misses) : null;
  return { label: 'Answered from cache', pct: p, sub: s && s.cache_hits != null ? `${fmtNum(s.cache_hits)} hits · ${fmtNum(s.cache_misses)} misses` : (data.engine ? 'statistics not available' : 'no resolver is running') };
}

// The default forwarders (the servers of the "." zone), without a "local only" marker.
export function defaultForwarders(data) {
  const row = (data.forwards ?? []).find(f => f.zone === '.');
  return row && !row.flags.includes('local-only') ? row.servers : [];
}

// The forwarders of the conditional zones (every row but the default one).
export const zoneForwards = data => (data.forwards ?? []).filter(f => f.zone !== '.');

// How many upstream servers the resolver can use: the default forwarders and the ones learned from the WAN (counted once
// each; dnsmasq told to ignore the WAN's resolvers does not use them).
export function upstreamCounts(data) {
  const defaults = defaultForwarders(data);
  const wan = data.upstream_used === false ? [] : (data.upstream ?? []);
  const all = new Set([...defaults.map(serverAddress), ...wan]);
  return { defaults: defaults.length, wan: wan.length, total: all.size };
}

// DNSSEC as { text, sub, kind } for the tile: Validating, Off, Not supported, or unknown.
export function dnssecInfo(data) {
  const d = data.dnssec ?? {};
  if (!subject(data) || d.supported == null) return { text: '–', sub: 'no resolver', kind: '' };
  if (d.supported === false) return { text: 'Not supported', sub: 'this build of dnsmasq has no DNSSEC', kind: 'none' };
  if (d.enabled) return { text: 'Validating', sub: 'answers are checked against their signatures', kind: 'on' };
  return { text: 'Off', sub: 'answers are not checked', kind: 'off' };
}

// The six summary tiles as [{ label, value, sub, cls }], from the reply (any engine, or none).
export function summary(data) {
  const e = data.engine;
  const name = engineName(e ?? data.configured);
  const s = data.stats;

  let resolver;
  if (e) {
    const other = e === 'unbound' ? 'dnsmasq' : 'unbound';
    const also = data.engines?.[other]?.running ? ` · ${engineName(other)} also runs (port ${data.engines[other].port})` : '';
    resolver = { label: 'Resolver', value: name, sub: [data.version, data.uptime != null ? `up ${fmtSpan(data.uptime)}` : null].filter(Boolean).join(' · ') + also, cls: '' };
  } else if (data.configured) {
    resolver = { label: 'Resolver', value: 'Stopped', sub: `${name} is installed but not running`, cls: 'text-danger' };
  } else {
    resolver = { label: 'Resolver', value: 'None', sub: 'no DNS resolver is installed', cls: 'text-danger' };
  }

  const total = totalQueries(data);
  const rate = perMinute(total, s?.since);
  const queries = {
    label: 'Queries', value: total == null ? '–' : fmtNum(total),
    sub: total == null ? (e ? 'counters not available' : 'nothing is counting') : `since start${rate != null ? ` · ${rate < 10 ? rate.toFixed(1) : fmtNum(Math.round(rate))} per minute` : ''}`, cls: '',
  };

  const cache = cacheShare(data);
  const answered = { label: cache.label, value: fmtPct(cache.pct), sub: cache.sub, cls: '' };

  let timing;
  if (e === 'dnsmasq') {
    timing = { label: 'Forwarded upstream', value: s?.forwarded != null ? fmtNum(s.forwarded) : '–', sub: 'dnsmasq does not report resolution times', cls: '' };
  } else {
    const avg = s?.recursion_avg_ms;
    timing = {
      label: 'Resolution time', value: avg != null ? `${fmtMs(avg)} ms` : '–',
      sub: avg != null ? `median ${fmtMs(s.recursion_median_ms)} ms · for answers that were not cached` : (e ? (s ? 'no upstream answer yet' : 'statistics not available') : 'no resolver is running'), cls: '',
    };
  }

  const up = upstreamCounts(data);
  let upstream;
  if (!subject(data)) upstream = { label: 'Upstream servers', value: '–', sub: 'no resolver', cls: '' };
  else if (subject(data) === 'unbound' && !up.defaults) upstream = { label: 'Upstream servers', value: 'Recursive', sub: `asks the root servers itself${up.wan ? ` · ${up.wan} from the WAN` : ''}`, cls: '' };
  else upstream = { label: 'Upstream servers', value: fmtNum(up.total), sub: `${up.defaults} default forwarder${up.defaults === 1 ? '' : 's'} · ${up.wan} from the WAN`, cls: up.total ? '' : 'text-danger' };

  const d = dnssecInfo(data);
  const dnssec = { label: 'DNSSEC', value: d.text, sub: d.sub, cls: d.kind === 'off' ? 'text-warning' : '' };
  return [resolver, queries, answered, timing, upstream, dnssec];
}

//#endregion

//#region Findings

// Whether a forwarder row sends queries in clear text to a public address. dnsmasq cannot encrypt, so every public
// server is clear text; for Unbound only a clause known not to use TLS counts (an unknown one is not accused).
function clearText(f, engine) {
  const isPublic = f.servers.some(s => isPublicIp(serverAddress(s)));
  return isPublic && (engine === 'dnsmasq' ? true : f.tls === false);
}

// What needs attention, worst first: [{ level: 'bad' | 'warn' | 'info', key, text }].
export function findings(data) {
  const list = [];
  const add = (level, key, text) => list.push({ level, key, text });
  const engines = data.engines ?? {};
  const e = data.engine;
  const installed = ['unbound', 'dnsmasq'].filter(n => engines[n]?.installed);

  if (!e) {
    if (installed.length) add('bad', 'stopped', `${installed.map(engineName).join(' and ')} ${installed.length > 1 ? 'are' : 'is'} installed but not running, so this router answers no DNS queries. Start the service from the Services page.`);
    else add('bad', 'none', 'No DNS resolver is running or installed (neither Unbound nor dnsmasq), so clients cannot resolve names through this router.');
    return finish(list, data);
  }

  const other = e === 'unbound' ? 'dnsmasq' : 'unbound';
  if (!data.listeners?.some(l => l.port === 53)) add('warn', 'no-port-53', `${engineName(e)} is running, but nothing listens on port 53, so clients cannot use it unless another rule redirects their queries.`);
  if (engines[other]?.running) {
    const o = engines[other];
    add('info', 'both', `${engineName(other)} also runs (port ${o.port}) next to ${engineName(e)}${e === 'unbound' && o.port !== 53 ? ', which answers on port 53; it only sees queries that are forwarded to it' : ''}.`);
  }

  const dn = data.dnssec ?? {};
  if (dn.supported === false) add('info', 'dnssec-unsupported', `This build of ${engineName(e)} has no DNSSEC support, so answers are not validated.`);
  else if (dn.supported && !dn.enabled) add('warn', 'dnssec-off', `DNSSEC validation is off: ${engineName(e)} cannot tell a forged answer from a real one${e === 'unbound' ? " (option validator '1' in /etc/config/unbound turns it on)" : " (option dnssec '1' in /etc/config/dhcp turns it on)"}.`);

  if (String(effective(data, 'rebind_protection')) === '0') add('warn', 'rebind-off', 'Rebind protection is off: a public name can be made to resolve to a private address, which lets a web page reach devices on the LAN.');

  const up = upstreamCounts(data);
  if (e === 'dnsmasq' && !up.total) add('bad', 'no-upstream', 'dnsmasq has no upstream servers (no server option, and the WAN resolvers are ignored or missing), so it can only answer local names.');

  const forwards = data.forwards ?? [];
  const clearDefault = forwards.find(f => f.zone === '.' && clearText(f, e));
  if (clearDefault) add('info', 'clear-text', `Queries are forwarded in clear text to a public resolver (${clearDefault.servers.slice(0, 3).join(', ')}${clearDefault.servers.length > 3 ? ', …' : ''}): everyone on the path can read every name looked up${e === 'unbound' ? " (option tls_upstream '1' on the forward zone turns on DNS over TLS)" : ''}.`);
  const clearZones = forwards.filter(f => f.zone !== '.' && clearText(f, e));
  if (clearZones.length) add('info', 'clear-text-zones', `${clearZones.length} conditional zone${clearZones.length === 1 ? '' : 's'} (${clearZones.slice(0, 3).map(z => z.zone).join(', ')}${clearZones.length > 3 ? ', …' : ''}) ${clearZones.length === 1 ? 'is' : 'are'} forwarded in clear text to public addresses.`);

  const s = data.stats;
  if (e === 'unbound' && engines.unbound?.control === false) add('warn', 'no-stats', "unbound-control is not enabled, so the counters, the forwarders and the local names cannot be read. Set option unbound_control '1' in /etc/config/unbound and restart unbound.");
  if (e === 'dnsmasq' && !s) add('info', 'no-stats', 'dnsmasq reports no counters: its ubus object dnsmasq.metrics did not answer (dnsmasq must be built with UBus).');

  if (s && e === 'unbound') {
    const answers = Object.values(s.rcodes ?? {}).reduce((a, b) => a + b, 0);
    if (s.rcodes?.SERVFAIL && answers >= MIN_SAMPLE && s.rcodes.SERVFAIL / answers > 0.05) add('warn', 'servfail', `${fmtPct(pct(s.rcodes.SERVFAIL, answers))} of the answers are SERVFAIL (${fmtNum(s.rcodes.SERVFAIL)} of ${fmtNum(answers)}): an upstream server fails or does not answer, or DNSSEC validation fails.`);
    if (s.bogus > 0) add('warn', 'bogus', `${fmtNum(s.bogus)} answer${s.bogus === 1 ? '' : 's'} failed DNSSEC validation (bogus): a zone is misconfigured, the clock is wrong, or an answer was forged.`);
    if (s.ratelimited > 0) add('warn', 'ratelimited', `${fmtNum(s.ratelimited)} quer${s.ratelimited === 1 ? 'y was' : 'ies were'} dropped by rate limiting (${effective(data, 'rate_limit') ?? '?'} per second and client).`);
  }
  if (s && e === 'dnsmasq' && s.forwarded >= MIN_SAMPLE && s.unanswered / s.forwarded > 0.02)
    add('warn', 'unanswered', `${fmtNum(s.unanswered)} of ${fmtNum(s.forwarded)} forwarded queries (${fmtPct(pct(s.unanswered, s.forwarded))}) got no answer from the upstream servers.`);
  return finish(list, data);
}

// The plugin's own warnings that no rule above explains are added as information, and so is a cut list. The list is then
// ordered worst first (the order inside a level is kept).
function finish(list, data) {
  const covered = /unbound-control is not enabled|dnsmasq reported no counters/;
  for (const w of data.warnings ?? []) if (!covered.test(w)) list.push({ level: 'info', key: 'plugin', text: w });
  if (data.truncated?.forwards) list.push({ level: 'info', key: 'truncated-forwards', text: 'The router has more forwarders than the page lists; only the first 500 are shown.' });
  const rank = { bad: 0, warn: 1, info: 2 };
  return list.map((f, i) => [f, i]).sort((a, b) => rank[a[0].level] - rank[b[0].level] || a[1] - b[1]).map(x => x[0]);
}

//#endregion

//#region Listeners

// The listening sockets as chips: one per address and port, with its protocols. { addr, port, protos, wildcard, family,
// engine, text }; the wildcard address is marked, IPv6 addresses are bracketed. Sorted by port, wildcards first, then IPv4.
export function listenerChips(data) {
  const by = new Map();
  for (const l of data.listeners ?? []) {
    const key = `${l.addr}|${l.port}`;
    if (!by.has(key)) by.set(key, { addr: l.addr, port: l.port, protos: [], engine: l.engine });
    const c = by.get(key);
    if (!c.protos.includes(l.proto)) c.protos.push(l.proto);
  }
  const chips = [...by.values()].map(c => {
    const family = c.addr.includes(':') ? 6 : 4;
    return { ...c, protos: c.protos.sort(), wildcard: c.addr === '0.0.0.0' || c.addr === '::', family, text: family === 6 ? `[${c.addr}]:${c.port}` : `${c.addr}:${c.port}` };
  });
  return chips.sort((a, b) => a.port - b.port || Number(b.wildcard) - Number(a.wildcard) || a.family - b.family || a.addr.localeCompare(b.addr));
}

//#endregion

//#region Forwarding

// Plain-language meaning of the flags Unbound prints after the "+" in list_forwards, and of the markers dnsmasq adds.
export const FLAG_WORDS = {
  i: 'not DNSSEC-validated', t: 'TCP only', f: 'falls back to recursion',
  'local-only': 'answered locally, never forwarded', 'default-servers': 'uses the default servers',
};

// The words for a list of flags (an unknown flag is shown as it is).
export const flagWords = flags => flags.map(f => FLAG_WORDS[f] ?? f);

// The conditional zones grouped by their server set, flags, TLS and where they are defined: [{ key, servers, flags, tls,
// source, section, zones }], the largest group first (then by the first zone). Zones inside a group keep the order of the
// reply. Zones of different UCI sections, or one defined in UCI and one in a file, never share a group: they are changed
// in different places.
export function groupForwards(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = JSON.stringify([r.servers, [...r.flags].sort(), r.tls ?? null, r.source ?? null, r.section ?? null]);
    if (!groups.has(key)) groups.set(key, { key, servers: r.servers, flags: r.flags, tls: r.tls ?? null, source: r.source ?? null, section: r.section ?? null, zones: [] });
    groups.get(key).zones.push(r.zone);
  }
  return [...groups.values()].sort((a, b) => b.zones.length - a.zones.length || a.zones[0].localeCompare(b.zones[0]));
}

// How many forwarders are defined in UCI (changeable through UCI) and how many only in a file (Unbound's extension file),
// counting the rows of the reply: { uci, file }. A row without a source (an older plugin) counts as neither.
export function forwardSources(data) {
  const rows = data.forwards ?? [];
  return { uci: rows.filter(r => r.source === 'uci').length, file: rows.filter(r => r.source === 'file').length };
}

// The values a form for one Unbound forward-zone section starts from (the fields are ZONE_FIELDS in schema.js), from an
// entry of the reply's `forward_uci`: one value per field as core/fields.js reads them. This is the draft an editing page
// would change.
export function zoneDraft(entry) {
  const raw = { enabled: entry.enabled ? '1' : '0', zone_name: entry.zones, server: entry.servers, ...(entry.options ?? {}) };
  return Object.fromEntries(ZONE_FIELDS.map(f => [f.key, valueOf(f, raw[f.key])]));
}

// The rows (zone, servers, flags) that match a filter text: every word must be in the zone, a server or a flag's words.
export function filterForwards(rows, text) {
  const words = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter(r => {
    const hay = [r.zone, ...r.servers, ...flagWords(r.flags ?? [])].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

//#endregion

//#region Activity

// What each answer code means.
const RCODE_HINTS = {
  NOERROR: 'The name exists (an answer, or an empty one when it has no record of that type).',
  NXDOMAIN: 'The name does not exist.',
  SERVFAIL: 'The resolver could not get an answer: an upstream failure or a DNSSEC failure.',
  REFUSED: 'The query was refused.',
  FORMERR: 'The query was malformed.',
  NOTIMPL: 'The query type is not implemented.',
};

// A row of the Activity card: { key, label, value, fraction (0 to 1, or null: no bar), level (good | fair | weak | ''), hint }.
const row = (key, label, value, fraction, level, hint) => ({ key, label, value, fraction, level, hint });

// The rows of the counters card and, for Unbound with extended statistics, the answer codes:
// { rows, codes, since, note }. Counters the engine does not report are left out, never shown as zero.
export function activity(data) {
  const s = data.stats;
  if (!s) return { rows: [], codes: [], since: null, note: data.engine ? 'The resolver reports no counters.' : 'No resolver is running.' };
  if (data.engine === 'dnsmasq') {
    const total = totalQueries(data);
    const f = (n, d) => (n == null || !d ? null : n / d);
    const rows = [
      row('forwarded', 'Forwarded upstream', s.forwarded, f(s.forwarded, total), '', 'Queries dnsmasq had to ask an upstream server.'),
      row('local', 'Answered locally', s.local_answered, f(s.local_answered, total), 'good', 'From the cache or from local names (hosts files, DHCP leases).'),
      row('auth', 'Answered as authoritative', s.auth_answered, f(s.auth_answered, total), '', 'From zones dnsmasq is authoritative for.'),
      row('stale', 'Answered from stale cache', s.stale_answered, null, '', 'Expired cache entries served while a fresh answer was fetched.'),
      row('unanswered', 'No answer from upstream', s.unanswered, f(s.unanswered, s.forwarded), s.unanswered > 0 && pct(s.unanswered, s.forwarded) > 2 ? 'weak' : (s.unanswered > 0 ? 'fair' : ''), 'Forwarded queries no upstream server answered.'),
      row('inserted', 'Cache insertions', s.cache_inserted, null, '', 'Names added to the cache since start.'),
      row('freed', 'Live entries evicted', s.cache_live_freed, null, s.cache_live_freed > 0 ? 'fair' : '', 'Cache entries removed before they expired because the cache was full. A value above zero means the cache is too small.'),
      row('size', 'Cache size', s.cache_size, null, '', 'Names the cache can hold (the configured size).'),
    ].filter(r => r.value != null);
    return { rows, codes: [], since: s.since, note: 'Counters since dnsmasq started. dnsmasq counts what it forwarded and what it answered itself; it reports neither answer codes nor resolution times.' };
  }
  const total = s.queries;
  const f = n => (n == null || !total ? null : n / total);
  const rows = [
    row('queries', 'Queries received', s.queries, null, '', 'Every query a client sent to Unbound.'),
    row('hits', 'Answered from the cache', s.cache_hits, f(s.cache_hits), 'good', 'Answers that needed no upstream query.'),
    row('misses', 'Needed an upstream query', s.cache_misses, f(s.cache_misses), '', 'Answers Unbound had to fetch by forwarding or by recursion.'),
    row('prefetch', 'Prefetched', s.prefetch, null, '', 'Entries refreshed shortly before they expired, so the next client gets a cached answer.'),
    row('expired', 'Served expired', s.expired, null, '', 'Expired entries served while a fresh answer was fetched.'),
    row('timeouts', 'Timed out', s.timed_out, f(s.timed_out), s.timed_out > 0 ? 'fair' : '', 'Queries that took too long and were abandoned.'),
    row('ratelimited', 'Rate limited', s.ratelimited, f(s.ratelimited), s.ratelimited > 0 ? 'weak' : '', 'Queries dropped because a client sent too many per second.'),
    row('secure', 'DNSSEC secure answers', s.secure, f(s.secure), 'good', 'Answers whose signatures were verified.'),
    row('bogus', 'DNSSEC bogus answers', s.bogus, f(s.bogus), s.bogus > 0 ? 'weak' : '', 'Answers that failed DNSSEC validation and were refused.'),
    row('unwanted-queries', 'Unwanted queries', s.unwanted_queries, null, '', 'Queries Unbound refused to answer (clients outside its access list).'),
    row('unwanted-replies', 'Unwanted replies', s.unwanted_replies, null, s.unwanted_replies > 0 ? 'fair' : '', 'Replies nobody asked for: stray or spoofed packets.'),
    row('cache-msgs', 'Cached messages', s.cache_msgs, null, '', 'Answers held in the message cache.'),
    row('cache-rrsets', 'Cached record sets', s.cache_rrsets, null, '', 'Record sets held in the record cache.'),
  ].filter(r => r.value != null);
  const entries = Object.entries(s.rcodes ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sum = entries.reduce((n, [, v]) => n + v, 0);
  const LEVEL = { NOERROR: 'good', SERVFAIL: 'weak', REFUSED: 'fair', FORMERR: 'fair', NOTIMPL: 'fair' };
  const codes = entries.map(([code, count]) => row(`rcode-${code}`, code, count, sum ? count / sum : null, code === 'SERVFAIL' && pct(count, sum) <= 5 ? 'fair' : (LEVEL[code] ?? ''), RCODE_HINTS[code] ?? ''));
  return { rows, codes, since: s.since, note: 'Counters since Unbound started (summed over its threads).' };
}

//#endregion

//#region Configuration

// The options the page shows for the engine it describes, as the fields of schema.js in the order of their groups, with
// the options of the section that the table does not know last (a list when the router holds several values, otherwise a
// text box), under their own names.
export function configFields(data) {
  return configGroups(data).flatMap(g => g.fields);
}

// The same, grouped: [{ id, title, legend, fields }] for the groups that have options. The options the tables do not
// know form a last group, "Other options".
export function configGroups(data) {
  const e = subject(data);
  const known = e === 'unbound' ? UNBOUND_FIELDS : e === 'dnsmasq' ? DNSMASQ_FIELDS : [];
  const groups = (e === 'unbound' ? UNBOUND_GROUPS : e === 'dnsmasq' ? DNSMASQ_GROUPS : [])
    .map(g => ({ id: g.id, title: g.title, legend: g.legend, fields: g.keys.map(k => known.find(f => f.key === k)).filter(Boolean) }));
  const grouped = new Set(groups.flatMap(g => g.fields.map(f => f.key)));
  const strays = known.filter(f => !grouped.has(f.key));
  const unknown = Object.entries(data.config ?? {}).filter(([key]) => !known.some(f => f.key === key))
    .map(([key, value]) => ({ key, type: Array.isArray(value) ? 'list' : 'string', label: key, hint: '' }));
  const rest = [...strays, ...unknown];
  return [...groups, ...(rest.length ? [{ id: 'other', title: 'Other options', legend: 'Options of this section that the page has no description for.', fields: rest }] : [])];
}

// The values the controls start from: one per field, as core/fields.js reads them (a boolean with the package's default
// when the option is absent, a list, or a string that is '' when the option is not set). This is the draft an editing
// page would change; here it is only displayed.
export function configDraft(data) {
  return Object.fromEntries(configFields(data).map(f => [f.key, valueOf(f, data.config?.[f.key])]));
}

//#endregion
