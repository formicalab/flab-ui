// Builds the scenario fixture folders of the Asterisk plugin test from the real capture (<work>/fx-real, made by run.ps1 with FLAB_RECORD).
// Every scenario is a copy of the capture with one thing changed: Asterisk down, disabled or not installed, a rejected registration, a call in
// progress, no PJSIP, a configuration file changed after the last reload, a fresh error in the log, many endpoints, and secrets in places
// the plugin must hide. Usage: node mkfx.mjs <work>
import fs from 'node:fs';
import path from 'node:path';

const work = process.argv[2];
const real = path.join(work, 'fx-real');

// The fixture file stem flab.exec gives `/usr/sbin/asterisk -rx '<c>' 2>/dev/null`.
export const cliName = c => `_usr_sbin_asterisk_rx_${c.replace(/[^A-Za-z0-9]+/g, '_')}_`;

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);
// Rewrites the saved output of one CLI command.
const edit = (dir, c, fn) => write(dir, `${cliName(c)}.txt`, fn(read(dir, `${cliName(c)}.txt`)));
// Makes one CLI command fail the way it does when the control socket is unreachable (by command text, or by fixture file stem).
const fail = (dir, c, stem = cliName(c)) => {
  write(dir, `${stem}.txt`, '');
  write(dir, `${stem}.result.json`, JSON.stringify({ code: 1, truncated: false, timed_out: false }));
};
// Makes every CLI command fail the way it does when Asterisk is not running or its control socket is unreachable.
const failAll = dir => {
  for (const f of fs.readdirSync(dir))
    if (f.startsWith('_usr_sbin_asterisk_rx_') && f.endsWith('.txt')) fail(dir, null, f.slice(0, -4));
};
const json = (dir, name, fn) => {
  const v = JSON.parse(read(dir, name));
  fn(v);
  write(dir, name, JSON.stringify(v));
};

// Registers a scenario: the capture is copied to <work>/<name> and `fn(dir)` changes it. The reload commands are never run for real: every
// scenario answers them from these files (and an unreachable daemon fails them like every other command).
function scenario(name, fn) {
  const dir = path.join(work, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(real, dir, { recursive: true });
  for (const c of ['core reload', 'dialplan reload', 'module reload res_pjsip.so']) write(dir, `${cliName(c)}.txt`, '');
  // Whatever the real router did last, no file is newer than the last reload (an hour ago) unless the scenario says so.
  const clock = +read(dir, 'clock.txt');
  edit(dir, 'core show uptime seconds', t => t.replace(/Last reload: \d+/, 'Last reload: 3600'));
  json(dir, 'conf_index.json', index => { for (const f of index) f.mtime = clock - 7200; });
  fn?.(dir);
}

scenario('base');

scenario('unreachable', dir => {
  failAll(dir);
});

scenario('stopped', dir => {
  failAll(dir);
  json(dir, 'files.json', f => { for (const k of Object.keys(f)) if (k.includes('asterisk.pid') || k.startsWith('/proc/')) delete f[k]; });
});

scenario('disabled', dir => {
  failAll(dir);
  json(dir, 'files.json', f => { for (const k of Object.keys(f)) if (k.includes('asterisk.pid') || k.startsWith('/proc/')) delete f[k]; });
  json(dir, 'uci_asterisk.json', u => { u.values.general.enabled = '0'; });
});

scenario('notinstalled', dir => write(dir, 'installed.txt', '0'));

scenario('regfail', dir => {
  for (const c of ['pjsip list registrations', 'pjsip show registrations'])
    edit(dir, c, t => t.replace(/(Vodafone[^\n]*?)Registered\s+\(exp\. \d+s\)/, '$1Rejected'));
});

scenario('calls', dir => {
  edit(dir, 'core show calls', () => '1 active calls\n5 calls processed\n');
  write(dir, `${cliName('core show channels concise')}.txt`, [
    'PJSIP/1001-0000000a!from-internal!_0[1-9].!2!Up!Dial!PJSIP/+390612345@Vodafone,120,T!1001!!!3!125!2f5b1c3e-aaaa!1700000000.10',
    'PJSIP/Vodafone-0000000b!from-internal!_0[1-9].!2!Up!AppDial!(Outgoing Line)!+390612345!!!3!124!2f5b1c3e-aaaa!1700000000.11',
    '',
  ].join('\n'));
  edit(dir, 'pjsip show endpoints', t => t.replace(
    / Endpoint:  1001 [^\n]*\n +InAuth:  1001\/1001\n +Aor:  1001 +\d+\n( +Contact:  1001\/[^\n]*\n)*/,
    ' Endpoint:  1001                                                 In use        1 of inf\n' +
    '     InAuth:  1001/1001\n' +
    '        Aor:  1001                                               2\n' +
    '      Contact:  1001/sip:1001@192.168.1.50:5060;ob               0123456789 Avail        12.345\n' +
    '      Contact:  1001/sip:1001@192.168.1.51:5060;ob               abcdef0123 Avail        30.5\n' +
    '    Channel:  PJSIP/1001-0000000a                                 Up         00:02:05\n' +
    '        Exten: +390612345         CLCID: "" <+390612345>\n'));
  edit(dir, 'pjsip list endpoints', t => t.replace(/(Endpoint:  1001 +)[^\n]*?( {2,})\d+ of (\d+|inf)/, '$1In use        1 of inf'));
});

scenario('nopjsip', dir => {
  edit(dir, 'module show', t => t.split('\n').filter(l => !/pjsip/.test(l)).join('\n'));
  for (const c of ['pjsip show endpoints', 'pjsip list endpoints', 'pjsip list registrations', 'pjsip show registrations'])
    write(dir, `${cliName(c)}.txt`, `No such command '${c}' (type 'help pjsip' for other possible commands)\n`);
});

scenario('changed', dir => {
  const clock = +read(dir, 'clock.txt');
  // pjsip.conf was written ten seconds ago, the last reload an hour ago.
  json(dir, 'conf_index.json', index => { for (const f of index) if (f.name === 'pjsip.conf') f.mtime = clock - 10; });
});

scenario('recenterr', dir => {
  const stamp = read(dir, 'now-log.txt').trim();
  const name = 'file__var_log_asterisk_messages_log.txt';
  write(dir, name, read(dir, name) + `[${stamp}] ERROR[321] res_pjsip.c: Synthetic failure for the test\n`);
});

// The error Asterisk always logs on musl: listed, marked harmless, no finding.
scenario('benignerr', dir => {
  const stamp = read(dir, 'now-log.txt').trim();
  const name = 'file__var_log_asterisk_messages_log.txt';
  write(dir, name, read(dir, name) + `[${stamp}] ERROR[321] res_pjsip/config_system.c: There are no local system nameservers configured, resorting to system resolution\n`);
});

scenario('many', dir => {
  const blocks = Array.from({ length: 45 }, (_, i) => ` Endpoint:  ext${i}                                                 Unavailable   0 of inf\n     InAuth:  ext${i}/ext${i}\n        Aor:  ext${i}                                               1\n`).join('\n');
  write(dir, `${cliName('pjsip show endpoints')}.txt`, ` Endpoint:  <Endpoint/CID.....>  <State.....>  <Channels.>\n==========================================================================================\n\n${blocks}\nObjects found: 45\n`);
});

// Secrets in every place the plugin reads: the plugin must hide each of them, and only them.
scenario('secrets', dir => {
  const pj = 'file__etc_asterisk_pjsip_conf.txt', ex = 'file__etc_asterisk_extensions_conf.txt';
  write(dir, pj, `${read(dir, pj)}\n[extra]\ntype=auth\nauth_type=userpass\nusername=visible-user\nsecret=topsecret-1\nmd5_cred=deadbeefmd5\n`);
  write(dir, ex, `${read(dir, ex)}\n[secrets]\nexten => s,1,Authenticate(4321)\n same => n,Set(SIP_PASSWORD=hunter2)\n same => n,GotoIf($["\${ADMIN_PIN}" != "9999"]?bad)\n`);
  edit(dir, 'dialplan show', t => `${t}\n[ Context 'secrets' created by 'pbx_config' ]\n` +
    `  's' =>            1. Authenticate(4321)                         [extensions.conf:900]\n` +
    `                    2. Set(SIP_PASSWORD=hunter2)                  [extensions.conf:901]\n` +
    `                    3. GotoIf($["\${ADMIN_PIN}" != "9999"]?bad)    [extensions.conf:902]\n` +
    `                    4. Set(PLAIN=ok)                              [extensions.conf:903]\n` +
    `                    5. GotoIf($["\${PIN}" != "" & "\${PIN}" = "\${REMOTE_ACCESS_PIN}"]?ok) [extensions.conf:904]\n`);
  edit(dir, 'dialplan show globals', t => t.replace('\n    -- ', '\n   API_TOKEN=abc123xyz\n   VISIBLE_NAME=shown\n\n    -- '));
  edit(dir, 'pjsip show endpoint Vodafone', t => `${t}\n password                           : swordfish\n`);
});

// What `dialplan show <exten>@<context>` prints for the resolve method (an included context and no match).
write(real, `${cliName('dialplan show 6000@from-internal')}.txt`, `[ Included context 'internal-lab' created by 'pbx_config' ]\n  '6000' =>         1. Answer()                                   [extensions.conf:260]\n                    2. Playback(demo-echotest)                    [extensions.conf:261]\n                    3. Hangup()                                   [extensions.conf:264]\n\n-= 1 extension (3 priorities) in 1 context. =-\n`);
write(real, `${cliName('dialplan show 99999@from-pstn')}.txt`, '');
for (const name of fs.readdirSync(work)) {
  const dir = path.join(work, name);
  if (name === 'fx-real' || name === 'out' || !fs.statSync(dir).isDirectory()) continue;
  for (const f of ['6000@from-internal', '99999@from-pstn'])
    fs.copyFileSync(path.join(real, `${cliName(`dialplan show ${f}`)}.txt`), path.join(dir, `${cliName(`dialplan show ${f}`)}.txt`));
}

// The real secrets of the captured router (passwords in pjsip.conf, a PIN literal in the dialplan or in its [globals]): assert.mjs checks that none
// of them reaches any reply. They are kept only in the temporary work folder.
const out = path.join(work, 'out');
fs.mkdirSync(out, { recursive: true });
const rawPjsip = read(real, 'file__etc_asterisk_pjsip_conf.txt');
const found = new Set();
for (const m of rawPjsip.matchAll(/^[ \t]*(?:password|secret|md5_cred)[ \t]*=[ \t]*([^\s;]+)/gim)) found.add(m[1]);
// A literal only: a comparison with another variable names no secret.
for (const m of read(real, `${cliName('dialplan show')}.txt`).matchAll(/\$\{[A-Za-z0-9_]*(?:PIN|PASS\w*|SECRET|TOKEN)\}"\s*[!=]=?\s*"([^"$]+)"/g)) found.add(m[1]);
for (const m of read(real, `${cliName('dialplan show globals')}.txt`).matchAll(/^\s+[A-Za-z0-9_]*(?:PIN|PASS\w*|SECRET|TOKEN)[A-Za-z0-9_]*=(\S+)/gm)) found.add(m[1]);
fs.writeFileSync(path.join(out, 'secrets.json'), JSON.stringify([...found].filter(v => v.length >= 4)));
fs.writeFileSync(path.join(out, 'raw-pjsip.conf'), rawPjsip);
