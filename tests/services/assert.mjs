// Checks the output of flab.services for each scenario built by mkfx.mjs, and (when present) the real router's `list`.
// Usage: node assert.mjs <dir with <scenario>.json files>
//   real.json, real-init.txt and real-rc.txt (optional): `list` run for real (it only reads) and the executable files
//   of /etc/init.d and links of /etc/rc.d as the shell reports them.
import fs from 'node:fs';
import path from 'node:path';
import { BACKGROUND, INSTALLED, REFUSED, RUN } from './cases.mjs';

const dir = process.argv[2];
// Loads one scenario's results (a JSON object keyed by call id).
const load = n => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));
let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

// The calls that must be refused, in every scenario, without anything being run.
function refusals(sc, r) {
  const bad = [];
  for (const [name, action, pattern] of REFUSED) {
    const x = r[`refused:${name}:${action}`];
    if (!(x && x.ok === false && x.code === null && x.detached === false && x.output === '' && pattern.test(x.error))) bad.push(`${name}/${action}: ${j(x)}`);
  }
  check(bad.length === 0, `${sc}: ${REFUSED.length} refused calls (protected, unknown, invalid name, invalid action) say why and run nothing`, bad.join(' | '));
  const types = ['no-args', 'number-name', 'list-name', 'object-action', 'no-action'].filter(k => r[`refused:${k}`]?.ok !== false || r[`refused:${k}`]?.code !== null);
  check(types.length === 0, `${sc}: missing or wrongly typed arguments are refused`, types.join());
}

// The calls that run in the background answer at once and never wait for the script.
function background(sc, r) {
  const bad = BACKGROUND.filter(([n, a]) => { const x = r[`bg:${n}:${a}`]; return !(x && x.ok === true && x.detached === true && x.code === null && x.output === '' && x.error === null); });
  check(bad.length === 0, `${sc}: stop and restart of rpcd, uhttpd and network run in the background`, j(bad));
}

console.log('== list ==');
const ok = load('ok');
const list = ok.list;
const names = list.services.map(s => s.name);
check(names.join() === INSTALLED.join(), 'every executable init script is listed, sorted; names that are not plain file names are dropped', names.join());
// The service named `n` in the list.
const svc = n => list.services.find(s => s.name === n);
check(svc('dropbear').enabled && svc('dropbear').start === 19 && svc('cron').start === 50 && svc('done').start === 95, 'a service with an S link starts at boot, at that position');
check(svc('acme').enabled === false && svc('acme').start === null && svc('umount').enabled === false, 'a service without an S link is disabled (a K link alone does not enable it)');
check(list.services.filter(s => s.protected).map(s => s.name).join() === 'boot,done,umount', 'only the boot-sequence scripts are protected');
check(typeof list.generated === 'number' && list.services.every(s => Object.keys(s).sort().join() === 'enabled,name,protected,start'), 'the reply has only the whitelisted fields');

console.log('\n== control: scripts that succeed ==');
for (const [n, a] of RUN) {
  const x = ok[`run:${n}:${a}`];
  check(x.ok === true && x.code === 0 && x.detached === false && x.output === 'Restarting service' && x.error === null && x.name === n && x.action === a, `${a} ${n} runs the script and returns its output`, j(x));
}
background('ok', ok);
refusals('ok', ok);

console.log('\n== control: a script that fails ==');
const fail = load('fail');
const fx = fail['run:dropbear:restart'];
check(fx.ok === false && fx.code === 1 && /exit code 1/.test(fx.error) && /bad config/.test(fx.output), 'a nonzero exit code is a failure that carries the code and the script\'s output', j(fx));
check(RUN.every(([n, a]) => fail[`run:${n}:${a}`].ok === false), 'every waited call reports the failure');
background('fail', fail);
refusals('fail', fail);

console.log('\n== control: a script that hangs, or reports nothing ==');
const to = load('timeout')['run:dropbear:restart'];
check(to.ok === false && to.code === 124 && /45 seconds/.test(to.error), 'a script that does not finish in time is reported as such', j(to));
const nr = load('noresult')['run:dropbear:restart'];
check(nr.ok === false && nr.code === null && /did not report/.test(nr.error), 'a missing exit code is a failure, not a success', j(nr));
background('timeout', load('timeout'));
refusals('timeout', load('timeout'));
refusals('noresult', load('noresult'));

if (fs.existsSync(path.join(dir, 'real.json'))) {
  console.log('\n== the real router (list only, nothing is run) ==');
  const real = JSON.parse(fs.readFileSync(path.join(dir, 'real.json'), 'utf8')).list;
  // The non-empty, trimmed lines of capture file `f`.
  const lines = f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  const init = lines('real-init.txt').sort();
  const rc = lines('real-rc.txt');
  check(init.length > 3 && real.services.map(s => s.name).join() === init.join(), `the list matches the executable files of /etc/init.d (${init.length})`, `${real.services.map(s => s.name).join()} vs ${init.join()}`);
  const starts = Object.fromEntries(rc.map(l => /^S([0-9]+)(.+)$/.exec(l)).filter(Boolean).map(m => [m[2], +m[1]]));
  check(real.services.every(s => s.enabled === (starts[s.name] !== undefined) && s.start === (starts[s.name] ?? null)), 'enabled and position match the S links of /etc/rc.d', j(real.services.filter(s => s.enabled !== (starts[s.name] !== undefined))));
  check(real.services.filter(s => s.protected).every(s => ['boot', 'done', 'umount'].includes(s.name)) && real.services.some(s => s.name === 'rpcd'), 'rpcd is listed and only boot-sequence scripts are protected');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall Services backend checks passed');
process.exit(failed ? 1 : 0);
