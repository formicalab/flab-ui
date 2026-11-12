// Unit test for the DNS page's model (www/js/pages/dns/model.js): addresses, the six tiles, the findings, the listener
// chips, grouping and filtering of the forwarders, the activity rows and the configuration rows. Pure functions: no router
// and no browser. Usage: node model.test.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const m = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/dns/model.js')).href);

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;
// The text without the thousands separators the machine's locale adds ("26,000" or "26.000").
const plain = s => s.replace(/(\d)[.,\u00a0\u202f](?=\d{3}\b)/g, '$1');
const clone = o => JSON.parse(JSON.stringify(o));
const keys = list => list.map(f => f.key);
const tileOf = (data, label) => m.summary(data).find(t => t.label === label);

// A reply the way the plugin builds it, for each situation.
const ub = {
  ok: true, engine: 'unbound', configured: 'unbound', version: '1.26.2', uptime: 3600,
  engines: { unbound: { installed: true, running: true, pid: 1, port: 53, control: true }, dnsmasq: { installed: false, running: false, pid: null, port: 53 } },
  listeners: [{ addr: '0.0.0.0', port: 53, proto: 'tcp', engine: 'unbound' }, { addr: '::', port: 53, proto: 'udp', engine: 'unbound' }, { addr: '0.0.0.0', port: 53, proto: 'udp', engine: 'unbound' }],
  stats: { queries: 1200, cache_hits: 900, cache_misses: 300, prefetch: 4, expired: 0, ratelimited: 0, timed_out: 1, recursion_avg_ms: 45.9, recursion_median_ms: 30.8, rcodes: {}, secure: null, bogus: null, unwanted_queries: null, unwanted_replies: null, cache_msgs: null, cache_rrsets: null, cache_bytes: null, since: 3600 },
  config: { validator: '1', rebind_protection: '1', domain: 'lab.example', rate_limit: '300', num_threads: '4', extended_stats: '0' }, defaults: { listen_port: '53', extended_stats: '0', rate_limit: '0' },
  forwards: [{ zone: '.', servers: ['2606:4700:4700::1111', '1.1.1.1'], flags: [], tls: true }, { zone: 'corp.example', servers: ['10.0.0.1'], flags: ['i'], tls: false }],
  upstream: ['192.0.2.53'], upstream_used: null, local_names: 6, dnssec: { supported: true, enabled: true }, truncated: { forwards: false, listeners: false }, warnings: [],
};
const dm = {
  ok: true, engine: 'dnsmasq', configured: 'dnsmasq', version: '2.93', uptime: 7200,
  engines: { unbound: { installed: false, running: false, pid: null, port: 53 }, dnsmasq: { installed: true, running: true, pid: 5, port: 53 } },
  listeners: [{ addr: '192.168.8.1', port: 53, proto: 'tcp', engine: 'dnsmasq' }],
  stats: { forwarded: 568, local_answered: 814, auth_answered: 0, stale_answered: 0, unanswered: 7, cache_inserted: 418, cache_live_freed: 0, cache_size: 1000, since: 7200 },
  config: { domain: 'lan.example', cachesize: '1000', strictorder: '1' }, defaults: { port: '53', cachesize: '150', rebind_protection: '1', localservice: '1' },
  forwards: [{ zone: '.', servers: ['127.0.0.1#5053', '1.1.1.1'], flags: [], tls: null }, { zone: 'azure.net', servers: ['10.0.2.4'], flags: [], tls: null }],
  upstream: ['10.133.106.38'], upstream_used: true, local_names: 7, dnssec: { supported: false, enabled: false }, truncated: { forwards: false, listeners: false }, warnings: [],
};
const stopped = { ...clone(ub), engine: null, stats: null, uptime: null, listeners: [], local_names: null, engines: { unbound: { installed: true, running: false, pid: null, port: 53 }, dnsmasq: { installed: true, running: false, pid: null, port: 53 } } };
const none = { ok: true, engine: null, configured: null, version: null, uptime: null, engines: { unbound: { installed: false, running: false, port: 53 }, dnsmasq: { installed: false, running: false, port: 53 } }, listeners: [], stats: null, config: {}, defaults: {}, forwards: [], upstream: [], upstream_used: null, local_names: null, dnssec: { supported: null, enabled: null }, truncated: { forwards: false, listeners: false }, warnings: [] };

//#region Addresses
console.log('== addresses and percentages ==');
check(m.serverAddress('1.1.1.1@853#cloudflare-dns.com') === '1.1.1.1' && m.serverAddress('127.0.0.1#5053') === '127.0.0.1' && m.serverAddress('2606:4700::1111') === '2606:4700::1111', 'a server entry loses its port and TLS name, an IPv6 address keeps its colons');
const pub = ['1.1.1.1', '8.8.8.8', '91.80.35.167', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2001:db8::1'];
const priv = ['10.0.252.68', '192.168.8.1', '172.16.0.1', '172.31.255.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd0c:f0e0::1', 'fc00::1', 'ff02::1', 'dns.example', ''];
check(pub.every(m.isPublicIp), 'public IPv4 and IPv6 addresses are public (including 172.32/12 and 100.128/10, just outside the private blocks)', j(pub.filter(a => !m.isPublicIp(a))));
check(priv.every(a => !m.isPublicIp(a)), 'private, loopback, link-local, shared, multicast, unique-local addresses and names are not public', j(priv.filter(m.isPublicIp)));
check(m.pct(1, 4) === 25 && m.pct(null, 4) === null && m.pct(1, 0) === null && m.fmtPct(25) === '25%' && m.fmtPct(4.23) === '4.2%' && m.fmtPct(null) === '–' && m.fmtPct(0) === '0%' && m.fmtMs(45.94) === '45.9' && m.fmtMs(312.4) === '312', 'percentages and milliseconds');
check(m.effective(ub, 'validator') === '1' && m.effective(dm, 'cachesize') === '1000' && m.effective(dm, 'rebind_protection') === '1' && m.effective(ub, 'nothing') === undefined, 'an option is the one that is set, else the default');
//#endregion

//#region Tiles
console.log('\n== tiles ==');
let t = m.summary(ub);
check(t.length === 6 && t.map(x => x.label).join() === 'Resolver,Queries,Answered from cache,Resolution time,Upstream servers,DNSSEC', 'six tiles in order (Unbound)', t.map(x => x.label).join());
check(t[0].value === 'Unbound' && t[0].sub === '1.26.2 · up 1h 0m', 'resolver: name, version and uptime', j(t[0]));
check(plain(t[1].value) === '1200' && t[1].sub === 'since start · 20 per minute', 'queries and the average per minute', j(t[1]));
check(t[2].value === '75%' && plain(t[2].sub) === '900 hits · 300 misses', 'Unbound: cache hits against hits and misses', j(t[2]));
check(t[3].value === '45.9 ms' && /median 30\.8 ms/.test(t[3].sub), 'resolution time: average and median', j(t[3]));
check(t[4].value === '3' && t[4].sub === '2 default forwarders · 1 from the WAN', 'upstream: the two default forwarders (the zone rule is not counted) and the WAN server', j(t[4]));
check(t[5].value === 'Validating' && t[5].cls === '', 'DNSSEC validating');
t = m.summary(dm);
check(t[2].label === 'Answered locally' && t[2].value === '59%' && /from the cache and local names/.test(t[2].sub), 'dnsmasq: local answers against local and forwarded', j(t[2]));
check(plain(t[1].value) === '1382' && /per minute/.test(t[1].sub), 'dnsmasq queries: forwarded plus answered locally', j(t[1]));
check(t[3].label === 'Forwarded upstream' && t[3].value === '568' && /does not report/.test(t[3].sub), 'dnsmasq has no resolution time: the forwarded count instead', j(t[3]));
check(t[4].value === '3' && t[5].value === 'Not supported' && /no DNSSEC/.test(t[5].sub), 'upstream servers count the WAN one; DNSSEC not supported by the build', j([t[4], t[5]]));
const noWan = { ...clone(dm), upstream_used: false };
check(tileOf(noWan, 'Upstream servers').value === '2', 'WAN resolvers dnsmasq ignores (noresolv) are not counted');
const dup = { ...clone(ub), upstream: ['1.1.1.1'] };
check(tileOf(dup, 'Upstream servers').value === '2', 'a WAN server that is also a default forwarder is counted once');
const rec = { ...clone(ub), forwards: [] };
check(tileOf(rec, 'Upstream servers').value === 'Recursive' && /root servers/.test(tileOf(rec, 'Upstream servers').sub), 'Unbound without a default forwarder resolves recursively');
const off = { ...clone(ub), dnssec: { supported: true, enabled: false } };
check(tileOf(off, 'DNSSEC').value === 'Off' && tileOf(off, 'DNSSEC').cls === 'text-warning', 'DNSSEC off is amber');
const nostats = { ...clone(ub), stats: null, engines: { ...ub.engines, unbound: { ...ub.engines.unbound, control: false } } };
check(tileOf(nostats, 'Queries').value === '–' && tileOf(nostats, 'Answered from cache').value === '–' && tileOf(nostats, 'Resolution time').value === '–' && /not available/.test(tileOf(nostats, 'Queries').sub), 'without statistics the tiles show a dash and say why', j(m.summary(nostats)));
t = m.summary(stopped);
check(t[0].value === 'Stopped' && t[0].cls === 'text-danger' && /Unbound is installed but not running/.test(t[0].sub), 'a stopped resolver', j(t[0]));
t = m.summary(none);
check(t[0].value === 'None' && t[0].cls === 'text-danger' && t.slice(1).every(x => x.value === '–'), 'no resolver: None, and dashes everywhere else', j(t));
const both = { ...clone(ub), engines: { ...ub.engines, dnsmasq: { installed: true, running: true, pid: 9, port: 5353 } } };
check(/dnsmasq also runs \(port 5353\)/.test(tileOf(both, 'Resolver').sub), 'the tile says when the other engine runs too');
check(m.perMinute(120, 60) === 120 && m.perMinute(null, 60) === null && m.perMinute(5, 0) === null && m.perMinute(5, null) === null, 'per minute needs a total and an age');
//#endregion

//#region Findings
console.log('\n== findings ==');
const f = d => m.findings(d);
// The ub reply has a clear-text zone only when tls is false for a public server.
check(f(ub).length === 0, 'a healthy Unbound has nothing to report (TLS to Cloudflare, a private zone)', j(f(ub)));
check(keys(f(none)).join() === 'none' && f(none)[0].level === 'bad' && /No DNS resolver is running or installed/.test(f(none)[0].text), 'no resolver at all is critical');
check(keys(f(stopped)).join() === 'stopped' && f(stopped)[0].level === 'bad' && /Unbound and dnsmasq are installed but not running/.test(f(stopped)[0].text), 'both installed but stopped is critical and names them');
const oneStopped = clone(stopped); oneStopped.engines.dnsmasq.installed = false;
check(/^Unbound is installed but not running/.test(f(oneStopped)[0].text), 'one stopped engine is named in the singular');
let d = { ...clone(ub), dnssec: { supported: true, enabled: false } };
check(keys(f(d)).join() === 'dnssec-off' && f(d)[0].level === 'warn' && /validator '1'/.test(f(d)[0].text), 'DNSSEC off is a warning that says how to turn it on (Unbound)');
d = { ...clone(dm), dnssec: { supported: true, enabled: false } };
check(/option dnssec '1' in \/etc\/config\/dhcp/.test(f(d).find(x => x.key === 'dnssec-off').text), 'and for dnsmasq');
check(f(dm).some(x => x.key === 'dnssec-unsupported' && x.level === 'info'), 'a dnsmasq build without DNSSEC is information only');
d = clone(ub); d.config.rebind_protection = '0';
check(keys(f(d)).join() === 'rebind-off' && f(d)[0].level === 'warn', 'rebind protection off (set to 0)');
d = clone(dm); d.config.rebind_protection = '0';
check(f(d).some(x => x.key === 'rebind-off'), 'also for dnsmasq');
check(!f(dm).some(x => x.key === 'rebind-off') && !f(ub).some(x => x.key === 'rebind-off'), 'a default (dnsmasq) or an unset option (Unbound) is not accused');
d = clone(ub); d.forwards[0].tls = false;
check(f(d).find(x => x.key === 'clear-text')?.level === 'info' && /1\.1\.1\.1/.test(f(d).find(x => x.key === 'clear-text').text) && /tls_upstream/.test(f(d).find(x => x.key === 'clear-text').text), 'Unbound: a public default forwarder without TLS is a clear-text finding');
d = clone(ub); d.forwards[0].tls = null;
check(!f(d).some(x => x.key === 'clear-text'), 'Unbound with unknown TLS is not accused');
check(f(dm).some(x => x.key === 'clear-text' && /1\.1\.1\.1/.test(x.text)), 'dnsmasq: a public server= is clear text');
d = clone(dm); d.forwards[0].servers = ['127.0.0.1#5053'];
check(!f(d).some(x => x.key === 'clear-text'), 'dnsmasq: a loopback DoH proxy is not');
d = clone(ub); d.forwards.push({ zone: 'proxy.isp.example', servers: ['91.80.35.167'], flags: [], tls: false }, { zone: 'b.isp.example', servers: ['91.80.35.134'], flags: [], tls: false });
check(f(d).find(x => x.key === 'clear-text-zones')?.text.startsWith('2 conditional zones (proxy.isp.example, b.isp.example) are forwarded in clear text'), 'public conditional zones in clear text are one finding with a count', j(f(d)));
d = clone(dm); d.forwards = []; d.upstream = [];
check(f(d).some(x => x.key === 'no-upstream' && x.level === 'bad'), 'dnsmasq without any upstream is critical');
d = clone(dm); d.forwards = []; d.upstream_used = false;
check(f(d).some(x => x.key === 'no-upstream'), 'WAN resolvers that dnsmasq ignores do not count as upstream');
d = clone(ub); d.forwards = [];
check(!f(d).some(x => x.key === 'no-upstream'), 'Unbound without forwarders is recursive, not broken');
d = clone(ub); d.engines.unbound.control = false; d.stats = null;
check(f(d).find(x => x.key === 'no-stats')?.level === 'warn' && /option unbound_control '1' in \/etc\/config\/unbound/.test(f(d).find(x => x.key === 'no-stats').text), 'unbound-control disabled: a warning that says how to enable it');
d = clone(dm); d.stats = null;
check(f(d).find(x => x.key === 'no-stats')?.level === 'info', 'dnsmasq without metrics is information');
d = clone(ub); d.stats.rcodes = { NOERROR: 900, SERVFAIL: 60, NXDOMAIN: 40 };
check(f(d).find(x => x.key === 'servfail')?.text.startsWith('6.0% of the answers are SERVFAIL (60 of 1000)'), 'SERVFAIL above 5% of the answers is a warning', j(f(d)));
d = clone(ub); d.stats.rcodes = { NOERROR: 950, SERVFAIL: 50 };
check(!f(d).some(x => x.key === 'servfail'), 'exactly 5% is not');
d = clone(ub); d.stats.rcodes = { NOERROR: 10, SERVFAIL: 5 };
check(!f(d).some(x => x.key === 'servfail'), 'fewer than 20 answers are too few to judge');
check(!f(ub).some(x => x.key === 'servfail'), 'unknown answer codes (extended statistics off) give no finding');
d = clone(ub); d.stats.bogus = 3;
check(f(d).find(x => x.key === 'bogus')?.text.startsWith('3 answers failed DNSSEC validation'), 'bogus answers');
d.stats.bogus = 1;
check(f(d).find(x => x.key === 'bogus')?.text.startsWith('1 answer failed'), 'singular');
d = clone(ub); d.stats.ratelimited = 12;
check(f(d).find(x => x.key === 'ratelimited')?.text.startsWith('12 queries were dropped by rate limiting (300 per second and client)'), 'rate-limited queries name the limit', j(f(d)));
d = clone(dm);
check(!f(d).some(x => x.key === 'unanswered'), '7 of 568 (1.2%) is fine');
d.stats.unanswered = 20;
check(f(d).find(x => x.key === 'unanswered')?.text.startsWith('20 of 568 forwarded queries (3.5%)'), 'more than 2% unanswered is a warning', j(f(d)));
d.stats.forwarded = 10; d.stats.unanswered = 5;
check(!f(d).some(x => x.key === 'unanswered'), 'with fewer than 20 forwarded queries there is too little to judge');
d = clone(ub); d.engines.dnsmasq = { installed: true, running: true, pid: 9, port: 5353 };
check(f(d).find(x => x.key === 'both')?.level === 'info' && /dnsmasq also runs \(port 5353\) next to Unbound, which answers on port 53/.test(f(d).find(x => x.key === 'both').text), 'both engines: information that names the port');
d = clone(ub); d.listeners = [];
check(f(d).find(x => x.key === 'no-port-53')?.level === 'warn', 'a running engine that listens nowhere on port 53 is a warning');
d = clone(ub); d.warnings = ['The listening sockets could not be read.', "unbound-control is not enabled, so statistics, forwarders and local names are not available. Set option unbound_control '1' in /etc/config/unbound and restart unbound."]; d.truncated.forwards = true;
check(same(keys(f(d)), ['plugin', 'truncated-forwards']), 'a plugin warning that no rule covers, and a cut list, become information; the one already covered is not repeated', j(keys(f(d))));
d = clone(ub); d.dnssec = { supported: true, enabled: false }; d.config.rebind_protection = '0'; d.forwards[0].tls = false; d.stats.bogus = 2; d.engines.dnsmasq = { installed: true, running: true, pid: 1, port: 5353 };
const order = f(d).map(x => x.level);
check(order.join() === [...order].sort((a, b) => ({ bad: 0, warn: 1, info: 2 })[a] - ({ bad: 0, warn: 1, info: 2 })[b]).join() && order[0] === 'warn' && order.at(-1) === 'info', 'findings are listed worst first', order.join());
//#endregion

//#region Listeners
console.log('\n== listener chips ==');
const chips = m.listenerChips({ listeners: [
  { addr: '::1', port: 53, proto: 'udp', engine: 'dnsmasq' }, { addr: '192.168.8.1', port: 53, proto: 'udp', engine: 'dnsmasq' }, { addr: '192.168.8.1', port: 53, proto: 'tcp', engine: 'dnsmasq' },
  { addr: '0.0.0.0', port: 53, proto: 'tcp', engine: 'dnsmasq' }, { addr: '127.0.0.1', port: 5353, proto: 'udp', engine: 'dnsmasq' }, { addr: '::', port: 53, proto: 'tcp', engine: 'dnsmasq' }] });
check(chips.map(c => c.text).join() === '0.0.0.0:53,[::]:53,192.168.8.1:53,[::1]:53,127.0.0.1:5353', 'one chip per address and port: wildcards first, IPv4 before IPv6, by port', chips.map(c => c.text).join());
check(same(chips[2].protos, ['tcp', 'udp']) && chips[0].wildcard && chips[1].wildcard && !chips[2].wildcard, 'protocols merged and sorted; the wildcard addresses are marked');
function same(a, b) { return j(a) === j(b); }
check(m.listenerChips({}).length === 0, 'no listeners, no chips');
//#endregion

//#region Forwarding
console.log('\n== forwarding rows ==');
const rows = [
  { zone: 'a.example', servers: ['10.0.0.1', '10.0.0.2'], flags: [], tls: false }, { zone: 'b.example', servers: ['10.0.0.1', '10.0.0.2'], flags: [], tls: false },
  { zone: 'c.example', servers: ['10.0.0.1', '10.0.0.2'], flags: ['i'], tls: false }, { zone: 'd.example', servers: ['10.0.0.9'], flags: [], tls: false },
  { zone: 'e.example', servers: ['10.0.0.1', '10.0.0.2'], flags: [], tls: false }, { zone: 'x.corp', servers: ['10.0.0.1', '10.0.0.2'], flags: [], tls: true },
];
const g = m.groupForwards(rows);
check(g.length === 4 && same(g[0].zones, ['a.example', 'b.example', 'e.example']) && same(g.map(x => x.zones.length), [3, 1, 1, 1]), 'zones with the same servers, flags and TLS are one group, the largest first, zones in reply order', j(g.map(x => x.zones)));
check(g.some(x => same(x.zones, ['c.example']) && same(x.flags, ['i'])) && g.some(x => same(x.zones, ['x.corp']) && x.tls === true), 'a different flag or TLS setting is a different group');
check(m.groupForwards([]).length === 0, 'no rows, no groups');
{
  const src = [
    { zone: 'a.example', servers: ['10.0.0.1'], flags: [], tls: false, source: 'uci', section: 'fwd_a' }, { zone: 'b.example', servers: ['10.0.0.1'], flags: [], tls: false, source: 'uci', section: 'fwd_a' },
    { zone: 'c.example', servers: ['10.0.0.1'], flags: [], tls: false, source: 'uci', section: 'fwd_c' }, { zone: 'd.example', servers: ['10.0.0.1'], flags: [], tls: false, source: 'file' },
    { zone: 'e.example', servers: ['10.0.0.1'], flags: [], tls: false, source: 'file' },
  ];
  const sg = m.groupForwards(src);
  check(sg.length === 3 && same(sg[0].zones, ['a.example', 'b.example']) && sg[0].source === 'uci' && sg[0].section === 'fwd_a' && sg.some(x => x.source === 'file' && same(x.zones, ['d.example', 'e.example']) && x.section === null), 'zones with the same servers share a group only when they are defined in the same place (one UCI section, or the file)', j(sg.map(x => [x.source, x.section, x.zones])));
  check(j(m.forwardSources({ forwards: src })) === '{"uci":3,"file":2}' && j(m.forwardSources({ forwards: rows })) === '{"uci":0,"file":0}' && j(m.forwardSources({})) === '{"uci":0,"file":0}', 'forwarders are counted by where they are defined; a row without a source counts as neither');
  const cf = { section: 'fwd_cloudflare', enabled: true, zones: ['.'], servers: ['1.1.1.1', '1.0.0.1'], options: { tls_upstream: '1', tls_index: 'cloudflare-dns.com', fallback: '0' } };
  const zd = m.zoneDraft(cf);
  check(zd.enabled === true && j(zd.zone_name) === '["."]' && j(zd.server) === '["1.1.1.1","1.0.0.1"]' && zd.tls_upstream === true && zd.tls_index === 'cloudflare-dns.com' && zd.fallback === false && zd.tls_port === '' && zd.port === '' && zd.dns_assist === '' && zd.resolv_conf === false, 'a UCI zone becomes the values of its form: booleans as booleans (the default when absent), lists, and empty strings for what is not set', j(zd));
  check(Object.keys(m.zoneDraft({ enabled: false, zones: [], servers: [] })).join() === 'enabled,zone_name,server,tls_upstream,tls_index,tls_port,port,fallback,dns_assist,resolv_conf' && m.zoneDraft({ enabled: false, zones: [], servers: [] }).fallback === true, 'a zone with no options still has every field; fall back is on unless set off');
}
check(m.filterForwards(rows, '').length === 6 && m.filterForwards(rows, '  ').length === 6, 'an empty filter keeps everything');
check(m.filterForwards(rows, 'EXAMPLE 0.9').length === 1 && m.filterForwards(rows, 'EXAMPLE 0.9')[0].zone === 'd.example', 'every word must match, ignoring case');
check(m.filterForwards(rows, '10.0.0.9').length === 1 && m.filterForwards(rows, 'validated').length === 1 && m.filterForwards(rows, 'nothing').length === 0, 'the filter looks at servers and at the words of the flags too');
check(m.flagWords(['i', 'local-only', 'zz']).join('|') === 'not DNSSEC-validated|answered locally, never forwarded|zz', 'flags in words; an unknown flag as it is');
check(same(m.defaultForwarders(ub), ['2606:4700:4700::1111', '1.1.1.1']) && m.zoneForwards(ub).length === 1 && m.defaultForwarders(none).length === 0, 'default forwarders and zone rules are told apart');
check(m.defaultForwarders({ forwards: [{ zone: '.', servers: [], flags: ['local-only'] }] }).length === 0, 'a "local only" default has no forwarders');
//#endregion

//#region Activity
console.log('\n== activity ==');
let a = m.activity(ub);
const row = (x, k) => x.rows.find(r => r.key === k);
check(row(a, 'hits').value === 900 && Math.abs(row(a, 'hits').fraction - 0.75) < 1e-9 && row(a, 'hits').level === 'good' && Math.abs(row(a, 'misses').fraction - 0.25) < 1e-9, 'Unbound: hits and misses with their shares of the queries');
check(!a.rows.some(r => ['secure', 'bogus', 'unwanted-queries', 'cache-msgs'].includes(r.key)) && a.codes.length === 0 && a.since === 3600, 'counters that are not reported are left out, not shown as zero; no answer codes');
check(row(a, 'timeouts').level === 'fair' && row(a, 'ratelimited').level === '', 'a timeout is amber, no rate limiting is plain');
d = clone(ub); Object.assign(d.stats, { rcodes: { NOERROR: 880, NXDOMAIN: 100, SERVFAIL: 15, REFUSED: 5 }, secure: 700, bogus: 2, unwanted_queries: 0, unwanted_replies: 9, cache_msgs: 50, cache_rrsets: 80, ratelimited: 3 });
a = m.activity(d);
check(a.codes.map(c => c.label).join() === 'NOERROR,NXDOMAIN,SERVFAIL,REFUSED' && a.codes[0].level === 'good' && a.codes[2].level === 'fair' && a.codes[3].level === 'fair' && Math.abs(a.codes[0].fraction - 0.88) < 1e-9, 'answer codes sorted by count; SERVFAIL up to 5% amber', j(a.codes.map(c => [c.label, c.level])));
check(row(a, 'bogus').level === 'weak' && row(a, 'ratelimited').level === 'weak' && row(a, 'unwanted-replies').level === 'fair' && row(a, 'secure').value === 700, 'extended counters appear; bogus and rate limiting are red');
d.stats.rcodes = { NOERROR: 800, SERVFAIL: 200 };
check(m.activity(d).codes.find(c => c.label === 'SERVFAIL').level === 'weak', 'SERVFAIL above 5% is red');
a = m.activity(dm);
check(a.rows.map(r => r.key).join() === 'forwarded,local,auth,stale,unanswered,inserted,freed,size' && Math.abs(row(a, 'local').fraction - 814 / 1382) < 1e-9 && row(a, 'unanswered').level === 'fair' && row(a, 'size').value === 1000 && a.codes.length === 0, 'dnsmasq: its eight counters; no answer codes; unanswered below 2% is amber', a.rows.map(r => r.key).join());
d = clone(dm); d.stats.unanswered = 50; d.stats.cache_live_freed = 4;
check(row(m.activity(d), 'unanswered').level === 'weak' && row(m.activity(d), 'freed').level === 'fair', 'above 2% unanswered is red; evicted live entries are amber');
d = clone(dm); d.stats.auth_answered = null;
check(!m.activity(d).rows.some(r => r.key === 'auth'), 'a null counter has no row');
check(m.activity(none).rows.length === 0 && /No resolver is running/.test(m.activity(none).note) && /reports no counters/.test(m.activity({ ...clone(ub), stats: null }).note), 'no statistics: an explanation instead of rows');
//#endregion

//#region Configuration
console.log('\n== configuration fields ==');
{
let f = m.configFields(ub);
const groups = m.configGroups(ub);
check(groups.length === 6 && groups.every(g => g.title && g.legend && g.fields.length) && groups[0].title === 'Protection and privacy' && j(groups[1].fields.map(x => x.key)) === '["validator","validator_ntp","domain_insecure","root_age"]' && f[0].key === 'localservice', 'Unbound\'s options are in six titled groups, each with an explanation, in a fixed order', groups.map(g => `${g.title} ${g.fields.length}`).join(' | '));
check(j(f.map(x => x.key).sort()) === j(m.configFields({ ...ub, config: {} }).map(x => x.key).sort()) && new Set(f.map(x => x.key)).size === f.length && f.length === 38, 'every option is in exactly one group', String(f.length));
check(m.configGroups(dm).map(g => g.id).join() === 'listen,upstream,local,protect,cache,dhcp,log' && m.configFields(dm).length === 28, 'dnsmasq\'s options are in seven groups', String(m.configFields(dm).length));
check(f.every(x => x.label && x.hint && ['bool', 'enum', 'int', 'string', 'list'].includes(x.type) && (x.type !== 'enum' || (x.options.length > 1 && (x.default == null || x.options.includes(x.default)))) && (x.type !== 'int' || x.number === true)), 'every field has a label, a hint and a known type; an enum lists its choices; a number is a number input');
check(f.filter(x => x.type === 'enum').every(x => x.options.every(o => x.labels?.[o])), 'every choice has its words');
check(new Set(f.map(x => x.key)).size === f.length && f.some(x => x.key === 'unbound_control' && x.type === 'enum') && f.some(x => x.key === 'rate_limit' && x.type === 'int' && x.min === 0), 'one field per option; remote control is a choice and the rate limit a number');
let v = m.configDraft(ub);
check(v.validator === true && v.extended_stats === false && v.rebind_protection === '1' && v.domain === 'lab.example' && v.rate_limit === '300' && v.num_threads === '4', 'the draft holds what is set: booleans as booleans, the rest as strings');
check(v.listen_port === '' && v.protocol === '' && v.dns64 === false && v.localservice === true && Array.isArray(v.iface_lan) && v.iface_lan.length === 0, 'an option that is not set is empty (the control shows its default); a boolean takes its default; a list is empty');
d = clone(ub); d.config.iface_lan = ['lan', 'wg0']; d.config.mystery = 'x'; d.config.mysteries = ['x', 'y'];
f = m.configFields(d);
check(f.at(-2).key === 'mystery' && f.at(-2).type === 'string' && f.at(-2).label === 'mystery' && f.at(-1).type === 'list' && m.configGroups(d).at(-1).title === 'Other options' && m.configGroups(ub).every(g => g.id !== 'other') && j(m.configDraft(d).iface_lan) === '["lan","wg0"]' && m.configDraft(d).mystery === 'x', 'an option the table does not know is listed as it is, in a last group "Other options"');
f = m.configFields(dm);
check(f.find(x => x.key === 'cachesize').type === 'int' && f.find(x => x.key === 'rebind_protection').type === 'bool' && m.configDraft(dm).rebind_protection === true && m.configDraft(dm).cachesize === '1000', 'dnsmasq options and defaults');
check(m.configFields(none).length === 0, 'no resolver, no options');
{
  // The plugin reports exactly the options the page describes; one missing there would show as "not set" on a router that has it.
  const src = readFileSync(new URL('../../rpcd/ucode/flab.dns.uc', import.meta.url), 'utf8');
  const listed = name => [...src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort();
  check(j(listed('UNBOUND_OPTIONS')) === j(m.configFields(ub).map(x => x.key).sort()) && j(listed('DNSMASQ_OPTIONS')) === j(m.configFields(dm).map(x => x.key).sort()), 'the plugin reports every option of the schema, and no other');
}
check(m.configFields(stopped).length > 0 && m.subject(stopped) === 'unbound' && m.subject(none) === null && m.engineName('dnsmasq') === 'dnsmasq' && m.engineName(null) === 'None', 'a stopped engine\'s options are still shown');
}
//#endregion

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
