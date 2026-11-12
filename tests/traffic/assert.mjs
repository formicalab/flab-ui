// Checks the JSON the flab.traffic plugin produced for each case. Usage: node assert.mjs <work dir with out/<case>.json,
// out/<case>.ms and expect/*.json>. The scenarios, the cases and the reference answers come from mkfx.mjs (see there).
import fs from 'node:fs';
import path from 'node:path';

const work = process.argv[2];
const out = name => JSON.parse(fs.readFileSync(path.join(work, 'out', `${name}.json`), 'utf8'));
const expectOf = name => JSON.parse(fs.readFileSync(path.join(work, 'expect', `${name}.json`), 'utf8'));
const ms = name => Number(fs.readFileSync(path.join(work, 'out', `${name}.ms`), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(work, 'cases.json'), 'utf8'));
const tables = expectOf('tables');
const here = import.meta.dirname;
let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;
const same = (a, b) => j(a) === j(b);
// How an entry is identified across the table and the reply.
const keyOf = e => [e.proto, e.src, e.sport ?? '', e.dst, e.dport ?? ''].join('|');
// A NAT object with absent ports and null ports treated alike.
const natKey = n => (n ? j({ src: n.src, dst: n.dst, sport: n.sport ?? null, dport: n.dport ?? null }) : 'null');

//#region The source and the ACL
console.log('== the plugin source and its ACL ==');
const source = fs.readFileSync(path.join(here, '../../rpcd/ucode/flab.traffic.uc'), 'utf8');
// Every command the plugin can run: all fixed strings but the nlbw one, whose parts come from allow-lists.
const commands = [...source.matchAll(/\brun\(('[^']*'|[a-z]+ \+ '[^']*')/g)].map(m => m[1]);
check(same(commands.sort(), ["'command -v nlbw 2>/dev/null'", "'ip -6 neigh show 2>/dev/null'", "'ls /tmp/hosts 2>/dev/null'", "'nlbw -c list 2>/dev/null'", "'pidof nlbwmon 2>/dev/null'", "cmd + ' 2>/dev/null'"].sort()), 'the plugin runs six commands, five of them fixed strings', j(commands));
check(!/\brun\(`/.test(source) && !/popen|system\(|exec/.test(source.replace(/\/\/.*$/gm, '')), 'no template string reaches run(), and nothing else starts a program', '');
check(/let cmd = `nlbw -c json -g \$\{GROUPS\[gi\]\}`;/.test(source) && /cmd \+= ` -t \$\{listed\}`;/.test(source), 'the nlbw command is built from the allow-list entry and a period taken from nlbw\'s own list only');
const acl = JSON.parse(fs.readFileSync(path.join(here, '../../rpcd/acl.d/flab-traffic.json'), 'utf8'));
check(same(Object.keys(acl), ['flab']) && same(acl.flab.read.ubus, { 'flab.traffic': ['status', 'connections', 'usage_periods', 'usage'] }) && same(acl.flab.write, {}) && same(Object.keys(acl.flab.read), ['ubus']), 'the ACL grants the four methods of flab.traffic read-only: no write, no file, no exec', j(acl));
//#endregion

//#region status and features
console.log('\n== status ==');
let s = out('rich-status');
check(s.conntrack === true && s.count === 141 && s.max === 31232 && s.acct === true && s.nlbw === true && s.nlbwmon_running === true, 'status: conntrack, its count and limit, accounting, nlbw installed and running', j(s));
s = out('noct-status');
check(s.conntrack === false && s.count === null && s.acct === null && s.nlbw === true, 'status without connection tracking', j(s));
s = out('noacct-status');
check(s.conntrack === true && s.acct === false && s.max === 100, 'status with nf_conntrack_acct=0', j(s));
s = out('nonlbw-status');
check(s.nlbw === false && s.nlbwmon_running === false && s.conntrack === true, 'status without nlbw', j(s));
s = out('stopped-status');
check(s.nlbw === true && s.nlbwmon_running === false, 'status with nlbw installed but nlbwmon stopped', j(s));
//#endregion

//#region connections
// Compares a connections reply with the reference answer and the table it was built from.
function checkConnections(name, list, wantNames) {
  const r = out(name), ref = expectOf(name);
  const byKey = new Map(list.map(e => [keyOf(e), e]));
  const keys = r.entries.map(keyOf);
  check(r.ok === true && r.matched === ref.matched && r.entries.length === ref.order.length, `${name}: ${r.matched} matched, ${r.entries.length} returned`, `${r.matched}/${r.entries.length} vs ${ref.matched}/${ref.order.length}`);
  const wantKeys = ref.order.map(id => keyOf(list.find(e => e.id === id)));
  check(same(keys, wantKeys), `${name}: the entries and their order match the reference`, `${keys.slice(0, 3)} vs ${wantKeys.slice(0, 3)}`);
  const bad = r.entries.filter(e => {
    const t = byKey.get(keyOf(e));
    return !t || t.family !== e.family || (t.state ?? null) !== (e.state ?? null) || (t.timeout ?? null) !== (e.timeout ?? null) || !same(t.flags, e.flags)
      || natKey(t.nat) !== natKey(e.nat) || !same(t.bytes ?? null, e.bytes ?? null) || !same(t.packets ?? null, e.packets ?? null);
  });
  check(bad.length === 0, `${name}: every entry carries its family, state, timeout, flags, NAT and counters`, j(bad[0]));
  const a = r.aggregates;
  check(r.parsed === ref.parsed && same(a.protocols, ref.protocols) && same(a.states, ref.states) && a.unreplied === ref.unreplied && a.nat === ref.nat, `${name}: counts per protocol and state, unreplied and translated`, j(a.protocols));
  check(same(a.sources, ref.sources) && same(a.destinations, ref.destinations) && same(a.unreplied_sources, ref.unreplied_sources), `${name}: the top sources and destinations by connections and by bytes`, j(a.sources.by_connections.slice(0, 2)) + ' vs ' + j(ref.sources.by_connections.slice(0, 2)));
  if (wantNames) {
    const bogus = Object.entries(r.names).filter(([a2, n]) => wantNames[a2] !== n);
    check(bogus.length === 0, `${name}: every name given is the right one`, j(bogus));
  }
  return r;
}

console.log('\n== connections: the rich table ==');
const rich = tables.rich;
check(new Set(rich.map(keyOf)).size === rich.length, 'the synthetic entries are distinguishable (test sanity)');
for (const c of cases.filter(c => c.scenario === 'rich' && c.method === 'connections' && fs.existsSync(path.join(work, 'expect', `${c.name}.json`)))) checkConnections(c.name, rich, tables.richNames);

let r = out('rich-default');
check(r.total === tables.richLines && r.parsed === rich.length && r.truncated === false && r.available === true && r.count === 141 && r.max === 31232 && r.acct === true, 'total counts every line, parsed only the ones that are entries (one line is garbage)', j([r.total, r.parsed, r.truncated]));
check(r.request.limit === 300 && r.request.sort === 'bytes' && r.request.proto === 'all' && r.request.scope === 'all' && r.request.q === '', 'defaults: limit 300, sort bytes, all protocols, all traffic');
const find = (re, f) => r.entries.find(e => e.proto === re && f(e));
check(find('tcp', e => e.src === '192.168.1.10' && e.sport === 51234).nat && natKey(find('tcp', e => e.src === '192.168.1.10' && e.sport === 51234).nat) === natKey({ src: '203.0.113.9', dst: '93.184.216.34', sport: 51234, dport: 443 }), 'a masqueraded flow reports the translated source (the WAN address, same port)');
check(natKey(find('tcp', e => e.src === '198.51.100.99').nat) === natKey({ src: '198.51.100.99', dst: '192.168.1.20', sport: 60000, dport: 80 }), 'a port forward reports the translated destination and port (8080 to 80)');
check(find('tcp', e => e.src === '192.168.1.1' || e.dst === '192.168.1.1') === undefined && find('udp', e => e.dst === '192.168.1.1' && e.dport === 53 && e.src === '192.168.1.12').nat == null, 'a flow whose reply mirrors the original has no NAT');
check(find('tcp', e => e.src === '192.168.1.10' && e.sport === 52000).timeout === null && find('tcp', e => e.src === '192.168.1.10' && e.sport === 52000).flags.includes('OFFLOAD'), 'an offloaded flow has no timeout and is flagged OFFLOAD');
check(find('tcp', e => e.src === '192.168.1.14').bytes == null && find('tcp', e => e.src === '192.168.1.14').packets == null, 'an entry without counters has none (nothing is invented)');
check(find('tcp', e => e.src === '192.168.1.11').flags.includes('UNREPLIED') && find('tcp', e => e.src === '192.168.1.11').state === 'SYN_SENT', 'UNREPLIED is a flag next to the TCP state');
check(r.entries.every(e => !/0000|[A-F]/.test(`${e.src}${e.dst}`)), 'IPv6 addresses are compressed and lowercase (no zero-padded group)');
const v6 = new Set(r.entries.filter(e => e.family === 6).map(e => e.src));
for (const want of ['2001:db8:0:1::2', '2001:db8:1:2:3:4:0:5', '2001:db8::1:0:0:1', 'fe80::639e:1bc5:db9e:45b2', '::', '2001:db8:1::10', 'fd00::10', 'fe80::1'])
  check(v6.has(want), `IPv6 ${want} is spelled the way ip prints it`, j([...v6]));
check(natKey(find('udp', e => e.src === 'fd00::10').nat) === natKey({ src: '2001:db8:1::10', dst: '2606:4700::1', sport: 6000, dport: 53 }), 'an IPv6 translation shows the translated source');
check(r.entries.filter(e => e.proto === 'icmp').every(e => e.sport == null && e.dport == null && e.icmp === 8) && r.entries.some(e => e.proto === 'icmpv6' && e.icmp === 134), 'ICMP entries have the type and no ports');
check(r.entries.some(e => e.proto === 'gre') && r.entries.some(e => e.proto === 'unknown'), 'GRE and unknown-protocol entries are listed');
check(r.names['192.168.1.10'] === 'laptop' && r.names['2001:db8:1::10'] === 'laptop' && r.names['192.168.1.11'] === 'tv' && r.names['192.168.1.12'] === 'phone' && r.names['2001:db8:1::12'] === 'phone' && r.names['192.168.1.20'] === 'printer' && r.names['192.168.1.50'] === 'nas' && r.names['192.168.1.1'] === 'router' && r.names['2001:db8:1::1'] === 'router',
  'names come from a lease (domain removed), the neighbor table, ethers plus ARP, odhcpd leases (IPv4 and IPv6), static hosts and the hosts files', j(r.names));
check(r.names['192.168.1.13'] === undefined && r.names['93.184.216.34'] === undefined, 'a client that sent "*" and a public host have no name');
check(r.aggregates.sources.by_connections[0].addr === '192.168.1.50' && r.aggregates.sources.by_connections[0].connections === 40 && r.aggregates.sources.by_connections[0].unreplied === 10 && r.aggregates.unreplied_sources[0].addr === '192.168.1.50', 'the heavy host tops the sources by connections and the unanswered ones');
check(same(r.aggregates.protocols.slice(0, 2).map(p => p.name), ['tcp', 'udp']) && r.aggregates.states.some(x => x.name === 'TIME_WAIT') && r.aggregates.states.some(x => x.name === 'SYN_RECV'), 'protocols and TCP states are counted');
r = out('rich-noargs');
check(r.ok === true && r.entries.length === rich.length && r.request.limit === 300, 'a call without arguments uses the defaults', String(r.entries.length));
check(out('rich-limit-max').request.limit === 2000 && out('rich-q-max').ok === true, 'the largest limit and a 64-character filter are accepted');
check(out('rich-alphabet').ok === true && out('rich-alphabet').matched === 0, 'every allowed filter character is accepted');
r = out('rich-nomatch');
check(r.ok === true && r.matched === 0 && r.entries.length === 0 && r.aggregates.protocols.length > 0, 'a filter that matches nothing still reports the whole table\'s aggregates');

console.log('\n== connections: refused requests ==');
for (const c of cases.filter(c => c.name.startsWith('refused-conn-'))) {
  const x = out(c.name);
  check(x.ok === false && typeof x.error === 'string' && x.error.length > 10 && x.entries === undefined && x.aggregates === undefined, `${c.name.slice(13)} is refused (${j(c.args).slice(0, 50)})`, j(x).slice(0, 200));
}

console.log('\n== connections: other tables ==');
r = out('noct-connections');
check(r.ok === true && r.available === false && r.total === 0 && r.entries.length === 0 && r.count === null, 'without connection tracking the reply says so and is empty', j(r).slice(0, 200));
r = out('noacct-connections');
check(r.available === true && r.acct === false && r.entries.length === 12 && r.entries.every(e => e.bytes == null && e.packets == null) && r.aggregates.sources.by_bytes.length === 0, 'without accounting there are no counters, no byte ranking and nothing fails', j(r.aggregates.sources.by_bytes));
check(same(r.entries.map(keyOf), rich.slice(0, 12).map(keyOf)), 'without byte counters the entries keep the order of the table');

console.log('\n== connections: a table of 60000 entries ==');
const big = tables.big;
for (const c of cases.filter(c => c.scenario === 'big' && c.method === 'connections' && fs.existsSync(path.join(work, 'expect', `${c.name}.json`)))) checkConnections(c.name, big, null);
r = out('big-default');
check(r.total === 60000 && r.parsed === 20000 && r.truncated === true && r.entries.length === 300 && r.count === 59871 && r.max === 65535, 'only the first 20000 entries are analyzed and the reply says the table was cut', j([r.total, r.parsed, r.truncated, r.entries.length]));
check(out('big-limit2000').entries.length === 2000, 'the largest limit returns 2000 entries');
for (const c of ['big-default', 'big-limit2000', 'big-timeout', 'big-tcp', 'big-internet', 'big-filter']) {
  const t = ms(c);
  check(t < 20000, `${c} takes ${(t / 1000).toFixed(1)} s on this router for 20000 entries`, String(t));
}
r = out('budget-big');
const position = new Map(big.map((e, i) => [keyOf(e), i]));
check(r.ok === true && r.truncated === true && r.parsed >= 1 && r.parsed < 20000 && r.total === 60000, `with a 50 ms budget the table is cut after ${r.parsed} entries and the reply says so`, j([r.parsed, r.truncated]));
check(r.entries.every(e => position.get(keyOf(e)) < r.parsed) && r.aggregates.protocols.reduce((n, x) => n + x.count, 0) === r.parsed, 'a cut table is the first lines only: every entry and every count comes from them');
check(r.entries.every((e, i) => i === 0 || (e.bytes[0] + e.bytes[1]) <= (r.entries[i - 1].bytes[0] + r.entries[i - 1].bytes[1])), 'a cut table is still sorted');
//#endregion

//#region usage
console.log('\n== usage ==');
let p = out('rich-periods');
check(p.ok && p.present === true && p.running === true && same(p.periods, ['2026-11-01', '2026-10-01', '2026-09-01']), 'periods: only dates, newest first (junk and blank lines dropped)', j(p));
check(p.current === '2026-11-01' && p.today === '2026-11-12', 'the running period starts on the first (the default monthly interval) and today is the pinned date', j(p));
p = out('nonlbw-periods');
check(p.present === false && p.running === false && p.periods.length === 0, 'without nlbw there are no periods', j(p));
p = out('stopped-periods');
check(p.present === true && p.running === false && p.periods.length === 0, 'with nlbwmon stopped there are no periods (nlbw cannot answer)', j(p));
for (const c of cases.filter(c => c.method === 'usage' && fs.existsSync(path.join(work, 'expect', `${c.name}.json`)))) {
  const x = out(c.name), ref = expectOf(c.name);
  check(x.ok === true && same(x.columns, ref.columns) && same(x.rows, ref.rows) && x.total_rows === ref.total_rows && x.truncated === ref.truncated && same(x.totals, ref.totals) && x.group === c.args.group && x.period === (c.args.period ?? 'current'),
    `${c.name}: rows as objects, largest total first, totals over every row`, j(x).slice(0, 300));
}
r = out('rich-usage-mac-ip');
check(r.names.mac['aa:bb:cc:00:00:10'] === 'laptop' && r.names.mac['aa:bb:cc:00:00:11'] === 'tv' && r.names.mac['aa:bb:cc:00:00:12'] === 'phone' && r.names.mac['aa:bb:cc:00:00:50'] === 'nas' && r.names.ip['2001:db8:1::12'] === 'phone' && r.names.ip['192.168.1.10'] === 'laptop' && r.names.mac['00:00:00:00:00:00'] === undefined && r.names.mac['aa:bb:cc:00:00:99'] === undefined, 'usage names by MAC and by IP', j(r.names));
check(r.rows[0].mac === 'aa:bb:cc:00:00:11' && r.rows.at(-1).mac === '00:00:00:00:00:00', 'the heaviest host comes first');
r = out('big-usage');
check(r.rows.length === 3000 && r.total_rows === 3500 && r.truncated === true, 'at most 3000 usage rows are returned and the reply says rows were left out', j([r.rows.length, r.total_rows]));
for (const [name, re] of [['rich-usage-unlisted', /not one nlbwmon keeps/], ['rich-usage-nodata', /no data/], ['nonlbw-usage', /not installed/], ['stopped-usage', /not running/]]) {
  const x = out(name);
  check(x.ok === false && re.test(x.error) && x.rows === undefined, `${name}: ${x.error}`, j(x));
}
for (const c of cases.filter(c => c.name.startsWith('refused-usage-'))) {
  const x = out(c.name);
  check(x.ok === false && /must be/.test(x.error) && x.rows === undefined, `${c.name.slice(14)} is refused (${j(c.args).slice(0, 60)})`, j(x).slice(0, 200));
}
for (const [name, w] of [
  ['rich-usage-mac-ip', { start: '2026-11-01', end: '2026-12-01', today: '2026-11-12', ongoing: true, days: 12 }],
  ['rich-usage-old', { start: '2026-10-01', end: '2026-11-01', today: '2026-11-12', ongoing: false, days: 31 }],
  ['noct-usage-window', { start: '2026-11-12', end: '2026-11-26', today: '2026-11-12', ongoing: true, days: 1 }],
  ['noacct-usage-window', { start: '2026-10-30', end: '2026-11-29', today: '2026-11-12', ongoing: true, days: 14 }],
]) check(same(out(name).window, w), `${name}: the accounting window ${w.start} to ${w.end} (${w.days} day${w.days === 1 ? '' : 's'}, ${w.ongoing ? 'running' : 'finished'})`, j(out(name).window));
check(out('inflated-periods').current === '2026-11-01', 'the running period of the inflated router');
//#endregion

//#region The real router
console.log('\n== the real router ==');
if (cases.some(c => c.name === 'real-status')) {
  s = out('real-status');
  check(typeof s.conntrack === 'boolean' && typeof s.nlbw === 'boolean' && typeof s.nlbwmon_running === 'boolean' && (s.count === null || (s.count >= 0 && s.count <= s.max)), 'status: booleans for the features, count not above the limit', j(s));
  r = out('real-connections');
  if (r.available) {
    const sum = list => list.reduce((n, x) => n + x.count, 0);
    check(r.ok && r.entries.length <= 300 && r.parsed <= r.total && r.parsed <= 20000 && r.matched === r.parsed && r.entries.length === Math.min(300, r.parsed), `the table: ${r.total} lines, ${r.parsed} parsed, ${r.entries.length} returned`, j([r.total, r.parsed, r.matched, r.entries.length]));
    check(sum(r.aggregates.protocols) === r.parsed && sum(r.aggregates.states) <= r.parsed, 'every parsed entry is counted once per protocol', j(r.aggregates.protocols));
    check(r.entries.every(e => (e.family === 4 || e.family === 6) && typeof e.src === 'string' && e.src && typeof e.dst === 'string' && e.dst && typeof e.proto === 'string' && Array.isArray(e.flags)), 'every entry has a family, protocol, endpoints and flags');
    check(r.entries.every(e => !/0000|[A-F]/.test(`${e.src}${e.dst}${e.nat ? e.nat.src + e.nat.dst : ''}`)) && r.entries.every(e => e.family === 6 || !e.src.includes(':')), 'addresses are canonical');
    check(r.entries.every((e, i) => i === 0 || (e.bytes ? e.bytes[0] + e.bytes[1] : 0) <= (r.entries[i - 1].bytes ? r.entries[i - 1].bytes[0] + r.entries[i - 1].bytes[1] : 0)), 'the entries are sorted by bytes, largest first');
    const mentioned = new Set([...r.entries.flatMap(e => [e.src, e.dst, e.nat?.src, e.nat?.dst]), ...[r.aggregates.sources, r.aggregates.destinations].flatMap(t => [...t.by_connections, ...t.by_bytes].map(h => h.addr)), ...r.aggregates.unreplied_sources.map(h => h.addr)]);
    check(Object.keys(r.names).every(a => mentioned.has(a)), 'names are given only for addresses the reply shows', j(Object.keys(r.names)));
    check(out('real-connections-5').entries.length === Math.min(5, r.parsed), 'a limit of 5 returns the five largest');
  } else console.log('INFO  the router has no connection tracking: connection checks skipped');
  const per = out('real-periods');
  check(per.ok && Array.isArray(per.periods) && per.periods.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x)), 'periods are dates', j(per));
  if (s.nlbw && s.nlbwmon_running) {
    for (const g of ['mac-ip', 'ip', 'layer7', 'fam']) {
      const u = out(`real-usage-${g}`);
      const rows = u.rows ?? [];
      const sum = k => rows.reduce((n, x) => n + (x[k] ?? 0), 0);
      check(u.ok === true && u.total_rows === rows.length && sum('rx_bytes') === u.totals.rx_bytes && sum('tx_bytes') === u.totals.tx_bytes && sum('conns') === u.totals.conns
        && rows.every((x, i) => i === 0 || x.rx_bytes + x.tx_bytes <= rows[i - 1].rx_bytes + rows[i - 1].tx_bytes), `usage ${g}: ${rows.length} rows, totals are the sums, largest first`, j(u).slice(0, 200));
    }
    const m = out('real-usage-mac-ip');
    check(m.rows.every(x => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(x.mac) && typeof x.ip === 'string') && Object.keys(m.names.mac).every(k => m.rows.some(x => x.mac === k)), 'usage by MAC and IP: the columns the page needs, names only for rows present');
    check(out('real-usage-layer7').rows.every(x => 'proto' in x && 'port' in x && 'layer7' in x), 'usage by protocol has proto, port and layer7');
    check(out('real-usage-fam').rows.every(x => x.family === 4 || x.family === 6), 'usage by family');
    const win = m.window;
    check(/^\d{4}-\d{2}-\d{2}$/.test(per.current) && win.start === per.current && win.ongoing === true && win.start <= win.today && win.today < win.end && win.days >= 1, 'the running period has a start, an end after today and at least one day, and the periods reply agrees on the start', j([per.current, win]));
  } else console.log('INFO  nlbwmon is not running on the router: usage checks skipped');
}
//#endregion

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
