// Browser test of the Asterisk page. A real browser opens the deployed UI; the flab.asterisk calls are intercepted and answered with the
// scenario JSON produced by the backend run (see run.ps1, mkfx.mjs), so the page can be driven through a rejected registration, a call in
// progress, an unreachable daemon and secrets in the dialplan without touching the PBX. `resolve` goes to the real router so the number
// tester can be compared with Asterisk itself. Usage: node live.mjs <dir with <scenario>.<name>.json files>   (env: FLAB_SID, FLAB_ACLS, FLAB_URL, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID;
const acls = JSON.parse(process.env.FLAB_ACLS);
const shots = process.env.FLAB_SHOTS;
const scenario = (s, n) => JSON.parse(fs.readFileSync(path.join(out, `${s}.${n}.json`), 'utf8'));

let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

// The scenario that answers the page's calls; null passes everything to the router.
let current = null;
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 }, colorScheme: 'light', ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const [, object, method, args] = body?.params ?? [];
  if (current && object === 'flab.asterisk' && method !== 'resolve') {
    const name = method === 'config' ? (args?.file ? `config.${args.file.replace(/\.conf$/, '')}` : 'config') : method;
    const file = path.join(out, `${current}.${name}.json`);
    if (fs.existsSync(file)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [0, JSON.parse(fs.readFileSync(file, 'utf8'))] }) });
  }
  return route.continue();
});

const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `asterisk-${label}.png`), fullPage: true }); };
const tab = async name => { await page.getByRole('tab', { name, exact: true }).click(); await page.waitForTimeout(900); };
const view = async name => { await page.locator('.seg-tab', { hasText: name }).last().click(); await page.waitForTimeout(500); };
const text = () => page.locator('body').innerText();
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(900); };
const stage = async (label, name) => { console.log(`\n== ${label} ==`); current = name; await refresh(); };

await page.addInitScript(([id, granted]) => {
  sessionStorage.setItem('sid', id);
  sessionStorage.setItem('acls', JSON.stringify(granted));
}, [sid, acls]);
await page.goto(baseUrl);
await page.waitForSelector('nav a[href="#asterisk"]');
check(true, 'the Asterisk page is in the navigation (the module manifest is installed)');
current = 'base';
await page.click('nav a[href="#asterisk"]');
await page.waitForSelector('.tile');

console.log('== Overview ==');
const base = scenario('base', 'status');
check(await page.locator('.tile').count() === 6, 'six summary tiles', String(await page.locator('.tile').count()));
check((await page.locator('.tile .value').first().innerText()).trim() === base.version, 'the first tile shows the Asterisk version', await page.locator('.tile .value').first().innerText());
check((await page.locator('[role=tablist]').first().locator('button').allInnerTexts()).join() === 'Overview,Calls,PJSIP,Dialplan,Configuration files', 'five tabs, the live ones first');
check(await page.locator('[role=tablist] .seg-gap').count() === 1 && (await page.locator('[role=tablist] .seg-tab', { hasText: 'Calls' }).evaluate(b => b.nextElementSibling.classList.contains('seg-gap'))), 'a gap separates Overview and Calls from the rest');
check(await page.locator('.cmd-reload button').count() === 3, 'the Reload buttons are in the tab strip line');
await page.locator('.cmd-reload button', { hasText: 'Dialplan' }).click();
await page.waitForSelector('dialog.fl-dialog[open]');
check(/dialplan reload/.test(await page.locator('dialog.fl-dialog').innerText()), 'a Reload button asks first and names the command');
await page.locator('dialog.fl-dialog button', { hasText: 'Cancel' }).click();
await page.waitForSelector('dialog.fl-dialog', { state: 'detached', timeout: 3000 }).catch(() => {});
check(await page.locator('dialog.fl-dialog').count() === 0, 'Cancel runs nothing (the test never confirms a reload)');
check(/Asterisk daemon/.test(await text()) && /running/.test(await text()), 'the daemon card says running');
check(await page.locator('.ast-log tbody tr').count() === base.problems.entries.length, 'the log table lists the problems', String(await page.locator('.ast-log tbody tr').count()));
await shot('overview');

await stage('a registration is rejected', 'regfail');
check(await page.locator('.alert-danger:has-text("Vodafone is Rejected")').count() === 1, 'a red banner names the rejected registration');
check(await page.locator('.tile:has-text("Registrations") .text-danger').count() === 1, 'the registrations tile turns red');

await stage('the daemon does not answer', 'unreachable');
check(/Not answering/.test(await text()) && /control socket/.test(await text()), 'overview says the daemon is not answering');
await tab('PJSIP');
check(/does not answer/.test(await text()), 'the PJSIP tab explains that nothing can be read');
await tab('Dialplan');
check(/dialplan cannot be read/.test(await text()), 'the Dialplan tab explains too');

await stage('Asterisk is disabled', 'disabled');
await tab('Overview');
check(/Disabled/.test(await text()) && await page.locator('.alert-danger').count() === 0, 'a disabled daemon is a note, not an error');

console.log('\n== PJSIP ==');
await stage('normal state', 'base');
await tab('PJSIP');
const pj = scenario('base', 'pjsip');
check(await page.locator('.tile').count() === 6 && await page.locator('.cmdbar .fl-summary').count() === 1, 'the same six tiles stay pinned above the tabs');
check(await page.locator('.ast-reg').count() === pj.registrations.length, 'one card per registration');
check(await page.locator('.ast-row').count() === pj.endpoints.length, 'one row per endpoint');
check(await page.locator('.ast-node').count() === pj.endpoints.length, 'the signalling diagram has every endpoint');
await page.locator('input[type=search]').first().fill('trunk');
await page.waitForTimeout(300);
check(await page.locator('.ast-row').count() === pj.endpoints.filter(e => e.role === 'trunk').length, 'the filter finds the trunks by role');
await page.locator('input[type=search]').first().fill('');
await page.waitForTimeout(300);
await page.locator('.ast-row').first().click();
await page.waitForSelector('.fl-drawer');
check(await page.locator('.fl-drawer-title').innerText() === pj.endpoints[0].name, 'a row opens the side panel of that endpoint');
await page.locator('.fl-drawer summary').click();
await page.waitForSelector('.fl-drawer table');
check(await page.locator('.fl-drawer table tr').count() > 20, 'the panel lists every parameter on demand');
await shot('pjsip-drawer');
await page.locator('.fl-drawer .btn-close').click();
await shot('pjsip');

await stage('a call in progress', 'calls');
check(await page.locator('.tile:has-text("Calls") .value').innerText() === '1', 'the calls tile shows the call in progress');
check(await page.locator('.card-header:has-text("Active channels")').count() === 1 && /PJSIP\/1001-0000000a/.test(await text()), 'the active channel is listed');
check(await page.locator('.ast-wire.live').count() === 2, 'the signalling lines animate while a call is up');

console.log('\n== Calls ==');
await stage('normal state', 'base');
await tab('Calls');
check(await page.locator('.cmdbar .fl-summary').count() === 1 && await page.locator('.tile').count() === 6, 'the tiles stay pinned on the Calls tab');
check(await page.locator('.cmd-reload button').count() === 3, 'the Reload buttons are there too');
check(await page.locator('.ast-table tbody tr').count() === 7, 'seven calls: the two legs of the Local call are one', String(await page.locator('.ast-table tbody tr').count()));
check(await page.locator('.ast-dir.in').count() === 2 && await page.locator('.ast-dir.out').count() === 3 && await page.locator('.ast-dir.internal').count() === 2, 'incoming, outgoing and internal calls are told apart by the trunk endpoints');
check(/7 calls · 4 answered · 2 missed · 1 failed/.test(await text()), 'the line over the table counts by result', (await text()).match(/\d+ calls? ·[^\n]*/)?.[0]);
check(/Rossi, "Gino"/.test(await text()) && /Clouditalia/.test(await text()) && /2m 2s/.test(await text()), 'a quoted name, the trunk that carried the call and the talking time are shown');
await page.selectOption('select[title="Kind of call"]', 'missed');
await page.waitForTimeout(300);
check(await page.locator('.ast-table tbody tr').count() === 2, 'the Missed filter keeps the unanswered and the busy call', String(await page.locator('.ast-table tbody tr').count()));
await page.selectOption('select[title="Kind of call"]', 'all');
await page.locator('input[placeholder="Filter calls…"]').fill('0612');
await page.waitForTimeout(300);
check(await page.locator('.ast-table tbody tr').count() === 1, 'the text filter finds a call by its number');
await page.locator('input[placeholder="Filter calls…"]').fill('');
await shot('calls');
await stage('a call in progress', 'calls');
const live = page.locator('.card:has(.card-header:has-text("Calls in progress"))');
check(await live.locator('tbody').count() === 1 && await live.locator('tbody tr.ast-row').count() === 2, 'the two channels of the call in progress are listed together in one block');
check(await live.locator('.ast-cf .ast-cf-node').count() === 3 && await live.locator('.ast-cf .ast-cf-wire').count() === 2 && /simple_bridge/.test(await live.locator('.ast-cf').innerText()), 'the media path is drawn: an end, a wire, the bridge, a wire, the other end');
check(await live.locator('.ast-dir').count() >= 1 && await live.locator('.fl-summary .tile').count() === 5, 'the direction and the five tiles are shown');
check(/ulaw/.test(await live.innerText()) && /ulaw, alaw/.test(await live.innerText()) && await live.locator('tr.ast-row .fl-badge:has-text("transcoding")').count() === 1 && await live.locator('.ast-cf .fl-badge:has-text("transcoding")').count() === 1, 'the codec in use, the codecs negotiated and the channel that transcodes are shown');
check(/loss in <0\.1% · out <0\.1%/.test(await live.innerText()) && /RTT 12\.0 ms/.test(await live.innerText()), 'the RTP quality is shown');
await live.locator('tbody tr.ast-row').first().click();
await page.waitForTimeout(400);
check(await page.locator('.fl-drawer').count() === 1 && /Call identifier/.test(await page.locator('.fl-drawer').innerText()) && /C-00000026/.test(await page.locator('.fl-drawer').innerText()), 'a click on a channel opens the side panel with its ids');
await shot('calls-active');
await page.locator('.fl-drawer .btn-close').click();
await stage('no CDR backend', 'nocdr');
check(/No call history/.test(await text()) && /asterisk-cdr-csv/.test(await text()), 'without a backend the tab says what to install');
await stage('the daemon does not answer', 'unreachable');
check(await page.locator('.ast-table tbody tr').count() === 7 && await page.locator('.ast-dir').count() === 0, 'with Asterisk down the file is still shown, without directions');
await stage('normal state', 'base');
await tab('PJSIP');

console.log('\n== Dialplan browser ==');
await stage('normal state', 'base');
await tab('Dialplan');
const dp = scenario('base', 'dialplan');
check(await page.locator('.tile').count() === 6 && await page.locator('.cmdbar .fl-summary').count() === 1, 'the same tiles are pinned on the Dialplan tab');
check(await page.locator('.ast-ctx').count() === dp.contexts.length, 'every context is listed');
await page.locator('.ast-ctx', { hasText: 'from-internal' }).click();
await page.waitForTimeout(400);
check(await page.locator('.ast-ext').count() === dp.contexts.find(c => c.name === 'from-internal').extensions.length, 'its extensions are shown');
check(/Includes/.test(await text()) && /internal-lab/.test(await text()), 'the include is shown');
const ext = page.locator('.ast-ext', { hasText: '_0[1-9].' });
await ext.locator('summary').click();
check(await ext.locator('.ast-app.flow', { hasText: 'Gosub' }).count() >= 1 && /one or more of anything/.test(await ext.innerText()), 'the pattern is explained and the Gosub step is colored as flow');
await page.locator('input[type=search]').last().fill('sub-trunk');
await page.waitForTimeout(300);
check(await page.locator('.ast-ext').count() > 0 && await page.locator('.ast-ext').count() < dp.contexts.find(c => c.name === 'from-internal').extensions.length, 'the filter narrows the extensions');
await page.locator('input[type=search]').last().fill('');
await page.waitForTimeout(300);
await ext.locator('.ast-src button').first().click();
await page.waitForSelector('.ast-ln.hl');
check(/extensions\.conf/.test(await page.locator('.ast-file-head').innerText()), 'a source link opens the configuration file at its line');
check(await page.locator('.ast-ln.hl').count() === 1, 'the line is highlighted');
await shot('config-from-dialplan');

console.log('\n== Routing map ==');
await tab('Dialplan');
await view('Routing map');
await page.waitForSelector('.ast-svg');
check(await page.locator('.ast-n.ctx').count() === dp.contexts.length, 'the map has a node per context');
check(await page.locator('.ast-edge.enter').count() >= 1 && await page.locator('.ast-edge.dial').count() >= 1, 'it draws entry and dial edges');
await page.locator('.ast-n.ctx', { hasText: 'from-pstn' }).click();
await page.waitForTimeout(300);
check(await page.locator('.ast-n.ctx.sel').count() === 1 && await page.locator('.ast-edge.dim').count() > 0, 'a click on a context highlights its wiring');
await shot('map');

console.log('\n== Number tester ==');
await view('Number tester');
await page.waitForSelector('#ast-digits');
await page.selectOption('#ast-from', { label: 'Context from-internal' });
// Fills the form, submits, waits for Asterisk's answer, returns the text of the result.
const ask = async digits => {
  await page.fill('#ast-digits', digits);
  await page.press('#ast-digits', 'Enter');
  await page.waitForSelector('.alert:has-text("Asterisk")', { timeout: 10000 });
  await page.waitForFunction(() => !/Asking Asterisk/.test(document.body.innerText), null, { timeout: 10000 });
  return text();
};
let t = await ask('1002');
check(/_1XXX/.test(t) && /Asterisk agrees/.test(t), '1002 goes to _1XXX and Asterisk agrees', t.slice(0, 300));
t = await ask('0612345678');
check(/_0\[1-9\]\./.test(t) && /Asterisk agrees/.test(t) && /Vodafone/.test(t), 'an Italian landline goes to _0[1-9]. and dials Vodafone', t.slice(0, 300));
t = await ask('6000');
check(/through the include/.test(t) && /internal-lab/.test(t) && /Asterisk agrees/.test(t), '6000 is found through the include', t.slice(0, 300));
t = await ask('99999');
check(/matches “99999”/.test(t) && /Asterisk agrees: nothing matches/.test(t), 'a number nothing matches says so', t.slice(0, 300));
await page.fill('#ast-digits', 'a b');
await page.press('#ast-digits', 'Enter');
await page.waitForTimeout(300);
check(/Enter a number/.test(await text()), 'an invalid number is refused in the form');
await shot('tester');

console.log('\n== Configuration ==');
await stage('normal state', 'base');
await tab('Configuration files');
await page.waitForSelector('.ast-code');
check(await page.locator('.tile').count() === 6 && await page.locator('.cmdbar .fl-summary').count() === 1, 'the same tiles are pinned on the Configuration files tab');
await page.locator('.ast-ctx', { hasText: 'pjsip.conf' }).click();
await page.waitForFunction(() => /pjsip\.conf/.test(document.querySelector('.ast-file-head')?.innerText ?? ''));
check(/pjsip\.conf/.test(await page.locator('.ast-file-head').innerText()), 'a file in the list opens in the viewer');
check(await page.locator('.ast-ln.section').count() > 3 && /<redacted>/.test(await page.locator('.ast-code').innerText()), 'sections are marked and passwords are hidden');
check(!/password=[^<\s]/.test(await page.locator('.ast-code').innerText()), 'no password value is left in the file view');
await shot('config');

console.log('\n== Secrets ==');
await stage('secrets in the dialplan', 'secrets');
await tab('Dialplan');
await view('Browser');
await page.locator('.ast-ctx', { hasText: 'secrets' }).click();
await page.waitForTimeout(400);
const all = await page.evaluate(() => document.body.innerText);
check(!/4321|hunter2|9999|abc123xyz|swordfish/.test(all) && /redacted/.test(all), 'planted secrets never reach the page; the marker does');

check(errors.length === 0, 'no console or page errors', errors.join(' | ').slice(0, 400));
await browser.close();
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll Asterisk browser checks passed');
