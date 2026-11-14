// Asserts the output of flab.traffic's nlbwmon_paths method (run against the fixtures of mkfx.mjs by run.ps1) and the plugin
// source and ACL around it. Usage: node assert.mjs <work dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, REFUSED } from './mkfx.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = process.argv[2];
let failed = 0;
let passed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts it.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (cond) passed++; else failed++; };
// The JSON a call printed.
const out = name => JSON.parse(fs.readFileSync(path.join(work, 'out', `${name}.json`), 'utf8'));
// JSON text of a value, for comparing and for messages.
const j = v => JSON.stringify(v);

//#region The source and the ACL
console.log('== the plugin source and its ACL ==');
const source = fs.readFileSync(path.join(here, '../../rpcd/ucode/flab.traffic.uc'), 'utf8');
const region = source.slice(source.indexOf('//#region nlbwmon paths'), source.indexOf('//#endregion', source.indexOf('//#region nlbwmon paths')));
check(region.length > 1000 && !/\brun\(|popen|system\(|exec/.test(region.replace(/\/\/.*$/gm, '')), 'the path code never starts a program: only stat, lsdir, realpath, open and /proc/mounts');
check(/safe_path\(path, MAX_DIR\)/.test(region) && /safe_path\(path, MAX_FILE\)/.test(region), 'both paths are checked before any filesystem function sees them');
const acl = JSON.parse(fs.readFileSync(path.join(here, '../../rpcd/acl.d/flab-traffic.json'), 'utf8')).flab;
check(j(acl.read.ubus['flab.traffic']) === j(['status', 'connections', 'usage_periods', 'usage', 'nlbwmon_paths']) && j(acl.read.ubus.uci) === j(['get', 'changes']) && j(acl.read.uci) === j(['nlbwmon']), 'the ACL reads flab.traffic and the nlbwmon config only', j(acl.read));
check(j(acl.write) === j({ ubus: { uci: ['set', 'add', 'delete', 'revert', 'apply', 'confirm', 'rollback'] }, uci: ['nlbwmon'] }), 'it writes the nlbwmon config only, through uci, with no file or exec grant', j(acl.write));
check(!JSON.stringify(acl).includes('"file"') && !JSON.stringify(acl).includes('exec'), 'the fragment grants no file or exec access');
//#endregion

console.log('\n== the directory ==');
let r = out('ram').dir;
check(out('ram').ok === true && out('ram').protocols === null && r.ok && r.path === '/var/lib/nlbwmon', 'only what was asked for is described');
check(r.resolved === '/tmp/lib/nlbwmon' && r.exists && r.is_dir && !r.blocked, 'a link is resolved (/var is /tmp) and the directory exists', j(r));
check(r.mount === '/tmp' && r.fstype === 'tmpfs' && r.kind === 'volatile', 'a directory on tmpfs is volatile', j(r));
check(j(r.files.map(f => f.name)) === j(['20261101.db.gz', '20261001.db.gz']) && r.total === 2, 'only database files are listed, newest period first (notes.txt, 2026-10.db and a .tmp file are not)', j(r.files));
check(r.files[0].size === 11564 && r.files[0].mtime === 1794582001, 'a file has its size and its last write', j(r.files[0]));
r = out('trailing-slash').dir;
check(r.exists && r.total === 2 && r.resolved === '/tmp/lib/nlbwmon', 'a trailing slash does not matter', j(r));
r = out('usb-existing').dir;
check(r.kind === 'storage' && r.fstype === 'ext4' && r.device === '/dev/sda1' && r.mount === '/mnt/usb' && r.total === 1 && r.files[0].name === '20260901.db', 'a directory on a USB disk is storage, with its device and the file in it', j(r));
r = out('usb-missing').dir;
check(!r.exists && !r.blocked && r.resolved === '/mnt/usb/nlbw-new/deeper' && r.kind === 'storage' && r.mount === '/mnt/usb' && r.files.length === 0, 'a directory that does not exist yet takes the filesystem of the nearest one that does', j(r));
r = out('flash-etc').dir;
check(!r.exists && r.kind === 'flash' && r.fstype === 'overlay' && r.mount === '/', 'a new directory under /etc is on the overlay: flash', j(r));
r = out('readonly-rom').dir;
check(r.kind === 'readonly' && r.fstype === 'squashfs' && r.readonly === true, 'a directory under /rom is read only', j(r));
r = out('readonly-card').dir;
check(r.kind === 'readonly' && r.fstype === 'vfat' && r.readonly === true, 'a card mounted read only is read only whatever its filesystem', j(r));
r = out('network-share').dir;
check(r.kind === 'storage' && r.fstype === 'cifs', 'a network share is storage', j(r));
r = out('a-file').dir;
check(r.exists && !r.is_dir && r.blocked && r.files.length === 0, 'a path that is a file is not usable as a directory', j(r));
r = out('below-a-file').dir;
check(!r.exists && r.blocked, 'a path below a file cannot be created', j(r));
r = out('root').dir;
check(r.ok && r.resolved === '/' && r.kind === 'flash', 'the root directory is described', j(r));
r = out('many-files').dir;
check(r.total === 120 && r.files.length === 100 && r.files.every((f, i, a) => i === 0 || a[i - 1].name > f.name), 'more than 100 database files: 100 are listed, newest first, and the real count is given', `${r.total} ${r.files.length}`);
r = out('no-mounts').dir;
check(r.ok && r.kind === 'unknown' && r.mount === null && r.resolved === '/data/nlbwmon', 'without /proc/mounts the kind is unknown and the answer still comes', j(r));
r = out('longest').dir;
check(r.ok === true, 'a path of 126 characters is the longest accepted');
r = out('too-long').dir;
check(r.ok === false && /not a usable/.test(r.error), 'a path of 127 characters is refused (nlbwmon cannot use one)', j(r));

console.log('\n== the protocol file ==');
let p = out('protocols-ok').protocols;
check(p.ok && p.exists && p.file && p.readable && p.size === 606 && out('protocols-ok').dir === null, 'a protocol file that exists and can be read', j(p));
p = out('protocols-missing').protocols;
check(p.ok && !p.exists && !p.file && !p.readable, 'a missing one', j(p));
p = out('protocols-dir').protocols;
check(p.ok && p.exists && !p.file && !p.readable, 'a directory is not a protocol file', j(p));
p = out('protocols-unreadable').protocols;
check(p.ok && p.exists && p.file && !p.readable, 'a file that cannot be opened is reported', j(p));
const both = out('both');
check(both.dir.ok && both.protocols.ok && both.dir.kind === 'volatile', 'both can be asked in one call');
check(out('none').dir === null && out('none').protocols === null, 'a call without arguments describes nothing');

console.log('\n== refused paths ==');
for (let i = 0; i < REFUSED.length; i++) {
  const bad = j(REFUSED[i]).slice(0, 40);
  const d = out(`refused-dir-${i}`).dir;
  const f = out(`refused-file-${i}`).protocols;
  check(d.ok === false && !('files' in d) && !('resolved' in d) && f.ok === false && !('size' in f), `refused as directory and as file: ${bad}`, j([d, f]).slice(0, 200));
}
check(CASES.length >= 19 && REFUSED.length >= 20, 'the suite tries every case and at least 20 refused paths');

console.log('\n== the real router (read only) ==');
const real = out('real');
const word = name => fs.readFileSync(path.join(work, 'out', name), 'utf8').trim();
const rd = real.dir;
check(real.ok && rd.ok && rd.path.startsWith('/') && rd.resolved.startsWith('/') && !rd.resolved.includes('//') && ['volatile', 'flash', 'readonly', 'storage', 'unknown'].includes(rd.kind), 'the router answers for its own database directory', j(rd).slice(0, 300));
check(rd.exists === true && rd.is_dir === true && rd.blocked === false && typeof rd.mount === 'string' && typeof rd.fstype === 'string', 'which exists and sits on a known mount', j(rd).slice(0, 300));
const fstype = word('real-fstype.txt');
check(['tmpfs', 'ramfs'].includes(fstype) === (rd.kind === 'volatile'), `the kind agrees with the filesystem type /proc/mounts gives (${fstype} is ${rd.kind})`, `${fstype} ${rd.kind}`);
const periods = word('real-periods.txt').split(/\s+/).filter(Boolean).sort();
const listed = rd.files.map(f => f.name.slice(0, 8)).sort();
// nlbw -c list prints the finished periods, which are files of the database directory (the running one may be a file too).
check(periods.every(p => listed.includes(p)), 'every period nlbw lists is a database file the plugin found', `${j(periods)} vs ${j(listed)}`);
check(real.protocols.ok && real.protocols.exists && real.protocols.file && real.protocols.readable && real.protocols.size > 0, 'the protocol file of the router is found and readable', j(real.protocols));

console.log(`\n${failed ? 'FAILED' : 'all'} ${passed} backend checks ${failed ? `passed, ${failed} failed` : 'passed'}`);
process.exit(failed ? 1 : 0);
