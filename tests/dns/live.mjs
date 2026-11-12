// Browser test of the DNS page. A real browser opens the deployed UI; flab.dns status is answered with the replies the backend
// run produced for each scenario (see mkfx.mjs / assert.mjs), so every tile, finding and card can be driven for both engines,
// for both together, for a stopped and for a missing resolver WITHOUT depending on or touching the router's resolver.
// flab.diag (the Toolbox the Try it buttons open) is answered by a mock that records the request and runs nothing. Everything
// else (login, system board) goes to the real router; the page only ever reads.
// Usage: node live.mjs <work dir with out/<scenario>.json>   (env: FLAB_SID, FLAB_ACLS, FLAB_URL, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const work = process.argv[2];
const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID;   // a session made by tests/TestSession.ps1, so no password is needed
const acls = JSON.parse(process.env.FLAB_ACLS);   // what that session may call, like the ACLs of a real sign-in
const shots = process.env.FLAB_SHOTS;
const load = name => JSON.parse(fs.readFileSync(path.join(work, 'out', `${name}.json`), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(work, 'facts.json'), 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));
const j = o => JSON.stringify(o);
const num = n => n.toLocaleString('en-US');

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

//#region The mock router
// The Toolbox status the page needs to draw its form: the tools exist, nothing else.
const DIAG_STATUS = { generated: 1, tools: { ping: true, traceroute: true, openssl: true }, dns_tool: 'dig', types: ['A', 'AAAA', 'MX'], devices: ['br-lan'], limits: { ping: 25, traceroute: 60, dns: 15, tls: 25, compare: 60, check: 75 }, starttls: [], upstream: [], check_host: 'example.com', hosts: [] };
const mock = { reply: clone(load('unbound')), dnsCalls: 0, dnsMethods: new Set(), writes: [], diagStarts: [], diagOther: [], unknownFlab: [] };

// The JSON-RPC answer for a request the mock handles, or null to let it through to the real router.
function answer(body) {
  const [, obj, method, args] = body.params;
  const ok = data => ({ jsonrpc: '2.0', id: body.id, result: [0, data] });
  if (obj === 'uci' && ['set', 'add', 'delete', 'apply', 'commit', 'rollback', 'confirm'].includes(method)) { mock.writes.push(`${obj}.${method}`); return { jsonrpc: '2.0', id: body.id, result: [6] }; }
  if (obj === 'flab.dns') {
    mock.dnsMethods.add(method);
    mock.dnsCalls++;
    return ok(clone(mock.reply));
  }
  if (obj === 'flab.diag') {
    if (method === 'status') return ok(clone(DIAG_STATUS));
    if (method === 'start') { mock.diagStarts.push(args); return ok({ ok: false, error: 'Nothing runs in this test.' }); }
    mock.diagOther.push(method);
    return ok({ ok: false, error: 'Nothing runs in this test.' });
  }
  if (obj.startsWith('flab.') && !['flab.dns', 'flab.diag'].includes(obj)) mock.unknownFlab.push(`${obj}.${method}`);
  return null;
}
//#endregion

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light', locale: 'en-US' });
const errors = [];
await ctx.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const reply = body ? answer(body) : null;
  return reply ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) }) : route.continue();
});
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(([id, granted]) => {
  sessionStorage.setItem('sid', id);
  sessionStorage.setItem('acls', JSON.stringify(granted));
}, [sid, acls]);

// Helpers: tiles, banner, cards, rows and screenshots.
const tile = async label => {
  const t = page.locator('.tile').filter({ has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) });
  return { value: (await t.locator('.value').innerText()).trim(), sub: (await t.locator('.sub').innerText()).trim(), cls: await t.locator('.value').getAttribute('class') };
};
const tileLabels = () => page.locator('.tile .label').allInnerTexts().then(t => t.map(x => x.trim()));
const banner = () => page.locator('.net-health').first().innerText().then(t => t.replace(/\s+/g, ' ').trim());
const bannerClass = () => page.locator('.net-health').first().getAttribute('class');
const cardOf = title => page.locator('.card').filter({ has: page.locator('.card-header', { hasText: title }) });
const headers = () => page.locator('.card-header').allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
const text = loc => loc.innerText().then(t => t.replace(/\s+/g, ' ').trim());
const texts = loc => loc.allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
const refresh = async (ms = 700) => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(ms); };
// Shows a reply: sets the mock and refreshes.
const show = async (reply, ms) => { mock.reply = clone(reply); await refresh(ms); };
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `dns-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// The browser's span text of core/format.js fmtSpan.
const span = s => { s = Math.round(s); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h`; };
const zoneRows = () => page.locator('.dns-table tbody tr:not(.dns-zones-row)');
const filterBox = () => page.locator('input[placeholder^="Filter zones"]');
const tryInput = () => page.locator('.dns-try input');
// Opens the DNS page again through the navigation pane.
const backToDns = async () => { await page.click('.nav-pane a:has-text("DNS")'); await page.waitForSelector('.tile'); };

//#region Unbound
await page.goto(`${baseUrl}#dns`);
await page.waitForSelector('.tile', { timeout: 20000 });
console.log('== Unbound with extended statistics ==');
const nav = (await page.locator('.nav-pane a.nav-link-fl').allInnerTexts()).map(t => t.trim());
check(nav.indexOf('DNS') === nav.indexOf('DHCP') + 1 && nav.indexOf('Devices and Interfaces') === nav.indexOf('DNS') + 1 && (await page.locator('.nav-pane a.active').innerText()).trim() === 'DNS', 'DNS is in the navigation after DHCP and before Devices and Interfaces, and active', nav.join(' | '));
check((await page.locator('.cmdbar h1').innerText()).trim() === 'DNS', 'the page title');
check((await tileLabels()).join() === 'Resolver,Queries,Answered from cache,Resolution time,Upstream servers,DNSSEC', 'six tiles in order', (await tileLabels()).join());
const T = facts.ubT;
let x = await tile('Resolver');
check(x.value === 'Unbound' && x.sub === `1.26.2 · up ${span(273600)}`, 'resolver: the engine, its version and uptime', `${x.value} | ${x.sub}`);
x = await tile('Queries');
check(x.value === num(T.queries) && x.sub === `since start · ${Math.round(T.queries / (273600 / 60))} per minute`, 'queries since start and the average per minute', `${x.value} | ${x.sub}`);
x = await tile('Answered from cache');
check(x.value === `${Math.round(T.hits / T.queries * 100)}%` && x.sub === `${num(T.hits)} hits · ${num(T.queries - T.hits)} misses`, 'cache hit share with hits and misses', `${x.value} | ${x.sub}`);
x = await tile('Resolution time');
check(x.value === '51.2 ms' && /^median 32\.1 ms/.test(x.sub), 'resolution time: average and median', `${x.value} | ${x.sub}`);
x = await tile('Upstream servers');
check(x.value === '6' && x.sub === '4 default forwarders · 2 from the WAN', 'upstream servers: the default forwarders and the WAN ones', `${x.value} | ${x.sub}`);
x = await tile('DNSSEC');
check(x.value === 'Validating' && !/text-warning/.test(x.cls), 'DNSSEC validating');
let b = await banner();
check((await bannerClass()).includes('warn') && /3 answers failed DNSSEC validation/.test(b) && /12 queries were dropped by rate limiting \(300 per second and client\)/.test(b) && /1 conditional zone \(proxy\.dsl\.vodafone\.it\) is forwarded in clear text/.test(b), 'findings: bogus answers, rate limiting and the one clear-text public zone', b);
check(!/clear text to a public resolver/.test(b) && !/SERVFAIL/.test(b), 'the default forwarders over TLS and 1.9% SERVFAIL are not reported', b);
const heads = await headers();
check(['Listening and configuration', 'Forwarding', 'Activity', 'Upstream from the WAN', 'Try it'].every((t, i) => heads[i]?.startsWith(t)) && heads.length === 5, 'the five cards in order: Listening and configuration, Forwarding, Activity, Upstream from the WAN, Try it', heads.join(' | '));
check(Math.abs((await cardOf('Activity').boundingBox()).width - (await cardOf('Forwarding').boundingBox()).width) < 2, 'Activity is as wide as Forwarding');
const actTables = await cardOf('Activity').locator('table').evaluateAll(t => t.map(x => Math.round(x.getBoundingClientRect().x)));
check(actTables.length === 2 && actTables[1] > actTables[0] + 300, 'the counters and the answer codes sit side by side', actTables.join());
check(Math.abs((await cardOf('Listening and configuration').boundingBox()).width - (await cardOf('Forwarding').boundingBox()).width) < 2 && (await cardOf('Listening and configuration').boundingBox()).y < (await cardOf('Forwarding').boundingBox()).y, 'the merged card is on top and as wide as Forwarding');

console.log('\n== Listening on ==');
let chips = await texts(page.locator('.dns-sock'));
check(chips.length === 2 && chips[0].startsWith('0.0.0.0:53 TCP/UDP') && chips[0].includes('all addresses') && chips[1].startsWith('[::]:53 TCP/UDP') && chips[1].includes('all addresses'), 'one chip per address and port, protocols together, wildcard marked "all addresses"', chips.join(' | '));
check((await cardOf('Listening and configuration').locator('.dns-legend').first().boundingBox()).y < (await page.locator('.dns-sock').first().boundingBox()).y && (await texts(cardOf('Listening and configuration').locator('.dns-part'))).join().toLowerCase() === 'listening on,configuration', 'the legend sits above the chips; the card has a Listening on and a Configuration part');

console.log('\n== Forwarding ==');
const fwd = cardOf('Forwarding');
check(/90 forward rules/.test(await text(fwd.locator('.card-header'))), 'the header counts the rules', await text(fwd.locator('.card-header')));
let defs = await texts(fwd.locator('.blk').first().locator('.dns-server'));
check(defs.length === 4 && defs.every(d => d.endsWith('TLS')) && defs[2].startsWith('1.1.1.1'), 'the four default forwarders, each marked TLS', defs.join(' | '));
check(/Conditional zones \(89\)/i.test(await text(fwd)), 'the conditional zones are counted (89)');
check((await zoneRows().count()) === 4, 'grouped by default: the 86 Azure zones are one line, the others stay single', String(await zoneRows().count()));
let rows = await texts(zoneRows());
check(rows[0].startsWith('86 zones') && rows[0].includes('10.0.252.68') && rows[0].includes('10.1.252.68') && !rows[0].includes('clear text'), 'the group line: "86 zones" with the servers (private, so no clear-text badge)', rows[0]);
check(rows.some(r => r.startsWith('proxy.dsl.vodafone.it') && r.includes('clear text')) && rows.some(r => r.startsWith('lab.formicalab.casa') && r.includes('not DNSSEC-validated')) && rows.some(r => r.startsWith('flumini.formicalab.casa') && r.includes('192.168.8.1')), 'single zones keep their name, flags and clear-text badge', rows.join(' | '));
check(await page.locator('.dns-zones-row').count() === 0, 'groups are folded');
await page.locator('.dns-toggle').first().click();
check(await page.locator('.dns-zones-row .dns-zones span').count() === 86, 'a group opens to list its 86 zones');
check((await page.locator('.dns-zones-row').boundingBox()).y > (await page.locator('.dns-group').boundingBox()).y, 'the zones sit under their group line');
await page.locator('.dns-toggle').first().click();
check(await page.locator('.dns-zones-row').count() === 0, 'and fold again');
await page.click('button:has-text("List every zone")');
check((await zoneRows().count()) === 12 && /Showing the first 12 of 89 zones/.test(await text(fwd.locator('.dns-more'))), 'listing every zone shows the first 12 and says so', String(await zoneRows().count()));
await page.click('button:has-text("Show all 89")');
check((await zoneRows().count()) === 89 && await fwd.locator('.dns-more').count() === 0, 'Show all draws every zone');
await filterBox().fill('vodafone');
check((await zoneRows().count()) === 1 && (await text(zoneRows())).startsWith('proxy.dsl.vodafone.it'), 'the filter narrows the zones to one');
check(await page.evaluate(() => document.activeElement?.placeholder?.startsWith('Filter zones')), 'typing in the filter does not take the focus away');
await filterBox().fill('10.1.252.68 privatelink');
check((await zoneRows().count()) === 12 && /Showing the first 12 of 43 zones/.test(await text(fwd.locator('.dns-more'))), 'every word must match: 43 private-link zones on that server', String(await zoneRows().count()));
await filterBox().fill('zzz');
check(/No zone matches the filter/.test(await text(fwd)) && await zoneRows().count() === 0, 'a filter that matches nothing says so');
await filterBox().fill('');
await page.click('button:has-text("Group by servers")');
await filterBox().fill('privatelink');
check((await zoneRows().count()) === 1 && /^43 zones/.test((await texts(zoneRows()))[0]) && await page.locator('.dns-zones-row .dns-zones span').count() === 43, 'grouped and filtered: one group of 43, opened by the filter', (await texts(zoneRows())).join(' | '));
await filterBox().fill('');
check((await fwd.locator('.dns-legend').first().boundingBox()).y < (await fwd.locator('.dns-table').boundingBox()).y, 'the legend sits above the table');
const bar = await text(fwd.locator('.dns-fwd-bar'));
check(/Read only for now\. 2 forwarders are defined in UCI \(zone sections of \/etc\/config\/unbound\)/.test(bar) && /88 only exist in \/etc\/unbound\/unbound_ext\.conf and stay read only here/.test(bar) && await fwd.locator('.dns-fwd-bar button:has-text("Add forwarder")').isDisabled(), 'the card says what can be changed later (2 UCI forwarders, 88 from the extension file) and has a disabled Add button', bar);
check(/^86 zones/.test(rows[0]) && rows[0].includes('unbound_ext.conf') && !/UCI/.test(rows[0]) && await zoneRows().first().locator('button.dns-act-btn').count() === 0, 'the 86 Azure zones are marked as coming from the extension file and have no edit or remove buttons', rows[0]);
const vod = zoneRows().filter({ hasText: 'proxy.dsl.vodafone.it' });
check(/UCI/.test(await text(vod)) && await vod.locator('button.dns-act-btn').count() === 2 && await vod.locator('button.dns-act-btn:not([disabled])').count() === 0 && await vod.locator('.fl-badge', { hasText: 'UCI' }).getAttribute('title') === 'The zone section fwd_vodafone of /etc/config/unbound.', 'a UCI zone says so (naming its section) and has disabled Edit and Remove buttons', await text(vod));
const defBlock = fwd.locator('.blk').first();
check(await defBlock.locator('.fl-badge', { hasText: 'UCI' }).getAttribute('title') === 'The zone section fwd_cloudflare of /etc/config/unbound.' && await defBlock.locator('button.dns-act-btn').count() === 2 && await fwd.locator('button.dns-act-btn:not([disabled])').count() === 0, 'the default forwarders show their UCI section too; no button of the card is enabled');
check(same(await fwd.locator('thead th').allInnerTexts(), ['Zones', 'Forwarded to', 'Flags', 'Defined in']), 'the table has a Defined in column');
await shot('unbound');

console.log('\n== Upstream, Activity, Configuration ==');
check(same(await texts(cardOf('Upstream from the WAN').locator('.dns-server')), ['192.0.2.53', '2001:db8:53::1']), 'the WAN resolvers', (await texts(cardOf('Upstream from the WAN').locator('.dns-server'))).join());
const act = cardOf('Activity');
const actRows = await texts(act.locator('tbody tr'));
check(/since the resolver started 3d 4h ago/.test(await text(act.locator('.card-header'))), 'the age of the counters is in the header');
check(actRows.some(r => r.startsWith('Answered from the cache') && r.includes(num(T.hits)) && r.includes('65%')) && actRows.some(r => r.startsWith('Rate limited') && r.includes('12')) && actRows.some(r => r.startsWith('DNSSEC bogus answers') && r.includes('3')), 'counters with their shares', actRows.join(' | '));
check(actRows.some(r => r.startsWith('NOERROR') && r.includes(num(44100))) && actRows.some(r => r.startsWith('SERVFAIL') && r.includes('910')) && actRows.some(r => r.startsWith('NXDOMAIN')), 'extended statistics: the answer codes', actRows.join(' | '));
check((await act.locator('.dns-legend').boundingBox()).y < (await act.locator('table').first().boundingBox()).y, 'the legend sits above the counters');
const conf = () => cardOf('Listening and configuration');
const areaTitles = await texts(conf().locator('.dns-area-title'));
const areaOpen = () => conf().locator('.dns-area').evaluateAll(d => d.map(x => x.open));
check(j(areaTitles) === '["General","Security and privacy","Local names and DHCP","Performance and cache"]' && j(await areaOpen()) === '[true,false,false,false]', 'the options are in four collapsible areas, General first and open, Security and privacy second and folded', areaTitles.join(' | '));
const areaSums = await texts(conf().locator('.dns-area-sum'));
check(areaSums.length === 2 && areaSums[0] === 'port 53 · 3 LAN interfaces · remote control: local host, unencrypted · basic statistics' && areaSums[1] === 'DNSSEC on · rebind protection: block private addresses (rfc 1918 and 4193) · local clients only · 300 queries/s per client', 'a folded area still says how it is set: the port, interfaces and monitoring; the security switches', areaSums.join(' // '));
check((await texts(conf().locator('.dns-area-count'))).join() === '14 options,11 options,8 options,5 options', 'each area says how many options it holds');
await conf().locator('.dns-area').nth(1).locator('summary').click();
await show(load('unbound'));
check(j(await areaOpen()) === '[true,true,false,false]', 'an area the user opened stays open when the page redraws');
await conf().locator('.dns-area').nth(1).locator('summary').click();
check(j(await areaOpen()) === '[true,false,false,false]', 'and folds again');
await page.evaluate(() => document.querySelectorAll('.dns-area').forEach(d => { d.open = true; }));
const chev = await conf().locator('.dns-area > summary .dns-chevron').evaluateAll(c => c.map(x => ({ w: x.getBoundingClientRect().width, t: getComputedStyle(x).transform })));
check(chev.length === 4 && chev.every(c => c.w > 0 && c.t !== 'none'), 'every area header has the chevron that marks it as collapsible, pointing down when open', JSON.stringify(chev));
await conf().locator('.dns-area').nth(3).locator('summary').click();
await page.waitForTimeout(400);
check((await conf().locator('.dns-area').nth(3).locator('summary .dns-chevron').evaluate(x => getComputedStyle(x).transform)) === 'none', 'and right when folded');
await conf().locator('.dns-area').nth(3).locator('summary').click();
const confText = await text(conf());
check(/Read only for now/.test(confText) && /DNSSEC validation/.test(confText) && /Rate limit \(queries per second\)/.test(confText) && /\/etc\/config\/unbound/.test(confText), 'the configuration is read only, with plain labels', confText.slice(0, 300));
// A control by its label: the field of a text box, number, drop-down or list, or the checkbox of a yes/no option.
const ctl = label => conf().locator('.set-field').filter({ has: page.locator('label.form-label', { hasText: new RegExp(`^${label}$`) }) });
const chk = label => conf().locator('.set-check').filter({ hasText: new RegExp(`^${label}`) });
const picked = label => ctl(label).locator('select option:checked').innerText();
check(await picked('Rebind protection') === 'Block private addresses (RFC 1918 and 4193)' && await picked('Remote control') === 'Local host, unencrypted' && await picked('Local domain type') === 'Transparent: may forward or recurse' && await picked('DHCP server linked') === 'odhcpd' && await picked('IP protocols') === 'Built-in setting', 'options with a fixed set of values are drop-downs showing the one in force', [await picked('Rebind protection'), await picked('Remote control'), await picked('Local domain type')].join(' | '));
check((await ctl('IP protocols').locator('select option').allInnerTexts()).join('|') === 'Default (Both IPv4 and IPv6)|IPv4 only|IPv6 only (for testing)|IPv4 upstream, IPv4 and IPv6 locally|Both, IPv6 first|Both IPv4 and IPv6|Built-in setting' && await conf().locator('select:not([disabled])').count() === 0 && await conf().locator('select.form-select').count() >= 8, 'a drop-down lists every choice (and the default) and is disabled, because the page is read only', String(await conf().locator('select.form-select').count()));
const numberOf = async label => ctl(label).locator('input').evaluate(i => ({ type: i.type, value: i.value, min: i.min, max: i.max, disabled: i.disabled, ph: i.placeholder }));
const rl = await numberOf('Rate limit \\(queries per second\\)'), thr = await numberOf('Threads'), lp = await numberOf('Listen port'), ttl = await numberOf('Minimum TTL \\(s\\)');
check(rl.type === 'number' && rl.value === '300' && rl.min === '0' && rl.disabled && thr.type === 'number' && thr.value === '4' && thr.min === '1' && lp.type === 'number' && lp.value === '53' && lp.max === '65535' && ttl.type === 'number' && ttl.value === '0' && ttl.max === '1800', 'numbers are number inputs with their range, disabled', JSON.stringify([rl, thr, lp, ttl]));
const str = await ctl('Local domain').locator('input').evaluate(i => ({ type: i.type, value: i.value, disabled: i.disabled }));
const prefix = await ctl('DNS64 prefix').locator('input').evaluate(i => ({ value: i.value, ph: i.placeholder }));
check(str.type === 'text' && str.value === 'lab.formicalab.casa' && str.disabled && prefix.value === '' && prefix.ph === 'default: 64:ff9b::/96', 'a name is a text box; one that is not set is empty and shows its default', JSON.stringify([str, prefix]));
check(await chk('DNSSEC validation').locator('input').isChecked() && !await chk('Extended statistics').locator('input').isChecked() && await conf().locator('.set-check input:not([disabled])').count() === 0 && await conf().locator('.form-switch, [role=switch]').count() === 0 && await chk('Service enabled').locator('input').isChecked(), 'yes/no options are disabled checkboxes, checked or not, with no switches');
const lan = await ctl('LAN interfaces').locator('input').evaluateAll(i => i.map(x => `${x.value}${x.disabled ? '' : ' (editable)'}`));
check(lan.join() === 'lan,lan100,wg0' && await ctl('LAN interfaces').locator('button:not([disabled])').count() === 0 && await ctl('LAN interfaces').locator('button').count() === 4, 'a list shows one disabled box per value, and its add and remove buttons are disabled', lan.join());
check(/refuses forged ones/.test(confText) && /DNS rebinding|reach devices on the LAN/.test(confText), 'important options carry a short explanation');
const secTitles = (await texts(conf().locator('.dns-area').first().locator('.dns-sec-title'))).map(t => t.toLowerCase());
const secSec = (await texts(conf().locator('.dns-area').nth(1).locator('.dns-sec-title'))).map(t => t.toLowerCase());
check(j(secTitles) === '["service and monitoring","listening and interfaces"]' && j(secSec) === '["access and abuse","rebind protection","privacy","dnssec"]' && await conf().locator('.dns-area').first().locator('.set-field, .set-check').count() === 14 && await conf().locator('.dns-area').first().locator('.dns-sec', { hasText: 'Remote control' }).count() === 1 && await conf().locator('.dns-area').nth(1).locator('.dns-sec', { hasText: 'DNSSEC validation' }).count() === 1, 'General holds the listening, interface and monitoring options in two sections; Security and privacy the access, rebind, privacy and DNSSEC ones', `${secTitles} // ${secSec}`);
const optX = await conf().locator('.dns-area').first().locator('.set-fields').first().locator('> *').evaluateAll(n => [...new Set(n.map(x => Math.round(x.getBoundingClientRect().x)))]);
check(optX.length >= 3, 'on a wide screen the options of a section flow in several columns', optX.join());

console.log('\n== Try it ==');
await page.click('.dns-try button:has-text("Look up")');
check((await page.locator('.dns-try-hint').innerText()).includes('Type a name') && (await page.evaluate(() => location.hash)) === '#dns', 'an empty name is refused with a hint and stays on the page');
await tryInput().fill('example.org');
await page.click('.dns-try button:has-text("Look up")');
await page.waitForSelector('.rt-host input', { timeout: 10000 });
check((await page.evaluate(() => location.hash)) === '#toolbox' && (await page.locator('.rt-host input').inputValue()) === 'example.org' && /Host or address/.test(await text(page.locator('.rt-host'))), 'Look up opens the Toolbox with the name in the DNS lookup form', await page.evaluate(() => location.hash));
await page.waitForTimeout(500);
check(mock.diagStarts.length === 1 && mock.diagStarts[0].tool === 'dns' && mock.diagStarts[0].host === 'example.org', 'and starts the lookup (answered by the mock, nothing ran)', JSON.stringify(mock.diagStarts));
await page.click('.nav-pane a:has-text("DNS")');
await page.waitForSelector('.tile');
check((await tryInput().inputValue()) === 'example.org', 'the name typed is kept when the page is opened again');
await tryInput().fill('  example.net ');
await page.click('.dns-try button:has-text("Compare resolvers")');
await page.waitForSelector('.rt-host input', { timeout: 10000 });
check((await page.evaluate(() => location.hash)) === '#toolbox' && (await page.locator('.rt-host input').inputValue()) === 'example.net' && /Name to look up/.test(await text(page.locator('.rt-host'))), 'Compare resolvers opens the comparison with the trimmed name', await page.locator('.rt-host input').inputValue());
await page.waitForTimeout(500);
check(mock.diagStarts.length === 2 && mock.diagStarts[1].tool === 'compare' && mock.diagStarts[1].host === 'example.net', 'and starts it', JSON.stringify(mock.diagStarts));
await backToDns();
// Enter in the box also looks the name up.
await tryInput().fill('example.com');
await tryInput().press('Enter');
await page.waitForSelector('.rt-host input', { timeout: 10000 });
check((await page.locator('.rt-host input').inputValue()) === 'example.com' && mock.diagStarts.at(-1).tool === 'dns', 'Enter in the box looks the name up');
await backToDns();

console.log('\n== Polling and focus ==');
await refresh(300);
await filterBox().focus();
const before = mock.dnsCalls;
await page.waitForTimeout(10600);
check(mock.dnsCalls === before && await page.evaluate(() => document.activeElement?.placeholder?.startsWith('Filter zones')), 'a focused text box pauses the polling, so typing is never interrupted', `${before} -> ${mock.dnsCalls}`);
await page.evaluate(() => document.activeElement.blur());
await page.waitForTimeout(10600);
check(mock.dnsCalls > before, 'the page polls again (every 10 s) once the box loses the focus', `${before} -> ${mock.dnsCalls}`);
//#endregion

//#region Findings that need other data
console.log('\n== findings from other data ==');
const ub = load('unbound');
let r = clone(ub); r.stats.rcodes = { NOERROR: 800, SERVFAIL: 200 }; r.stats.bogus = 0; r.stats.ratelimited = 0;
await show(r);
b = await banner();
check(/20% of the answers are SERVFAIL \(200 of 1,000\)/.test(b) && (await bannerClass()).includes('warn'), 'SERVFAIL above 5% is reported', b);
check(/SERVFAIL/.test(await text(cardOf('Activity'))) && await page.locator('.dns-act .meter .fill').count() > 3, 'and the Activity card shows the code with a bar');
r = clone(ub); r.dnssec = { supported: true, enabled: false }; r.config.rebind_protection = '0'; r.forwards[0].tls = false; r.stats.bogus = 0; r.stats.ratelimited = 0;
await show(r);
b = await banner();
x = await tile('DNSSEC');
check(x.value === 'Off' && /text-warning/.test(x.cls), 'DNSSEC off: the tile is amber');
check(/DNSSEC validation is off/.test(b) && /Rebind protection is off/.test(b) && /clear text to a public resolver \(2a06:98c1:54::1c:8e39, 2606:4700:4700::1111, 1\.1\.1\.1, …\)/.test(b), 'DNSSEC off, rebind protection off and a clear-text default forwarder are reported', b);
check(await picked('Rebind protection') === 'Off' && (await text(fwd)).includes('clear text'), 'the configuration and the forwarders show it too');
r = clone(ub); r.truncated.forwards = true; r.stats.bogus = 0; r.stats.ratelimited = 0; r.forwards = r.forwards.slice(0, 20);
await show(r);
check(/only the first 500 are shown/.test(await banner()) && /\(cut\)/.test(await text(fwd.locator('.card-header'))), 'a cut list is said');
await show(ub);

console.log('\n== Unbound without extended statistics (the main router) ==');
await show(load('unbound-basic'));
x = await tile('Queries');
check(x.value === '2,011' && x.sub === `since start · ${(2011 / (618 / 60)).toFixed(1) < 10 ? (2011 / (618 / 60)).toFixed(1) : Math.round(2011 / (618 / 60))} per minute`, 'queries and the rate', `${x.value} | ${x.sub}`);
check((await tile('Answered from cache')).value === '29%' && (await tile('Resolution time')).value === '45.9 ms', 'cache share and resolution time come from the totals');
b = await banner();
check(/Rebind protection is off/.test(b) && !/answers failed/.test(b), 'the finding follows the option', b);
const act2 = cardOf('Activity');
check(await act2.locator('th', { hasText: 'Answer code' }).count() === 0 && /extended_stats '1'/.test(await text(act2)) && !/DNSSEC secure|Unwanted/.test(await text(act2)), 'no answer-code table, and the card says how to get one; counters that are absent are not shown as zero');
check((await tile('Upstream servers')).value === '4', 'upstream servers: four Cloudflare forwarders, no WAN one');
await shot('unbound-basic');

console.log('\n== Unbound without unbound-control ==');
await show(load('unbound-nocontrol'));
b = await banner();
check((await bannerClass()).includes('warn') && /unbound-control is not enabled/.test(b) && /option unbound_control '1' in \/etc\/config\/unbound/.test(b), 'the banner says how to enable it', b);
check((await tile('Queries')).value === '–' && (await tile('Answered from cache')).value === '–' && (await tile('Resolution time')).value === '–' && (await tile('Resolver')).value === 'Unbound', 'the counter tiles show a dash; the resolver is still known');
check((await tile('DNSSEC')).value === 'Off', 'DNSSEC follows the option');
check(/The resolver reports no counters/.test(await text(cardOf('Activity'))) && /come from Unbound's generated configuration/.test(await text(fwd)) && /90 forward rules/.test(await text(fwd.locator('.card-header'))), 'the Activity card says so and the forwarders come from the generated configuration');
check((await cardOf('Forwarding').locator('.dns-server').first().innerText()).includes('2a06:98c1:54::1c:8e39') && await cardOf('Forwarding').locator('.dns-server').filter({ hasText: 'TLS' }).count() === 4, 'TLS is still known for the default forwarders');

console.log('\n== many forwarders, many sockets ==');
await show(load('unbound-many'));
check(/\(cut\)/.test(await text(cardOf('Forwarding').locator('.card-header'))) && /\(cut\)/.test(await text(cardOf('Listening and configuration').locator('.card-header'))) && await page.locator('.dns-sock').count() === 25, 'cut lists are marked; 60 sockets cut at 50 leave 25 addresses', String(await page.locator('.dns-sock').count()));
check(/Conditional zones \(499\)/i.test(await text(cardOf('Forwarding'))) && (await zoneRows().count()) === 1 && /^499 zones/.test((await texts(zoneRows()))[0]), 'five hundred identical zones are one group line', (await texts(zoneRows())).join(' | ').slice(0, 100));
//#endregion

//#region dnsmasq
console.log('\n== dnsmasq (the GL-X3000) ==');
await show(load('dnsmasq'));
x = await tile('Resolver');
check(x.value === 'dnsmasq' && x.sub === `2.93 · up ${span(facts.dmAge)}`, 'resolver: dnsmasq, version and uptime', `${x.value} | ${x.sub}`);
x = await tile('Queries');
check(x.value === '1,382' && x.sub === `since start · ${(1382 / (facts.dmAge / 60)).toFixed(1)} per minute`, 'queries: forwarded plus answered locally', `${x.value} | ${x.sub}`);
x = await tile('Answered locally');
check(x.value === '59%' && x.sub === 'from the cache and local names · 568 forwarded', 'the share dnsmasq answered itself, with its own label', `${x.value} | ${x.sub}`);
x = await tile('Forwarded upstream');
check(x.value === '568' && /does not report resolution times/.test(x.sub), 'no resolution time: the forwarded count instead', `${x.value} | ${x.sub}`);
x = await tile('Upstream servers');
check(x.value === '4' && x.sub === '2 default forwarders · 2 from the WAN', 'upstream servers', `${x.value} | ${x.sub}`);
x = await tile('DNSSEC');
check(x.value === 'Not supported' && /no DNSSEC/.test(x.sub) && !/text-warning/.test(x.cls), 'DNSSEC not supported by the build (neutral)', `${x.value} | ${x.sub}`);
b = await banner();
check((await bannerClass()).includes('info') && /no DNSSEC support/.test(b) && /forwarded in clear text to a public resolver \(127\.0\.0\.1#5053, 1\.1\.1\.1\)/.test(b) && !/Rebind/.test(b), 'findings: information only (no DNSSEC in the build, a public server in clear text)', b);
chips = await texts(page.locator('.dns-sock'));
check(chips.length === 6 && chips.every(c => c.includes('TCP/UDP')) && chips.some(c => c.startsWith('[fe80::9683:c4ff:fea3:9530]:53')) && chips.some(c => c.startsWith('192.168.8.1:53')), 'six listening addresses (IPv6 in brackets), no DHCP socket', chips.join(' | '));
defs = await texts(cardOf('Forwarding').locator('.blk').first().locator('.dns-server'));
check(defs.length === 2 && defs[0] === '127.0.0.1#5053' && defs[1].startsWith('1.1.1.1') && defs[1].includes('clear text'), 'default forwarders: the local proxy, and a public server marked clear text', defs.join(' | '));
rows = await texts(zoneRows());
check(rows.length === 2 && rows[0].startsWith('16 zones') && rows[0].includes('10.0.2.4') && rows[1].startsWith('lab.formicalab.casa') && rows[1].includes('192.168.1.1'), 'conditional zones: sixteen to one server in a group, one to another', rows.join(' | '));
const dfwd = cardOf('Forwarding');
check(/Every forwarder is a "server" entry of the dnsmasq section in \/etc\/config\/dhcp/.test(await text(dfwd.locator('.dns-fwd-bar'))) && rows.every(r => r.includes('UCI')) && !(await text(dfwd)).includes('unbound_ext.conf') && await dfwd.locator('button.dns-act-btn').count() === 6 && await dfwd.locator('button.dns-act-btn:not([disabled])').count() === 0 && await dfwd.locator('.fl-badge', { hasText: 'UCI' }).first().getAttribute('title') === 'A server entry of the dnsmasq section in /etc/config/dhcp.', 'dnsmasq: every forwarder is a UCI server entry, each with disabled Edit and Remove buttons; nothing mentions the extension file', rows.join(' | '));
const dact = await texts(cardOf('Activity').locator('tbody tr'));
check(dact.length === 8 && dact[0].startsWith('Forwarded upstream') && dact[0].includes('568') && dact.some(r => r.startsWith('No answer from upstream') && r.includes('7')) && dact.some(r => r.startsWith('Cache size') && r.includes('1,000')), 'dnsmasq counters: eight rows', dact.join(' | '));
check(!/NOERROR|extended_stats/.test(await text(cardOf('Activity'))) && /reports neither answer codes nor resolution times/.test(await text(cardOf('Activity'))), 'no answer codes for dnsmasq, and the card says why');
const dconf = await text(cardOf('Listening and configuration'));
const cache = await ctl('Cache size \\(names\\)').locator('input').evaluate(i => ({ type: i.type, value: i.value }));
const exceptions = await ctl('Rebind exceptions').locator('input').evaluateAll(i => i.map(x => x.value));
check(cache.type === 'number' && cache.value === '1000' && await chk('Ask servers in order').locator('input').isChecked() && /\/etc\/config\/dhcp/.test(dconf) && exceptions[0] === 'lab.formicalab.casa' && exceptions.length === 17 && exceptions[1].startsWith('blob'), 'dnsmasq options: the set ones, and a long list shown in full, one box per value', `${cache.value} ${exceptions.length} ${exceptions.slice(0, 3)}`);
r = clone(load('dnsmasq')); delete r.config.rebind_protection;
await show(r);
check(await chk('Rebind protection').locator('input').isChecked(), 'an option that is not set takes its default (a checked box here)');
await show(load('dnsmasq'));
check(same(await texts(cardOf('Upstream from the WAN').locator('.dns-server')), ['10.133.106.38', '10.128.28.16']) && /ignores|asks them/.test(await text(cardOf('Upstream from the WAN'))), 'the WAN resolvers');
await shot('dnsmasq');
r = clone(load('dnsmasq')); r.stats.unanswered = 50;
await show(r);
check(/50 of 568 forwarded queries \(8\.8%\) got no answer/.test(await banner()) && (await bannerClass()).includes('warn'), 'many unanswered queries are a warning', await banner());
r = clone(load('dnsmasq')); r.forwards = []; r.upstream = [];
await show(r);
check((await bannerClass()).includes('bad') && /no upstream servers/.test(await banner()) && (await tile('Upstream servers')).value === '0' && /text-danger/.test((await tile('Upstream servers')).cls), 'no upstream server at all is critical, and the tile is red');
r = clone(load('dnsmasq')); r.stats = null; r.engines.dnsmasq.stats = null; r.warnings = ['dnsmasq reported no counters: its ubus object dnsmasq.metrics did not answer (dnsmasq must be built with UBus).'];
await show(r);
check(/reports no counters/.test(await banner()) && (await tile('Queries')).value === '–', 'no dnsmasq metrics are said, once', await banner());
r = clone(load('dnsmasq')); r.dnssec = { supported: true, enabled: false };
await show(r);
check(/option dnssec '1' in \/etc\/config\/dhcp/.test(await banner()) && (await tile('DNSSEC')).value === 'Off', 'a dnsmasq with DNSSEC support but off is a warning');

console.log('\n== both engines ==');
await show(load('both'));
x = await tile('Resolver');
check(x.value === 'Unbound' && /dnsmasq also runs \(port 5353\)/.test(x.sub), 'Unbound is the resolver; the tile says dnsmasq runs too', x.sub);
b = await banner();
check(/dnsmasq also runs \(port 5353\) next to Unbound, which answers on port 53/.test(b) && (await bannerClass()).includes('info') || /dnsmasq also runs/.test(b), 'the banner reports the second engine', b);
chips = await texts(page.locator('.dns-sock'));
check(chips.length === 4 && chips.some(c => c.startsWith('0.0.0.0:53') && c.includes('Unbound')) && chips.some(c => c.startsWith('127.0.0.1:5353') && c.includes('dnsmasq')) && chips.some(c => c.startsWith('[::1]:5353')), 'sockets of both, tagged with their engine', chips.join(' | '));
await shot('both');

console.log('\n== stopped and none ==');
await show(load('stopped'));
x = await tile('Resolver');
check(x.value === 'Stopped' && /text-danger/.test(x.cls) && /Unbound is installed but not running/.test(x.sub), 'a stopped resolver', `${x.value} | ${x.sub}`);
check((await bannerClass()).includes('bad') && /Unbound and dnsmasq are installed but not running/.test(await banner()), 'the banner is critical and names both', await banner());
check(/No resolver is listening/.test(await text(cardOf('Listening and configuration'))) && (await tile('Queries')).value === '–' && /not running/.test(await text(cardOf('Listening and configuration').locator('.card-header'))), 'no sockets, no counters, the configuration marked "not running"');
check((await cardOf('Forwarding').count()) === 1 && /Read only/.test(await text(cardOf('Listening and configuration'))), 'the configured forwarders and options are still shown');
await shot('stopped');
await show(load('none'));
x = await tile('Resolver');
check(x.value === 'None' && /text-danger/.test(x.cls) && (await tile('Upstream servers')).value === '–' && (await tile('DNSSEC')).value === '–', 'no resolver: None and dashes', `${x.value}`);
check((await bannerClass()).includes('bad') && /No DNS resolver is running or installed/.test(await banner()), 'the banner is critical');
check((await headers()).join('|').includes('Listening on') && !(await headers()).join('|').includes('configuration') && await cardOf('Forwarding').count() === 0 && await cardOf('Activity').count() === 0 && /No resolver is installed, so there are no counters/.test(await text(page.locator('main'))), 'Forwarding and Activity give way to a sentence, and the card is only Listening on', (await headers()).join(' | '));
check(same(await texts(cardOf('Upstream from the WAN').locator('.dns-server')), ['192.0.2.53']) && await cardOf('Try it').count() === 1, 'the WAN resolvers and Try it remain');
await show(ub);
//#endregion

//#region Style
console.log('\n== style ==');
const FONT = [12, 12.8, 14, 16, 19.2, 24, 28];
const bad = await page.evaluate(sizes => {
  const out = [];
  for (const el of document.querySelectorAll('main *')) {
    if (el instanceof SVGElement) continue;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (!sizes.some(s => Math.abs(s - size) < 0.05)) out.push(`${el.tagName}.${el.className} ${size}px`);
    if (!['400', '600'].includes(cs.fontWeight) && el.childNodes.length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) out.push(`${el.tagName}.${el.className} weight ${cs.fontWeight}`);
  }
  return out;
}, FONT);
check(bad.length === 0, 'every size is on the type scale and every weight is 400 or 600', bad.slice(0, 5).join(' | '));
const mono = await page.evaluate(() => [...document.querySelectorAll('.dns-server .mono')].every(e => getComputedStyle(e).fontFamily === getComputedStyle(document.documentElement).getPropertyValue('--fl-mono').trim() || /mono|consolas|courier/i.test(getComputedStyle(e).fontFamily)));
check(mono, 'addresses are set in the monospace font');
const light = await page.evaluate(() => getComputedStyle(document.querySelector('.card')).backgroundColor);
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(400);
const dark = await page.evaluate(() => getComputedStyle(document.querySelector('.card')).backgroundColor);
check(light !== dark, 'the dark theme changes the surfaces', `${light} / ${dark}`);
check((await tile('Resolver')).value === 'Unbound' && await page.locator('.net-health').count() === 1, 'and the page still draws');
await shot('dark');
await page.emulateMedia({ colorScheme: 'light' });
//#endregion

check(mock.writes.length === 0, 'the page wrote nothing to the router', mock.writes.join());
check([...mock.dnsMethods].join() === 'status' && mock.diagOther.length === 0 && mock.unknownFlab.length === 0, 'the only flab.dns call is status; the Toolbox made no other call than status and the two starts', `${[...mock.dnsMethods]} ${mock.diagOther} ${mock.unknownFlab}`);
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);

// Whether two values are equal as JSON.
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
