// Browser test for the Services page. A real browser opens the deployed UI.
// 1. Against the real router, read only: the page lists the router's own init scripts and procd services. A
//    flab.services control call reaching the router in this phase is blocked and fails the test.
// 2. Against a mock of the `service` and `flab.services` objects: the whole flow - the buttons, confirmations for
//    risky services, the outcome of a call (success, a script that fails, an error), buttons disabled while a
//    call runs, a login that may not control services, a missing plugin, an expired session, rpcd restarted from
//    the page - WITHOUT ever starting, stopping or restarting a service on the router: every control call is
//    answered by the mock.
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
// Resolves after `ms` milliseconds.
const sleep = ms => new Promise(r => setTimeout(r, ms));

//#region The mock router
// The init scripts of the mock router: [name, enabled position or null, protected].
const SCRIPTS = [['acme', null, false], ['boot', 10, true], ['cron', 50, false], ['dnsmasq', 19, false], ['done', 95, true], ['dropbear', 19, false],
  ['failsvc', 90, false], ['firewall', 19, false], ['network', 20, false], ['odhcpd', 35, false], ['rpcd', 12, false], ['uhttpd', 50, false], ['wpad', 19, false]];
// The procd entry of a service that is running with process id `pid`.
const running = pid => ({ instances: { instance1: { running: true, pid } } });
// procd's view: firewall, network and failsvc have no instance; acme is known but idle; ubus has no init script.
const baseProcd = () => ({ acme: {}, cron: running(1770), dnsmasq: running(1800), dropbear: running(1900), odhcpd: running(2000), rpcd: running(2100), uhttpd: running(2200), wpad: running(2300), ubus: running(300) });

// `calls` records every control call the mock answered, `unsafe` every one that would have reached the real router.
const mock = { on: false, procd: baseProcd(), calls: [], unsafe: [], delay: 0, expired: false, noPlugin: false, controlError: null, expireAfterDetached: false, nextPid: 5000 };

// One method of the mock's objects: [ubus status, data], or a JSON-RPC error object.
async function control(args) {
  const { name, action } = args;
  mock.calls.push({ name, action });
  if (mock.delay) await sleep(mock.delay);
  if (mock.controlError) return { error: { code: -32000, message: mock.controlError } };
  // The control result of a successful run of `action` on `name`; `over` replaces fields.
  const reply = (over = {}) => [0, { name, action, ok: true, code: 0, detached: false, output: '', error: null, ...over }];
  if (name === 'failsvc') return reply({ ok: false, code: 1, output: 'failsvc: cannot open /etc/failsvc.conf', error: 'The service script failed with exit code 1.' });
  if (['rpcd', 'uhttpd', 'network'].includes(name) && action !== 'start') {
    if (mock.expireAfterDetached && name === 'rpcd') setTimeout(() => { mock.expired = true; }, 800);
    return reply({ code: null, detached: true });
  }
  if (action === 'stop') delete mock.procd[name];
  else mock.procd[name] = running(mock.nextPid++);
  return reply({ output: `${name} ${action}ed` });
}

// The JSON-RPC answer for a request the mock handles, or null to let it through to the real router.
async function answer(body) {
  const [, obj, method, args] = body.params;
  // The JSON-RPC reply for a ubus `[code, data]` result.
  const ok = ([code, data]) => ({ jsonrpc: '2.0', id: body.id, result: data === undefined ? [code] : [code, data] });
  const denied = { jsonrpc: '2.0', id: body.id, error: { code: -32002, message: 'Access denied' } };

  if (!mock.on) {
    // Real router: reads only. A control call would start or stop a service, so it is blocked and the test fails.
    if (obj === 'flab.services' && method === 'control') { mock.unsafe.push(JSON.stringify(args)); return ok([6]); }
    return null;
  }
  if (mock.expired && ['flab.services', 'service', 'system', 'session'].includes(obj)) return denied;
  if (obj === 'flab.services' && method === 'control') {
    const r = await control(args);
    return r.error ? { jsonrpc: '2.0', id: body.id, ...r } : ok(r);
  }
  if (obj === 'flab.services' && method === 'list') {
    if (mock.noPlugin) return ok([4]);
    return ok([0, { generated: 1, services: SCRIPTS.map(([name, start, prot]) => ({ name, enabled: start != null, start, protected: prot })) }]);
  }
  if (obj === 'service' && method === 'list') return ok([0, mock.procd]);
  return null;
}
//#endregion

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
const errors = [];
await ctx.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const reply = body ? await answer(body) : null;
  return reply ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) }) : route.continue();
});
// Opens the Services page with a session in sessionStorage, the way a real sign-in leaves the tab.
const open = async acls => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(([id, a]) => {
    sessionStorage.setItem('sid', id);
    sessionStorage.setItem('acls', JSON.stringify(a));
  }, [sid, acls ?? rootAcls]);
  await p.goto(`${baseUrl}#services`);
  await p.waitForSelector('.svc-table, .login-form', { timeout: 20000 });
  return p;
};
let page = await open();

// Helpers: tiles, rows and buttons (found by the ids the page gives them), the notes, and screenshots.
// The big value of tile `i`.
const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
// The table row of service `name`.
const rowOf = name => page.locator(`[id="svc-row-${name}"]`);
// The `action` button of service `name`.
const btn = (name, action) => page.locator(`[id="svc-${name}-${action}"]`);
// The service names in the table, in row order.
const names = () => page.locator('.svc-table tbody tr td:first-child').allInnerTexts().then(t => t.map(s => s.trim()));
// The confirmation box shown before a stop or restart.
const confirmBox = () => page.locator('#svc-confirm');
// The box that reports the outcome of the last action.
const outcomeBox = () => page.locator('#svc-outcome');
// Saves a full-page screenshot named after `label` when FLAB_SHOTS is set.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `services-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Presses Refresh and waits for the page to redraw.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(600); };
// Waits until `fn` returns true (polling), for conditions that follow a call to the mock.
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
// The text of the state cell (second column) of service `name`.
const stateOf = name => rowOf(name).locator('td').nth(1).innerText().then(t => t.trim());

//#region Navigation and the real router (read only)
console.log('== navigation ==');
const nav = (await page.locator('.nav-pane a.nav-link-fl').allInnerTexts()).map(t => t.trim());
check(nav.indexOf('Toolbox') === nav.indexOf('Services') + 1 && nav.indexOf('Logs') === nav.indexOf('Toolbox') + 1 && nav.indexOf('Services') > nav.indexOf('Devices and Interfaces'), 'Services sits just before Toolbox and Logs, after the network pages', nav.join(' | '));
check((await page.locator('.cmdbar h1').innerText()).trim() === 'Services', 'the page title');

console.log('\n== the real router (read only, no service is touched) ==');
const real = await page.evaluate(async () => {
  const sid = sessionStorage.getItem('sid');
  // Calls ubus `obj.method` with this session and returns the data part of the answer.
  const call = async (obj, method, args = {}) => (await (await fetch('/ubus', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [sid, obj, method, args] }) })).json()).result[1];
  const scripts = (await call('flab.services', 'list')).services;
  const procd = Object.keys(await call('service', 'list'));
  return { scripts: scripts.map(s => s.name), protectedNames: scripts.filter(s => s.protected).map(s => s.name), procd };
});
const union = [...new Set([...real.scripts, ...real.procd])].sort();
const shown = await names();
check(real.scripts.length > 3 && shown.length === union.length && shown.join() === union.join(), `every init script and procd service of the router is listed once (${union.length})`, `${shown.length} vs ${union.length}`);
const controllable = real.scripts.filter(n => !real.protectedNames.includes(n));
check(await page.locator('.svc-actions').count() === controllable.length && await page.locator('.svc-actions button').count() === controllable.length * 3, 'the router login gets Start, Stop and Restart on every controllable service');
check(await rowOf('rpcd').count() === 1 && await btn('rpcd', 'restart').isEnabled(), 'rpcd is listed and can be restarted');
check(await page.locator('.svc-table th').allInnerTexts().then(t => t.map(s => s.trim()).join() === 'Service,State,Start at boot,PID,Actions'), 'the table columns');
check(/running: procd reports/.test(await page.locator('.svc-legend').innerText()), 'the meaning of the states is explained above the table');
await shot('real');
//#endregion

//#region Mock: reading
mock.on = true;
await page.reload();
await page.waitForSelector('.svc-table');
console.log('\n== reading (mock router) ==');
check(await tile(0) === '8' && await tile(1) === '6' && await tile(2) === '13' && /12 start at boot/.test(await page.locator('.tile .sub').nth(2).innerText()), 'tiles: 8 running, 6 not running, 13 init scripts of which 12 start at boot', `${await tile(0)} ${await tile(1)} ${await tile(2)}`);
check((await names()).join() === 'acme,boot,cron,dnsmasq,done,dropbear,failsvc,firewall,network,odhcpd,rpcd,uhttpd,ubus,wpad'.split(',').sort().join(), 'init scripts and the procd service without a script, sorted', (await names()).join());
check(/running/.test(await stateOf('dropbear')) && /idle/.test(await stateOf('acme')) && /no instance/.test(await stateOf('firewall')), 'states: running, idle, no instance');
check(/1900/.test(await rowOf('dropbear').innerText()) && /enabled/.test(await rowOf('dropbear').innerText()) && /disabled/.test(await rowOf('acme').innerText()), 'PIDs and the boot state are shown');
check(await btn('dropbear', 'start').isDisabled() && await btn('dropbear', 'stop').isEnabled() && await btn('dropbear', 'restart').isEnabled(), 'a running service cannot be started again');
check(await btn('acme', 'start').isEnabled() && await btn('firewall', 'start').isEnabled() && await btn('firewall', 'stop').isEnabled(), 'a service that is not running can be started');
check(await rowOf('boot').locator('button').count() === 0 && /boot sequence/.test(await rowOf('boot').innerText()) && await rowOf('done').locator('button').count() === 0, 'boot-sequence scripts have no buttons');
check(await rowOf('ubus').locator('button').count() === 0 && /no init script/.test(await rowOf('ubus').innerText()), 'a procd service without an init script has no buttons');
await page.fill('.search input', 'dns');
check((await names()).join() === 'dnsmasq', 'the filter narrows the list', (await names()).join());
await page.fill('.search input', '');
check((await names()).length === 14, 'clearing the filter brings the list back');
await shot('mock-base');
//#endregion

//#region Confirmation and busy state
console.log('\n== a risky restart asks first ==');
await btn('dnsmasq', 'restart').click();
check(await confirmBox().isVisible() && /Restart dnsmasq\?/.test(await confirmBox().innerText()) && /interrupts DNS/.test(await confirmBox().innerText()) && mock.calls.length === 0, 'the confirmation names the service and the consequence, and nothing has been sent yet', await confirmBox().innerText().catch(() => ''));
check(await confirmBox().evaluate(e => e.classList.contains('warning')), 'a short interruption is a warning');
await shot('confirm-warning');
await page.locator('#svc-confirm-no').click();
check(await confirmBox().count() === 0 && mock.calls.length === 0, 'Cancel closes it without a call');
mock.delay = 900;
await btn('dnsmasq', 'restart').click();
await page.locator('#svc-confirm-yes').click();
await page.waitForTimeout(250);
check(mock.calls.length === 1 && mock.calls[0].name === 'dnsmasq' && mock.calls[0].action === 'restart', 'Confirm sends exactly one call: restart dnsmasq', JSON.stringify(mock.calls));
const buttons = page.locator('.svc-actions button');
const enabledWhileBusy = await buttons.evaluateAll(b => b.filter(x => !x.disabled).length);
check(enabledWhileBusy === 0 && /Restarting/.test(await stateOf('dnsmasq')) && await confirmBox().count() === 0, 'every button is disabled while the call runs, and the row says it is restarting', `${enabledWhileBusy} enabled`);
check(await until(async () => await outcomeBox().count() === 1), 'the outcome appears when the call returns');
check(await outcomeBox().evaluate(e => e.classList.contains('ok')) && /dnsmasq restarted\./.test(await outcomeBox().innerText()) && /dnsmasq restarted$/.test(await outcomeBox().locator('pre').innerText().catch(() => '')), 'success is shown in green with the script\'s output', await outcomeBox().innerText());
check(await until(async () => /1800|50\d\d/.test(await rowOf('dnsmasq').innerText()) && !/1800/.test(await rowOf('dnsmasq').innerText())), 'the list is refreshed: dnsmasq has a new PID');
check(await buttons.evaluateAll(b => b.filter(x => x.disabled).length) === 7, 'the buttons are back (only Start on the 7 running services stays disabled)', String(await buttons.evaluateAll(b => b.filter(x => x.disabled).length)));
mock.delay = 0;
await shot('outcome-ok');
await page.locator('#svc-outcome-dismiss').click();
check(await outcomeBox().count() === 0, 'Dismiss clears the outcome');
//#endregion

//#region Services that need no confirmation, and failures
console.log('\n== stop and start without a confirmation ==');
await btn('cron', 'stop').click();
check(await until(async () => await outcomeBox().count() === 1) && await confirmBox().count() === 0 && mock.calls.at(-1).name === 'cron' && mock.calls.at(-1).action === 'stop', 'an ordinary service is stopped at once', JSON.stringify(mock.calls.at(-1)));
check(await until(async () => /no instance/.test(await stateOf('cron'))) && await btn('cron', 'start').isEnabled(), 'the list shows it stopped and offers Start');
await btn('cron', 'start').click();
check(await until(async () => /running/.test(await stateOf('cron')) && await btn('cron', 'start').isDisabled()) && /cron started\./.test(await outcomeBox().innerText()), 'Start brings it back');

console.log('\n== failures ==');
await btn('failsvc', 'start').click();
check(await until(async () => /failsvc failed/.test(await outcomeBox().innerText().catch(() => ''))), 'a script that fails is reported');
check(await outcomeBox().evaluate(e => e.classList.contains('bad')) && /exit code 1/.test(await outcomeBox().innerText()) && /cannot open \/etc\/failsvc\.conf/.test(await outcomeBox().locator('pre').innerText()), 'the error and the script\'s own output are shown', await outcomeBox().innerText());
check(await btn('failsvc', 'start').isEnabled() && await btn('cron', 'stop').isEnabled(), 'the buttons are usable again after a failure');
await shot('outcome-bad');
mock.controlError = 'Boom from the router';
await btn('acme', 'start').click();
check(await until(async () => /Boom from the router/.test(await outcomeBox().innerText().catch(() => ''))) && await outcomeBox().evaluate(e => e.classList.contains('bad')), 'an error from the router is shown as the outcome');
mock.controlError = null;
//#endregion

//#region Critical services
console.log('\n== critical services ==');
const callsBefore = mock.calls.length;
await btn('network', 'stop').click();
check(await confirmBox().evaluate(e => e.classList.contains('danger')) && /unreachable/.test(await confirmBox().innerText()) && /Stop network\?/.test(await confirmBox().innerText()), 'stopping the network asks, and says the router becomes unreachable', await confirmBox().innerText());
await page.locator('#svc-confirm-no').click();
await btn('firewall', 'stop').click();
check(/removes all filtering/.test(await confirmBox().innerText()), 'stopping the firewall says it removes filtering');
await btn('dropbear', 'stop').click();
check(/Stop dropbear\?/.test(await confirmBox().innerText()) && await page.locator('#svc-confirm').count() === 1, 'asking about another service replaces the question');
await page.locator('#svc-confirm-no').click();
await btn('wpad', 'restart').click();
check(/Wi-Fi/.test(await confirmBox().innerText()), 'restarting wpad says Wi-Fi is cut');
await page.locator('#svc-confirm-no').click();
check(mock.calls.length === callsBefore, 'nothing was sent for any of those questions');
check(await btn('network', 'start').isEnabled(), 'starting a service never asks');
await btn('uhttpd', 'restart').click();
check(/web server that serves this page/.test(await confirmBox().innerText()) && /few seconds/.test(await confirmBox().innerText()), 'restarting uhttpd says the page is unavailable for a moment');
await page.locator('#svc-confirm-yes').click();
check(await until(async () => await outcomeBox().count() === 1) && await outcomeBox().evaluate(e => e.classList.contains('info')) && /runs in the background/.test(await outcomeBox().innerText()) && !/sign in again/.test(await outcomeBox().innerText()), 'a background restart is reported as requested, not as done', await outcomeBox().innerText());
check(mock.calls.at(-1).name === 'uhttpd' && mock.calls.at(-1).action === 'restart' && await page.locator('.svc-table').isVisible(), 'the call was sent once and the page stays');
await shot('outcome-background');
await page.locator('#svc-outcome-dismiss').click();
//#endregion

//#region Logins and plugins
console.log('\n== a login that may not control services ==');
const ro = await open({ ubus: { system: ['board', 'info'], service: ['list'], 'flab.services': ['list'] } });
check(/not allowed to start or stop/.test(await ro.locator('main').innerText()) && await ro.locator('.svc-actions').count() === 0 && await ro.locator('.svc-table th').count() === 4, 'the buttons and the Actions column are hidden and the page says why');
check(await ro.locator('.svc-table tbody tr').count() === 14, 'the services are still listed');
await ro.close();

console.log('\n== the plugin is missing ==');
mock.noPlugin = true;
const np = await open();
check(/plugin is not installed/.test(await np.locator('main').innerText()) && await np.locator('.svc-actions').count() === 0 && await np.locator('.svc-table tbody tr').count() === 9, 'procd\'s services are listed read-only, with a note');
await np.close();
mock.noPlugin = false;
//#endregion

//#region Theme
console.log('\n== theme ==');
await page.emulateMedia({ colorScheme: 'dark' });
await btn('wpad', 'stop').click();
await page.waitForTimeout(300);
await shot('dark-confirm');
check(await confirmBox().isVisible(), 'the confirmation is shown in the dark theme');
await page.locator('#svc-confirm-no').click();
await page.emulateMedia({ colorScheme: 'light' });
//#endregion

//#region Expired session
console.log('\n== the session expires ==');
mock.expired = true;
// A poll may notice the expiry before the click lands; either way the sign-in screen must appear.
await btn('cron', 'stop').click({ timeout: 5000 }).catch(() => {});
await page.waitForSelector('.login-form', { timeout: 20000 });
check(/Session expired/.test(await page.locator('.login-error').innerText()), 'a session that ends during a call returns to the sign-in screen');
await page.close();
mock.expired = false;

console.log('\n== rpcd restarted from the page ==');
page = await open();
mock.expireAfterDetached = true;
await btn('rpcd', 'restart').click();
check(/signs everyone out/.test(await confirmBox().innerText()) && /sign in again/.test(await confirmBox().innerText()), 'the confirmation says the session ends');
await page.locator('#svc-confirm-yes').click();
check(await until(async () => /sign in again/.test(await outcomeBox().innerText().catch(() => ''))), 'the outcome says it was requested and that the session ends');
await page.waitForSelector('.login-form', { timeout: 20000 });
check(/Session expired/.test(await page.locator('.login-error').innerText()), 'when rpcd is gone the page returns to the sign-in screen with "Session expired"');
//#endregion

check(mock.unsafe.length === 0, 'no control call reached the real router', mock.unsafe.join());
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall Services browser checks passed');
process.exit(failed ? 1 : 0);
