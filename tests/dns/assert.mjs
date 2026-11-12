// Checks the JSON the flab.dns plugin produced for each scenario. Usage: node assert.mjs <work dir with out/<case>.json,
// facts.json and cases.json>. The scenarios and the numbers they must give come from mkfx.mjs (see there).
import fs from 'node:fs';
import path from 'node:path';

const work = process.argv[2];
const out = name => JSON.parse(fs.readFileSync(path.join(work, 'out', `${name}.json`), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(work, 'facts.json'), 'utf8'));
const scenarios = JSON.parse(fs.readFileSync(path.join(work, 'scenarios.json'), 'utf8'));
const here = import.meta.dirname;
let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;
const same = (a, b) => j(a) === j(b);
// The plugin's rounding to one decimal.
const round1 = x => Math.floor(x * 10 + 0.5) / 10;
// The listening sockets as "proto addr port engine" strings, sorted.
const socks = r => r.listeners.map(l => `${l.proto} ${l.addr} ${l.port} ${l.engine}`).sort();
const zone = (r, z) => r.forwards.find(f => f.zone === z);

//#region The source and the ACL
console.log('== the plugin source and its ACL ==');
const source = fs.readFileSync(path.join(here, '../../rpcd/ucode/flab.dns.uc'), 'utf8');
const code = source.replace(/\/\/.*$/gm, '');
const literal = [...code.matchAll(/\brun\('([^']*)'\)/g)].map(m => m[1]);
const all = [...code.matchAll(/\brun\(/g)].length;
check(all === literal.length && !/\brun\(`/.test(code), 'every run() call takes one plain string: no template, no variable reaches a shell', `${all} calls, ${literal.length} literal`);
check(same([...new Set(literal)].sort(), ['command -v dnsmasq 2>/dev/null', 'command -v unbound 2>/dev/null', 'dnsmasq --version 2>/dev/null', 'ls /tmp/hosts 2>/dev/null', 'netstat -lntup 2>/dev/null', 'pidof dnsmasq 2>/dev/null',
  'pidof unbound 2>/dev/null', 'unbound -V 2>/dev/null', 'unbound-control list_forwards 2>/dev/null', 'unbound-control list_local_data 2>/dev/null', 'unbound-control stats_noreset 2>/dev/null', 'unbound-control status 2>/dev/null'].sort()),
  'the plugin runs exactly twelve fixed commands, all of them reads', j(literal));
check(!/popen|system\(|exec|writefile|unlink|mkdir|rename/.test(code), 'nothing else starts a program or writes a file');
check(!/request\.args|\.args\b/.test(code), 'status never looks at the request: it takes no arguments');
check(/call: function\(request\) \{\s*return status\(\);/.test(code) && (code.match(/call:/g) ?? []).length === 1 && !/args:/.test(code), 'one method, status, declared without arguments');
const acl = JSON.parse(fs.readFileSync(path.join(here, '../../rpcd/acl.d/flab-dns.json'), 'utf8'));
check(same(Object.keys(acl), ['flab']) && same(acl.flab.read, { ubus: { 'flab.dns': ['status'], uci: ['get', 'changes'] }, uci: ['unbound', 'dhcp'] }) && same(acl.flab.write, { ubus: { uci: ['set', 'add', 'delete', 'revert', 'apply', 'confirm', 'rollback'] }, uci: ['unbound', 'dhcp'] }), 'the ACL grants flab.dns: [status] and the staged uci edits of the unbound and dhcp configs, and nothing else: no file, no exec, no other config', j(acl));
//#endregion

//#region Every scenario
const sane = (r, name) => {
  check(r.ok === true && typeof r.generated === 'number' && Array.isArray(r.listeners) && Array.isArray(r.forwards) && Array.isArray(r.upstream) && Array.isArray(r.warnings)
    && r.engines?.unbound && r.engines?.dnsmasq && r.truncated && typeof r.truncated.forwards === 'boolean' && typeof r.truncated.listeners === 'boolean', `${name}: the reply has its whole shape`, j(Object.keys(r)));
};
for (const n of scenarios.filter(s => s !== 'real')) sane(out(n), n);

console.log('\n== unbound (extended statistics, ninety forwarders) ==');
{
  const r = out('unbound');
  const e = r.engines.unbound;
  check(r.engine === 'unbound' && r.configured === 'unbound' && e.installed && e.running && e.pid === 2201 && e.control === true && e.port === 53 && r.engines.dnsmasq.installed === false && r.engines.dnsmasq.running === false && r.engines.dnsmasq.stats === null, 'Unbound is the engine, running as pid 2201 with the control channel; dnsmasq is not installed', j(r.engines));
  check(r.version === '1.26.2' && r.uptime === 273600 && e.version === '1.26.2' && e.uptime === 273600, 'version and uptime come from unbound-control status', `${r.version} ${r.uptime}`);
  check(same(socks(r), ['tcp 0.0.0.0 53 unbound', 'tcp :: 53 unbound', 'udp 0.0.0.0 53 unbound', 'udp :: 53 unbound']), 'four listeners, each socket once (Unbound opens two per address) and without the loopback control port 8953', j(socks(r)));
  const s = r.stats, t = facts.ubT;
  check(s.queries === t.queries && s.cache_hits === t.hits && s.cache_misses === t.queries - t.hits && s.prefetch === t.prefetch && s.expired === t.expired && s.ratelimited === t.ratelimited && s.timed_out === t.timedOut, 'the totals of the statistics: queries, hits, misses, prefetch, expired, rate limited, timed out', j(s));
  check(s.recursion_avg_ms === round1(51.234) && s.recursion_median_ms === round1(32.1) && s.since === 273600, 'recursion times in milliseconds with one decimal, and the age of the counters', `${s.recursion_avg_ms} ${s.recursion_median_ms} ${s.since}`);
  check(same(s.rcodes, { NOERROR: 44100, SERVFAIL: 910, NXDOMAIN: 3200, REFUSED: 12 }), 'the answer codes (without the nodata line, which is a subset of NOERROR)', j(s.rcodes));
  check(s.secure === t.secure && s.bogus === 3 && s.unwanted_queries === 0 && s.unwanted_replies === 17 && s.cache_msgs === 4120 && s.cache_rrsets === 6800 && s.cache_bytes === 1048576 + 2097152, 'the extended counters: DNSSEC secure and bogus, unwanted traffic, cache sizes', j(s));
  check(same(r.stats, r.engines.unbound.stats), 'the top-level statistics are those of the engine');
  check(r.config.validator === '1' && r.config.rate_limit === '300' && r.config.extended_stats === '0' && same(r.config.iface_lan, ['lan', 'lan100', 'wg0']) && r.config.domain === 'lab.formicalab.casa' && r.config.fwd_cloudflare === undefined && same(r.config.iface_trig, ['lan', 'wan']) && r.config.add_extra_dns === '1' && r.config.hide_binddata === '1' && r.config.interface_auto === '1' && r.config.root_age === '9', 'the options that are set, whitelisted (a list stays a list); zone sections are not options', j(r.config));
  check(same(r.defaults, { listen_port: '53', extended_stats: '0', unbound_control: '0', edns_size: '1232', rate_limit: '0', dns64: '0' }), 'the known defaults of Unbound', j(r.defaults));
  check(r.forwards.length === facts.forwardRows && r.truncated.forwards === false, `${facts.forwardRows} forward rules, nothing cut`, String(r.forwards.length));
  const def = r.forwards[0];
  check(def.zone === '.' && same(def.servers, facts.cloudflare) && same(def.flags, []) && def.tls === true, 'the default forwarders come first, over TLS (known from the generated configuration)', j(def));
  check(facts.azureZones.every(z => same(zone(r, z)?.servers, facts.azureServers) && zone(r, z).tls === false && same(zone(r, z).flags, [])), 'every Azure zone goes to the same two private resolvers, in clear text, no trailing dot', j(zone(r, facts.azureZones[0])));
  check(same(zone(r, 'lab.formicalab.casa').flags, ['i']) && same(zone(r, 'flumini.formicalab.casa').servers, ['192.168.8.1']) && same(zone(r, 'flumini.formicalab.casa').flags, ['i']), 'the +i flag is read as the flag "i" and is not a server', j(zone(r, 'lab.formicalab.casa')));
  check(same(zone(r, 'proxy.dsl.vodafone.it').servers, facts.vodafone) && zone(r, 'proxy.dsl.vodafone.it').tls === false, 'a public clear-text zone is reported with tls false');
  check(same(r.upstream, ['192.0.2.53', '2001:db8:53::1']) && r.upstream_used === null, 'the WAN resolvers: loopback skipped, duplicates once, search lines ignored', j(r.upstream));
  check(same(r.forward_uci.map(z => z.section), ['fwd_cloudflare', 'fwd_google', 'fwd_vodafone']) && same(r.forward_uci[0], { section: 'fwd_cloudflare', enabled: true, zones: ['.'], servers: facts.cloudflare, options: { tls_upstream: '1', tls_index: 'cloudflare-dns.com', fallback: '0' } }) && r.forward_uci[1].enabled === false && same(r.forward_uci[2].zones, ['proxy.dsl.vodafone.it']) && r.forward_uci[2].options.dns_assist === 'none', 'the UCI forward zones, enabled or not, with their servers and options; the auth zone is not one', j(r.forward_uci));
  check(def.source === 'uci' && def.section === 'fwd_cloudflare' && zone(r, 'proxy.dsl.vodafone.it').source === 'uci' && zone(r, 'proxy.dsl.vodafone.it').section === 'fwd_vodafone', 'a running forwarder that a UCI zone section defines says so, with the section', j([def.source, def.section]));
  check(facts.azureZones.every(z => zone(r, z).source === 'file' && zone(r, z).section === undefined) && zone(r, 'lab.formicalab.casa').source === 'file' && r.forwards.filter(f => f.source === 'uci').length === 2, 'the zones that only the extension file defines are marked "file" and have no section', String(r.forwards.filter(f => f.source === 'file').length));
  check(r.local_names === facts.localNames, `${facts.localNames} local names (reverse names and repeated records are not counted)`, String(r.local_names));
  check(same(r.dnssec, { supported: true, enabled: true }) && same(r.warnings, []), 'DNSSEC is validating (the validator module is loaded) and nothing was left unread', j([r.dnssec, r.warnings]));
  check(same(r.config_section, { config: 'unbound', name: 'ub_main' }), 'the UCI section that holds the options is named, so a page can write them', j(r.config_section));
  const pd = r.private_domains;
  check(pd.length === 14 && same(pd[0], { name: 'lab.formicalab.casa', source: 'uci' }) && same(pd.slice(1, 3), [{ name: 'formicalab.casa', source: 'file' }, { name: 'proxy.dsl.vodafone.it', source: 'file' }]) && pd.filter(x => x.name === 'lab.formicalab.casa').length === 1 && pd.at(-1).name === 'blob.core.windows.net' && pd.every(x => x.name === x.name.toLowerCase() && !/["]|\.$/.test(x.name)) && !pd.some(x => /commented|domain-insecure|openwrt/.test(x.name)) && r.truncated.private_domains === false, 'the rebind-protection exceptions: the one UCI generates, then those of the srv file; once each, lowercase, no quotes or trailing dot, comments and other directives ignored', j(pd));
}

console.log('\n== unbound-basic (the main router: extended statistics off) ==');
{
  const r = out('unbound-basic');
  const s = r.stats, t = facts.basicT;
  check(r.engine === 'unbound' && r.uptime === 618 && s.queries === 2011 && s.cache_hits === 575 && s.cache_misses === 1436, 'totals are read', j(s));
  check(s.recursion_avg_ms === round1(45.918) && s.recursion_median_ms === round1(30.7683), 'recursion times', `${s.recursion_avg_ms} ${s.recursion_median_ms}`);
  check(same(s.rcodes, {}) && s.secure === null && s.bogus === null && s.unwanted_queries === null && s.unwanted_replies === null && s.cache_msgs === null && s.cache_rrsets === null && s.cache_bytes === null, 'what extended statistics would add is null, not zero', j(s));
  check(s.prefetch === 0 && s.expired === 0 && s.ratelimited === 0 && s.timed_out === 0 && t.queries === 2011, 'counters that are present and zero stay zero');
  check(r.forwards.length === 3 && r.config.rebind_protection === '0' && r.upstream.length === 0 && r.local_names === facts.localNames, 'three forwarders, rebind protection off in the options, no WAN resolver');
}

console.log('\n== unbound-nocontrol (unbound-control fails) ==');
{
  const r = out('unbound-nocontrol');
  check(r.engine === 'unbound' && r.engines.unbound.running && r.engines.unbound.control === false && r.stats === null && r.engines.unbound.stats === null && r.local_names === null && r.uptime === null, 'the call still succeeds: no statistics, no uptime, no local names', j([r.engine, r.stats, r.uptime]));
  check(r.warnings.length === 1 && /unbound-control is not enabled/.test(r.warnings[0]) && /option unbound_control '1' in \/etc\/config\/unbound/.test(r.warnings[0]), 'one warning that says how to enable it', j(r.warnings));
  check(r.version === '1.26.2', 'the version falls back to `unbound -V`', String(r.version));
  check(r.forwards.length === facts.forwardRows && r.forwards[0].zone === '.' && r.forwards[0].tls === true && r.forwards.every(f => same(f.flags, [])), 'the forwarders fall back to the generated configuration (no flags there)', String(r.forwards.length));
  check(same(r.dnssec, { supported: true, enabled: false }), 'DNSSEC follows the option (validator 0)', j(r.dnssec));
}

console.log('\n== unbound-many (the lists are cut) ==');
{
  const r = out('unbound-many');
  check(r.forwards.length === 500 && r.truncated.forwards === true && r.forwards[0].zone === '.' && r.forwards[1].zone === 'zone000.example.net', 'forwarders are cut at 500, the first ones kept', `${r.forwards.length} ${r.truncated.forwards}`);
  check(r.listeners.length === 50 && r.truncated.listeners === true, `${facts.manyAddrs * 2} sockets are cut at 50`, `${r.listeners.length} ${r.truncated.listeners}`);
  const mine = r.forwards.filter(f => f.source === 'uci');
  check(r.forward_uci.length === 1 && r.forward_uci[0].zones.length === 89 && mine.length === 89 && mine.every(f => f.section === 'fwd_many') && r.forwards.find(f => f.zone === 'zone089.example.net').source === 'file', 'a UCI zone section with 89 zones keeps all of them (the 50-value cap of the option lists does not apply to its names): each is marked "uci", the next one "file"', `${r.forward_uci[0]?.zones.length} ${mine.length}`);
}

console.log('\n== dnsmasq (the GL-X3000) ==');
{
  const r = out('dnsmasq');
  const e = r.engines.dnsmasq;
  check(r.engine === 'dnsmasq' && r.configured === 'dnsmasq' && e.installed && e.running && e.pid === 5752 && e.port === 53 && r.engines.unbound.installed === false && r.engines.unbound.running === false, 'dnsmasq is the engine; its pid is the one procd reports (the jail parent, not the worker)', j(r.engines));
  check(r.version === '2.93' && r.uptime === facts.dmAge && e.uptime === facts.dmAge, `version 2.93; the uptime is worked out from /proc/<pid>/stat and /proc/uptime (${facts.dmAge} s)`, `${r.version} ${r.uptime}`);
  const m = facts.dmMetrics;
  check(same(r.stats, { forwarded: m.dns_queries_forwarded, local_answered: m.dns_local_answered, auth_answered: 0, stale_answered: 0, unanswered: 7, cache_inserted: 418, cache_live_freed: 0, cache_size: 1000, since: facts.dmAge }), 'counters from `dnsmasq metrics`, the configured cache size and the age; nothing invented', j(r.stats));
  check(r.listeners.length === 12 && r.listeners.every(l => l.engine === 'dnsmasq' && l.port === 53) && r.listeners.some(l => l.addr === 'fe80::9683:c4ff:fea3:9530') && r.listeners.some(l => l.addr === 'fd0c:f0e0:4283::1'), 'twelve DNS sockets (six addresses, TCP and UDP); the DHCP socket on port 67 and IPv6 addresses with their colons are handled', j(socks(r)));
  check(r.config.domain === 'flumini.formicalab.casa' && r.config.cachesize === '1000' && r.config.strictorder === '1' && same(r.config.interface, ['lan', 'wg0']) && r.config.rebind_domain.length === 17 && r.config.server === undefined, 'the options that are set (the server list is not repeated there)', j(Object.keys(r.config)));
  check(same(r.defaults, { port: '53', cachesize: '150', rebind_protection: '1', localservice: '1' }), 'the known defaults of dnsmasq', j(r.defaults));
  check(r.forwards.length === 1 + facts.dmZones.length + 1 && r.forwards[0].zone === '.' && same(r.forwards[0].servers, ['127.0.0.1#5053', '1.1.1.1']) && r.forwards[0].tls === null, 'the plain server lines are the default forwarders and come first', j(r.forwards[0]));
  check(facts.dmZones.every(z => same(zone(r, z)?.servers, ['10.0.2.4'])) && same(zone(r, 'lab.formicalab.casa').servers, ['192.168.1.1']), '"/*.zone/server" lines become zones without the wildcard', j(zone(r, facts.dmZones[0])));
  check(same(r.upstream, ['10.133.106.38', '10.128.28.16']) && r.upstream_used === true, 'the WAN resolvers, used (noresolv is not set)', j(r.upstream));
  check(r.forward_uci.length === facts.dmZones.length + 3 && same(r.forward_uci[0], { index: 0, value: `/*.${facts.dmZones[0]}/10.0.2.4` }) && same(r.forward_uci.at(-1), { index: facts.dmZones.length + 2, value: '1.1.1.1' }) && r.forwards.every(f => f.source === 'uci' && f.section === undefined), 'every server entry is listed as written, with its index, and every forwarder is a UCI one', j(r.forward_uci.slice(0, 1)));
  check(r.local_names === facts.dmNames, `${facts.dmNames} local names from the host files and the named leases`, String(r.local_names));
  check(same(r.dnssec, { supported: false, enabled: false }) && same(r.warnings, []), 'the build says no-DNSSEC, so validation is not supported', j(r.dnssec));
  check(same(r.private_domains, []), 'dnsmasq has no private-domain list: its exceptions are the rebind_domain option', j(r.private_domains));
  check(same(r.config_section, { config: 'dhcp', name: 'cfg01411c' }), 'dnsmasq\'s options are in the dnsmasq section of the dhcp config', j(r.config_section));
}

console.log('\n== both (dnsmasq on 5353 behind Unbound) ==');
{
  const r = out('both');
  check(r.engine === 'unbound' && r.engines.unbound.running && r.engines.dnsmasq.running && r.engines.dnsmasq.pid === 3302 && r.engines.dnsmasq.port === 5353 && r.engines.unbound.port === 53, 'both run; Unbound answers on port 53 and is the engine', j(r.engines));
  check(r.stats.queries === 2011 && r.engines.dnsmasq.stats.forwarded === 568 && r.engines.dnsmasq.stats.cache_size === 1000 && r.engines.dnsmasq.uptime === facts.dmAge, 'each engine has its own counters and uptime', j(r.engines.dnsmasq));
  check(same(socks(r), ['tcp 0.0.0.0 53 unbound', 'tcp 127.0.0.1 5353 dnsmasq', 'tcp :: 53 unbound', 'tcp ::1 5353 dnsmasq', 'udp 0.0.0.0 53 unbound', 'udp 127.0.0.1 5353 dnsmasq', 'udp :: 53 unbound', 'udp ::1 5353 dnsmasq'].sort()), 'the sockets of both, each tagged with its engine; no control port, no DHCP socket', j(socks(r)));
  check(r.forwards.length === 1 && same(r.forwards[0].servers, ['127.0.0.1']) && r.config.validator === '1' && r.local_names === facts.localNames, 'the description is Unbound\'s (forwarders, options, local names)');
}

console.log('\n== stopped (installed, nothing running) ==');
{
  const r = out('stopped');
  check(r.engine === null && r.configured === 'unbound' && r.engines.unbound.installed && r.engines.dnsmasq.installed && !r.engines.unbound.running && !r.engines.dnsmasq.running && r.engines.unbound.pid === null, 'no engine answers; Unbound (enabled in UCI) is the one described', j([r.engine, r.configured]));
  check(r.stats === null && r.uptime === null && r.local_names === null && r.listeners.length === 0 && r.version === '1.26.2' && r.warnings.length === 0, 'no counters, uptime, names or sockets, no warning (a stopped engine is not an error here); the version is still known', j(r.warnings));
  check(r.forwards.length === facts.forwardRows && r.config.validator === '1' && same(r.dnssec, { supported: true, enabled: true }), 'the configured forwarders, options and DNSSEC setting are still shown');
}

console.log('\n== none (no resolver) ==');
{
  const r = out('none');
  check(r.engine === null && r.configured === null && !r.engines.unbound.installed && !r.engines.dnsmasq.installed && r.version === null && r.stats === null && r.uptime === null, 'nothing installed, nothing running', j(r.engines));
  check(r.listeners.length === 0 && r.forwards.length === 0 && same(r.config, {}) && same(r.defaults, {}) && same(r.dnssec, { supported: null, enabled: null }) && r.local_names === null && r.upstream_used === null && r.config_section === null && same(r.forward_uci, []) && same(r.warnings, []), 'every part is empty or null', j(r));
  check(same(r.upstream, ['192.0.2.53']), 'the WAN resolvers are still reported');
}

console.log('\n== arguments are ignored ==');
{
  const a = out('unbound-args'), b = out('unbound');
  check(same({ ...a, generated: 0 }, { ...b, generated: 0 }), 'a call with shell metacharacters in host, zone and q gives the reply of a call without arguments');
}
//#endregion

//#region The router under test
if (scenarios.includes('real')) {
  console.log('\n== real (what the router under test reports: invariants only) ==');
  const r = out('real');
  sane(r, 'real');
  const nonneg = v => v === null || (Number.isInteger(v) && v >= 0);
  check([null, 'unbound', 'dnsmasq'].includes(r.engine) && ['unbound', 'dnsmasq'].every(n => typeof r.engines[n].installed === 'boolean' && typeof r.engines[n].running === 'boolean'), `the engine is ${r.engine}`, j(r.engines));
  check(r.engine === null || r.engines[r.engine].running === true, 'the engine named is running');
  check(r.listeners.every(l => typeof l.addr === 'string' && l.addr !== '' && Number.isInteger(l.port) && l.port > 0 && ['tcp', 'udp'].includes(l.proto) && ['unbound', 'dnsmasq'].includes(l.engine)) && new Set(r.listeners.map(l => `${l.proto}|${l.addr}|${l.port}`)).size === r.listeners.length && r.listeners.length <= 50, `${r.listeners.length} listeners, each once, well formed`, j(r.listeners.slice(0, 3)));
  check(!r.engine || r.listeners.some(l => l.port === 53) || r.engines[r.engine].port !== 53, 'a running engine on port 53 has a listener there');
  check(r.version === null || (typeof r.version === 'string' && r.version !== ''), `version ${r.version}`);
  check(nonneg(r.uptime) && (r.engine !== null || r.uptime === null), `uptime ${r.uptime}`);
  if (r.stats) {
    const vals = Object.entries(r.stats).filter(([k]) => k !== 'rcodes' && k !== 'recursion_avg_ms' && k !== 'recursion_median_ms').map(([, v]) => v);
    check(vals.every(nonneg), 'every counter is null or a non-negative integer', j(r.stats));
    if (r.engine === 'unbound') check(r.stats.cache_hits + r.stats.cache_misses <= r.stats.queries + 1000 && (r.stats.recursion_avg_ms === null || r.stats.recursion_avg_ms >= 0), 'cache hits and misses fit the queries', j(r.stats));
    else check(r.stats.cache_size >= 0, 'the cache size is known');
  } else check(r.engine === null || r.engines[r.engine].control === false || r.engine === 'dnsmasq', 'no statistics only without a resolver, without unbound-control or without dnsmasq metrics');
  const wellFormed = f => typeof f.zone === 'string' && f.zone !== '' && Array.isArray(f.servers) && Array.isArray(f.flags) && (f.zone === '.' || !f.zone.endsWith('.'));
  check(r.forwards.length <= 500 && r.forwards.every(wellFormed) && r.forwards.filter(f => f.zone === '.').length <= 1 && (r.engine !== 'dnsmasq' || r.forwards.length === 0 || r.forwards.findIndex(f => f.zone === '.') <= 0), `${r.forwards.length} forward rules, zones normalized, at most one default (first for dnsmasq)`, j(r.forwards.slice(0, 2)));
  check(r.upstream.every(a => typeof a === 'string' && !/^127\./.test(a) && a !== '::1') && new Set(r.upstream).size === r.upstream.length, `${r.upstream.length} WAN resolvers, no loopback, no duplicates`, j(r.upstream));
  check(['boolean', 'object'].includes(typeof r.dnssec.supported) && ['boolean', 'object'].includes(typeof r.dnssec.enabled) && (r.dnssec.supported !== false || r.dnssec.enabled === false), `DNSSEC ${j(r.dnssec)}`);
  check(Object.values(r.config).every(v => typeof v === 'string' || Array.isArray(v)), 'options are strings or lists', j(r.config));
  check(nonneg(r.local_names) && r.warnings.every(w => typeof w === 'string'), `local names ${r.local_names}, warnings ${j(r.warnings)}`);
}
//#endregion

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
