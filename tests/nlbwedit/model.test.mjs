// Unit test of the nlbwmon settings model of the Traffic page (www/js/pages/traffic/settings-model.js and settings-schema.js):
// reading the config, the draft, the review list, validation of every option, the accounting window and the periods a lower
// number to keep would delete, the effect texts, the UCI operations, the check after a save and the check that the daemon runs with
// the saved settings. Pure functions: no router and no browser. Usage: node model.test.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Imports one module of the page.
const mod = f => import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/traffic', f)).href);
const m = await mod('settings-model.js');
const { FIELDS, GROUPS } = await mod('settings-schema.js');

let failed = 0;
let passed = 0;
// Prints PASS or FAIL for one condition (with detail on failure) and counts it.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (cond) passed++; else failed++; };
const j = JSON.stringify;
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));

// The config of the real router: one anonymous nlbwmon section, as the package ships it.
const CFG = () => ({
  cfg0: {
    '.type': 'nlbwmon', '.name': 'cfg0', '.anonymous': true,
    netlink_buffer_size: '524288', commit_interval: '24h', refresh_interval: '30s', database_directory: '/var/lib/nlbwmon', database_generations: '10',
    database_interval: '1', database_limit: '10000', protocol_database: '/usr/share/nlbwmon/protocols', local_network: ['192.168.1.0/24', 'lan', 'wan', 'wan6'], database_compress: '1',
  },
});
// The command line procd reports for the daemon of that config (the subnets are what the interface names resolved to).
const COMMAND = () => ['/usr/sbin/nlbwmon', '-o', '/var/lib/nlbwmon', '-b', '524288', '-i', '24h', '-r', '30s', '-p', '/usr/share/nlbwmon/protocols', '-G', '10', '-I', '1', '-L', '10000', '-Z', '-s', '192.168.1.0/24', '-s', '192.168.1.1/24', '-s', 'fd92:cdf9:fb3f::1/60'];
const SVC = (over = {}) => ({ nlbwmon: { instances: { instance1: { running: true, pid: 8345, command: COMMAND(), ...over } } } });
const dir = (over = {}) => ({ ok: true, path: '/var/lib/nlbwmon', resolved: '/tmp/lib/nlbwmon', exists: true, is_dir: true, blocked: false, mount: '/tmp', fstype: 'tmpfs', device: 'tmpfs', readonly: false, kind: 'volatile', total: 2, generated: 1794600000, files: [{ name: '20261101.db.gz', size: 11564, mtime: 1794592800 }, { name: '20261001.db.gz', size: 9000, mtime: 1792000000 }], ...over });
const LIVE = () => ({
  status: { nlbw: true, nlbwmon_running: true },
  svc: SVC(),
  periods: { ok: true, running: true, periods: ['2026-10-01', '2026-09-01', '2026-08-01', '2026-07-01'], current: '2026-11-01', today: '2026-11-14' },
  dump: { interface: [{ interface: 'loopback' }, { interface: 'lan' }, { interface: 'wan' }, { interface: 'wan6' }] },
  memTotal: 512 * 1048576,
  paths: { ok: true, generated: 1794600000, dir: dir(), protocols: { ok: true, path: '/usr/share/nlbwmon/protocols', exists: true, file: true, size: 606, readable: true } },
});
// The page's data for that router.
const data = (cfg = CFG(), live = LIVE()) => m.readNlbw(cfg, live);
// A draft of that data, edited by `edit(values)`.
const draftWith = (edit, d = data()) => { const dr = m.draftFrom(d); edit?.(dr.values); return dr; };
// The errors and warnings of a draft edited by `edit`, as plain texts.
const check_ = (edit, d = data()) => { const p = m.problems(d, draftWith(edit, d)); return { errors: p.errors.map(e => e.text), keys: p.errors.map(e => e.key), warnings: p.warnings }; };

//#region Reading
console.log('== reading ==');
const d0 = data();
check(d0.installed && d0.section === 'cfg0' && d0.values.commit_interval === '24h' && d0.extraSections === 0 && d0.networks.join() === 'lan,wan,wan6', 'the config and the interface names are read (loopback is not a network to count)');
check(d0.daemon.known && d0.daemon.running && d0.daemon.pid === 8345 && d0.daemon.command[0] === '/usr/sbin/nlbwmon', 'the daemon is read from procd');
check(d0.periods.running && d0.periods.list.length === 4 && d0.periods.today === '2026-11-14', 'the stored periods are read');
check(m.readNlbw(null).installed === false && m.readNlbw({}).installed === true && m.readNlbw({}).section === null, 'no config is "not installed"; an empty config has no section');
check(m.readNlbw(CFG(), {}).daemon.known === false && m.readNlbw(CFG(), { status: { nlbwmon_running: false } }).daemon.running === false && m.readNlbw(CFG(), { svc: {} }).daemon.running === false, 'without procd the plugin\'s status decides; a service procd does not know is not running');
check(m.readNlbw({ ...CFG(), second: { '.type': 'nlbwmon', '.name': 'second' } }).extraSections === 1, 'a second nlbwmon section is counted');
const eff = m.effective({});
check(eff.commit_interval === '24h' && eff.database_directory === '/var/lib/nlbwmon' && eff.database_compress === true && eff.database_prealloc === false && eff.local_network.length === 0 && eff.netlink_buffer_size === '524288' && eff.database_generations === '10' && eff.database_limit === '10000' && eff.refresh_interval === '30s' && eff.database_interval === '1' && eff.protocol_database === '/usr/share/nlbwmon/protocols', 'an absent option takes the init script\'s default');
check(m.effective({ commit_interval: '', database_compress: '0' }).commit_interval === '24h' && m.effective({ database_compress: '0' }).database_compress === false && m.effective({ local_network: '10.0.0.0/8 lan' }).local_network.join() === '10.0.0.0/8,lan', 'an empty option is absent; a switch reads 0; a list written on one line is split');
//#endregion

//#region The tables
console.log('\n== the tables ==');
check(new Set(FIELDS.map(f => f.key)).size === FIELDS.length && FIELDS.every(f => f.label && f.hint && GROUPS.some(g => g.id === f.group) && ['string', 'int', 'bool', 'list'].includes(f.type)), 'every option has a label, a hint, a card and a known type, and the keys are unique');
check(['local_network', 'database_interval', 'database_generations', 'database_directory', 'commit_interval', 'database_compress', 'refresh_interval', 'database_limit', 'database_prealloc', 'netlink_buffer_size', 'protocol_database'].every(k => FIELDS.some(f => f.key === k)), 'every option of nlbwmon\'s init script has an entry');
check(FIELDS.filter(f => f.arg).length === 10 && FIELDS.filter(f => f.type !== 'bool' && f.type !== 'list').every(f => f.default != null), 'every option the daemon takes as a flag has its flag, and every plain option its default');
check(FIELDS.filter(f => f.kind).every(f => ['duration', 'bytes', 'interval', 'path', 'file', 'network'].includes(f.kind)) && GROUPS.every(g => g.title && g.legend.length), 'checks and cards are known');
//#endregion

//#region Durations, sizes and addresses
console.log('\n== durations, sizes and addresses ==');
check([['30s', 30], ['10m', 600], ['24h', 86400], ['1d', 86400], ['2w', 1209600], ['90', 90], ['0', 0]].every(([v, s]) => m.parseDuration(v) === s), 'intervals in every unit, and a bare number as seconds');
check(['', '1h30m', '24H', '-5', '1.5h', '10x', ' 5', 'h', '1 h', '99999999999'].every(v => m.parseDuration(v) === null), 'what nlbwmon would refuse is not a duration');
check([[86400, '1 day'], [172800, '2 days'], [7200, '2 hours'], [3600, '1 hour'], [90, '90 seconds'], [60, '1 minute'], [5400, '90 minutes'], [30, '30 seconds']].every(([s, t]) => m.fmtSeconds(s) === t), 'spans in words use the largest exact unit', [5400, 30].map(m.fmtSeconds).join());
check(m.parseBytes('524288') === 524288 && m.parseBytes('512k') === 524288 && m.parseBytes('512K') === 524288 && m.parseBytes('1M') === 1048576 && m.parseBytes('0x80000') === 524288 && m.parseBytes('1G') === null && m.parseBytes('0x') === null && m.parseBytes('1.5M') === null && m.parseBytes('') === null, 'sizes accept a K or M suffix and hexadecimal, like nlbwmon\'s own parser (without the suffix)');
check(m.fmtAgo(100, 130) === 'just now' && m.fmtAgo(0, 300) === '5 minutes ago' && m.fmtAgo(0, 3600) === '1 hour ago' && m.fmtAgo(0, 86400 * 3) === '3 days ago' && m.fmtAgo(100, 50) === 'just now', 'how long ago');
check(['192.168.1.0/24', '10.0.0.1', '192.168.1.0/255.255.255.0', 'fd00::/8', '2a01:827:2443:6f00::1/60', '::1', '::', '::ffff:1.2.3.4', 'fe80::1/128', '1:2:3:4:5:6:7:8'].every(m.validSubnet), 'addresses with a prefix or a mask are subnets');
check(['192.168.1.0/33', '256.1.1.1', '1.2.3', 'fd00::/129', 'fd00:::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', 'gggg::1', '1.2.3.4/5/6', '10.0.0.0/', '::1/255.255.255.0', '192.168.1.0/-1', 'lan', ''].every(v => !m.validSubnet(v)), 'what inet_pton would refuse is not');
//#endregion

//#region Accounting periods
console.log('\n== accounting periods ==');
check(m.parseInterval('1').kind === 'month' && m.parseInterval('-1').n === -1 && m.parseInterval('31').n === 31 && m.parseInterval('2026-11-05/14').n === 14 && m.parseInterval('2026-11-05/14').kind === 'days', 'a day of the month, from the end, or every N days');
check(['', '0', '32', '-32', '1.5', 'abc', '2026-13-05/14', '2026-02-30/14', '2026-11-05/0', '2026-11-05', '2026-11-05/', '1999-01-01/7', '3001-01-01/7', '2026-11-05/36501', '2026-1-5/7', '01/14', '1/2'].every(v => m.parseInterval(v) === null), 'what nlbwmon would refuse (or cannot mean) is not an interval');
let w = m.windowOf('', '2026-11-14');
check(w.start === '2026-11-01' && w.end === '2026-11-30' && w.next === '2026-12-01' && w.day === 14 && w.length === 30, 'the default is the first of the month', j(w));
w = m.windowOf('15', '2026-11-14');
check(w.start === '2026-10-15' && w.end === '2026-11-14' && w.next === '2026-11-15' && w.day === 31 && w.length === 31, 'day 15 before the 15th: the period began last month', j(w));
w = m.windowOf('-1', '2026-11-14');
check(w.start === '2026-10-31' && w.next === '2026-11-30', 'the last day of the month', j(w));
w = m.windowOf('1', '2026-02-10');
check(w.length === 28 && w.end === '2026-02-28', 'February has 28 days');
w = m.windowOf('2026-11-05/14', '2026-11-14');
check(w.start === '2026-11-05' && w.end === '2026-11-18' && w.next === '2026-11-19' && w.day === 10 && w.length === 14, 'every 14 days from a date', j(w));
w = m.windowOf('2026-01-17/14', '2026-11-14');
const base = Date.UTC(2026, 0, 17) / 86400000;
const now = Date.UTC(2026, 10, 14) / 86400000;
check(new Date((base + Math.floor((now - base) / 14) * 14) * 86400000).toISOString().slice(0, 10) === w.start && w.length === 14, 'a period that is many cycles after the start date', j(w));
check(m.windowOf('x', '2026-11-14') === null && m.windowOf('1', null) === null && m.windowOf('1', 'soon') === null, 'no window for an interval or a date that is not valid');
const stored = ['2026-10-01', '2026-09-01', '2026-08-01', '2026-07-01'];
check(j(m.periodsToDelete('1', '2026-11-14', '3', stored)) === j(['2026-08-01', '2026-07-01']), 'keeping 3 periods (the running one and two): the two oldest go', j(m.periodsToDelete('1', '2026-11-14', '3', stored)));
check(m.periodsToDelete('1', '2026-11-14', '10', stored).length === 0 && m.periodsToDelete('1', '2026-11-14', '0', stored).length === 0 && j(m.periodsToDelete('1', '2026-11-14', '1', stored)) === j(stored), 'ten keeps them all, 0 keeps everything, 1 keeps only the running period');
check(m.periodsToDelete('x', '2026-11-14', '3', stored).length === 0 && m.periodsToDelete('1', null, '3', stored).length === 0 && m.periodsToDelete('1', '2026-11-14', 'x', stored).length === 0, 'nothing is deleted on a guess');
check(j(m.periodsToDelete('2026-09-01/14', '2026-11-14', '2', ['2026-10-27', '2026-10-13', '2026-09-29', '2026-09-15', '2026-09-01'])) === j(['2026-10-13', '2026-09-29', '2026-09-15', '2026-09-01']), 'with periods of 14 days (the running one began 2026-11-10), keeping 2 cuts at 2026-10-13');
//#endregion

//#region The daemon's command line
console.log('\n== the daemon\'s command line ==');
const pc = m.parseCommand(COMMAND());
check(pc.o === '/var/lib/nlbwmon' && pc.b === '524288' && pc.i === '24h' && pc.r === '30s' && pc.G === '10' && pc.I === '1' && pc.L === '10000' && pc.Z === true && pc.P === false && pc.s.length === 3, 'the flags are parsed, with their values and the subnets', j(pc));
check(m.configDiffs(CFG().cfg0, COMMAND()).length === 0, 'a daemon started from this config has no differences');
check(m.configDiffs({ ...CFG().cfg0, commit_interval: '1h', database_compress: '0' }, COMMAND()).map(d => d.key).join() === 'commit_interval,database_compress', 'a changed option is reported');
check(m.configDiffs({ ...CFG().cfg0, commit_interval: '86400', netlink_buffer_size: '0x80000', database_limit: '010000' }, COMMAND()).length === 0, 'the same value spelled another way is not a difference (86400 s is 24h, 0x80000 is 524288)', j(m.configDiffs({ ...CFG().cfg0, commit_interval: '86400', netlink_buffer_size: '0x80000' }, COMMAND())));
check(m.configDiffs({ ...CFG().cfg0, database_prealloc: '1' }, COMMAND()).map(d => d.key).join() === 'database_prealloc' && m.configDiffs({}, ['/usr/sbin/nlbwmon']).length > 0, 'a flag that is missing is a difference');
// A readService that returns the replies in turn (the last one repeats) and counts the reads.
const sequence = replies => { let n = 0; const read = async () => replies[Math.min(n++, replies.length - 1)]; read.count = () => n; return read; };
const noSleep = { sleep: async () => {}, tries: 6 };
let r = await m.confirmDaemon(sequence([SVC()]), CFG().cfg0, noSleep).catch(e => e);
check(!(r instanceof Error) && r.pid === 8345 && r.running, 'a daemon that runs with the saved settings passes');
let seq = sequence([{}, SVC({ pid: 1 }), SVC({ pid: 2 }), SVC({ pid: 2 })]);
r = await m.confirmDaemon(seq, CFG().cfg0, noSleep).catch(e => e);
check(!(r instanceof Error) && r.pid === 2 && seq.count() === 4, 'it waits for the restart, and for the same process to be seen twice', `${r} ${seq.count()}`);
r = await m.confirmDaemon(sequence([{}]), CFG().cfg0, noSleep).catch(e => e);
check(r instanceof Error && /not running/.test(r.message), 'a daemon that never comes back fails the check', String(r));
r = await m.confirmDaemon(sequence([SVC({ running: false, command: [] })]), CFG().cfg0, noSleep).catch(e => e);
check(r instanceof Error && /not running/.test(r.message), 'an instance that is down fails it');
r = await m.confirmDaemon(sequence([SVC()]), { ...CFG().cfg0, database_limit: '5000' }, noSleep).catch(e => e);
check(r instanceof Error && /other settings.*Entry limit: 10000/.test(r.message), 'a daemon with another command line fails it, and the message names the option', String(r));
r = await m.confirmDaemon(sequence([SVC({ pid: 1 }), SVC({ running: false }), SVC({ pid: 3 }), SVC({ running: false })]), CFG().cfg0, noSleep).catch(e => e);
check(r instanceof Error, 'a daemon that keeps crashing and restarting fails it (two sightings of one process are needed)', String(r));
let slept = 0;
await m.confirmDaemon(sequence([SVC()]), CFG().cfg0, { tries: 3, sleep: async ms => { slept += ms; } }).catch(() => {});
check(slept === 1500, 'the two reads are 1.5 s apart', String(slept));
//#endregion

//#region The draft, the review list and the UCI plan
console.log('\n== the draft and the plan ==');
const dr0 = m.draftFrom(d0);
check(dr0.values.commit_interval === '24h' && dr0.values.local_network.join() === '192.168.1.0/24,lan,wan,wan6' && dr0.values.database_compress === true && dr0.values.database_prealloc === false && dr0.values.database_limit === '10000', 'the draft starts from the router\'s values; a switch follows the default when absent');
check(m.changesOf(d0, dr0).length === 0 && !m.isDirty(d0, dr0) && m.plan(d0, dr0).length === 0, 'an untouched form has no changes and writes nothing');
let dr = draftWith(v => { v.commit_interval = '1h'; v.database_compress = false; v.local_network.push('guest'); v.netlink_buffer_size = '1M'; });
check(m.changesOf(d0, dr).map(c => `${c.label}: ${c.from} → ${c.to}`).join('; ') === 'Local networks: 192.168.1.0/24, lan, wan, wan6 → 192.168.1.0/24, lan, wan, wan6, guest; Commit interval: 24h → 1h; Compress the database files: on → off; Netlink buffer: 524288 → 1048576', 'the review shows before and after, a size in bytes', j(m.changesOf(d0, dr)));
check(j(m.plan(d0, dr)) === j([{ op: 'set', config: 'nlbwmon', section: 'cfg0', values: { local_network: ['192.168.1.0/24', 'lan', 'wan', 'wan6', 'guest'], commit_interval: '1h', database_compress: '0', netlink_buffer_size: '1048576' } }]), 'only what changed is written: a list as a list, a switch as 0 or 1, a size in bytes', j(m.plan(d0, dr)));
dr = draftWith(v => { v.netlink_buffer_size = '512k'; v.commit_interval = ' 24h '; v.local_network = ['192.168.1.0/24', ' lan ', '', 'wan', 'wan6']; });
check(m.changesOf(d0, dr).length === 0 && m.plan(d0, dr).length === 0, '512K is 524288 bytes, spaces are trimmed and blank rows dropped: no change');
check(m.isDirty(d0, draftWith(v => v.local_network.push(''))) === true && m.changesOf(d0, draftWith(v => v.local_network.push(''))).length === 0, 'a blank row that was added counts as an edit, though it changes nothing yet');
dr = draftWith(v => { v.commit_interval = ''; v.database_limit = ''; v.local_network = []; v.database_prealloc = true; });
check(j(m.plan(d0, dr)) === j([{ op: 'set', config: 'nlbwmon', section: 'cfg0', values: { database_prealloc: '1' } }, { op: 'delete', config: 'nlbwmon', section: 'cfg0', options: ['local_network', 'commit_interval', 'database_limit'] }]), 'an emptied option or list is deleted, not set to an empty string', j(m.plan(d0, dr)));
const noOpt = data({ cfg0: { '.type': 'nlbwmon', '.name': 'cfg0', commit_interval: '24h' } });
dr = draftWith(v => { v.refresh_interval = ''; v.commit_interval = ''; }, noOpt);
check(j(m.plan(noOpt, dr)) === j([{ op: 'delete', config: 'nlbwmon', section: 'cfg0', options: ['commit_interval'] }]), 'an option that is not in the file is not deleted');
const empty = data({});
dr = draftWith(v => { v.local_network = ['lan']; v.database_compress = false; }, empty);
check(j(m.plan(empty, dr)) === j([{ op: 'add', config: 'nlbwmon', type: 'nlbwmon', values: { local_network: ['lan'], database_compress: '0' } }]), 'a config without a section gets one, anonymous, with the edited options', j(m.plan(empty, dr)));
check(m.plan(empty, m.draftFrom(empty)).length === 0, 'and nothing at all when nothing was edited');
let applied = clone(CFG());
applied.cfg0.commit_interval = '1h';
dr = draftWith(v => { v.commit_interval = '1h'; });
check((() => { try { m.checkApplied(data(applied), dr); return true; } catch { return false; } })(), 'the check after a save passes when the router holds the draft');
check((() => { try { m.checkApplied(d0, dr); return null; } catch (e) { return e.message; } })() === 'Commit interval was not saved', 'and fails, naming the option, when it does not');
//#endregion

//#region Validation
console.log('\n== validation ==');
// Whether editing option `key` to `value` gives an error.
const bad = (key, value) => check_(v => { v[key] = value; }).keys.includes(key);
check(['30s', '5m', '24h', '1d', '3600', '2w', '1'].every(v => !bad('commit_interval', v)) && ['', '0', '0s', '1h30m', '24H', 'abc', '-1', '25d', '2147484', '1.5h'].every(v => v === '' ? !bad('commit_interval', v) : bad('commit_interval', v)), 'the commit interval: units, at least a second, at most 24 days; empty is the default');
check(!bad('commit_interval', '2147483') && bad('commit_interval', '2147484') && !bad('refresh_interval', '1s') && bad('refresh_interval', '0') && bad('refresh_interval', '5 s'), 'the longest interval is 2147483 seconds; the refresh interval is checked the same way');
check(check_(v => { v.commit_interval = '25d'; }).errors[0] === 'Commit interval is too long: nlbwmon accepts at most 24 days (2147483 seconds).', 'the message says why and what is allowed', check_(v => { v.commit_interval = '25d'; }).errors[0]);
check(['524288', '32768', '512K', '1M', '0x80000', '2147483647'].every(v => !bad('netlink_buffer_size', v)) && ['32767', '1G', 'abc', '2147483648', '-1', '1.5M', '10K'].every(v => bad('netlink_buffer_size', v)), 'the netlink buffer: bytes with an optional K or M, at least 32768');
check(['1', '-1', '15', '28', '31', '-31', '2026-11-05/14', '2024-02-29/7'].every(v => !bad('database_interval', v)) && ['0', '32', 'x', '2026-02-30/14', '2026-11-05/0', '1/2', '1999-01-01/7', '2026-11-05'].every(v => bad('database_interval', v)), 'the accounting period: a day of the month, from the end, or N days from a real date');
check(['0', '1', '10', '1000'].every(v => !bad('database_generations', v)) && ['-1', '1001', '1.5', 'x', '10 '.trim() + 'a'].every(v => bad('database_generations', v)), 'periods to keep: a whole number from 0 to 1000 (a huge count would stall nlbwmon\'s start)');
check(['0', '10000', '4294967295'].every(v => !bad('database_limit', v)) && ['-1', '4294967296', 'ten'].every(v => bad('database_limit', v)), 'the entry limit: a whole number up to the largest the daemon holds');
check(['/var/lib/nlbwmon', '/mnt/usb/nlbwmon', '/tmp/nlbw', '/dev/shm/nlbw', '/mnt/usb/a_b-c.d+e@f:g=h,i/'].every(v => !bad('database_directory', v)) && ['relative', '/', '//', '/proc/x', '/sys', '/rom/nlbw', '/dev/sda', '/a b', '/a;b', '/a/../b', '/a/..', '/$(id)', '/' + 'x'.repeat(126), '/etc/nlbw"x"'].every(v => bad('database_directory', v)), 'the database directory: an absolute path that nlbwmon can create, at most 126 characters, no .. and no odd characters, not a special filesystem');
check(!bad('database_directory', '/' + 'x'.repeat(125)) && ['/usr/share/nlbwmon/protocols', '/etc/nlbwmon/protocols'].every(v => !bad('protocol_database', v)) && ['protocols', '/a b', '/x/../y', '/' + 'x'.repeat(260)].every(v => bad('protocol_database', v)), 'the longest directory is 126 characters; the protocol file is an absolute path too');
check(['lan', 'wan6', 'guest_net', '192.168.1.0/24', 'fd00::/8', '10.0.0.1', '2a01::1/64'].every(v => !check_(x => { x.local_network = [v]; }).keys.includes('local_network')) && ['lan-1', 'my lan', 'lan/24', '192.168.1.0/33', '1.2.3', 'br.lan', 'fd00::/129', 'eth0.1'].every(v => check_(x => { x.local_network = [v]; }).keys.includes('local_network')), 'a local network: a network name, or an address with a prefix (a name with a dot is an address to nlbwmon)');
let rows = check_(v => { v.local_network = ['lan', 'wan', 'LAN', '1.2.3']; });
check(rows.errors.length === 2 && /"LAN" is listed twice/.test(rows.errors[0]) && /"1\.2\.3" is not an IPv4/.test(rows.errors[1]), 'a repeated entry and an invalid one are both reported, one error each', j(rows.errors));
const withIndex = m.problems(d0, draftWith(v => { v.local_network = ['lan', 'nope!', '']; }));
check(withIndex.errors.length === 1 && withIndex.errors[0].key === 'local_network' && withIndex.errors[0].index === 1, 'a bad list row is reported with its row number', j(withIndex.errors));
check(check_(v => { v.commit_interval = '0'; v.database_limit = 'x'; v.database_interval = '99'; }).errors.length === 3, 'several errors are all reported');
check(check_(() => {}).errors.length === 0 && check_(() => {}).warnings.length === 0, 'the router\'s own config has no error and no warning');
//#endregion

//#region Warnings
console.log('\n== warnings ==');
let p = check_(v => { v.local_network = []; });
check(p.errors.length === 0 && p.warnings.includes('No local network is listed, so nlbwmon counts nothing.'), 'an empty list of networks is allowed but says nothing is counted');
p = check_(v => { v.local_network.push('guest'); });
check(p.warnings.some(w => /^guest is not a network of this router \(it has lan, wan, wan6\)/.test(w)), 'a network name the router does not have is flagged', j(p.warnings));
p = check_(v => { v.database_directory = '/mnt/usb/nlbwmon'; });
check(p.errors.length === 0 && p.warnings.some(w => /Nothing is moved: the periods already stored stay in \/var\/lib\/nlbwmon, and the running period starts again from zero in \/mnt\/usb\/nlbwmon/.test(w)), 'a new database directory says that existing data stays behind', j(p.warnings));
p = check_(v => { v.protocol_database = '/etc/nlbwmon/protocols'; });
check(p.warnings.some(w => /will not start if \/etc\/nlbwmon\/protocols is missing/.test(w)), 'a new protocol file warns that nlbwmon needs it');
p = check_(v => { v.database_generations = '2'; });
check(p.warnings.length === 1 && /deletes the stored periods 2026-09-01, 2026-08-01, 2026-07-01\. That cannot be undone/.test(p.warnings[0]), 'keeping fewer periods names the periods that are deleted when nlbwmon restarts', j(p.warnings));
p = check_(v => { v.database_generations = '0'; });
check(p.warnings.length === 1 && /kept forever/.test(p.warnings[0]), 'keeping every period warns that the directory grows');
p = check_(v => { v.database_interval = '2026-11-01/14'; });
check(p.warnings.some(w => /from a day of the month to a fixed number of days/.test(w)), 'switching the kind of interval warns about stored periods');
p = check_(v => { v.database_interval = '15'; });
check(p.warnings.length === 1 && /moves the boundaries/.test(p.warnings[0]), 'another day of the month says the boundaries move');
p = check_(v => { v.database_interval = '30'; });
check(p.warnings.some(w => /A start day of 30 does not exist in every month/.test(w)), 'a start day beyond the 28th warns');
p = check_(v => { v.database_interval = '2027-01-01/14'; });
check(p.warnings.some(w => /start date is in the future/.test(w)), 'a start date in the future warns');
p = check_(v => { v.commit_interval = '5m'; });
check(p.warnings.length === 0, 'a short commit interval does not warn when the directory is in RAM', j(p.warnings));
let flashData = data(CFG(), { ...LIVE(), paths: { ...LIVE().paths, dir: dir({ kind: 'flash', fstype: 'overlay', mount: '/' }) } });
p = check_(v => { v.commit_interval = '5m'; }, flashData);
check(p.warnings.length === 1 && /every 5 minutes rewrites the database file 288 times a day on flash/.test(p.warnings[0]), 'on flash a commit every few minutes warns, with how often it writes', j(p.warnings));
p = check_(v => { v.commit_interval = '5m'; }, data(CFG(), { ...LIVE(), paths: null }));
check(p.warnings.length === 1 && /if the database directory is on the router's flash/.test(p.warnings[0]), 'without knowing the storage the warning is conditional');
check(check_(v => { v.commit_interval = '1h'; }, flashData).warnings.length === 0, 'an hour or more is gentle');
check(check_(v => { v.refresh_interval = '2s'; }).warnings.some(w => /costs CPU time/.test(w)) && check_(v => { v.refresh_interval = '15m'; }).warnings.some(w => /reaches the numbers late/.test(w)), 'a refresh interval that is very short or very long warns');
check(check_(v => { v.database_limit = '500'; }).warnings.some(w => /overwrites the oldest entries early/.test(w)) && check_(v => { v.database_limit = '0'; }).warnings.some(w => /grows with the variety of traffic/.test(w)) && check_(v => { v.database_limit = '2000000'; }).warnings.some(w => /over a quarter of this router's memory/.test(w)), 'a small, a missing and a huge entry limit each warn');
check(check_(v => { v.database_prealloc = true; v.database_limit = '0'; }).warnings.some(w => /no effect without an entry limit/.test(w)), 'reserving memory without a limit says it does nothing');
check(check_(v => { v.netlink_buffer_size = '65536'; }).warnings.some(w => /under 128 KiB/.test(w)), 'a small netlink buffer warns');
check(check_(() => {}, data(CFG(), { ...LIVE(), svc: {} })).warnings.some(w => /nlbwmon is not running now/.test(w)), 'a daemon that is not running is noted');
check(check_(() => {}, data({ ...CFG(), b: { '.type': 'nlbwmon', '.name': 'b' } })).warnings.some(w => /2 nlbwmon sections. Only the first is edited/.test(w)), 'a second section is noted');
//#endregion

//#region What the router says about the paths
console.log('\n== paths ==');
let dd = data();
dd.probes.dir['/mnt/usb/x'] = { ok: true, path: '/mnt/usb/x', resolved: '/mnt/usb/x', exists: false, is_dir: true, blocked: false, kind: 'storage', fstype: 'ext4', device: '/dev/sda1', mount: '/mnt/usb', total: 0, files: [], generated: 1 };
p = check_(v => { v.database_directory = '/mnt/usb/x'; }, dd);
check(p.errors.length === 0, 'a directory that does not exist yet on a writable disk is fine', j(p.errors));
dd.probes.dir['/rom/x'] = { ok: true, path: '/rom/x', kind: 'readonly', fstype: 'squashfs', blocked: false };
dd.probes.dir['/etc/passwd'] = { ok: true, path: '/etc/passwd', kind: 'flash', blocked: true };
dd.probes.dir['/mnt/ro'] = { ok: true, path: '/mnt/ro', kind: 'readonly', fstype: 'vfat', blocked: false };
check(check_(v => { v.database_directory = '/mnt/ro'; }, dd).errors[0] === 'Database directory: /mnt/ro is on a read-only filesystem (vfat), so nlbwmon cannot write its database there.', 'a directory the router says is read only is an error');
check(/is not a directory, or is below a file/.test(check_(v => { v.database_directory = '/etc/passwd'; }, dd).errors[0]), 'a path that is a file is an error');
dd.probes.file['/nope'] = { ok: true, path: '/nope', exists: false, file: false, readable: false };
dd.probes.file['/etc'] = { ok: true, path: '/etc', exists: true, file: false, readable: false };
dd.probes.file['/etc/shadow'] = { ok: true, path: '/etc/shadow', exists: true, file: true, readable: false };
dd.probes.file['/etc/ok'] = { ok: true, path: '/etc/ok', exists: true, file: true, readable: true, size: 100 };
check(check_(v => { v.protocol_database = '/nope'; }, dd).errors[0] === 'Protocol file: /nope does not exist, and nlbwmon does not start without it.', 'a protocol file that does not exist is an error');
check(/is not a regular file/.test(check_(v => { v.protocol_database = '/etc'; }, dd).errors[0]) && /cannot be read/.test(check_(v => { v.protocol_database = '/etc/shadow'; }, dd).errors[0]), 'a directory or an unreadable file is an error');
check(check_(v => { v.protocol_database = '/etc/ok'; }, dd).errors.length === 0, 'a readable file is fine');
check(check_(v => { v.protocol_database = '/unknown'; }, dd).errors.length === 0 && check_(v => { v.database_directory = '/mnt/unknown'; }, dd).errors.length === 0, 'a path nothing is known about yet is not an error');
check(m.infoFor(d0, 'dir', '/var/lib/nlbwmon').kind === 'volatile' && m.infoFor(d0, 'file', '/usr/share/nlbwmon/protocols').size === 606 && m.infoFor(d0, 'dir', '/other') === null, 'the reply for the saved paths is reused; another path is unknown until asked');
//#endregion

//#region Effects
console.log('\n== effects ==');
let fx = m.effects(d0, dr0);
check(/nlbwmon is counting 3 subnets now: 192\.168\.1\.0\/24, 192\.168\.1\.1\/24, fd92:cdf9:fb3f::1\/60\. Networks of this router: lan, wan, wan6\./.test(fx.local_network.text), 'the networks show what the running daemon counts', fx.local_network?.text);
check(fx.database_interval.text === 'The running period would be 2026-11-01 to 2026-11-30 (day 14 of 30); the next one starts 2026-12-01.', 'the accounting window', fx.database_interval?.text);
check(/4 finished periods stored \(2026-10-01, 2026-09-01, 2026-08-01, 2026-07-01\) besides the running one\. Nothing is deleted at the next start: 10 periods may be kept/.test(fx.database_generations.text) && fx.database_generations.kind === 'info', 'the stored periods against the number to keep', fx.database_generations?.text);
check(/\/var\/lib\/nlbwmon is \/tmp\/lib\/nlbwmon\. On tmpfs \(RAM\): no flash wear, but the history is lost at every reboot\. It holds 2 database files \(20\.1 KiB\), the latest written 2 hours ago\./.test(fx.database_directory.text) && fx.database_directory.kind === 'warn', 'the directory: where it really is, the kind of storage, the files and the last write', fx.database_directory?.text);
check(fx.commit_interval.text === 'Written every 1 day: at most once a day. After a crash or power loss up to 1 day of counts are lost, and the file is in RAM anyway.', 'the commit interval', fx.commit_interval?.text);
check(fx.refresh_interval.text === 'The counters of open connections are read every 30 seconds (120 times an hour).', 'the refresh interval', fx.refresh_interval?.text);
check(fx.database_limit.text === 'At most 10,000 entries, roughly 976.6 KiB of RAM when full (0.2% of this router\'s memory).', 'the entry limit in RAM', fx.database_limit?.text);
check(fx.netlink_buffer_size.text === '524288 bytes = 512.0 KiB.' && /File found \(606 bytes\)\./.test(fx.protocol_database.text), 'the buffer in KiB, the protocol file found', `${fx.netlink_buffer_size?.text} | ${fx.protocol_database?.text}`);
fx = m.effects(d0, draftWith(v => { v.database_generations = '2'; v.database_interval = '15'; v.commit_interval = '10m'; v.database_limit = '0'; }));
check(fx.database_interval.text === 'The running period would be 2026-10-15 to 2026-11-14 (day 31 of 31); the next one starts 2026-11-15.', 'the window follows the draft', fx.database_interval?.text);
check(fx.database_generations.text.endsWith('The next start deletes 2026-08-01, 2026-07-01.') && fx.database_generations.kind === 'warn', 'the periods that would be deleted are named and flagged', fx.database_generations?.text);
check(/Written every 10 minutes: 144 times a day/.test(fx.commit_interval.text) && fx.database_limit.text === 'No limit: the database grows with the variety of traffic.', 'the commit interval and a missing limit follow the draft');
fx = m.effects(d0, draftWith(v => { v.commit_interval = 'x'; v.database_interval = 'x'; v.database_generations = 'x'; v.database_limit = 'x'; v.netlink_buffer_size = 'x'; v.database_directory = 'x'; }));
check(!('commit_interval' in fx) && !('database_interval' in fx) && !('database_generations' in fx) && !('database_limit' in fx) && !('netlink_buffer_size' in fx) && !('database_directory' in fx), 'an option with an error has no effect text');
fx = m.effects(dd, draftWith(v => { v.database_directory = '/mnt/usb/x'; }, dd));
check(/The directory does not exist yet: nlbwmon creates it\. On ext4 on \/dev\/sda1 \(mounted at \/mnt\/usb\): storage of its own/.test(fx.database_directory.text) && /It holds no database file yet\.$/.test(fx.database_directory.text) === false && fx.database_directory.kind === 'info', 'a new directory on a USB disk (a directory that does not exist holds nothing, so says nothing of files)', fx.database_directory?.text);
fx = m.effects(dd, draftWith(v => { v.database_directory = '/mnt/never-asked'; }, dd));
check(fx.database_directory.text === 'Checking where this directory is…', 'a path that has not been asked about yet says so');
fx = m.effects(data(CFG(), { ...LIVE(), svc: SVC({ command: ['/usr/sbin/nlbwmon', '-o', '/x'] }) }), dr0);
check(/nlbwmon is running without any subnet, so it counts nothing/.test(fx.local_network.text) && fx.local_network.kind === 'warn', 'a daemon with no subnet is flagged');
check(m.effects(data(CFG(), { ...LIVE(), periods: null, paths: null, dump: null }), dr0).database_interval === undefined, 'without the plugin there is nothing to say about periods');
//#endregion

console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${passed} nlbwmon settings model checks passed`);
process.exit(failed ? 1 : 0);
