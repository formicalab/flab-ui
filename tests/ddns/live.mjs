// Browser test for the Dynamic DNS page. A real browser opens the deployed UI.
// 1. Against the real router, read only: the page shows the router's own services, and every uci write and every action on the
//    updater it might send in this phase is blocked and fails the test.
// 2. Against mocked flab.ddns replies and a stateful mock of rpcd's `uci` object: the status of every kind of service, the
//    actions and the log, and the whole editing flow - validation, the write-only password, adding and removing services,
//    saving, a change the router does not keep, a login that may not write, a missing plugin, an expired session - WITHOUT
//    touching the router's configuration or its updater.
// Usage: node live.mjs   (env: FLAB_SID and FLAB_ACLS from tests/TestSession.ps1, FLAB_URL, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import path from 'node:path';

const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID;
const rootAcls = JSON.parse(process.env.FLAB_ACLS);   // what the session may call, like the ACLs of a real sign-in
const shots = process.env.FLAB_SHOTS;

let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));

//#region The mock router
const SECRET = 'mock-secret-value-1234';
const TYPED = 'typed-new-pass-9876';
const WRITES = ['set', 'add', 'delete', 'apply', 'confirm', 'rollback', 'revert', 'commit', 'order', 'rename'];
const SECRET_KEYS = ['password', 'api_token'];

// The ddns config of the mock router: a global section and four services in four states.
const baseCfg = () => ({
  global: { '.type': 'ddns', ddns_loglines: '250' },
  home: { '.type': 'service', service_name: 'dyn.example', enabled: '1', lookup_host: 'home.example.com', domain: 'home.example.com', username: 'me', password: SECRET, ip_source: 'network', ip_network: 'wan', check_interval: '5', check_unit: 'minutes', force_interval: '72', force_unit: 'hours', odd_option: 'x' },
  v6: { '.type': 'service', service_name: 'duckdns.example', enabled: '1', lookup_host: 'v6.example.com', domain: 'v6', password: SECRET, use_ipv6: '1', ip_source: 'interface', ip_interface: 'eth1' },
  custom: { '.type': 'service', enabled: '1', update_url: 'http://u.example.com/?h=[DOMAIN]', ip_source: 'web', ip_url: 'http://ip.example.com', lookup_host: 'c.example.com', domain: 'c.example.com' },
  off: { '.type': 'service', enabled: '0', service_name: 'old.example', lookup_host: 'off.example.com' },
});
const PROVIDERS = [
  { name: 'dyn.example', ipv6: true, needs: ['DOMAIN', 'USERNAME', 'PASSWORD'], script: null, available: true, source: 'default' },
  { name: 'duckdns.example', ipv6: true, needs: ['DOMAIN', 'PASSWORD'], script: null, available: true, source: 'default' },
  { name: 'old.example', ipv6: false, needs: ['DOMAIN', 'USERNAME', 'PASSWORD'], script: null, available: true, source: 'default' },
];
const mock = { on: false, cfg: baseCfg(), staged: [], restage: [], snapshot: null, calls: [], controls: [], dropWrites: false, confirmFails: false, expired: false, noPlugin: false, installed: true, running: true, controlFails: false, reads: [], unsafe: [] };
let nextId = 1;
// The log the mock gives for any service: a routine line, a note, a warning, an error and a debug line.
const LOG = [' 100000  info : Rerun IP check at 2026-11-13 10:05', ' 100001  note : Starting main loop at 100001', ' 100002  WARN : Transfer failed - retry 1/0 in 30 seconds', ' 100003 ERROR : bad credentials for the account', ' 100004      : Detected IP: 203.0.113.7'].join('\n') + '\n';

// What the runtime of each mock service looks like, against the time `now`.
function runtime(name, now) {
  const base = { detected_ip: null, error: null, last_update: null, local_ip: null, log: true, next_check: null, pid: null, problem: null, registered_ip: null, running: false, terminated: null };
  if (name === 'home') return { ...base, running: true, pid: 4000, registered_ip: '203.0.113.7', local_ip: '203.0.113.7', detected_ip: '203.0.113.7', last_update: now - 600, next_check: now + 40 };
  if (name === 'v6') return { ...base, running: true, pid: 4001, registered_ip: '2001:db8::4', local_ip: '2001:db8::5', last_update: now - 7200, next_check: now + 100, problem: { level: 'ERROR', time: '100003', text: 'IP update not accepted by DDNS Provider: bad credentials' } };
  if (name === 'custom') return { ...base, detected_ip: '198.51.100.9', terminated: 'No valid certificate(s) found for HTTPS communication', problem: { level: 'ERROR', time: '100003', text: 'No valid certificate(s) found' } };
  return { ...base, log: false };
}

// The reply of flab.ddns status for the mock's config (secrets are only flagged, never returned).
function status() {
  const now = Math.floor(Date.now() / 1000);
  const services = Object.entries(mock.cfg).filter(([, s]) => s['.type'] === 'service').map(([name, s]) => ({
    section: name,
    values: Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith('.') && !SECRET_KEYS.includes(k))),
    secrets: Object.fromEntries(SECRET_KEYS.filter(k => s[k]).map(k => [k, true])),
    runtime: runtime(name, now),
  }));
  return {
    installed: mock.installed, version: '2.8.4-12', running: mock.running, at_boot: true, uptime: 5000, generated: now, rundir: '/var/run/ddns', logdir: '/var/log/ddns',     ca: '/etc/ssl/certs/ca-certificates.crt',
    global: { section: mock.cfg.global ? 'global' : null, values: Object.fromEntries(Object.entries(mock.cfg.global ?? {}).filter(([k]) => !k.startsWith('.'))) },
    services, providers: PROVIDERS, networks: ['lan', 'wan', 'wan6'], devices: ['br-lan', 'eth0', 'eth1'], tools: { curl: true, wget: false, uclient_fetch: true, host: false },
  };
}

// Applies the staged edits to the mock's config, the way rpcd's uci apply does.
function commit() {
  for (const [op, section, option, value] of mock.staged) {
    if (op === 'set') mock.cfg[section][option] = value;
    else if (op === 'delete') (option ? delete mock.cfg[section][option] : delete mock.cfg[section]);
    else if (op === 'add') mock.cfg[section] = { '.type': option, ...value };
  }
}
// What a rollback or a failed confirmation puts back.
const restore = () => { mock.cfg = mock.snapshot; mock.staged = mock.restage; mock.snapshot = null; };

// One uci method of the mock: [ubus status, data].
function uci(method, args) {
  if (method === 'get') { mock.reads.push(`${args.config}`); return [6]; }
  if (method === 'changes') {
    const list = args.config && args.config !== 'ddns' ? [] : mock.staged.map(c => c.slice(0, 4));
    return [0, { changes: args.config ? list : (list.length ? { ddns: list } : {}) }];
  }
  if (method === 'set') { for (const [k, v] of Object.entries(args.values)) mock.staged.push(['set', args.section, k, v]); return [0, {}]; }
  if (method === 'add') {
    const name = args.name ?? `cfg${100 + nextId++}`;
    mock.staged.push(['add', name, args.type, args.values ?? {}]);
    return [0, { section: name }];
  }
  if (method === 'delete') { for (const o of args.options ?? [undefined]) mock.staged.push(['delete', args.section, o, undefined]); return [0, {}]; }
  if (method === 'revert') { if (args.config !== 'ddns') return [4]; mock.staged = []; return [0, {}]; }
  if (method === 'apply') {
    mock.snapshot = clone(mock.cfg);
    mock.restage = mock.staged;
    if (!mock.dropWrites) commit();
    mock.staged = [];
    return [0, {}];
  }
  if (method === 'confirm') {
    if (!mock.snapshot) return [5];
    if (mock.confirmFails) { restore(); return [1]; }
    mock.snapshot = null;
    return [0, {}];
  }
  if (method === 'rollback') {
    if (!mock.snapshot) return [5];
    restore();
    return [0, {}];
  }
  return [0, {}];
}

// The JSON-RPC answer for a request the mock handles, or null to let it through to the real router.
function answer(body) {
  const [, obj, method, args] = body.params;
  // Wraps a ubus status code and optional data as a JSON-RPC result.
  const ok = ([code, data]) => ({ jsonrpc: '2.0', id: body.id, result: data === undefined ? [code] : [code, data] });
  const denied = { jsonrpc: '2.0', id: body.id, error: { code: -32002, message: 'Access denied' } };

  if (!mock.on) {
    // Real router: reads only. A write or an action would change something, so it is blocked and the test fails.
    if ((obj === 'uci' && WRITES.includes(method)) || (obj === 'flab.ddns' && method === 'control')) { mock.unsafe.push(`${obj}.${method}`); return ok([6]); }
    if (obj === 'uci' && method === 'get') mock.reads.push(`real:${args.config}`);
    return null;
  }
  if (mock.expired && ['uci', 'flab.ddns', 'system', 'service', 'session'].includes(obj)) return denied;
  if (obj === 'uci') { mock.calls.push(`uci.${method}`); return ok(uci(method, args)); }
  if (obj === 'flab.ddns') {
    if (mock.noPlugin) return ok([4]);
    if (method === 'status') return ok([0, status()]);
    if (method === 'log') return ok([0, { ok: true, section: args.section, exists: true, text: LOG, truncated: false }]);
    if (method === 'control') {
      mock.controls.push(`${args.section}:${args.action}`);
      return ok([0, mock.controlFails ? { ok: false, code: 1, output: 'Failed to start: bad config', error: 'The init script failed (exit code 1).', section: args.section, action: args.action } : { ok: true, code: 0, output: '', error: null, section: args.section, action: args.action }]);
    }
  }
  if (obj === 'system' && method === 'board') return ok([0, { hostname: 'openwrt', model: 'GL.iNet GL-MT6000' }]);
  return null;
}
//#endregion

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
const errors = [];
await ctx.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const reply = body ? answer(body) : null;
  return reply ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) }) : route.continue();
});
// Opens the Dynamic DNS page with a session in sessionStorage, the way a real sign-in leaves the tab.
const open = async acls => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(([id, a]) => {
    sessionStorage.setItem('sid', id);
    sessionStorage.setItem('acls', JSON.stringify(a));
  }, [sid, acls ?? rootAcls]);
  await p.goto(`${baseUrl}#ddns`);
  await p.waitForSelector('.ddns-form, main .set-note, .login-form', { timeout: 20000 });
  return p;
};
let page = await open();

// Helpers: tiles, service cards and their parts, the banner, and screenshots.
const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
// The small text under the value of tile number `i`.
const tileSub = async i => (await page.locator('.tile .sub').nth(i).innerText()).trim();
// The card of the service called `name`.
const svc = name => page.locator('.card').filter({ has: page.locator(`.card-header span:text-is("${name}")`) });
// The form field (or checkbox) labeled `label` within `scope`.
const field = (scope, label) => scope.locator('.set-field, .set-check').filter({ has: page.locator('label', { hasText: new RegExp(`^\\s*${label}\\s*$`) }) }).first();
// The input of that field.
const input = (scope, label) => field(scope, label).locator('input, select').first();
// All the notes under the form, joined into one string.
const notes = () => page.locator('.set-notes .set-note').allInnerTexts().then(t => t.join(' | '));
// How many error notes the form shows.
const errorCount = () => page.locator('.set-notes .set-note.bad').count();
// The save bar.
const bar = () => page.locator('.set-bar');
// The "Save and apply" button.
const saveBtn = () => page.locator('button:has-text("Save and apply")');
// The text of the review of pending changes.
const changes = () => page.locator('.set-changes').evaluate(e => e.textContent);
// Saves a full-page screenshot named after `label`, when a screenshot folder is set.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `ddns-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Waits for the save bar to report the result of a save and returns its text.
const outcome = async () => { const n = page.locator('.set-bar .set-outcome.ok, .set-bar .set-outcome.bad').first(); await n.waitFor({ timeout: 20000 }); return (await n.innerText()).trim(); };
// Clicks Refresh and gives the page a moment to redraw.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };

//#region Navigation and the real router (read only)
console.log('== navigation ==');
const nav = (await page.locator('.nav-pane a.nav-link-fl').allInnerTexts()).map(t => t.trim());
check(!nav.includes('Dynamic DNS') && nav.includes('DNS'), 'Dynamic DNS is part of the DNS navigation entry', nav.join(' | '));
check((await page.locator('.cmdbar h1').innerText()).trim() === 'DNS', 'the combined page title');
check((await page.getByRole('tab', { name: 'Dynamic DNS' }).getAttribute('aria-selected')) === 'true', 'the compatibility route selects Dynamic DNS');

console.log('\n== the real router (read only, nothing is written or run) ==');
const real = await page.evaluate(async () => {
  const sid = sessionStorage.getItem('sid');
  const r = (await (await fetch('/ubus', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [sid, 'flab.ddns', 'status', {}] }) })).json()).result[1];
  return { sections: r.services.map(s => s.section), secrets: r.services.map(s => Boolean(s.secrets.password)), running: r.running };
});
check(real.sections.length >= 1 && await page.locator('.ddns-form .card').count() === real.sections.length + 1, 'every service of the router has a card, plus the global settings', JSON.stringify(real));
check(await tile(0) === (real.running ? 'Running' : 'Stopped') && await saveBtn().isDisabled() && await bar().isHidden(), 'the updater state is shown, and nothing is pending');
const pw = page.locator('.ddns-form input[type=password]');
check(await pw.count() === real.secrets.filter(Boolean).length + real.secrets.filter(s => !s).length && await pw.evaluateAll(els => els.every(e => e.value === '')), 'a stored password is never shown: every password box is empty');
check(real.secrets.every(s => !s) || (await pw.evaluateAll(els => els.some(e => /stored; leave empty/.test(e.placeholder)))), 'a box says when a password is stored');
await shot('real');
//#endregion

//#region Mock: reading
mock.on = true;
await page.reload();
await page.waitForSelector('.ddns-form');
console.log('\n== reading (mock router) ==');
check(await tile(0) === 'Running' && /2 of 3 services enabled running · starts at boot/.test(await tileSub(0)), 'tile: the updater runs 2 of the 3 enabled services', `${await tile(0)} | ${await tileSub(0)}`);
check(await tile(1) === '1 of 3' && /2 services with a problem/.test(await tileSub(1)), 'tile: 1 of 3 up to date, 2 with a problem', `${await tile(1)} | ${await tileSub(1)}`);
check(/ago/.test(await tile(2)) && /sent for home/.test(await tileSub(2)) && /^in \d+s$/.test(await tile(3)), 'tiles: the last update and the next check', `${await tile(2)} | ${await tileSub(2)} | ${await tile(3)}`);
// The verdict heading of the card of service `n`.
const verdict = async n => (await svc(n).locator('.ddns-verdict strong').innerText()).trim();
check(await verdict('home') === 'Up to date' && await verdict('v6') === 'Problem' && await verdict('custom') === 'Not running' && await verdict('off') === 'Disabled', 'each service has its verdict', [await verdict('home'), await verdict('v6'), await verdict('custom'), await verdict('off')].join());
const homeStatus = await svc('home').locator('.ddns-status').innerText();
check(/203\.0\.113\.7[\s\S]*from network wan/.test(homeStatus) && /5 minutes/.test(homeStatus) && /process 4000/.test(homeStatus), 'the status block has the addresses, where the address comes from, the intervals and the process', homeStatus);
check(/2001:db8::5[\s\S]*device eth1/.test(await svc('v6').locator('.ddns-status').innerText()) && /bad credentials/.test(await svc('v6').locator('.ddns-verdict').innerText()), 'the IPv6 service reads its device, and its error is quoted');
check(/The updater stopped: No valid certificate/.test(await svc('custom').locator('.ddns-verdict').innerText()), 'a service that stopped on a fatal error says why');
check(await svc('off').locator('.ddns-actions button:has-text("Check now")').isDisabled() && await svc('off').locator('.ddns-actions button:has-text("Force update")').isDisabled(), 'a disabled service cannot be checked or forced');
check(/odd_option/.test(await svc('home').locator('.ddns-extra').innerText()) && await svc('v6').locator('.ddns-extra').count() === 0, 'an option the page has no control for is listed read only');
const pwHome = input(svc('home'), 'Password or token');
check(await pwHome.getAttribute('type') === 'password' && await pwHome.inputValue() === '' && /stored; leave empty/.test(await pwHome.getAttribute('placeholder')) && !(await page.locator('main').innerHTML()).includes(SECRET), 'the stored password is not in the page: its box is empty, with a note that one is stored');
check(await input(svc('home'), 'Lookup host name').inputValue() === 'home.example.com' && await input(svc('home'), 'Provider').inputValue() === 'dyn.example', 'the options show their values');
check(await field(svc('custom'), 'Update address').count() === 1 && await field(svc('home'), 'Update address').count() === 0, 'the custom provider fields show only for a service without a provider');
const globalCard = page.locator('.card').filter({ has: page.locator('.card-header span:text-is("Global settings")') });
check(await globalCard.locator('.set-fields').first().isHidden(), 'the global settings start folded');
check(await bar().isHidden(), 'the banner is hidden while nothing is edited');
await shot('mock-base');
//#endregion

//#region Actions and the log
console.log('\n== actions on the updater ==');
await svc('home').locator('button:has-text("Check now")').click();
await page.waitForSelector('.ddns-busy');
check(/Restarting the updater/.test(await svc('home').locator('.ddns-busy').innerText()) && await svc('home').locator('button:has-text("Force update")').isDisabled() && mock.controls.join() === 'home:check', 'Check now restarts the updater of that service and shows it is busy, with the other buttons off', mock.controls.join());
await page.waitForSelector('.ddns-outcome.ok', { timeout: 10000 });
check(/restarted and is checking/.test(await svc('home').locator('.ddns-outcome').innerText()), 'and reports it');
await page.waitForSelector('.ddns-busy', { state: 'detached', timeout: 10000 });
await svc('home').locator('button:has-text("Force update")').click();
await page.waitForSelector('.ddns-outcome.ok', { timeout: 10000 });
check(mock.controls.join() === 'home:check,home:force' && /sending the address/.test(await svc('home').locator('.ddns-outcome').innerText()), 'Force update asks for a forced update');
mock.controlFails = true;
await page.waitForSelector('.ddns-busy', { state: 'detached', timeout: 10000 });
await svc('v6').locator('button:has-text("Check now")').click();
await page.waitForSelector('.ddns-outcome.bad', { timeout: 10000 });
check(/exit code 1.*Failed to start: bad config/.test(await svc('v6').locator('.ddns-outcome').innerText()), 'a failure is shown with the init script\'s output');
mock.controlFails = false;
await page.waitForSelector('.ddns-busy', { state: 'detached', timeout: 10000 });

console.log('\n== the log ==');
await svc('home').locator('button:has-text("Log")').click();
await svc('home').locator('.ddns-logbox').waitFor();
// The text of every line shown in the log panel of home.
const logLines = async () => svc('home').locator('.ddns-logline').allInnerTexts();
check((await logLines()).length === 3 && !(await logLines()).some(l => /Rerun IP check/.test(l)) && /Log of home/.test(await svc('home').locator('.ddns-log-head').innerText()), 'the log shows the lines that matter, without the routine "Rerun IP check" line', (await logLines()).join(' / '));
await svc('home').locator('.ddns-log-all input').check();
check((await logLines()).length === 5 && /Show every line \(5\)/.test(await svc('home').locator('.ddns-log-head').innerText()), 'Show every line shows all of them');
check(await svc('home').locator('.ddns-logbox').evaluate(e => e.scrollTop > 0 || e.scrollHeight <= e.clientHeight), 'the box is scrolled to the newest line');
await shot('mock-log');
await svc('home').locator('button:has-text("Hide log")').click();
check(await svc('home').locator('.ddns-log').count() === 0, 'Hide log closes the panel');
//#endregion

//#region Editing
console.log('\n== editing ==');
await input(svc('home'), 'Lookup host name').fill('bad host!');
check(/Lookup host name/.test(await notes()) && await saveBtn().isDisabled() && await input(svc('home'), 'Lookup host name').evaluate(e => e.classList.contains('is-invalid')), 'a bad host name is marked and blocks Save', await notes());
await input(svc('home'), 'Lookup host name').fill('home2.example.com');
check(await bar().isVisible() && /1 unsaved change/.test(await page.locator('.set-bar-summary').innerText()) && await saveBtn().isEnabled(), 'a valid edit shows the banner and enables Save');
await input(svc('home'), 'Password or token').fill(TYPED);
check(/2 unsaved changes/.test(await page.locator('.set-bar-summary').innerText()), 'typing a password is a change');
await input(svc('home'), 'Password or token').fill("it's a caffè \\ $");
check(/does not pass a single quote, a backslash or a non-ASCII character in a password through unchanged/.test(await page.locator('.set-bar').innerText()) && await saveBtn().isEnabled(), 'a single quote, a backslash or a non-ASCII character in a password is a warning that does not block Save');
await input(svc('home'), 'Password or token').fill("it's a $");
check(/does not pass a single quote/.test(await page.locator('.set-bar').innerText()), 'a quote alone is enough');
await input(svc('home'), 'Password or token').fill('plain$word');
check(!/does not pass/.test(await page.locator('.set-bar').innerText()) && await saveBtn().isEnabled(), 'and a $ is no problem');
await input(svc('home'), 'Password or token').fill(TYPED);
await page.click('.set-bar button:has-text("Details")');
const review = await changes();
check(/home2\.example\.com/.test(review) && /new value \(hidden\)/.test(review) && !review.includes(TYPED) && !review.includes(SECRET), 'the review shows the password only as "new value (hidden)"', review);
await page.click('.set-bar button:has-text("Hide details")');
await input(svc('home'), 'Provider').selectOption({ label: '-- custom --' });
check(await field(svc('home'), 'Update address').count() === 1, 'switching to a custom provider shows its fields');
await input(svc('home'), 'Provider').selectOption('dyn.example');
check(await field(svc('home'), 'Update address').count() === 0, 'and switching back hides them');
await shot('mock-edited');

console.log('\n== saving ==');
mock.calls = [];
await saveBtn().click();
const done = await outcome();
check(/^Saved/.test(done), 'a successful save says so', done);
check(/^uci\.changes( uci\.(set|add|delete))+ uci\.apply uci\.confirm/.test(mock.calls.join(' ')), 'checked for leftovers, staged, applied, confirmed', mock.calls.join(' '));
check(mock.cfg.home.lookup_host === 'home2.example.com' && mock.cfg.home.password === TYPED && mock.cfg.home.odd_option === 'x' && mock.cfg.home.username === 'me', 'the changed options were written, the new password was stored, the rest was kept', JSON.stringify({ ...mock.cfg.home, password: '(set)' }));
check(await input(svc('home'), 'Password or token').inputValue() === '' && /stored; leave empty/.test(await input(svc('home'), 'Password or token').getAttribute('placeholder')) && await bar().locator('.set-outcome.ok').count() === 1, 'afterwards the password box is empty again, and the outcome stays');
check(mock.reads.length === 0, 'the page never reads the config with uci get (so it can never receive a secret)', mock.reads.join());

console.log('\n== adding and removing services ==');
await page.click('button:has-text("Add service")');
const fresh = page.locator('.ddns-new');
check(await fresh.count() === 1 && /Not saved yet/.test(await fresh.innerText()), 'Add service opens a new card');
await fresh.locator('input[placeholder="myddns"]').fill('bad-name');
check(/name/i.test(await notes()) && await saveBtn().isDisabled(), 'a section name with a dash is refused', await notes());
await fresh.locator('input[placeholder="myddns"]').fill('home');
check(/already/.test(await notes()), 'so is a name that is taken', await notes());
await fresh.locator('input[placeholder="myddns"]').fill('work_ip');
await input(fresh, 'Provider').selectOption('duckdns.example');
await input(fresh, 'Lookup host name').fill('work.example.com');
await input(fresh, 'Domain').fill('work.example.com');
await input(fresh, 'Password or token').fill(TYPED);
check(await errorCount() === 0 && /work_ip/.test(await page.locator('.set-bar-summary').innerText()), 'a valid new service is listed in the banner (the missing network is only a warning)', await notes());
await svc('off').locator('button:has-text("Remove service")').click();
check(/to be removed/.test(await svc('off').innerText()) && /Service off is removed when you save/.test(await svc('off').innerText()), 'Remove marks a service (it is not gone until saved)');
await svc('off').locator('button:has-text("Undo")').click();
check(!/to be removed/.test(await svc('off').innerText()), 'Undo brings it back');
await svc('off').locator('button:has-text("Remove service")').click();
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'saving the new and the removed service works');
check(mock.cfg.work_ip?.['.type'] === 'service' && mock.cfg.work_ip.service_name === 'duckdns.example' && mock.cfg.work_ip.lookup_host === 'work.example.com' && !mock.cfg.off, 'the new service was added with its options and the removed one is gone', JSON.stringify(mock.cfg.work_ip));
check(await svc('work_ip').count() === 1 && await svc('off').count() === 0, 'the page lists the saved services');

console.log('\n== a change the router does not keep ==');
mock.dropWrites = true;
await input(svc('v6'), 'Lookup host name').fill('v6b.example.com');
mock.calls = [];
await saveBtn().click();
const lost = await outcome();
check(/rolled back/.test(lost) && /Lookup host name/.test(lost), 'a change that does not read back is rolled back and named', lost);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && mock.staged.length === 0 && mock.cfg.v6.lookup_host === 'v6.example.com', 'rollback is called, confirm is not, nothing stays staged, and the router is unchanged', mock.calls.join(' '));
mock.dropWrites = false;
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);
check(await bar().isHidden() && await input(svc('v6'), 'Lookup host name').inputValue() === 'v6.example.com', 'Discard edits returns to what the router has');

console.log('\n== leftovers from an earlier attempt ==');
mock.staged = [['set', 'home', 'enabled', '0']];
await refresh();
check(/1 change\(s\) are already staged/.test(await page.locator('main').innerText()), 'staged changes in the session are shown');
await page.getByRole('button', { name: "Discard this page's staged changes", exact: true }).click();
await page.waitForTimeout(700);
check(mock.staged.length === 0 && !/already staged/.test(await page.locator('main').innerText()), "Discard clears this page's staged changes");
//#endregion

//#region Other states
console.log('\n== the updater is stopped ==');
mock.running = false;
await refresh();
check(await tile(0) === 'Stopped' && /not running although a service is enabled/.test(await page.locator('main').innerText()), 'the tile and a note say that no address is being updated');
mock.running = true;

console.log('\n== ddns-scripts missing, plugin missing ==');
mock.installed = false;
await refresh();
check(/ddns-scripts is not installed/.test(await page.locator('main').innerText()) && await page.locator('.ddns-form').count() === 0, 'a router without ddns-scripts gets a note, not a form');
mock.installed = true;
mock.noPlugin = true;
await refresh();
check(/flab\.ddns\) is not available/.test(await page.locator('main').innerText()), 'a router without the plugin says so');
mock.noPlugin = false;
await refresh();

console.log('\n== a login that may not write ==');
const ro = await open({ ubus: { system: ['board', 'info'], service: ['list'], 'flab.ddns': ['status', 'log'], uci: ['get', 'changes'] } });
check(/not allowed to change the configuration/.test(await ro.locator('main').innerText()) && await ro.locator('.ddns-form input').first().isDisabled() && await ro.locator('button:has-text("Add service")').isDisabled(), 'the controls are disabled and the page says why');
check(await ro.locator('button:has-text("Check now")').first().isDisabled() && /not allowed to run actions/.test(await ro.locator('button:has-text("Check now")').first().getAttribute('title')) && await ro.locator('button:has-text("Log")').first().isEnabled(), 'actions on the updater are off, but the log can still be read');
await ro.close();

console.log('\n== theme ==');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(300);
await shot('dark');
await page.emulateMedia({ colorScheme: 'light' });

console.log('\n== the session expires ==');
await input(svc('home'), 'Lookup host name').fill('x1.example.com');
mock.expired = true;
// A poll may notice the expiry before the click lands; either way the sign-in screen must appear.
await saveBtn().click({ timeout: 5000 }).catch(() => {});
await page.waitForSelector('.login-form', { timeout: 20000 });
check(/Session expired/.test(await page.locator('.login-error').innerText()), 'an expired session returns to the sign-in screen');
//#endregion

check(mock.unsafe.length === 0, 'no uci write and no action on the updater reached the real router', mock.unsafe.join());
check(!mock.reads.some(r => r.startsWith('real:ddns')), 'the page never read the real ddns config with uci get', mock.reads.join());
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall Dynamic DNS browser checks passed');
process.exit(failed ? 1 : 0);
