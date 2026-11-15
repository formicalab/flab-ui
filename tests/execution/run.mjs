// Native validation only: a disposable chroot and private ubus socket, never installed rpcd/config/services.
// Usage: node tests\execution\run.mjs [root@router]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const router = process.argv[2] ?? 'root@openwrt.lab.formicalab.casa';
const root = path.resolve(import.meta.dirname, '..', '..');
const work = path.join(root, '.execution-work');
const remote = `/root/flab-ui-execution-${process.pid}-${Date.now()}`;
const jail = `${remote}/root`;
const run = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (r.error || r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.error ?? r.stderr}\n${r.stdout}`);
  return r.stdout;
};
const ssh = script => run('ssh', [router, script.replace(/\r/g, '')]);
const call = method => JSON.parse(ssh(`ubus -s ${jail}/run/bus -t 28 call flab.execution-test ${method}`));
const failure = (method, pattern) => {
  const r = spawnSync('ssh', [router, `ubus -s ${jail}/run/bus -t 28 call flab.execution-test ${method}`], { encoding: 'utf8' });
  if (r.error) throw r.error;
  assert.notEqual(r.status, 0, `${method} must fail at the ubus transport level`);
  assert.match(r.stdout, pattern, `${method} must also carry a useful error payload`);
  return JSON.parse(r.stdout);
};
const pending = method => new Promise((resolve, reject) => {
  const p = spawn('ssh', [router, `ubus -s ${jail}/run/bus -t 28 call flab.execution-test ${method}`]);
  let text = '', error = '';
  p.stdout.on('data', b => text += b);
  p.stderr.on('data', b => error += b);
  p.on('error', reject);
  p.on('close', code => code ? reject(new Error(error)) : resolve(JSON.parse(text)));
});
let started = false;
try {
  fs.mkdirSync(work, { recursive: true });
  for (const suite of ['services', 'ddns', 'fwedit'])
    run('node', [path.join(root, 'tests', suite, 'mkfx.mjs'), path.join(work, suite)]);
  const fixture = (name, files) => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, value] of Object.entries(files))
      fs.writeFileSync(path.join(dir, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const resultName = cmd => cmd.replace(/ 2>\/dev\/null$/, '').replace(/[^A-Za-z0-9]+/g, '_') + '.result.json';
  const routeFiles = {};
  for (const family of [4, 6]) for (const query of ['route show table all', 'rule show'])
    routeFiles[resultName(`/sbin/ip -${family} ${query} 2>/dev/null`)] = { code: 0, output: '' };
  fixture('routing-empty', routeFiles);
  fixture('routing-failure', {});
  fixture('firewall-failure', {});
  fixture('replay-edited', {
    'synthetic_command.result.json': { code: 7, output: 'obsolete capture', truncated: false, timed_out: false },
    'synthetic_command.txt': 'edited output',
  });
  fixture('replay-empty', {
    'synthetic_command.result.json': { code: 0, output: 'obsolete capture', truncated: false, timed_out: false },
    'synthetic_command.txt': '',
  });
  fixture('cable-failure', {
    'network_device_status.json': { lan1: { present: true, devtype: 'ethernet' } },
    [resultName('timeout 30 ethtool --cable-test lan1 2>&1')]: { code: 7, output: 'Pair A code OK\nPair B code OK\n' },
  });
  ssh(`mkdir -p ${remote}`);
  const archive = run('tar', ['-cf', '-', 'rpcd', ...['execution', 'services', 'ddns', 'fwedit'].map(s => path.join('tests', s)), '.execution-work'], { encoding: null });
  run('ssh', [router, `tar -xf - -C ${remote}`], { input: archive });
  ssh(`set -e
cd ${remote}
for f in rpcd/ucode/*.uc; do ucode -L "${remote}/rpcd/lib/*.uc" -c -o /dev/null "$f"; done
mkdir job stream
FLAB_JOB_DIR=${remote}/job FLAB_STREAM_DIR=${remote}/stream ucode -L "${remote}/rpcd/lib/*.uc" tests/execution/probe.uc >probe.json
mkdir -p root/bin root/sbin root/usr/bin root/usr/lib/ucode root/usr/share/rpcd/ucode root/usr/share/ucode/flab root/lib root/dev root/run root/etc
printf 'root:x:0:0:Test:/root:/bin/sh\\n' >root/etc/passwd
printf 'root:x:0:\\n' >root/etc/group
cp -L /bin/busybox root/bin/
cp -L /sbin/rpcd /sbin/ubusd root/sbin/
cp -L /lib/*.so* root/lib/
cp -L /usr/lib/*.so* root/usr/lib/
cp -L /usr/lib/ucode/fs.so /usr/lib/ucode/ubus.so /usr/lib/ucode/uci.so /usr/lib/ucode/uloop.so root/usr/lib/ucode/
mkdir -p root/usr/lib/rpcd
cp -L /usr/lib/rpcd/ucode.so root/usr/lib/rpcd/
cp rpcd/lib/flab/*.uc root/usr/share/ucode/flab/
cp tests/execution/rpcd.uc root/usr/share/rpcd/ucode/
for a in sh sleep timeout yes head kill; do ln -s busybox root/bin/$a; done
mknod root/dev/null c 1 3
chroot ${jail} /sbin/ubusd -s /run/bus >ubusd.log 2>&1 & echo $! >ubusd.pid
sleep 1
chroot ${jail} /sbin/rpcd -s /run/bus -t 30 >rpcd.log 2>&1 & echo $! >rpcd.pid
`);
  started = true;
  await new Promise(resolve => setTimeout(resolve, 600));
  const native = JSON.parse(ssh(`cat ${remote}/probe.json`));
  assert.equal(native.empty.ok, true);
  assert.equal(native.failure.code, 7);
  assert.equal(native.failure.ok, false);
  assert.equal(native.timeout.timed_out, true);
  assert.equal(native.flood.truncated, true);
  assert.equal(native.flood.output.length, 4096);
  assert.equal(native.silent_after_cap.truncated, true);
  assert.ok(native.silent_after_cap_seconds < 3, 'a producer which becomes silent at the cap is terminated, not merely timed out');
  assert.equal(native.aggregate, true);
  assert.equal(native.job.size, native.job.max);
  assert.equal(native.job.limited, true);
  assert.notEqual(native.job.code, '');
  assert.equal(native.streaming.running, true, 'streaming output is checked before the producer exits');
  assert.equal(native.streaming.text, 'headerfirst', 'small writes after the first chunk must be visible while the job runs');
  console.log('PASS command statuses, duration, aggregate budget and hard diagnostic output-file cap');
  console.log('PASS small diagnostic writes stream before producer completion');
  for (const [scenario, code, output] of [['replay-edited', 7, 'edited output'], ['replay-empty', 0, '']]) {
    const r = JSON.parse(ssh(`cd ${remote}; FLAB_FIXTURES=${remote}/.execution-work/${scenario} ucode -L "${remote}/rpcd/lib/*.uc" tests/execution/replay.uc`));
    assert.equal(r.code, code);
    assert.equal(r.output, output, 'canonical text overrides obsolete recorded output while preserving outcome metadata');
  }
  console.log('PASS recorded status metadata and edited/empty canonical text remain independent');
  const direct = (plugin, scenario, method = 'status', args = {}) => JSON.parse(ssh(
    `cd ${remote}; FLAB_PLUGIN=${remote}/rpcd/ucode/flab.${plugin}.uc FLAB_FIXTURES=${remote}/.execution-work/${scenario} FLAB_METHOD=${method} FLAB_ARGS='${JSON.stringify(args)}' ucode -L "${remote}/rpcd/lib/*.uc" tests/execution/call.uc`,
  ));
  const failedRoutes = direct('routing', 'routing-failure');
  const emptyRoutes = direct('routing', 'routing-empty');
  assert.equal(failedRoutes.ok, false);
  assert.equal(failedRoutes.available, false);
  assert.match(failedRoutes.error, /query failed/);
  assert.equal(emptyRoutes.error, undefined, 'successful empty status is distinct from command failure');
  const failedFirewall = direct('firewall', 'firewall-failure');
  assert.equal(failedFirewall.ok, false);
  assert.equal(failedFirewall.running, null, 'query failure is not a stopped firewall');
  const failedCable = direct('network', 'cable-failure', 'cable_test', { port: 'lan1' });
  assert.equal(failedCable.ok, false, 'partial output must not turn a failed cable command into success');
  assert.match(failedCable.error, /exit 7/);
  console.log('PASS status-command failures and partial-result failures remain explicit');

  const before = call('pulse').ticks;
  const sleeper = pending('sleep');
  await new Promise(resolve => setTimeout(resolve, 250));
  const t = performance.now();
  const during = call('pulse').ticks;
  assert.ok(performance.now() - t < 1000, 'rpcd must answer during a two-second sleeper');
  assert.ok(during > before, 'rpcd timers must advance while the worker waits');
  assert.equal((await sleeper).output, 'awake');
  assert.equal(call('fail').code, 9);
  assert.equal(call('timeout').timed_out, true);
  assert.equal(call('flood').truncated, true);
  failure('crash', /synthetic worker failure/);
  failure('noresult', /no result/);
  failure('oversized', /output budget/);
  assert.deepEqual(call('intentional'), { ok: false, error: 'Synthetic validation refusal.' }, 'intentional handler refusals remain successful ubus payloads');
  const crowded = Array.from({ length: 4 }, () => pending('sleep'));
  await new Promise(resolve => setTimeout(resolve, 300));
  failure('sleep', /busy/);
  assert.ok((await Promise.all(crowded)).every(r => r.ok));
  const timeoutAt = performance.now();
  assert.equal(failure('deadline', /timed out/).timed_out, true);
  assert.ok(performance.now() - timeoutAt < 27000, 'worker deadline must precede rpcd timeout');
  assert.ok(call('pulse').ticks > during);
  console.log('PASS native rpcd defer/reply, responsiveness, timer progress, failures and worker deadline');

  for (const [suite, scenarios] of [['services', ['ok', 'fail', 'timeout', 'noresult']], ['ddns', ['main', 'fail', 'timeout', 'noresult', 'empty']]]) {
    const output = path.join(work, `${suite}-out`);
    fs.mkdirSync(output, { recursive: true });
    for (const scenario of scenarios) {
      const json = ssh(`cd ${remote}; FLAB_PLUGIN=${remote}/rpcd/ucode/flab.${suite}.uc FLAB_CASES=${remote}/.execution-work/${suite}/cases.json FLAB_FIXTURES=${remote}/.execution-work/${suite}/${scenario} ucode -L "${remote}/rpcd/lib/*.uc" tests/${suite}/harness.uc`);
      fs.writeFileSync(path.join(output, `${scenario}.json`), json);
    }
    console.log(run('node', [path.join(root, 'tests', suite, 'assert.mjs'), output]).trim().split('\n').at(-1));
  }
  const firewallWork = path.join(work, 'fwedit');
  fs.mkdirSync(path.join(firewallWork, 'out'), { recursive: true });
  for (const scenario of JSON.parse(fs.readFileSync(path.join(firewallWork, 'scenarios.json'))))
    fs.writeFileSync(path.join(firewallWork, 'out', `${scenario}.json`), JSON.stringify(direct('firewall', `fwedit/${scenario}`)));
  console.log(run('node', [path.join(root, 'tests', 'fwedit', 'assert.mjs'), firewallWork]).trim().split('\n').at(-1));
} catch (error) {
  try { console.error(ssh(`cat ${remote}/ubusd.log ${remote}/rpcd.log 2>/dev/null; ls -la ${jail}/run; cat ${remote}/*.pid; ps w | grep '[u]busd\\|[r]pcd'`)); } catch {}
  throw error;
} finally {
  if (started) ssh(`for f in ${remote}/rpcd.pid ${remote}/ubusd.pid; do if [ -f "$f" ]; then read p <"$f"; kill "$p" 2>/dev/null || :; fi; done`);
  try { ssh(`rm -rf ${remote}`); } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
