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
check(t[4].value === '2' && t[4].sub === '2 default forwarders · 0 from the WAN', 'upstream: the two default forwarders (the zone rule is not counted); the WAN server is not among the servers in force, so it is not counted', j(t[4]));
const ubWan = clone(ub); ubWan.forwards[1].servers.push('192.0.2.53');
check(tileOf(ubWan, 'Upstream servers').value === '3' && tileOf(ubWan, 'Upstream servers').sub === '2 default forwarders · 1 from the WAN', 'a WAN server that a forward zone really uses is counted', j(tileOf(ubWan, 'Upstream servers')));
check(t[5].value === 'Validating' && t[5].cls === '', 'DNSSEC validating');
t = m.summary(dm);
check(t[2].label === 'Answered locally' && t[2].value === '59%' && /from the cache and local names/.test(t[2].sub), 'dnsmasq: local answers against local and forwarded', j(t[2]));
check(plain(t[1].value) === '1382' && /per minute/.test(t[1].sub), 'dnsmasq queries: forwarded plus answered locally', j(t[1]));
check(t[3].label === 'Forwarded upstream' && t[3].value === '568' && /does not report/.test(t[3].sub), 'dnsmasq has no resolution time: the forwarded count instead', j(t[3]));
check(t[4].value === '3' && t[5].value === 'Not supported' && /no DNSSEC/.test(t[5].sub), 'upstream servers count the WAN one; DNSSEC not supported by the build', j([t[4], t[5]]));
const noWan = { ...clone(dm), upstream_used: false };
check(tileOf(noWan, 'Upstream servers').value === '2', 'WAN resolvers dnsmasq ignores (noresolv) are not counted');
{
  const w = d => m.wanResolvers(d);
  check(w(ub).verdict === 'unused' && w(ub).servers.length === 1 && w(ub).servers[0].used === false && /does not ask them: it sends queries to its own forwarders/.test(m.wanNote(ub)) && /resolv_conf '1'/.test(m.wanNote(ub)), 'Unbound does not ask the WAN resolvers when they are not among the servers in force, and says how to use them', m.wanNote(ub));
  check(/resolves names itself, from the root servers/.test(m.wanNote({ ...clone(ub), forwards: [] })), 'recursive Unbound says it asks the root servers instead');
  check(w(ubWan).verdict === 'used' && j(w(ubWan).zones) === '["corp.example"]' && /asks them through a forward zone with option resolv_conf '1', for corp\.example/.test(m.wanNote(ubWan)), 'Unbound asks them when a forward zone lists them, and names the zone', m.wanNote(ubWan));
  const part = clone(ubWan); part.upstream.push('192.0.2.54');
  check(w(part).verdict === 'partly' && j(w(part).servers.map(s => s.used)) === '[true,false]' && /asks some of them/.test(m.wanNote(part)), 'some of them used: partly, each marked');
  const viaDefault = clone(ub); viaDefault.forwards[0].servers.push('192.0.2.53');
  check(/for every name without a zone of its own/.test(m.wanNote(viaDefault)), 'the default zone is described, not shown as a dot');
  const many = clone(ubWan); many.forwards.push(...['a', 'b', 'c'].map(z => ({ zone: `${z}.example`, servers: ['192.0.2.53'], flags: [], tls: false })));
  check(/for corp\.example, a\.example, b\.example and 1 more/.test(m.wanNote(many)), 'more than three zones are cut', m.wanNote(many));
  check(w(dm).verdict === 'used' && /asks them in addition to its own servers/.test(m.wanNote(dm)) && w(noWan).verdict === 'unused' && /ignores them: option noresolv is set/.test(m.wanNote(noWan)) && w(noWan).servers.every(s => !s.used), 'dnsmasq asks them unless noresolv is set');
  check(w(none).verdict === 'none' && /gave no resolver/.test(m.wanNote(none)) && w({ ...clone(ub), upstream: [] }).servers.length === 0, 'no WAN resolver: nothing to ask');
}
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
console.log('\n== zone drafts and flags ==');
{
  const cf = { section: 'fwd_cloudflare', enabled: true, zones: ['.'], servers: ['1.1.1.1', '1.0.0.1'], options: { tls_upstream: '1', tls_index: 'cloudflare-dns.com', fallback: '0' } };
  const zd = m.zoneDraft(cf);
  check(zd.enabled === true && j(zd.zone_name) === '["."]' && j(zd.server) === '["1.1.1.1","1.0.0.1"]' && zd.tls_upstream === true && zd.tls_index === 'cloudflare-dns.com' && zd.fallback === false && zd.tls_port === '' && zd.port === '' && zd.dns_assist === '' && zd.resolv_conf === false, 'a UCI zone becomes the values of its form: booleans as booleans (the default when absent), lists, and empty strings for what is not set', j(zd));
  check(Object.keys(m.zoneDraft({ enabled: false, zones: [], servers: [] })).join() === 'zone_type,enabled,zone_name,server,tls_upstream,tls_index,tls_port,port,fallback,dns_assist,resolv_conf,url_dir' && m.zoneDraft({ enabled: false, zones: [], servers: [] }).fallback === true && m.zoneDraft({ type: 'auth_zone', enabled: true, zones: ['.'], servers: [], options: { url_dir: 'https://x.example/' } }).zone_type === 'auth_zone', 'a zone with no options still has every field; fall back is on unless set off; the type and the URL are read');
}
check(m.flagWords(['i', 'local-only', 'zz']).join('|') === 'not DNSSEC-validated|answered locally, never forwarded|zz', 'flags in words; an unknown flag as it is');
check(same(m.defaultForwarders(ub), ['2606:4700:4700::1111', '1.1.1.1']) && m.defaultForwarders(none).length === 0, 'the default forwarders are the servers of the "." row');
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
const areas = m.configAreas(ub);
check(areas.map(a => a.id).join() === 'general,security,local,perf' && areas.every(a => a.title && a.legend && a.count > 0 && a.sections.length) && areas[0].open === false && areas.every(a => !a.open), 'Unbound\'s options are in four collapsible areas, General first and Security and privacy second, all folded', areas.map(a => `${a.title} ${a.count}`).join(' | '));
check(j(areas[0].sections.map(s => s.title)) === '["Service and monitoring","Listening and interfaces"]' && areas[0].sections[0].fields.some(x => x.key === 'unbound_control') && areas[0].sections[1].fields.some(x => x.key === 'iface_lan') && j(areas[1].sections.map(s => s.title)) === '["Access and abuse","Rebind protection","Privacy","DNSSEC"]' && areas[1].sections[3].fields.some(x => x.key === 'validator'), 'General holds the service and monitoring first, then listening and interfaces; Security and privacy holds access, rebind protection, privacy and DNSSEC');
check(j(f.map(x => x.key).sort()) === j(m.configFields({ ...ub, config: {} }).map(x => x.key).sort()) && new Set(f.map(x => x.key)).size === f.length && f.length === 38, 'every option is in exactly one area', String(f.length));
const dareas = m.configAreas(dm);
check(dareas.map(a => a.id).join() === 'general,security,local,cache,dhcp' && m.configFields(dm).length === 28 && dareas[1].sections.some(s => s.fields.some(x => x.key === 'dnssec')), 'dnsmasq\'s options are in five areas, General then Security and privacy', String(m.configFields(dm).length));
check(areas[0].summary === 'port 53 · LAN interfaces from DHCP · remote control: off · basic statistics' && areas[1].summary === 'DNSSEC on · rebind protection: block private addresses (rfc 1918 and 4193) · local clients only · 300 queries/s per client', 'a folded area says something: the port, interfaces and monitoring; the security switches', `${areas[0].summary} // ${areas[1].summary}`);
check(areas[2].summary === '' && dareas[0].summary === 'port 53 · every interface · WAN resolvers used' && dareas[1].summary === 'DNSSEC off · rebind protection on · local clients only', 'the other areas have no line; dnsmasq\'s are worked out from its options', `${dareas[0].summary} // ${dareas[1].summary}`);
check(f.every(x => x.label && x.hint && ['bool', 'enum', 'int', 'string', 'list'].includes(x.type) && (x.type !== 'enum' || (x.options.length > 1 && (x.default == null || x.options.includes(x.default)))) && (x.type !== 'int' || x.number === true)), 'every field has a label, a hint and a known type; an enum lists its choices; a number is a number input');
check(f.filter(x => x.type === 'enum').every(x => x.options.every(o => x.labels?.[o])), 'every choice has its words');
check(new Set(f.map(x => x.key)).size === f.length && f.some(x => x.key === 'unbound_control' && x.type === 'enum') && f.some(x => x.key === 'rate_limit' && x.type === 'int' && x.min === 0), 'one field per option; remote control is a choice and the rate limit a number');
let v = m.configDraft(ub);
check(v.validator === true && v.extended_stats === false && v.rebind_protection === '1' && v.domain === 'lab.example' && v.rate_limit === '300' && v.num_threads === '4', 'the draft holds what is set: booleans as booleans, the rest as strings');
check(v.listen_port === '' && v.protocol === '' && v.dns64 === false && v.localservice === true && Array.isArray(v.iface_lan) && v.iface_lan.length === 0, 'an option that is not set is empty (the control shows its default); a boolean takes its default; a list is empty');
d = clone(ub); d.config.iface_lan = ['lan', 'wg0']; d.config.mystery = 'x'; d.config.mysteries = ['x', 'y'];
f = m.configFields(d);
check(f.at(-2).key === 'mystery' && f.at(-2).type === 'string' && f.at(-2).label === 'mystery' && f.at(-1).type === 'list' && m.configAreas(d).at(-1).title === 'Other options' && m.configAreas(ub).every(a => a.id !== 'other') && j(m.configDraft(d).iface_lan) === '["lan","wg0"]' && m.configDraft(d).mystery === 'x', 'an option the table does not know is listed as it is, in a last group "Other options"');
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

//#region Editing
console.log('\n== editing the options ==');
{
  const e = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/dns/edit.js')).href);
  const U = { ...clone(ub), config_section: { config: 'unbound', name: 'ub_main' } };
  const D = { ...clone(dm), config_section: { config: 'dhcp', name: 'cfg01411c' } };
  let d = e.draftFrom(U);
  check(!e.isDirty(U, d) && e.changesOf(U, d).length === 0 && j(e.plan(U, d)) === '[]' && e.problems(U, d).errors.length === 0 && e.problems(U, d).warnings.length === 0, 'an untouched form has no changes, writes nothing and has no problems');
  d.values.rate_limit = '500'; d.values.extended_stats = true; d.values.rebind_protection = '2'; d.values.domain = 'lan.example';
  const ch = e.changesOf(U, d);
  check(j(ch.map(c => c.key)) === '["extended_stats","rate_limit","rebind_protection","domain"]' && j(ch[0]) === '{"key":"extended_stats","label":"Extended statistics","from":"off","to":"on"}' && ch[2].from === 'Block private addresses (RFC 1918 and 4193)' && ch[2].to === 'Also this router\'s own global /64' && ch[3].to === 'lan.example' && e.isDirty(U, d), 'the changes are listed in the order of the page, with words for the choices and on/off for the switches', j(ch));
  check(j(e.plan(U, d)) === j([{ op: 'set', config: 'unbound', section: 'ub_main', values: { extended_stats: '1', rate_limit: '500', rebind_protection: '2', domain: 'lan.example' } }]), 'the plan is one set of the changed options only, a boolean as 1 or 0', j(e.plan(U, d)));
  d = e.draftFrom(U); d.values.rate_limit = ''; d.values.verbosity = ''; d.values.validator = false; d.values.localservice = false; d.values.protocol = 'ip4_only';
  // The keys of a values object in a fixed order, so the comparison does not depend on the order the plan builds it in.
  const sorted = ops => j(ops.map(o => (o.values ? { ...o, values: Object.fromEntries(Object.entries(o.values).sort()) } : o)));
  check(sorted(e.plan(U, d)) === sorted([{ op: 'set', config: 'unbound', section: 'ub_main', values: { validator: '0', localservice: '0', protocol: 'ip4_only' } }, { op: 'delete', config: 'unbound', section: 'ub_main', options: ['rate_limit'] }]), 'an emptied option is deleted, but only when the router has it; a boolean whose default applies is written when changed', j(e.plan(U, d)));
  d = e.draftFrom(U); d.values.rate_limit = ' 500 '; d.values.domain = '  lan.example  ';
  check(e.plan(U, d)[0].values.rate_limit === '500' && e.plan(U, d)[0].values.domain === 'lan.example', 'values are trimmed');
  d = e.draftFrom(U); d.values.iface_lan = ['x']; d.values.mystery = 'y'; d.values.domain_insecure = ['a.example'];
  check(!e.isDirty(U, d) && j(e.plan(U, d)) === '[]', 'lists and options the page has no description for are not editable yet: changing them changes nothing');
  check(j(e.plan({ ...U, config_section: null }, { values: { ...d.values, rate_limit: '1' } })) === '[]', 'without a UCI section there is nothing to write');

  d = e.draftFrom(U); d.values.rate_limit = 'abc'; d.values.listen_port = '70000'; d.values.num_threads = '0'; d.values.edns_size = '12';
  const er = e.problems(U, d).errors;
  check(er.length === 4 && er.some(x => x.key === 'rate_limit' && /whole number/.test(x.text)) && er.some(x => x.key === 'listen_port' && /at most 65535/.test(x.text)) && er.some(x => x.key === 'num_threads' && /at least 1/.test(x.text)) && er.some(x => x.key === 'edns_size' && /at least 512/.test(x.text)), 'a number that is not a whole number or out of its range is an error', j(er));
  d = e.draftFrom(U); d.values.rate_limit = ''; d.values.listen_port = '';
  check(e.problems(U, d).errors.length === 0, 'an empty number is "not set", not an error');

  // A router where the service is enabled and the control channel is on, so that turning them off is a change.
  const U2 = { ...clone(U), config: { ...U.config, enabled: '1', unbound_control: '1' } };
  const warn = (data, edits) => { const x = e.draftFrom(data); Object.assign(x.values, edits); return e.problems(data, x).warnings.join(' | '); };
  check(/unbound-control/.test(warn(U2, { unbound_control: '0' })) && /port 5353 instead of 53/.test(warn(U, { listen_port: '5353' })) && /open resolver/.test(warn(U, { localservice: false })) && /web page could reach devices/.test(warn(U, { rebind_protection: '0' })) && /checked for forgery/.test(warn(U, { validator: false })) && /stopped and will not start/.test(warn(U2, { enabled: false })) && /read \/etc\/unbound\/unbound\.conf/.test(warn(U, { manual_conf: true })), 'risky changes are warned about: the control channel this page needs, another port, an open resolver, no rebind protection, no DNSSEC, stopping the service, manual configuration', [warn(U2, { unbound_control: '0' }), warn(U, { listen_port: '5353' }), warn(U2, { enabled: false })].join(' // '));
  check(warn(U, { verbosity: '2', rate_limit: '100' }) === '' && warn(U, { listen_port: '53' }) === '', 'harmless changes are not warned about; a port of 53 is not a change of port');
  check(/no DNSSEC support/.test(warn(D, { dnssec: true })) && /only serve DHCP/.test(warn(D, { port: '0' })) && /port 5353 instead of 53/.test(warn(D, { port: '5353' })) && /open resolver/.test(warn(D, { localservice: false })) && warn(D, { cachesize: '500' }) === '', 'dnsmasq: DNSSEC in a build without it, a port of 0 or another port, an open resolver; a bigger cache is fine');

  d = e.draftFrom(D); d.values.cachesize = '500'; d.values.strictorder = false; d.values.rebind_protection = false;
  check(sorted(e.plan(D, d)) === sorted([{ op: 'set', config: 'dhcp', section: 'cfg01411c', values: { cachesize: '500', strictorder: '0', rebind_protection: '0' } }]), 'dnsmasq options are written to its section of the dhcp config', j(e.plan(D, d)));

  d = e.draftFrom(U); d.values.rate_limit = '500'; d.values.extended_stats = true;
  const after = { ...clone(U), config: { ...U.config, rate_limit: '500', extended_stats: '1' } };
  let threw = null;
  try { e.checkApplied(U, after, d); } catch (x) { threw = x; }
  check(threw === null, 'a change that was kept passes the check');
  try { e.checkApplied(U, U, d); } catch (x) { threw = x; }
  check(threw && /Extended statistics, Rate limit \(queries per second\) were not saved/.test(threw.message), 'a change that was not kept fails it, naming the options', threw?.message);
  threw = null;
  const down = { ...clone(after), engines: { ...after.engines, unbound: { ...after.engines.unbound, running: false } } };
  try { e.checkApplied(U, down, d); } catch (x) { threw = x; }
  check(threw && /Unbound is not running after the change/.test(threw.message) && e.engineRunning(U) && !e.engineRunning(down), 'a resolver that stopped running after the change fails the check, so the change is rolled back', threw?.message);
  threw = null;
  d = e.draftFrom(U2); d.values.enabled = false;
  const off = { ...clone(U2), config: { ...U2.config, enabled: '0' }, engines: { ...U2.engines, unbound: { ...U2.engines.unbound, running: false } } };
  try { e.checkApplied(U2, off, d); } catch (x) { threw = x; }
  check(threw === null, 'switching the Unbound service off is the one change that may stop it');
}
//#endregion

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
