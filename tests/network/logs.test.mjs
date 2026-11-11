// Unit test for the Logs page helpers (www/js/pages/logs/entries.js): level filtering, text filtering,
// summaries and formatting. No router or browser needed. Usage: node logs.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const { LEVELS, levelLimit, levelKind, levelClass, programsOf, filterEntries, summarize, fmtClock, fmtStamp, priorityOf, originOf, toText } =
  await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/logs/entries.js')).href);

let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

// Builds an entry the way flab.logs returns one.
const SEV = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const entry = (level, program, message, t = 1794395684, pid = null) => ({ t, facility: level == null ? null : 'daemon', severity: level == null ? null : SEV[level], level, program, pid, message });

const entries = [
  entry(3, 'pppd', 'authentication failed for user x', 100, 99),
  entry(4, 'hostapd', 'STA 00:11:22:33:44:55 timed out', 101, 7),
  entry(5, 'netifd', 'Interface wan is now up', 102),
  entry(6, 'odhcpd', 'DHCPV6 RENEW IA_PD ok', 103, 2571),
  entry(7, 'dnsmasq', 'cache size 1000', 104),
  entry(null, null, 'a continuation line without a header', null),
];

console.log('== levels ==');
check(levelLimit('all') === null && levelLimit('err') === 3 && levelLimit('warning') === 4 && levelLimit('notice') === 5 && levelLimit('info') === 6 && levelLimit('nonsense') === null, 'level filter keys map to the highest level number shown');
check(LEVELS[0][0] === 'all' && LEVELS.every(([k, label]) => k && label), 'the filter lists "all levels" first');
check([0, 3].every(l => levelKind(l) === 'danger') && levelKind(4) === 'warning' && levelKind(5) === 'info' && levelKind(6) === '' && levelKind(null) === '', 'badge kinds: errors red, warnings amber, notices blue, the rest plain');
check(levelClass(2) === 'lv-err' && levelClass(4) === 'lv-warn' && levelClass(5) === 'lv-notice' && levelClass(6) === 'lv-info' && levelClass(7) === 'lv-debug' && levelClass(null) === 'lv-none', 'row classes follow the severity');

console.log('== filtering ==');
const names = list => list.map(e => e.program ?? '(none)').join();
check(filterEntries(entries).length === 6 && filterEntries(entries, { level: 'all' }).length === 6, 'no filter shows everything, including unparsed lines');
check(names(filterEntries(entries, { level: 'err' })) === 'pppd', 'errors only');
check(names(filterEntries(entries, { level: 'warning' })) === 'pppd,hostapd', 'warnings and above');
check(names(filterEntries(entries, { level: 'info' })) === 'pppd,hostapd,netifd,odhcpd', 'info and above hides debug and unparsed lines');
check(!filterEntries(entries, { level: 'err' }).some(e => e.level == null), 'a line without a severity only shows when no level limit is set');
check(names(filterEntries(entries, { program: 'hostapd' })) === 'hostapd', 'one source only');
check(names(filterEntries(entries, { q: 'DHCPV6' })) === 'odhcpd' && names(filterEntries(entries, { q: 'dhcpv6 renew' })) === 'odhcpd', 'text filter is case-insensitive and every word must match');
check(names(filterEntries(entries, { q: 'dhcpv6 hostapd' })) === '', 'all words must match: none here');
check(names(filterEntries(entries, { q: 'pppd[99]' })) === 'pppd' && names(filterEntries(entries, { q: 'daemon.err' })) === 'pppd', 'the text filter searches the origin (program[pid]) and the priority (facility.severity)');
check(names(filterEntries(entries, { q: 'daemon.warning' })) === 'hostapd' && filterEntries(entries, { q: 'daemon.' }).length === 5, 'a priority such as daemon.warning is searchable; unparsed lines have none');
check(names(filterEntries(entries, { q: 'timed', level: 'warning', program: 'hostapd' })) === 'hostapd' && filterEntries(entries, { q: 'timed', level: 'err' }).length === 0, 'filters combine');
check(programsOf(entries).join() === 'dnsmasq,hostapd,netifd,odhcpd,pppd', 'the source list is unique and sorted, without empty origins');

console.log('== summary ==');
const sum = summarize(entries);
check(sum.errors === 1 && sum.warnings === 1 && sum.newest === 104, 'errors, warnings and the newest timestamp', JSON.stringify(sum));
check(summarize([]).errors === 0 && summarize([]).newest === null, 'an empty log summarises to zero');
check(summarize([entry(0, 'a', 'x'), entry(1, 'a', 'x'), entry(2, 'a', 'x'), entry(3, 'a', 'x')]).errors === 4, 'emerg, alert, crit and err all count as errors');

console.log('== formatting ==');
check(/^\d{2} [A-Z][a-z]{2} \d{2}:\d{2}:\d{2}$/.test(fmtClock(1794395684)) && fmtClock(null) === '–', 'the clock is "dd Mon hh:mm:ss"; an entry without time shows a dash', fmtClock(1794395684));
check(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(fmtStamp(1794395684)) && fmtStamp(null) === '', 'the text stamp is sortable');
check(priorityOf(entries[0]) === 'daemon.err' && priorityOf(entries[5]) === '', 'priority is facility.severity, empty when unknown');
check(originOf(entries[0]) === 'pppd[99]' && originOf(entries[2]) === 'netifd' && originOf(entries[5]) === '', 'origin is program[pid], without a pid when there is none');
const text = toText([entries[0], entries[5]]).split('\n');
check(text.length === 3 && text[2] === '' && / daemon\.err pppd\[99\]: authentication failed for user x$/.test(text[0]) && text[1] === 'a continuation line without a header', 'the downloaded text has one line per entry, logread style', JSON.stringify(text));

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall log helper checks passed');
