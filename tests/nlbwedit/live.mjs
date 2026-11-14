// Browser test for the Settings tab of the Traffic page. A real browser opens the deployed UI.
// 1. Against the real router, read only: the tab shows the router's own nlbwmon config, and every uci write it might send in
//    this phase is blocked and fails the test.
// 2. Against a stateful mock of rpcd's `uci` object, procd's service list and the flab.traffic plugin: the reading, the
//    validation of every option, the effect lines, the probes of typed paths, the whole editing flow (saving, a change the router
//    does not keep, a change that stops nlbwmon or leaves it on the old settings, a failed confirmation), staged leftovers, a login
//    that may not write, no nlbwmon, no plugin, an expired session - WITHOUT touching the router's configuration or its daemon.
// Usage: node live.mjs   (env: FLAB_SID and FLAB_ACLS from tests/TestSession.ps1, FLAB_URL, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import path from 'node:path';

const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID;
const rootAcls = JSON.parse(process.env.FLAB_ACLS);   // what the session may call, like the ACLs of a real sign-in
const shots = process.env.FLAB_SHOTS;

let failed = 0;
let passed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts it for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (cond) passed++; else failed++; };
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));

//#region The mock router
const NOW = 1794600000;
const WRITES = ['set', 'add', 'delete', 'apply', 'confirm', 'rollback', 'revert', 'commit', 'order', 'rename'];
const STORED = ['2026-10-01', '2026-09-01', '2026-08-01', '2026-07-01'];

// The nlbwmon config of the mock router: the one the package ships plus what the real router has.
const baseCfg = () => ({
  cfg0: {
    '.type': 'nlbwmon', '.name': 'cfg0', '.anonymous': true,
    netlink_buffer_size: '524288', commit_interval: '24h', refresh_interval: '30s', database_directory: '/var/lib/nlbwmon', database_generations: '10',
    database_interval: '1', database_limit: '10000', protocol_database: '/usr/share/nlbwmon/protocols', local_network: ['192.168.1.0/24', 'lan', 'wan', 'wan6'], database_compress: '1',
  },
});
const NETS = { lan: '192.168.1.1/24', wan: '203.0.113.2/32', wan6: '2001:db8::1/64', guest: '10.9.0.1/24' };

// The command line the init script builds for a config (what procd reports for the daemon).
function commandFor(cfg) {
  const s = Object.values(cfg).find(x => x['.type'] === 'nlbwmon') ?? {};
  const opt = (flagName, key, def) => (s[key] === undefined || s[key] === '' ? def : s[key]);
  const cmd = ['/usr/sbin/nlbwmon', '-o', opt('-o', 'database_directory', '/var/lib/nlbwmon')];
  for (const [f, k, d] of [['-b', 'netlink_buffer_size', '524288'], ['-i', 'commit_interval', '24h'], ['-r', 'refresh_interval', '30s'], ['-p', 'protocol_database', '/usr/share/nlbwmon/protocols'], ['-G', 'database_generations', '10'], ['-I', 'database_interval', '1'], ['-L', 'database_limit', '10000']]) cmd.push(f, opt(f, k, d));
  if (['1', 'true', 'on', 'yes'].includes(String(s.database_prealloc))) cmd.push('-P');
  if (!['0', 'false', 'off', 'no'].includes(String(s.database_compress ?? '1'))) cmd.push('-Z');
  for (const n of [].concat(s.local_network ?? [])) cmd.push('-s', /[.:]/.test(n) ? n : (NETS[n] ?? '10.0.0.1/24'));
  return cmd;
}

const mock = {
  on: false, cfg: baseCfg(), staged: [], restage: [], snapshot: null, calls: [], log: [], probes: [], loads: 0, reads: [], unsafe: [],
  daemon: { running: true, pid: 8345, command: commandFor(baseCfg()) },
  // How the daemon reacts to an apply: follow (restarts with the new config), down (stops), stale (keeps the old command line),
  // flap (a new process every time it is looked at).
  mode: 'follow',
  dropWrites: false, confirmFails: false, expired: false, noPlugin: false, noConfig: false, nlbw: true,
};
let nextPid = 9000;
// Brings the daemon to what the committed config asks for, the way procd's reload would.
function reload() {
  if (mock.mode === 'down') mock.daemon = { running: false, pid: null, command: [] };
  else if (mock.mode !== 'stale') mock.daemon = { running: true, pid: nextPid++, command: commandFor(mock.cfg) };
}

// What the mock config looks like with the staged edits applied (uci get includes them).
function withStaged() {
  const cfg = clone(mock.cfg);
  for (const [op, section, option, value] of mock.staged) {
    if (op === 'set') cfg[section][option] = value;
    else if (op === 'delete') (option ? delete cfg[section][option] : delete cfg[section]);
    else if (op === 'add') cfg[section] = { '.type': option, '.name': section, '.anonymous': true, ...value };
  }
  return cfg;
}
// Applies the staged edits to the mock's config, the way rpcd's uci apply does.
function commit() { mock.cfg = withStaged(); }
// What a rollback or a failed confirmation puts back: the config, the staged edits and the daemon on that config.
function restore() {
  mock.cfg = mock.snapshot;
  mock.staged = mock.restage;
  mock.snapshot = null;
  mock.daemon = { running: true, pid: nextPid++, command: commandFor(mock.cfg) };
}

// One uci method of the mock: [ubus status, data].
function uci(method, args) {
  if (method === 'get') { mock.reads.push(args.config); return mock.noConfig ? [4] : [0, { values: withStaged() }]; }
  if (method === 'changes') {
    const list = mock.staged.map(c => c.slice(0, 4));
    return [0, { changes: args.config ? list : (list.length ? { nlbwmon: list } : {}) }];
  }
  if (method === 'set') { mock.log.push(`set ${JSON.stringify(args.values)}`); for (const [k, v] of Object.entries(args.values)) mock.staged.push(['set', args.section, k, v]); return [0, {}]; }
  if (method === 'add') { mock.log.push(`add ${JSON.stringify(args.values)}`); mock.staged.push(['add', 'cfg9', args.type, args.values ?? {}]); return [0, { section: 'cfg9' }]; }
  if (method === 'delete') { mock.log.push(`delete ${JSON.stringify(args.options)}`); for (const o of args.options ?? [undefined]) mock.staged.push(['delete', args.section, o, undefined]); return [0, {}]; }
  if (method === 'revert') { mock.staged = []; return [0, {}]; }
  if (method === 'apply') {
    mock.snapshot = clone(mock.cfg);
    mock.restage = mock.staged;
    if (!mock.dropWrites) { commit(); reload(); }
    mock.staged = [];
    return [0, {}];
  }
  if (method === 'confirm') {
    if (mock.confirmFails) { restore(); return [1]; }
    mock.snapshot = null;
    return [0, {}];
  }
  if (method === 'rollback') {
    if (mock.snapshot) restore();
    return [0, {}];
  }
  return [0, {}];
}

// The directory reply of the plugin for a path: a few places the tests type in, any other path is a new directory on flash.
function dirReply(p) {
  const base = { ok: true, path: p, resolved: p, exists: false, is_dir: true, blocked: false, mount: '/', fstype: 'overlay', device: 'overlayfs:/overlay', readonly: false, kind: 'flash', files: [], total: 0 };
  if (p === '/var/lib/nlbwmon') return { ...base, resolved: '/tmp/lib/nlbwmon', exists: true, mount: '/tmp', fstype: 'tmpfs', device: 'tmpfs', kind: 'volatile', total: 2, files: [{ name: '20261101.db.gz', size: 11564, mtime: NOW - 7200 }, { name: '20261001.db.gz', size: 9000, mtime: NOW - 2000000 }] };
  if (p.startsWith('/mnt/usb')) return { ...base, mount: '/mnt/usb', fstype: 'ext4', device: '/dev/sda1', kind: 'storage' };
  if (p.startsWith('/mnt/ro')) return { ...base, mount: '/mnt/ro', fstype: 'vfat', device: '/dev/sdb1', kind: 'readonly', readonly: true };
  if (p === '/etc/passwd') return { ...base, exists: true, is_dir: false, blocked: true };
  return base;
}
// The protocol file reply for a path.
function fileReply(p) {
  const f = { ok: true, path: p, exists: true, file: true, size: 606, readable: true };
  if (p === '/nope') return { ...f, exists: false, file: false, size: null, readable: false };
  if (p === '/etc') return { ...f, file: false, readable: false };
  if (p === '/etc/shadow') return { ...f, readable: false };
  return f;
}

// The JSON-RPC answer for a request the mock handles, or null to let it through to the real router.
function answer(body) {
  const [, obj, method, args] = body.params;
  // Wraps a ubus status code and optional data as a JSON-RPC result.
  const ok = ([code, data]) => ({ jsonrpc: '2.0', id: body.id, result: data === undefined ? [code] : [code, data] });
  const denied = { jsonrpc: '2.0', id: body.id, error: { code: -32002, message: 'Access denied' } };

  if (!mock.on) {
    // Real router: reads only. A write would change something, so it is blocked and the test fails.
    if (obj === 'uci' && WRITES.includes(method)) { mock.unsafe.push(`${obj}.${method}`); return ok([6]); }
    if (obj === 'uci' && method === 'get') mock.reads.push(`real:${args.config}`);
    return null;
  }
  if (mock.expired && ['uci', 'flab.traffic', 'system', 'service', 'session', 'network.interface', 'flab.network'].includes(obj)) return denied;
  if (obj === 'uci') { mock.calls.push(`uci.${method}`); return ok(uci(method, args)); }
  if (obj === 'service' && method === 'list') {
    mock.calls.push('service.list');
    if (mock.mode === 'flap' && mock.daemon.running) mock.daemon = { ...mock.daemon, pid: nextPid++ };
    const d = mock.daemon;
    return ok([0, { nlbwmon: { instances: { instance1: d.running ? { running: true, pid: d.pid, command: d.command } : { running: false } } } }]);
  }
  if (obj === 'network.interface' && method === 'dump') return ok([0, { interface: [{ interface: 'loopback' }, { interface: 'lan' }, { interface: 'wan' }, { interface: 'wan6' }] }]);
  if (obj === 'system' && method === 'info') return ok([0, { memory: { total: 536870912 } }]);
  if (obj === 'flab.traffic') {
    if (mock.noPlugin) return ok([4]);
    if (method === 'status') return ok([0, { generated: NOW, conntrack: true, count: 100, max: 65536, acct: true, nlbw: mock.nlbw, nlbwmon_running: mock.daemon.running }]);
    if (method === 'usage_periods') return ok([0, { ok: true, generated: NOW, present: mock.nlbw, running: mock.daemon.running, periods: mock.daemon.running ? STORED : [], current: '2026-11-01', today: '2026-11-14' }]);
    if (method === 'nlbwmon_paths') {
      // The page's own load asks about both saved paths at once; a typed path is asked about alone.
      if (args.dir != null && args.protocols != null) mock.loads++;
      else mock.probes.push(JSON.stringify(args));
      return ok([0, { ok: true, generated: NOW, dir: args.dir != null ? dirReply(args.dir) : null, protocols: args.protocols != null ? fileReply(args.protocols) : null }]);
    }
  }
  return null;
}
//#endregion

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1300 }, colorScheme: 'light' });
const errors = [];
await ctx.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const reply = body ? answer(body) : null;
  return reply ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) }) : route.continue();
});
let page = null;
// Opens the Traffic page with a session in sessionStorage, the way a real sign-in leaves the tab, and then its Settings tab.
const open = async (acls, tab = 'Settings') => {
  if (page) await page.close();
  page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/the server responded with a status of/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(([id, a]) => {
    sessionStorage.setItem('sid', id);
    sessionStorage.setItem('acls', JSON.stringify(a));
  }, [sid, acls ?? rootAcls]);
  await page.goto(`${baseUrl}#traffic`);
  await page.waitForFunction(() => document.querySelector('.tr-live, .seg-tab, .login-form:not([hidden])'), null, { timeout: 30000 });
  if (tab) {
    await page.locator('.seg-tab', { hasText: tab }).click();
    await page.waitForSelector('.nlbw-form, main .set-note, main .empty, .login-form', { timeout: 20000 });
  }
  return page;
};

// Helpers: the tiles, the fields and their parts, the banner, and screenshots.
const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
// The small text under the value of tile number `i`.
const tileSub = async i => (await page.locator('.tile .sub').nth(i).innerText()).trim();
// The field (or checkbox) of an option, found by its label.
const field = label => page.locator('.nlbw-form .set-field, .nlbw-form .set-check').filter({ has: page.locator('label.form-label, span', { hasText: new RegExp(`^\\s*${label}`) }) }).first();
// The first input or select of that field.
const input = label => field(label).locator('input, select').first();
// The effect line under that field.
const effect = label => field(label).locator('.nlbw-effect').innerText().then(t => t.trim()).catch(() => '');
// The text of every note that reports an error or a warning in the review banner.
const banner = () => page.locator('.set-bar .set-note').allInnerTexts().then(t => t.join(' | '));
// How many error notes the banner shows.
const errorCount = () => page.locator('.set-bar .set-note.bad').count();
// The save bar and its Save button.
const bar = () => page.locator('.set-bar');
const saveBtn = () => page.locator('button:has-text("Save and apply")');
// The review list of pending changes (opens the details if they are closed).
const changes = async () => { if (await page.locator('.set-bar-details').isHidden()) await page.locator('.set-bar button:has-text("Details")').click(); return page.locator('.set-changes').evaluate(e => e.textContent); };
// Saves a full-page screenshot named after `label`, when a screenshot folder is set.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `nlbwedit-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Waits for the save bar to report the result of a save and returns its text.
const outcome = async () => { const n = page.locator('.set-bar .set-outcome.ok, .set-bar .set-outcome.bad').first(); await n.waitFor({ timeout: 90000 }); return (await n.innerText()).trim(); };
// Clicks Refresh and gives the page a moment to redraw.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(900); };
// Starts a mock scenario: a fresh config and a daemon that follows it, and a freshly opened Settings tab.
const fresh = async (acls, tab) => {
  mock.cfg = baseCfg(); mock.staged = []; mock.restage = []; mock.snapshot = null; mock.mode = 'follow';
  mock.dropWrites = false; mock.confirmFails = false; mock.expired = false; mock.noPlugin = false; mock.noConfig = false; mock.nlbw = true;
  mock.daemon = { running: true, pid: 8345, command: commandFor(mock.cfg) };
  mock.calls = []; mock.log = []; mock.probes = [];
  await open(acls, tab);
};

//#region The real router (read only)
console.log('== the real router (read only, nothing is written) ==');
await open(undefined, null);
await page.locator('.seg-tab', { hasText: 'Settings' }).waitFor({ timeout: 20000 }).catch(() => {});
const tabs = (await page.locator('.seg-tab').allInnerTexts()).map(t => t.trim());
check(tabs.at(-1) === 'Settings' && tabs.includes('Live'), 'the Settings tab is offered', tabs.join());
await page.locator('.seg-tab', { hasText: 'Settings' }).click();
await page.waitForSelector('.nlbw-form, main .set-note', { timeout: 20000 });
const real = await page.evaluate(async () => {
  const id = sessionStorage.getItem('sid');
  const call = async (o, m, a) => (await (await fetch('/ubus', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [id, o, m, a] }) })).json()).result?.[1];
  const cfg = (await call('uci', 'get', { config: 'nlbwmon' }))?.values ?? null;
  const svc = await call('service', 'list', { name: 'nlbwmon' });
  return { section: cfg && Object.values(cfg).find(s => s['.type'] === 'nlbwmon'), running: Boolean(svc && Object.values(svc.nlbwmon?.instances ?? {}).some(i => i.running)) };
});
if (real.section) {
  const v = real.section;
  check(await page.locator('.nlbw-form .card').count() === 4 && await page.locator('.nlbw-form .set-field, .nlbw-form .set-check').count() === 11, 'four cards hold the eleven options of nlbwmon');
  check(await input('Commit interval').inputValue() === (v.commit_interval ?? '') && await input('Database directory').inputValue() === (v.database_directory ?? '') && await input('Accounting period').inputValue() === (v.database_interval ?? ''), 'the values are the router\'s own');
  const list = [].concat(v.local_network ?? []);
  check(await field('Local networks').locator('.set-list input').evaluateAll(els => els.map(e => e.value)).then(x => x.join()) === list.join(), 'the local networks are listed one per row', list.join());
  check(await tile(0) === (real.running ? 'Running' : 'Stopped'), 'the daemon tile follows procd', await tile(0));
  check((await effect('Database directory')).length > 20, 'the directory says where it really is', await effect('Database directory'));
  check(await bar().isHidden() && await saveBtn().isDisabled(), 'nothing is pending');
} else {
  check(/not installed|cannot be read/.test(await page.locator('main').innerText()), 'a router without nlbwmon gets a note, not an error', await page.locator('main').innerText());
}
await shot('real');
//#endregion

//#region Mock: reading
mock.on = true;
await fresh();
console.log('\n== reading (mock router) ==');
check((await page.locator('.seg-tab').allInnerTexts()).map(t => t.trim()).join() === 'Live,Connections,Usage,Settings' && await page.locator('.seg-tab.active').innerText() === 'Settings', 'the tab strip has four tabs and Settings is open');
check(await tile(0) === 'Running' && await tileSub(0) === 'process 8345 · runs with the saved settings', 'tile: the daemon runs with the saved settings', `${await tile(0)} | ${await tileSub(0)}`);
check(await tile(1) === 'Day 14 of 30' && await tileSub(1) === '2026-11-01 to 2026-11-30 · the next one starts 2026-12-01', 'tile: the accounting period now', `${await tile(1)} | ${await tileSub(1)}`);
check(await tile(2) === '5 of 10' && await tileSub(2) === '4 finished and the running one', 'tile: periods held against periods to keep', `${await tile(2)} | ${await tileSub(2)}`);
check(await tile(3) === 'RAM' && await tileSub(3) === '/tmp/lib/nlbwmon on tmpfs · last written 2 hours ago', 'tile: the database is in RAM, and when it was last written', `${await tile(3)} | ${await tileSub(3)}`);
check(await page.locator('.nlbw-form .card-header').allInnerTexts().then(t => t.map(x => x.trim()).join('|')) === 'What is counted|Accounting periods and history|Database storage|Polling, memory and protocols', 'the four cards');
const values = { 'Accounting period': '1', 'Periods to keep': '10', 'Database directory': '/var/lib/nlbwmon', 'Commit interval': '24h', 'Refresh interval': '30s', 'Entry limit': '10000', 'Netlink buffer': '524288', 'Protocol file': '/usr/share/nlbwmon/protocols' };
let wrong = [];
for (const [k, v] of Object.entries(values)) if (await input(k).inputValue() !== v) wrong.push(k);
check(wrong.length === 0, 'every option shows the router\'s value', wrong.join());
check(await input('Compress the database files').isChecked() && !(await input('Reserve the memory for the whole limit').isChecked()), 'a switch that is set is on; one that is not set follows its default (off)');
check(await field('Local networks').locator('.set-list input').evaluateAll(els => els.map(e => e.value)).then(x => x.join()) === '192.168.1.0/24,lan,wan,wan6', 'the networks are one per row');
check(await page.locator('.nlbw-form .set-hint:not(.nlbw-effect)').count() === 11, 'every option has a hint');
check(/^The counters of open connections are read every 30 seconds \(120 times an hour\)\.$/.test(await effect('Refresh interval')) && /^Written every 1 day: at most once a day\./.test(await effect('Commit interval')), 'the effect lines say what the intervals mean', `${await effect('Refresh interval')} | ${await effect('Commit interval')}`);
check(await effect('Accounting period') === 'The running period would be 2026-11-01 to 2026-11-30 (day 14 of 30); the next one starts 2026-12-01.', 'the accounting window', await effect('Accounting period'));
check(/^4 finished periods stored \(2026-10-01, 2026-09-01, 2026-08-01, 2026-07-01\) besides the running one\. Nothing is deleted at the next start/.test(await effect('Periods to keep')), 'the stored periods against the number to keep', await effect('Periods to keep'));
check(/^\/var\/lib\/nlbwmon is \/tmp\/lib\/nlbwmon\. On tmpfs \(RAM\): no flash wear, but the history is lost at every reboot\. It holds 2 database files \(20\.1 KiB\), the latest written 2 hours ago\.$/.test(await effect('Database directory')) && await field('Database directory').locator('.nlbw-effect.warn').count() === 1, 'the directory: a link resolved, the storage kind flagged, the files and the last write', await effect('Database directory'));
check(/^nlbwmon is counting 3 subnets now: 192\.168\.1\.0\/24, 192\.168\.1\.1\/24, 2001:db8::1\/64\. Networks of this router: lan, wan, wan6\.$/.test(await effect('Local networks')) === false && /nlbwmon is counting 4 subnets now/.test(await effect('Local networks')) && /Networks of this router: lan, wan, wan6\./.test(await effect('Local networks')), 'the local networks line shows what the daemon counts now and the router\'s networks', await effect('Local networks'));
check(/^At most 10,000 entries, roughly 976\.6 KiB of RAM when full/.test(await effect('Entry limit')) && /^File found \(606 bytes\)\.$/.test(await effect('Protocol file')) && await effect('Netlink buffer') === '524288 bytes = 512.0 KiB.', 'the limit, the protocol file and the buffer');
check(await bar().isHidden(), 'the banner is hidden while nothing is edited');
check(/Nothing is changed until you press Save and apply/.test(await page.locator('main').innerText()), 'a note says nothing is saved until Save and apply');
check(mock.probes.length === 0 && mock.loads >= 1, 'the saved paths are asked about once, together, when the tab loads, and typed paths are not', `${mock.probes.join()} ${mock.loads}`);
await shot('mock-base');

console.log('\n== options that are not set show their defaults ==');
mock.cfg = { cfg0: { '.type': 'nlbwmon', '.name': 'cfg0', local_network: ['lan'] } };
mock.daemon = { running: true, pid: 8345, command: commandFor(mock.cfg) };
await refresh();
check(await input('Commit interval').inputValue() === '' && await input('Commit interval').getAttribute('placeholder') === 'default: 24h' && await input('Refresh interval').getAttribute('placeholder') === 'default: 30s' && await input('Database directory').getAttribute('placeholder') === 'default: /var/lib/nlbwmon' && await input('Accounting period').getAttribute('placeholder') === 'default: 1' && await input('Entry limit').getAttribute('placeholder') === 'default: 10000' && await input('Netlink buffer').getAttribute('placeholder') === 'default: 524288', 'an option that is not in the file is empty and shows its default as a placeholder');
check(await input('Compress the database files').isChecked() && /^The counters of open connections are read every 30 seconds/.test(await effect('Refresh interval')) && /^4 finished periods stored/.test(await effect('Periods to keep')), 'the defaults also drive the switches and the effect lines');
mock.cfg = baseCfg();
mock.daemon = { running: true, pid: 8345, command: commandFor(mock.cfg) };
await refresh();
//#endregion

//#region Validation
console.log('\n== validation ==');
// Types `value` into the field `label`, then returns the number of errors the banner shows and whether Save is disabled.
const tryValue = async (label, value) => { await input(label).fill(value); await page.waitForTimeout(80); return { errors: await errorCount(), disabled: await saveBtn().isDisabled(), invalid: await input(label).evaluate(e => e.classList.contains('is-invalid')) }; };
// Restores a field to the router's value.
const restoreValue = async (label, value) => { await input(label).fill(value); await page.waitForTimeout(80); };
let t = await tryValue('Commit interval', '25d');
check(t.errors === 1 && t.disabled && t.invalid && /Commit interval is too long: nlbwmon accepts at most 24 days \(2147483 seconds\)\./.test(await banner()), 'an interval over 24 days is an error, marks the field and blocks Save', await banner());
check(await bar().evaluate(e => e.classList.contains('invalid')) && await page.locator('.set-bar .set-bar-head b').innerText() === '1 unsaved change', 'the banner turns red and counts the edit');
t = await tryValue('Commit interval', '10x');
check(/must be a number with w, d, h, m or s/.test(await banner()) && t.errors === 1, 'a bad unit is explained');
await restoreValue('Commit interval', '24h');
check(await bar().isHidden(), 'putting the value back clears the banner');
for (const [label, bad, text] of [
  ['Refresh interval', '0', /must be at least 1 second/],
  ['Netlink buffer', '1000', /must be at least 32768 bytes/],
  ['Netlink buffer', 'big', /must be a number of bytes, optionally with a K or M suffix/],
  ['Accounting period', '0', /must be a day of the month/],
  ['Accounting period', '2026-02-30/14', /has a date that does not exist/],
  ['Periods to keep', '1001', /must be at most 1000/],
  ['Periods to keep', 'x', /must be a whole number/],
  ['Entry limit', '-5', /must be a whole number/],
  ['Database directory', 'relative/dir', /must be an absolute path starting with \//],
  ['Database directory', '/proc/nlbw', /read-only or special filesystem/],
  ['Database directory', '/a b', /may only contain letters, digits/],
  ['Database directory', '/a/../b', /must not contain a "\.\." part/],
  ['Protocol file', 'protocols', /must be an absolute path/],
]) {
  t = await tryValue(label, bad);
  check(t.errors === 1 && t.disabled && t.invalid && text.test(await banner()), `${label}: "${bad}" is refused`, `${t.errors} ${await banner()}`);
  await restoreValue(label, values[label]);
}
check(await bar().isHidden(), 'every field is back to the router\'s value');
// Types `v` as the second row of the networks list.
const row = async v => { await field('Local networks').locator('.set-list input').nth(1).fill(v); await page.waitForTimeout(80); };
await row('lan-1');
check(await errorCount() === 1 && /Local networks: "lan-1" is not a network name/.test(await banner()) && await field('Local networks').locator('.set-list input').nth(1).evaluate(e => e.classList.contains('is-invalid')) && !(await field('Local networks').locator('.set-list input').nth(0).evaluate(e => e.classList.contains('is-invalid'))), 'a bad network is refused and only its row is marked', await banner());
await row('192.168.1.0/33');
check(/is not an IPv4 or IPv6 address with an optional prefix length or mask/.test(await banner()), 'a prefix that is too long is refused');
await row('wan');
check(await errorCount() === 1 && /"wan" is listed twice/.test(await banner()), 'a repeated network is refused');
await row('guest');
check(await errorCount() === 0 && /guest is not a network of this router \(it has lan, wan, wan6\)/.test(await banner()) && !(await saveBtn().isDisabled()), 'a network the router does not have is only a warning, so Save stays enabled', await banner());
await row('lan');
check(await bar().isHidden(), 'the list is back to the router\'s');
await page.locator('.nlbw-form').getByRole('button', { name: 'Add a network' }).click();
await page.waitForTimeout(200);
check(await field('Local networks').locator('.set-list input').count() === 5 && await field('Local networks').locator('.set-list input').nth(4).inputValue() === '', 'Add a network adds an empty row');
await field('Local networks').locator('.set-list input').nth(4).fill('10.9.0.0/16');
await page.waitForTimeout(100);
check(await errorCount() === 0 && /Local networks: 192\.168\.1\.0\/24, lan, wan, wan6 → 192\.168\.1\.0\/24, lan, wan, wan6, 10\.9\.0\.0\/16/.test(await changes()), 'the new row is a change in the review list', await changes());
await field('Local networks').locator('.set-row button').nth(4).click();
await page.waitForTimeout(200);
check(await field('Local networks').locator('.set-list input').count() === 4 && await bar().isHidden(), 'removing the row removes the change');
//#endregion

//#region Effects and warnings
console.log('\n== effects and warnings ==');
await input('Periods to keep').fill('3');
await page.waitForTimeout(100);
check(/^4 finished periods stored .* The next start deletes 2026-08-01, 2026-07-01\.$/.test(await effect('Periods to keep')) && await field('Periods to keep').locator('.nlbw-effect.warn').count() === 1, 'keeping 3 periods says which stored periods the next start deletes', await effect('Periods to keep'));
check(/When nlbwmon restarts \(it does when you save\) it deletes the stored periods 2026-08-01, 2026-07-01\. That cannot be undone\./.test(await banner()) && !(await saveBtn().isDisabled()), 'the banner warns about the data that goes', await banner());
await input('Periods to keep').fill('0');
await page.waitForTimeout(100);
check(/Nothing is ever deleted/.test(await effect('Periods to keep')) && /kept forever/.test(await banner()), '0 keeps every period and warns that the directory grows');
await restoreValue('Periods to keep', '10');
await input('Accounting period').fill('15');
await page.waitForTimeout(100);
check(await effect('Accounting period') === 'The running period would be 2026-10-15 to 2026-11-14 (day 31 of 31); the next one starts 2026-11-15.' && /moves the boundaries/.test(await banner()), 'another day of the month: the new window, and a warning about the stored periods', await effect('Accounting period'));
await input('Accounting period').fill('2026-11-01/14');
await page.waitForTimeout(100);
check(/Every 14 days|The running period would be 2026-11-01 to 2026-11-14 \(day 14 of 14\)/.test(await effect('Accounting period')) && /from a day of the month to a fixed number of days/.test(await banner()), 'every 14 days from a date: the window and the kind-change warning', await effect('Accounting period'));
await restoreValue('Accounting period', '1');
await input('Commit interval').fill('5m');
await page.waitForTimeout(100);
check(/^Written every 5 minutes: 288 times a day\./.test(await effect('Commit interval')) && (await banner()) === '', 'a short commit interval is fine while the database is in RAM (no warning)', await banner());
await restoreValue('Commit interval', '24h');
await input('Entry limit').fill('0');
await page.waitForTimeout(100);
check(await effect('Entry limit') === 'No limit: the database grows with the variety of traffic.' && /grows with the variety of traffic and can use a lot of RAM/.test(await banner()), 'no limit is explained and warned about');
await input('Entry limit').fill('300');
await page.waitForTimeout(100);
check(/roughly 29\.3 KiB of RAM when full/.test(await effect('Entry limit')) && /overwrites the oldest entries early/.test(await banner()), 'a very small limit warns');
await restoreValue('Entry limit', '10000');
await input('Reserve the memory for the whole limit').check();
await input('Entry limit').fill('0');
await page.waitForTimeout(100);
check(/no effect without an entry limit/.test(await banner()), 'reserving memory without a limit says it does nothing');
await input('Reserve the memory for the whole limit').uncheck();
await restoreValue('Entry limit', '10000');
await input('Netlink buffer').fill('64k');
await page.waitForTimeout(100);
check(await effect('Netlink buffer') === '65536 bytes = 64.0 KiB.' && /under 128 KiB/.test(await banner()), 'a size with a suffix is shown in bytes, and a small buffer warns');
await restoreValue('Netlink buffer', '524288');
await input('Refresh interval').fill('2s');
await page.waitForTimeout(100);
check(/costs CPU time/.test(await banner()), 'a very short refresh interval warns');
await restoreValue('Refresh interval', '30s');
check(await bar().isHidden(), 'all edits are undone');

console.log('\n== typed paths are checked by the router ==');
mock.probes = [];
await input('Database directory').fill('/mnt/usb/nlbw');
await page.waitForTimeout(100);
check(await effect('Database directory') === 'Checking where this directory is…' && mock.probes.length === 0, 'while typing, the page waits for a pause before it asks');
await page.waitForFunction(() => /ext4/.test(document.querySelector('.nlbw-form').innerText), null, { timeout: 5000 });
check(mock.probes.join() === '{"dir":"/mnt/usb/nlbw"}', 'then it asks once, for that directory only', mock.probes.join());
check(/^The directory does not exist yet: nlbwmon creates it\. On ext4 on \/dev\/sda1 \(mounted at \/mnt\/usb\): storage of its own/.test(await effect('Database directory')) && await field('Database directory').locator('.nlbw-effect.warn').count() === 0, 'a new directory on a USB disk: it will be created, and the storage is described', await effect('Database directory'));
check(/Nothing is moved: the periods already stored stay in \/var\/lib\/nlbwmon, and the running period starts again from zero in \/mnt\/usb\/nlbw\./.test(await banner()) && await errorCount() === 0, 'changing the directory warns that the existing data stays in the old one', await banner());
await input('Database directory').fill('/mnt/ro/nlbw');
await page.waitForFunction(() => /read-only filesystem/.test(document.querySelector('.set-bar')?.innerText ?? ''), null, { timeout: 5000 });
check(await errorCount() === 1 && await saveBtn().isDisabled() && /Database directory: \/mnt\/ro\/nlbw is on a read-only filesystem \(vfat\)/.test(await banner()), 'a directory on a read-only filesystem blocks Save', await banner());
await input('Database directory').fill('/etc/passwd');
await page.waitForFunction(() => /is not a directory, or is below a file/.test(document.querySelector('.set-bar')?.innerText ?? ''), null, { timeout: 5000 });
check(await errorCount() === 1 && await saveBtn().isDisabled(), 'a path that is a file blocks Save');
await input('Database directory').fill('/var/lib/nlbwmon');
await page.waitForTimeout(100);
const asked = mock.probes.length;
await input('Database directory').fill('/mnt/usb/nlbw');
await page.waitForTimeout(700);
check(mock.probes.length === asked && /ext4/.test(await effect('Database directory')), 'a path asked about before is not asked again', mock.probes.join());
await input('Database directory').fill('/rom/x');
await page.waitForTimeout(700);
check(mock.probes.length === asked && await errorCount() === 1, 'a path the page already refuses is not sent to the router');
await restoreValue('Database directory', '/var/lib/nlbwmon');
await input('Protocol file').fill('/nope');
await page.waitForFunction(() => /does not exist, and nlbwmon does not start without it/.test(document.querySelector('.set-bar')?.innerText ?? ''), null, { timeout: 5000 });
check(await errorCount() === 1 && await saveBtn().isDisabled() && /Protocol file: \/nope does not exist/.test(await banner()), 'a protocol file that does not exist blocks Save', await banner());
await input('Protocol file').fill('/etc/shadow');
await page.waitForFunction(() => /cannot be read/.test(document.querySelector('.set-bar')?.innerText ?? ''), null, { timeout: 5000 });
check(await errorCount() === 1, 'a protocol file that cannot be read blocks Save');
await input('Protocol file').fill('/etc/nlbwmon/protocols');
await page.waitForFunction(() => /File found/.test(document.querySelector('.nlbw-form').innerText), null, { timeout: 5000 });
check(await errorCount() === 0 && /will not start if \/etc\/nlbwmon\/protocols is missing or unreadable/.test(await banner()) && /^File found \(606 bytes\)\.$/.test(await effect('Protocol file')), 'a file that is there is fine; the warning says nlbwmon needs it', await banner());
await restoreValue('Protocol file', '/usr/share/nlbwmon/protocols');
check(await bar().isHidden(), 'all edits are undone');
//#endregion

//#region Saving
console.log('\n== saving ==');
await fresh();
await input('Commit interval').fill('12h');
await input('Periods to keep').fill('8');
await input('Netlink buffer').fill('1M');
await input('Compress the database files').uncheck();
await page.locator('.nlbw-form').getByRole('button', { name: 'Add a network' }).click();
await field('Local networks').locator('.set-list input').nth(4).fill('10.9.0.0/16');
await page.waitForTimeout(150);
check(await page.locator('.set-bar-head b').innerText() === '5 unsaved changes' && !(await saveBtn().isDisabled()), 'the banner counts the edits and Save is on');
const review = await changes();
check(/Commit interval: 24h → 12h/.test(review) && /Periods to keep: 10 → 8/.test(review) && /Netlink buffer: 524288 → 1048576/.test(review) && /Compress the database files: on → off/.test(review) && /Local networks: .* → .*10\.9\.0\.0\/16/.test(review), 'the review lists every change from what to what (a size in bytes)', review);
await shot('mock-edited');
check(JSON.stringify(mock.cfg) === JSON.stringify(baseCfg()) && mock.staged.length === 0, 'nothing is staged or written before Save');
mock.calls = [];
await saveBtn().click();
const saved = await outcome();
check(/^Saved: the router applied the change and it was confirmed\.$/.test(saved), 'saving applies, verifies and confirms', saved);
check(mock.calls.includes('uci.apply') && mock.calls.includes('uci.confirm') && !mock.calls.includes('uci.rollback') && mock.calls.filter(c => c === 'service.list').length >= 2, 'the page applied, looked at the daemon at least twice, and confirmed', mock.calls.join(' '));
check(mock.log.length === 1 && mock.log[0] === 'set {"local_network":["192.168.1.0/24","lan","wan","wan6","10.9.0.0/16"],"database_generations":"8","commit_interval":"12h","database_compress":"0","netlink_buffer_size":"1048576"}', 'only the changed options were written, a size in bytes, a switch as 0', mock.log.join('\n'));
const kept = mock.cfg.cfg0;
check(kept.commit_interval === '12h' && kept.netlink_buffer_size === '1048576' && kept.database_compress === '0' && kept.database_generations === '8' && kept.local_network.length === 5 && kept.database_limit === '10000', 'the router holds the new settings and left the others alone');
check(mock.daemon.command.join(' ').includes('-i 12h') && mock.daemon.command.includes('-b') && mock.daemon.pid >= 9000 && !mock.daemon.command.includes('-Z'), 'the daemon was restarted with them');
check(await input('Commit interval').inputValue() === '12h' && await bar().locator('.set-outcome.ok').count() === 1 && await saveBtn().isHidden(), 'the page shows the saved values, with the outcome and nothing left to save');
await page.waitForTimeout(500);
await page.click('.set-bar button[title="Dismiss"]');
check(await bar().isHidden(), 'the outcome can be dismissed');
await shot('mock-saved');

console.log('\n== removing an option ==');
await input('Commit interval').fill('');
await input('Entry limit').fill('');
await page.waitForTimeout(100);
check(/Commit interval: 12h → default/.test(await changes()), 'an emptied option goes back to its default in the review');
mock.log = [];
await saveBtn().click();
check(/^Saved/.test(await outcome()) && mock.log.join() === 'delete ["commit_interval","database_limit"]' && mock.cfg.cfg0.commit_interval === undefined && mock.cfg.cfg0.database_limit === undefined, 'the options are deleted, not set to an empty string', mock.log.join());
check(await input('Commit interval').getAttribute('placeholder') === 'default: 24h' && await input('Commit interval').inputValue() === '', 'and the form shows the default again');

console.log('\n== the daemon was not running before ==');
await fresh();
mock.daemon = { running: false, pid: null, command: [] };
mock.mode = 'down';
await refresh();
await input('Commit interval').fill('12h');
await page.waitForTimeout(100);
check(await tile(0) === 'Stopped' && /nothing is being counted/.test(await tileSub(0)) && /nlbwmon is not running now/.test(await banner()), 'a stopped daemon is shown, and noted when editing', await banner());
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'a change saves although there is no daemon to check', await bar().innerText());
//#endregion

//#region A change the router does not keep, or cannot run
console.log('\n== a change the router does not keep ==');
await fresh();
mock.dropWrites = true;
await input('Commit interval').fill('6h');
mock.calls = [];
await saveBtn().click();
let lost = await outcome();
check(/^The change was rolled back: Commit interval was not saved/.test(lost), 'a change that does not read back is rolled back and named', lost);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && mock.staged.length === 0 && mock.cfg.cfg0.commit_interval === '24h', 'rollback is called, confirm is not, nothing stays staged, and the router is unchanged', mock.calls.join(' '));
mock.dropWrites = false;
check(await input('Commit interval').inputValue() === '6h', 'the edit is still in the form');
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(700);
check(await bar().isHidden() && await input('Commit interval').inputValue() === '24h', 'Discard edits returns to what the router has');

console.log('\n== a change that stops nlbwmon ==');
await fresh();
mock.mode = 'down';
await input('Commit interval').fill('6h');
mock.calls = [];
await saveBtn().click();
lost = await outcome();
check(/^The change was rolled back: nlbwmon is not running with the new settings: it stopped or could not start$/.test(lost), 'a change after which nlbwmon is not running is rolled back', lost);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && mock.cfg.cfg0.commit_interval === '24h' && mock.daemon.running && mock.daemon.command.includes('24h') && mock.staged.length === 0, 'the old config is back and the daemon runs on it', `${mock.calls.join(' ')} ${mock.daemon.running}`);

console.log('\n== a daemon that keeps the old settings ==');
await fresh();
mock.mode = 'stale';
await input('Entry limit').fill('5000');
await saveBtn().click();
lost = await outcome();
check(/^The change was rolled back: nlbwmon is running with other settings than the saved ones \(Entry limit: 10000\)$/.test(lost), 'a daemon that does not pick up the change is rolled back, naming the option', lost);

console.log('\n== a daemon that keeps restarting ==');
await fresh();
mock.mode = 'flap';
await input('Entry limit').fill('5000');
await saveBtn().click();
lost = await outcome();
check(/^The change was rolled back: nlbwmon does not stay running with the new settings$/.test(lost), 'a daemon that crashes and restarts over and over is rolled back', lost);
mock.mode = 'follow';

console.log('\n== a confirmation the router refuses ==');
await fresh();
mock.confirmFails = true;
await input('Commit interval').fill('6h');
await saveBtn().click();
lost = await outcome();
check(/^The router did not accept the confirmation, so the change was rolled back/.test(lost) && mock.cfg.cfg0.commit_interval === '24h' && mock.staged.length === 0, 'a refused confirmation is a rollback', lost);
//#endregion

//#region Other states
console.log('\n== leftovers from an earlier attempt ==');
await fresh();
mock.staged = [['set', 'cfg0', 'commit_interval', '1h']];
await refresh();
check(/1 change\(s\) are already staged/.test(await page.locator('main').innerText()), 'staged changes in the session are shown');
await page.click('button:has-text("Discard them")');
await page.waitForTimeout(900);
check(mock.staged.length === 0 && !/already staged/.test(await page.locator('main').innerText()), 'Discard them clears the session\'s staging area');

console.log('\n== the daemon differs from the file ==');
await fresh();
mock.daemon = { running: true, pid: 8345, command: commandFor({ cfg0: { ...baseCfg().cfg0, database_limit: '5000' } }) };
await refresh();
check(await tileSub(0) === 'process 8345 · runs with other settings than the file (Entry limit)' && /nlbwmon is running with settings that differ from the saved ones \(Entry limit: running 5000, saved 10000\)/.test(await page.locator('main').innerText()), 'a daemon on other settings than the file is noted', await tileSub(0));

console.log('\n== no section, no nlbwmon, no plugin ==');
await fresh();
mock.cfg = {};
await refresh();
check(/no nlbwmon section; saving creates one/.test(await page.locator('main').innerText()), 'a config without a section says so');
await input('Commit interval').fill('1h');
mock.log = [];
await saveBtn().click();
check(/^Saved/.test(await outcome()) && mock.log[0] === 'add {"commit_interval":"1h"}' && mock.cfg.cfg9?.commit_interval === '1h', 'saving adds the section with the edited option', mock.log.join());
await fresh();
mock.noConfig = true;
mock.nlbw = false;
await refresh();
check(/nlbwmon is not installed on this router/.test(await page.locator('main').innerText()) && await page.locator('.nlbw-form').count() === 0 && await page.locator('.set-note.bad').count() === 0, 'a router without nlbwmon gets a note, not an error or a form', await page.locator('main').innerText());
mock.nlbw = true;
await refresh();
check(/cannot be read/.test(await page.locator('main').innerText()), 'a config that cannot be read although nlbwmon is installed says so');
mock.noConfig = false;
mock.noPlugin = true;
await refresh();
await page.waitForSelector('.tr-live', { timeout: 10000 });
check(await page.locator('.seg-tab:visible').count() === 0 && await page.locator('.tr-live').count() === 1 && await page.locator('.nlbw-form').count() === 0, 'without the plugin the Settings tab is not offered: the page falls back to the Live tab, the only one');
mock.noPlugin = false;

console.log('\n== unsaved edits survive a tab change and stop the polling ==');
await fresh();
await input('Commit interval').fill('6h');
await page.locator('.seg-tab', { hasText: 'Live' }).click();
await page.waitForSelector('.tr-live');
check(!(await bar().isHidden()) && /Commit interval/.test(await bar().innerText()), 'the banner keeps the unsaved change on another tab');
await page.locator('.seg-tab', { hasText: 'Settings' }).click();
await page.waitForSelector('.nlbw-form');
check(await input('Commit interval').inputValue() === '6h', 'and the edit is still in the form when coming back');
mock.calls = [];
await page.waitForTimeout(7000);
check(!mock.calls.includes('uci.get') && !mock.calls.includes('service.list'), 'the tab does not poll over unsaved edits', mock.calls.join(' '));
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(700);

console.log('\n== a login that may not write ==');
await fresh({ ubus: { system: ['board', 'info'], service: ['list'], 'network.interface': ['dump'], 'flab.network': ['status'], 'flab.traffic': ['status', 'connections', 'usage_periods', 'usage', 'nlbwmon_paths'], uci: ['get', 'changes'] } });
check(/not allowed to change the configuration/.test(await page.locator('main').innerText()) && await input('Commit interval').isDisabled() && await input('Compress the database files').isDisabled() && await page.locator('.nlbw-form').getByRole('button', { name: 'Add a network' }).isDisabled() && await field('Local networks').locator('.set-list input').first().isDisabled(), 'every control is disabled and the page says why');
check(/^Written every 1 day/.test(await effect('Commit interval')) && await tile(0) === 'Running', 'but everything can still be read');

console.log('\n== theme ==');
await fresh();
await input('Database directory').fill('/mnt/usb/nlbw');
await page.waitForTimeout(900);
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(300);
await shot('dark');
await page.emulateMedia({ colorScheme: 'light' });

console.log('\n== the session expires ==');
await fresh();
await input('Commit interval').fill('6h');
mock.expired = true;
// A poll may notice the expiry before the click lands; either way the sign-in screen must appear.
await saveBtn().click({ timeout: 5000 }).catch(() => {});
await page.waitForSelector('.login-form', { timeout: 20000 });
check(/Session expired/.test(await page.locator('.login-error').innerText()), 'an expired session returns to the sign-in screen');
//#endregion

check(mock.unsafe.length === 0, 'no uci write reached the real router', mock.unsafe.join());
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${passed} nlbwmon settings browser checks passed`);
process.exit(failed ? 1 : 0);
