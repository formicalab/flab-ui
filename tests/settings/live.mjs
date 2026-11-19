// Browser test for the System settings page. A real browser opens the deployed UI.
// 1. Against the real router, read only: the page shows the router's own /etc/config/system. Any uci write the
//    page might send in this phase is blocked and fails the test.
// 2. Against a stateful mock of rpcd's `uci` object, the clock and the NTP client: the whole editing flow -
//    validation, the review list, a successful save, a change the router does not keep, a late confirmation,
//    leftovers from an earlier attempt, an expired session, a login that may not write - WITHOUT touching the
//    router's configuration.
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
// What the mock holds: the system config as `uci get system` returns it, the staged edits, and switches that make
// the next apply or confirm go wrong. `calls` records every uci/session call made while the mock is on.
const baseCfg = () => ({
  cfg0: { '.anonymous': true, '.type': 'system', '.name': 'cfg0', hostname: 'openwrt', timezone: 'CET-1CEST,M3.5.0,M10.5.0/3', zonename: 'Europe/Rome', ttylogin: '0', log_size: '512' },
  ntp: { '.anonymous': false, '.type': 'timeserver', '.name': 'ntp', use_dhcp: '0', server: ['time.ien.it', 'ntp.inrim.it', 'pool.ntp.org'] },
});
const OFFSETS = { 'Europe/Rome': 3600, 'Europe/London': 0, 'Asia/Tokyo': 32400, UTC: 0 };
const WRITES = ['set', 'add', 'delete', 'apply', 'confirm', 'rollback', 'revert', 'commit', 'order', 'rename'];
const mock = {
  on: false, cfg: baseCfg(), staged: [], restage: [], snapshot: null, calls: [],
  dropWrites: false, confirmFails: false, expired: false, unsafe: [],
  backup: { created: false, uploaded: 0, restored: false },
  ntpSynced: false,
};
let nextId = 1;

// Applies the staged edits to the mock's config, the way rpcd's uci apply does.
function commit() {
  for (const [op, section, option, value] of mock.staged) {
    if (op === 'set') mock.cfg[section][option] = value;
    else if (op === 'delete') (option ? delete mock.cfg[section][option] : delete mock.cfg[section]);
    else if (op === 'add') mock.cfg[section] = { '.type': option, '.name': section, '.anonymous': false, ...value };
  }
}

// One uci method of the mock: [ubus status, data].
function uci(method, args) {
  if (method === 'get') return [0, { values: clone(mock.cfg) }];
  if (method === 'changes') {
    const list = args.config && args.config !== 'system' ? [] : mock.staged.map(c => c.slice(0, 4));
    return [0, { changes: args.config ? list : (list.length ? { system: list } : {}) }];
  }
  if (method === 'set') { for (const [k, v] of Object.entries(args.values)) mock.staged.push(['set', args.section, k, v]); return [0, {}]; }
  if (method === 'add') {
    const name = args.name ?? `cfg${nextId++}`;
    mock.staged.push(['add', name, args.type, args.values ?? {}]);
    return [0, { section: name }];
  }
  if (method === 'delete') { for (const o of args.options ?? [undefined]) mock.staged.push(['delete', args.section, o]); return [0, {}]; }
  if (method === 'revert') { if (args.config !== 'system') return [4]; mock.staged = []; return [0, {}]; }
  if (method === 'apply') {
    mock.snapshot = clone(mock.cfg);
    mock.restage = mock.staged;
    if (!mock.dropWrites) commit();
    mock.staged = [];
    return [0, {}];
  }
  if (method === 'confirm') {
    if (!mock.snapshot) return [5];
    if (mock.confirmFails) { mock.cfg = mock.snapshot; mock.staged = mock.restage; mock.snapshot = null; return [1]; }
    mock.snapshot = null;
    return [0, {}];
  }
  if (method === 'rollback') {
    if (!mock.snapshot) return [5];
    mock.cfg = mock.snapshot; mock.staged = mock.restage; mock.snapshot = null;
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
    // Real router: reads only. A write would change its configuration, so it is blocked and the test fails.
    if (obj === 'uci' && WRITES.includes(method)) { mock.unsafe.push(`${obj}.${method}`); return ok([6]); }
    return null;
  }
  if (mock.expired && ['uci', 'system', 'service', 'session'].includes(obj)) return denied;
  if (obj === 'uci') {
    mock.calls.push(`uci.${method}`);
    return ok(uci(method, args));
  }
  if (obj === 'system' && method === 'board') return ok([0, { hostname: mock.cfg.cfg0.hostname || 'OpenWrt', model: 'GL.iNet GL-MT6000' }]);
  if (obj === 'network.interface' && method === 'dump') return ok([0, { interface: [{ interface: 'lan' }, { interface: 'wan' }] }]);
  if (obj === 'system' && method === 'info') {
    const now = Math.floor(Date.now() / 1000);
    return ok([0, { unixtime: now, localtime: now + (OFFSETS[mock.cfg.cfg0.zonename] ?? 0), uptime: 1000 }]);
  }
  if (obj === 'service' && method === 'list') {
    const servers = mock.cfg.ntp?.server ?? [];
    return ok([0, { sysntpd: { instances: { instance1: { running: mock.cfg.ntp?.enabled !== '0', command: ['/usr/sbin/ntpd', '-n', ...servers.flatMap(s => ['-p', s])] } } } }]);
  }
  if (obj === 'flab.system' && method === 'ntp_sync') {
    mock.calls.push('flab.system.ntp_sync');
    mock.ntpSynced = true;
    return ok([0, { ok: true, restarted: true }]);
  }
  if (obj === 'flab.system' && method.startsWith('backup_')) {
    mock.calls.push(`flab.system.${method}`);
    const id = method === 'backup_create' || method === 'backup_begin' ? '0123456789ab' : args.id;
    if (method === 'backup_create') {
      mock.backup.created = true;
      return ok([0, { ok: true, id, size: 18, name: 'flab-backup-openwrt-1.tar.gz' }]);
    }
    if (method === 'backup_download') {
      return ok([0, { ok: true, from: args.from, size: 18, length: 18, data: Buffer.from('mock-config-backup').toString('base64'), done: true }]);
    }
    if (method === 'backup_begin') return ok([0, { ok: true, id, size: args.size }]);
    if (method === 'backup_upload') {
      mock.backup.uploaded = args.from + Buffer.from(args.data, 'base64').length;
      return ok([0, { ok: true, from: mock.backup.uploaded, done: mock.backup.uploaded === args.total }]);
    }
    if (method === 'backup_inspect') {
      return ok([0, { ok: true, id, size: mock.backup.uploaded, files: ['etc/config/network', 'etc/config/system'] }]);
    }
    if (method === 'backup_restore') {
      mock.backup.restored = true;
      return ok([0, { ok: true, reboot: true }]);
    }
    if (method === 'backup_cancel') return ok([0, { ok: true }]);
  }
  return null;
}
//#endregion

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
const errors = [];
// Sessions are created per page by open(): a session id and ACLs in sessionStorage, the way a real sign-in leaves
// the tab. The mock answers for every page of the context.
await ctx.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const reply = body ? answer(body) : null;
  return reply ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) }) : route.continue();
});
// Opens the settings page in a new tab, signed in with `acls` (the root ACLs by default).
const open = async acls => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(([id, a]) => {
    sessionStorage.setItem('sid', id);
    sessionStorage.setItem('acls', JSON.stringify(a));
  }, [sid, acls ?? rootAcls]);
  await p.goto(`${baseUrl}#settings`);
  await p.waitForSelector('.settings-form, .login-form', { timeout: 20000 });
  return p;
};

let page = await open();

// Helpers: the controls by label, tiles, notes, the outcome line of a save, and screenshots.
// The form field labeled `label`.
const field = label => page.locator('.set-field').filter({ has: page.locator(`label.form-label:text-is("${label}")`) });
// The input, drop-down or text area of the field labeled `label`.
const input = label => field(label).locator('input, select, textarea').first();
// The inputs of the list rows of the field labeled `label`.
const rows = label => field(label).locator('.set-row input');
// The checkbox of the switch labeled `label`.
const sw = label => page.locator('.set-check').filter({ hasText: label }).locator('input');
// The value of tile number `i`.
const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
// The small text under the value of tile number `i`.
const tileSub = async i => (await page.locator('.tile .sub').nth(i).innerText()).trim();
// All the notes under the form, joined into one string.
const notes = () => page.locator('.set-notes .set-note').allInnerTexts().then(t => t.join(' | '));
// The "Save and apply" button.
const saveBtn = () => page.locator('button:has-text("Save and apply")');
// The text of the review of pending changes.
const review = () => page.locator('.set-changes').evaluate(e => e.textContent);
// Saves a full-page screenshot named after `label`, when a screenshot folder is set.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `settings-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Waits for the save bar to report the result of a save and returns its text.
const outcome = async () => { const n = page.locator('.set-bar .set-outcome.ok, .set-bar .set-outcome.bad').first(); await n.waitFor({ timeout: 20000 }); return (await n.innerText()).trim(); };
// Clicks Refresh and gives the page a moment to redraw.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };

//#region Navigation and the real router (read only)
console.log('== navigation ==');
const bottom = await page.evaluate(() => {
  const kids = [...document.querySelector('.nav-pane').children];
  return kids.slice(kids.findIndex(k => k.classList.contains('nav-spacer')) + 1).map(k => k.innerText.trim());
});
check(bottom.join(' | ') === 'System settings | Sign out', 'System settings sits below the spacer, right above Sign out', bottom.join(' | '));
check((await page.locator('.cmdbar h1').innerText()).trim() === 'System settings', 'the page title');

console.log('\n== the real router (read only, nothing is written) ==');
const real = await page.evaluate(async () => {
  const sid = sessionStorage.getItem('sid');
  // One ubus call from the page with its session, returning the data of the reply.
  const call = async (obj, method, args = {}) => (await (await fetch('/ubus', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [sid, obj, method, args] }) })).json()).result[1];
  return { board: await call('system', 'board'), cfg: (await call('uci', 'get', { config: 'system' })).values };
});
const realSystem = Object.values(real.cfg).find(s => s['.type'] === 'system');
check(await tile(0) === realSystem.hostname && await tile(0) === real.board.hostname, 'the tiles and the Hostname field show the router\'s own hostname', `${await tile(0)} / ${real.board.hostname}`);
check(await input('Hostname').inputValue() === realSystem.hostname && await input('Zone').inputValue() === realSystem.zonename, 'the form starts from the router (hostname and zone)');
check(await page.locator('.settings-grid > .settings-disclosure > summary').allInnerTexts().then(t => t.map(x => x.trim()).map(x => x.startsWith('Time zone and NTP') ? 'Time zone and NTP' : x).join(' | ')) === 'General | Time zone and NTP | System log | Kernel, cron and memory', 'four full-width settings cards in order');
check(await page.evaluate(() => { const w = document.querySelector('main').clientWidth; return [...document.querySelectorAll('.settings-grid > .card')].every(c => c.getBoundingClientRect().width > w * 0.9); }), 'every card takes the full width of the page');
const columnTitles = await page.locator('.set-col-title').evaluateAll(nodes => nodes.map(x => x.textContent.trim()));
const columnAligned = await page.evaluate(() => { const c = [...document.querySelectorAll('.set-col')].map(e => e.getBoundingClientRect().top); return c.every(t => Math.abs(t - c[0]) < 2); });
check(await page.locator('.set-col').count() === 3 && columnTitles.join(' | ') === 'NTP client | Time zone | NTP server for the network' && columnAligned, 'the time card has NTP client, Time zone and NTP server side by side in operational order', `${columnTitles.join(' | ')} / aligned=${columnAligned}`);
check(await page.locator('.set-field').count() === 23 && await page.locator('.set-check').count() === 6, 'every option of the wiki is there: 21 fields and 2 for the zone, 6 checkboxes', `${await page.locator('.set-field').count()} / ${await page.locator('.set-check').count()}`);
check(await page.locator('.settings-disclosure:not([open])').count() === 5, 'all Settings cards start collapsed');
for (const disclosure of await page.locator('.settings-disclosure').all()) await disclosure.locator(':scope > summary').click();
check(await input('Hostname').isEnabled() && await saveBtn().isDisabled() && await page.locator('.set-bar').isHidden(), 'the router login may edit; the review banner is hidden and Save disabled until something changes');
check(!/not allowed/.test(await page.locator('main').innerText()), 'no read-only warning for a login with write access');
await shot('real');
//#endregion

//#region Mock: reading
mock.on = true;
await page.reload();
await page.waitForSelector('.settings-form');
for (const disclosure of await page.locator('.settings-disclosure').all()) await disclosure.locator(':scope > summary').click();
console.log('\n== reading (mock router) ==');
check(await tile(0) === 'openwrt' && await tile(2) === 'Europe/Rome', 'tiles: hostname and zone', `${await tile(0)} ${await tile(2)}`);
check(/NTP client\s+running/.test(await page.locator('.settings-disclosure > summary').filter({ hasText: 'Time zone and NTP' }).innerText()), 'NTP state is a badge in the Time zone and NTP panel banner');
check(/UTC\+01:00/.test(await tileSub(1)) && /^\d\d:\d\d:\d\d$/.test(await tile(1)), 'the router time tile shows the clock and the UTC offset', `${await tile(1)} ${await tileSub(1)}`);
check(await input('Zone').inputValue() === 'Europe/Rome' && await rows('Time servers').evaluateAll(e => e.map(x => x.value).join()) === 'time.ien.it,ntp.inrim.it,pool.ntp.org', 'the zone and the servers');
check(await input('Log file buffer (KiB)').inputValue() === '512' && await input('Remote syslog port').getAttribute('placeholder') === 'default: 514', 'a set number is shown, an unset one shows its default as the placeholder');
check(await input('Serve time only on interface').evaluate(e => e.tagName) === 'SELECT' && await input('Serve time only on interface').locator('option').allTextContents().then(v => v.join(' | ')) === 'Every interface | lan | wan', 'the NTP server interface is selected from the router network interfaces');
check(!await sw('Require a login on the console').isChecked() && await sw('Synchronize the clock with NTP').isChecked() && !await sw('Also use servers offered by DHCP').isChecked() && await sw('Send logs to a remote server').isChecked(), 'switches show the value, or OpenWrt\'s default when the option is absent');
check(await field('POSIX rule').getAttribute('hidden') !== null, 'the custom rule input is hidden while a zone is chosen');
check(await page.locator('.card-header').filter({ hasText: 'Configuration backup & restore' }).count() === 1, 'backup and restore is in the System settings page');
await page.getByRole('button', { name: 'Sync now' }).click();
await page.waitForSelector('text=NTP sync requested');
check(mock.ntpSynced && mock.calls.includes('flab.system.ntp_sync'), 'Sync now restarts the configured NTP service and reports the request');
await shot('mock-base');
//#endregion

//#region Backup and restore
console.log('\n== backup and restore ==');
const backupDownload = page.waitForEvent('download');
await page.getByRole('button', { name: 'Create backup' }).click();
const downloaded = await backupDownload;
check(downloaded.suggestedFilename() === 'flab-backup-openwrt-1.tar.gz' && mock.backup.created, 'a configuration backup is created and downloaded', downloaded.suggestedFilename());
const upload = page.locator('input[type=file][accept*="application/gzip"]');
await upload.setInputFiles({ name: 'router-backup.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from('mock-config-archive') });
await page.waitForSelector('text=Backup checked: router-backup.tar.gz');
check(/etc\/config\/system/.test(await page.locator('main').innerText()) && await page.getByRole('button', { name: 'Restore and reboot…' }).isEnabled(), 'an uploaded backup is validated and its archive contents are reviewed');
await page.getByRole('button', { name: 'Restore and reboot…' }).click();
check(await page.getByRole('dialog').getByText(/no automatic rollback/).isVisible(), 'restore warns that a full backup has no automatic rollback');
await page.getByRole('dialog').getByRole('button', { name: 'Restore and reboot' }).click();
await page.waitForSelector('text=Configuration restore accepted');
check(mock.backup.restored, 'restore is explicitly requested after confirmation');
check(mock.calls.includes('flab.system.backup_create') && mock.calls.includes('flab.system.backup_upload') && mock.calls.includes('flab.system.backup_inspect') && mock.calls.includes('flab.system.backup_restore'), 'all backup RPC methods are used');
//#endregion

//#region Editing and validation
console.log('\n== editing and validation ==');
await input('Hostname').fill('my.router');
check(/Hostname must be one name/.test(await notes()) && await input('Hostname').evaluate(e => e.classList.contains('is-invalid')) && await saveBtn().isDisabled() && await page.locator('.set-bar').evaluate(e => e.classList.contains('invalid') && getComputedStyle(e).backgroundColor === 'rgb(253, 243, 244)'), 'an invalid hostname is marked, explained, turns the banner red and blocks Save', await notes());
await input('Hostname').fill('router2');
check(/Hostname: openwrt → router2/.test(await review()) && await saveBtn().isEnabled() && !(await notes()), 'a valid one is listed for review and enables Save', await review());
check(await page.locator('.set-bar').isVisible() && /1 unsaved change: Hostname/.test(await page.locator('.set-bar-summary').innerText()), 'the banner appears in the command bar with the number and names of the pending changes', await page.locator('.set-bar-summary').innerText());
check(await page.locator('.set-bar').evaluate(e => getComputedStyle(e).backgroundColor) === 'rgb(255, 244, 206)', 'while changes are pending the banner is yellow', await page.locator('.set-bar').evaluate(e => getComputedStyle(e).backgroundColor));
check(!await page.locator('.set-changes').isVisible(), 'the full list stays collapsed until Details is clicked');
await page.click('.set-bar button:has-text("Details")');
check(await page.locator('.set-changes').isVisible() && /Hostname: openwrt → router2/.test(await page.locator('.set-changes').innerText()), 'Details shows what changes from what to what');
await page.click('.set-bar button:has-text("Hide details")');
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
check(await page.evaluate(() => { const r = document.querySelector('.set-bar').getBoundingClientRect(); return r.top >= 0 && r.bottom < 260; }), 'scrolled to the bottom of the form, the banner and its Save button are still at the top of the window');
await page.evaluate(() => window.scrollTo(0, 0));
await input('Remote syslog port').fill('70000');
check(/at most 65535/.test(await notes()) && await saveBtn().isDisabled(), 'a port above 65535 is refused');
await input('Remote syslog port').fill('1514');
await input('Remote syslog server').fill('999.1.1.1');
check(/not an IP address/.test(await notes()), 'the syslog server must be an IP address');
await input('Remote syslog server').fill('192.168.1.10');
await input('Log storage').selectOption('file');
check(/no log file is set/.test(await notes()) && await saveBtn().isEnabled(), 'file storage without a log file only warns');
await input('Log storage').selectOption('');
check(!/no log file/.test(await notes()), 'back to the default clears the warning');
await input('Notes').fill('line one\nline two');
check(/Notes: default → line one/.test(await review()), 'notes may hold several lines');
await sw('Require a login on the console').check();
check(/Require a login on the console: off → on/.test(await review()), 'a switch change is listed as off → on');

await page.locator('button:has-text("Add server")').click();
check((await rows('Time servers').count()) === 4 && await page.evaluate(() => document.activeElement?.closest('.set-row') !== null), 'Add server appends a row and focuses it');
await page.keyboard.type('bad host');
check(await rows('Time servers').last().evaluate(e => e.classList.contains('is-invalid')) && /"bad host" is not a valid host/.test(await notes()), 'an invalid server marks its row');
await rows('Time servers').last().fill('POOL.ntp.org');
check(/listed twice/.test(await notes()) && await rows('Time servers').last().evaluate(e => e.classList.contains('is-invalid')), 'a duplicate (any case) is refused');
await rows('Time servers').last().fill('time.cloudflare.com');
check(!/Time servers/.test(await notes()), 'a valid server clears the error');
await input('Zone').selectOption('');
check(await field('POSIX rule').getAttribute('hidden') === null, 'choosing Custom rule shows the rule input');
await input('POSIX rule').fill('nonsense');
check(/not a POSIX time zone rule/.test(await notes()) && await saveBtn().isDisabled(), 'a bad custom rule blocks Save');
await input('POSIX rule').fill('EST5EDT,M3.2.0,M11.1.0');
check(/Time zone: Europe\/Rome → EST5EDT/.test(await review()) && !/not a POSIX/.test(await notes()), 'a good custom rule is accepted and shown in the review');
await shot('mock-edited');
await page.waitForTimeout(11500);
check(await input('Hostname').inputValue() === 'router2', 'the page does not poll over unsaved edits');
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(700);
check(await input('Hostname').inputValue() === 'openwrt' && await input('Zone').inputValue() === 'Europe/Rome' && await rows('Time servers').count() === 3 && await saveBtn().isDisabled() && await page.locator('.set-bar').isHidden(), 'Discard edits returns to what the router has and hides the banner');
//#endregion

//#region Saving
console.log('\n== saving ==');
await input('Hostname').fill('router2');
await input('Description').fill('lab router');
await input('Zone').selectOption('Europe/London');
await rows('Time servers').first().fill('time.cloudflare.com');
await sw('Also use servers offered by DHCP').check();
await input('Remote syslog server').fill('192.168.1.10');
await input('Log storage').selectOption('file');
await input('Log file').fill('/var/log/messages');
mock.calls = [];
await saveBtn().click();
const done = await outcome();
check(/^Saved/.test(done), 'a successful save says so', done);
const seq = mock.calls.join(' ');
check(/^uci\.changes( uci\.set)+ uci\.apply uci\.get uci\.confirm/.test(seq), 'checked for leftovers, staged, applied, read back, then confirmed, in that order', seq);
const sys = mock.cfg.cfg0, ntp = mock.cfg.ntp;
check(sys.hostname === 'router2' && sys.description === 'lab router' && sys.zonename === 'Europe/London' && sys.timezone === 'GMT0BST,M3.5.0/1,M10.5.0' && sys.log_ip === '192.168.1.10' && sys.log_type === 'file' && sys.log_file === '/var/log/messages', 'the system options were written, both zone values together', JSON.stringify(sys));
check(ntp.server[0] === 'time.cloudflare.com' && ntp.server.length === 3 && ntp.use_dhcp === '1' && sys.log_size === '512' && sys.ttylogin === '0', 'the NTP options were written and untouched options kept', JSON.stringify([ntp, sys.log_size]));
check(await tile(0) === 'router2' && /UTC\+00:00/.test(await tileSub(1)) && await tile(2) === 'Europe/London', 'the tiles show the saved state', `${await tile(0)} ${await tileSub(1)}`);
check((await page.locator('.nav-pane .brand strong').innerText()).trim() === 'router2', 'the new hostname appears in the navigation header');
check(await saveBtn().isHidden() && await page.locator('button:has-text("Discard edits")').isHidden() && !/null|undefined/.test(await page.locator('.set-bar').innerText()) && /Saved/.test(await page.locator('.set-bar .set-outcome.ok').innerText()), 'the form restarts clean and the banner keeps only the outcome, without Save and Discard buttons');
await input('Hostname').fill('router3');
check(await page.locator('.set-outcome.ok').count() === 0 && await page.locator('.set-bar').isVisible(), 'editing again forgets the old outcome and shows the pending change');
await shot('mock-saved');

console.log('\n== removing an option ==');
await input('Hostname').fill('router2');
await input('Description').fill('');
mock.calls = [];
await saveBtn().click();
check(/^Saved/.test(await outcome()) && mock.cfg.cfg0.description === undefined, 'an emptied option is deleted from the config', JSON.stringify(mock.cfg.cfg0));
for (let i = 0; i < 3; i++) await page.locator('.set-row button').first().click();
await saveBtn().click();
check(/^Saved/.test(await outcome()) && mock.cfg.ntp.server === undefined, 'an emptied list is deleted too', JSON.stringify(mock.cfg.ntp));

console.log('\n== a change the router does not keep ==');
mock.dropWrites = true;
await input('Hostname').fill('router9');
mock.calls = [];
await saveBtn().click();
const lost = await outcome();
check(/rolled back/.test(lost) && /Hostname was not saved/.test(lost), 'a change that does not read back is rolled back and reported', lost);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && mock.calls.lastIndexOf('uci.revert') > mock.calls.indexOf('uci.rollback') && mock.staged.length === 0, 'rollback is called, confirm is not, and the re-staged edits are then discarded', mock.calls.join(' '));
check(await input('Hostname').inputValue() === 'router9' && await tile(0) === 'router2', 'the edit stays in the form for a retry, and the router is unchanged');
await shot('mock-rolled-back');
mock.dropWrites = false;

console.log('\n== a confirmation that comes too late ==');
mock.confirmFails = true;
mock.calls = [];
await saveBtn().click();
const late = await outcome();
check(/^Confirmation failed; the outcome is uncertain\./.test(late) && /Rollback could not be confirmed/.test(late) && !/was rolled back/.test(late)
  && mock.calls.filter(c => c === 'uci.confirm').length === 1 && mock.calls.indexOf('uci.rollback') > mock.calls.indexOf('uci.confirm')
  && mock.calls.lastIndexOf('uci.revert') > mock.calls.indexOf('uci.rollback') && await tile(0) === 'router2',
  'a late confirmation is reported as uncertain without retrying it; the mock restored the config and cleanup discards the leftovers', `${late} / ${mock.calls.join(' ')}`);
mock.confirmFails = false;
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(500);

console.log('\n== leftovers from an earlier attempt ==');
mock.staged = [['set', 'cfg0', 'hostname', 'stale'], ['set', 'cfg0', 'description', 'stale']];
await refresh();
check(/2 change\(s\) are already staged/.test(await page.locator('main').innerText()), 'staged changes in the session are shown');
await page.getByRole('button', { name: "Discard this page's staged changes", exact: true }).click();
await page.waitForTimeout(700);
check(mock.staged.length === 0 && !/already staged/.test(await page.locator('main').innerText()), "Discard clears this page's staged changes");
//#endregion

//#region A login that may not write, theme, expiry
console.log('\n== a login that may not write ==');
const ro = await open({ ubus: { system: ['board', 'info'], service: ['list'], uci: ['get', 'changes'] } });
await ro.waitForSelector('.settings-form');
check(/not allowed to change the configuration/.test(await ro.locator('main').innerText()) && await ro.locator('.set-field input').first().isDisabled() && await ro.locator('button:has-text("Save and apply")').isDisabled(), 'the controls are disabled and the page says why');
await ro.close();

console.log('\n== theme ==');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(300);
await shot('dark');
await page.emulateMedia({ colorScheme: 'light' });

console.log('\n== the session expires ==');
await input('Hostname').fill('router7');
mock.expired = true;
// A poll may notice the expiry before the click lands; either way the sign-in screen must appear.
await saveBtn().click({ timeout: 5000 }).catch(() => {});
await page.waitForSelector('.login-form', { timeout: 20000 });
check(/Session expired/.test(await page.locator('.login-error').innerText()), 'an expired session returns to the sign-in screen');
//#endregion

check(mock.unsafe.length === 0, 'no uci write reached the real router', mock.unsafe.join());
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall settings browser checks passed');
process.exit(failed ? 1 : 0);
