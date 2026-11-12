// Browser test of the DNS page. A real browser opens the deployed UI; flab.dns status is answered with the replies the backend
// run produced for each scenario (see mkfx.mjs / assert.mjs), so every tile, finding and card can be driven for both engines,
// for both together, for a stopped and for a missing resolver WITHOUT depending on or touching the router's resolver.
// Everything else (login, system board) goes to the real router; the page only ever reads.
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
const mock = { reply: clone(load('unbound')), dnsCalls: 0, dnsMethods: new Set(), writes: [], unknownFlab: [] };

// A stateful mock of rpcd's uci object for the one config the page edits (the current scenario's `config_section`). The
// committed options are the scenario's plus the changes applied so far; staged edits wait for `apply`; `rollback` restores what
// was there before the apply. Any write to another config is refused and counted in mock.writes, so the test can show the page
// never touched anything else, and nothing here reaches the router.
const uciMock = {
  applied: [], staged: [], backup: null, log: [], failApply: false, engineDown: false,
  // Forgets every edit (a new scenario starts from its own options).
  reset() { this.applied = []; this.staged = []; this.backup = null; },
  // The options of the section: the scenario's, with the applied edits (and the staged ones when asked).
  values(withStaged) {
    const vals = clone(mock.reply.config ?? {});
    for (const op of [...this.applied, ...(withStaged ? this.staged : [])]) {
      if (op.kind === 'set') Object.assign(vals, op.values);
      else for (const o of op.options ?? []) delete vals[o];
    }
    return vals;
  },
  // Answers one call of the uci object, or null for a method the mock does not know.
  call(method, args, ok, denied, invalid) {
    const sec = mock.reply.config_section;
    const own = sec && args?.config === sec.config;
    this.log.push({ method, args: clone(args ?? {}) });
    if (['set', 'delete', 'add'].includes(method) && !own) { mock.writes.push(`uci.${method} ${args?.config}`); return denied; }
    if (method === 'get') return own ? ok({ values: { [sec.name]: { '.type': mock.reply.configured === 'unbound' ? 'unbound' : 'dnsmasq', '.name': sec.name, ...this.values(true) } } }) : ok({ values: {} });
    if (method === 'set') { this.staged.push({ kind: 'set', section: args.section, values: args.values }); return ok({}); }
    if (method === 'delete') { this.staged.push({ kind: 'delete', section: args.section, options: args.options }); return ok({}); }
    if (method === 'changes') {
      const list = this.staged.flatMap(op => op.kind === 'set' ? Object.entries(op.values).map(([k, v]) => ['set', op.section, k, v]) : (op.options ?? []).map(o => ['remove', op.section, o]));
      return ok({ changes: own ? list : [] });
    }
    if (method === 'revert') { this.staged = []; return ok({}); }
    if (method === 'apply') {
      if (this.failApply) return invalid;
      this.backup = clone(this.applied);
      this.applied.push(...this.staged);
      this.staged = [];
      return ok({});
    }
    if (method === 'confirm') { this.backup = null; return ok({}); }
    if (method === 'rollback') { if (this.backup) this.applied = this.backup; this.backup = null; return ok({}); }
    return null;
  },
};

// The JSON-RPC answer for a request the mock handles, or null to let it through to the real router.
function answer(body) {
  const [, obj, method, args] = body.params;
  const ok = data => ({ jsonrpc: '2.0', id: body.id, result: [0, data] });
  const denied = { jsonrpc: '2.0', id: body.id, result: [6] };
  const invalid = { jsonrpc: '2.0', id: body.id, result: [2] };
  if (obj === 'uci') {
    const r = uciMock.call(method, args ?? {}, ok, denied, invalid);
    return r ?? ok({});
  }
  if (obj === 'flab.dns') {
    mock.dnsMethods.add(method);
    mock.dnsCalls++;
    const r = clone(mock.reply);
    // The status reads the configuration fresh, so it shows the edits that were applied; a resolver that "stopped" while an
    // applied change waits for its confirmation is how the test makes a change go wrong.
    if (r.config_section) r.config = uciMock.values(false);
    if (uciMock.engineDown && uciMock.backup && r.engines?.[r.configured]) r.engines[r.configured].running = false;
    return ok(r);
  }
  if (obj.startsWith('flab.') && obj !== 'flab.dns') mock.unknownFlab.push(`${obj}.${method}`);
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
  // A test can replace the permissions (a login that may not write) by keeping them under another key.
  sessionStorage.setItem('acls', sessionStorage.getItem('flab-test-acls') ?? JSON.stringify(granted));
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
const show = async (reply, ms) => { mock.reply = clone(reply); uciMock.reset(); await refresh(ms); };
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `dns-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// The browser's span text of core/format.js fmtSpan.
const span = s => { s = Math.round(s); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h`; };
const zoneRows = () => page.locator('.dns-table tbody tr');
const filterBox = () => page.locator('input[placeholder^="Filter zones"]');

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
check(x.value === '4' && x.sub === '4 default forwarders · 0 from the WAN', 'upstream servers: the default forwarders; the WAN ones are not among the servers in force', `${x.value} | ${x.sub}`);
x = await tile('DNSSEC');
check(x.value === 'Validating' && !/text-warning/.test(x.cls), 'DNSSEC validating');
let b = await banner();
check((await bannerClass()).includes('warn') && /3 answers failed DNSSEC validation/.test(b) && /12 queries were dropped by rate limiting \(300 per second and client\)/.test(b) && /1 conditional zone \(proxy\.dsl\.vodafone\.it\) is forwarded in clear text/.test(b), 'findings: bogus answers, rate limiting and the one clear-text public zone', b);
check(!/clear text to a public resolver/.test(b) && !/SERVFAIL/.test(b), 'the default forwarders over TLS and 1.9% SERVFAIL are not reported', b);
const heads = await headers();
check(['Configuration', 'Forwarding', 'Activity'].every((t, i) => heads[i]?.startsWith(t)) && heads.length === 3 && await page.locator('.dns-try').count() === 0, 'three cards in order: Configuration, Forwarding, Activity; no Upstream from the WAN or Try it card', heads.join(' | '));
check(Math.abs((await cardOf('Activity').boundingBox()).width - (await cardOf('Forwarding').boundingBox()).width) < 2, 'Activity is as wide as Forwarding');
check(await cardOf('Activity').locator('details.dns-fold').evaluate(d => !d.open) && !(await cardOf('Activity').locator('table').first().isVisible()) && (await cardOf('Activity').locator('.dns-chevron').evaluate(c => getComputedStyle(c).transform)) === 'none' && /since the resolver started/.test(await text(cardOf('Activity').locator('.card-header'))), 'the Activity card is folded when the page opens: only its header shows (with the age of the counters), the chevron pointing right');
await cardOf('Activity').locator('summary').click();
await page.waitForTimeout(400);
check(await cardOf('Activity').locator('table').first().isVisible() && (await cardOf('Activity').locator('.dns-chevron').evaluate(c => getComputedStyle(c).transform)) !== 'none', 'clicking its header opens it, and the chevron points down');
await refresh();
check(await cardOf('Activity').locator('details.dns-fold').evaluate(d => d.open), 'it stays open when the page redraws');
const actTables = await cardOf('Activity').locator('table').evaluateAll(t => t.map(x => Math.round(x.getBoundingClientRect().x)));
check(actTables.length === 2 && actTables[1] > actTables[0] + 300, 'the counters and the answer codes sit side by side', actTables.join());
check(Math.abs((await cardOf('Configuration').boundingBox()).width - (await cardOf('Forwarding').boundingBox()).width) < 2 && (await cardOf('Configuration').boundingBox()).y < (await cardOf('Forwarding').boundingBox()).y, 'the configuration card is on top and as wide as Forwarding');

console.log('\n== Listening on ==');
check(j(await texts(cardOf('Configuration').locator('.dns-area-title'))) === '["General","Security and privacy","Local names and DHCP","Performance and cache"]' && j(await cardOf('Configuration').locator('.dns-area').evaluateAll(d => d.map(x => x.open))) === '[false,false,false,false]' && await cardOf('Configuration').locator('.dns-part').count() === 0, 'the options are in four collapsible areas, General first and Security and privacy second, all folded when the page opens; no separate "Listening on" part');
check(!(await page.locator('.dns-sock').first().isVisible()), 'the sockets are inside the folded General area');
await cardOf('Configuration').locator('.dns-area').first().locator('summary').first().click();
let chips = await texts(page.locator('.dns-sock'));
check(chips.length === 2 && chips[0].startsWith('0.0.0.0:53 TCP/UDP') && chips[0].includes('all addresses') && chips[1].startsWith('[::]:53 TCP/UDP') && chips[1].includes('all addresses'), 'one chip per address and port, protocols together, wildcard marked "all addresses"', chips.join(' | '));
const sectionTitles = await texts(cardOf('Configuration').locator('.dns-area').first().locator('.dns-sec-title'));
check(sectionTitles.map(t => t.toLowerCase()).join() === 'service and monitoring,listening on,listening and interfaces', 'General holds the sockets as a "Listening on" section between the service options and the listening options', sectionTitles.join(','));
check((await cardOf('Configuration').locator('.dns-listen .dns-area-legend').boundingBox()).y < (await page.locator('.dns-sock').first().boundingBox()).y, 'the legend sits above the chips');

console.log('\n== Forwarding ==');
const fwd = cardOf('Forwarding');
check(/90 forward rules/.test(await text(fwd.locator('.card-header'))), 'the header counts the rules', await text(fwd.locator('.card-header')));
check(await fwd.locator('details.dns-fold').evaluate(d => !d.open) && !(await zoneRows().first().isVisible()) && (await fwd.locator('.dns-chevron').evaluate(c => getComputedStyle(c).transform)) === 'none', 'the card is folded when the page opens: only its header shows, with the chevron pointing right');
await fwd.locator('summary').click();
await page.waitForTimeout(400);
check(await fwd.locator('details.dns-fold').evaluate(d => d.open) && (await fwd.locator('.dns-chevron').evaluate(c => getComputedStyle(c).transform)) !== 'none' && await zoneRows().first().isVisible(), 'clicking the header opens it, and the chevron points down');
await refresh();
check(await fwd.locator('details.dns-fold').evaluate(d => d.open), 'it stays open when the page redraws');
check((await zoneRows().count()) === 90 && await fwd.locator('.dns-more, .dns-toggle, .dns-group').count() === 0 && !/Group by|List every|Show all|Conditional zones/.test(await text(fwd)), 'one flat list: every forwarder (90) is a row; no groups, no "Show all"', String(await zoneRows().count()));
let rows = await texts(zoneRows());
check(rows[0].startsWith('. (default: every other name)') && await zoneRows().first().locator('.dns-server').count() === 4 && (await texts(zoneRows().first().locator('.dns-server'))).every(d => d.endsWith('TLS')) && (await zoneRows().first().locator('.dns-server').nth(2).innerText()).startsWith('1.1.1.1'), 'the default forwarders are the first row: the four servers, each marked TLS', rows[0]);
const names = rows.slice(1).map(r => r.split(' ')[0]);
check(same(names, [...names].sort((a, b) => a.localeCompare(b))), 'the other rows are sorted by zone');
check(rows.filter(r => r.includes('10.0.252.68') && r.includes('10.1.252.68') && !r.includes('clear text')).length >= 86, 'the Azure zones are one row each, with both servers and no clear-text badge (private addresses)');
check(rows.some(r => r.startsWith('proxy.dsl.vodafone.it') && r.includes('clear text')) && rows.some(r => r.startsWith('lab.formicalab.casa') && r.includes('not DNSSEC-validated')) && rows.some(r => r.startsWith('flumini.formicalab.casa') && r.includes('192.168.8.1')), 'a zone keeps its name, flags and clear-text badge');
await filterBox().fill('vodafone');
check((await zoneRows().count()) === 1 && (await text(zoneRows())).startsWith('proxy.dsl.vodafone.it'), 'the filter narrows the list to one');
check(await page.evaluate(() => document.activeElement?.placeholder?.startsWith('Filter zones')), 'typing in the filter does not take the focus away');
await filterBox().fill('10.1.252.68 privatelink');
check((await zoneRows().count()) === 43, 'every word must match: 43 private-link zones on that server', String(await zoneRows().count()));
await filterBox().fill('zzz');
check(/No forwarder matches the filter/.test(await text(fwd)) && await zoneRows().count() === 0, 'a filter that matches nothing says so');
await filterBox().fill('');
check((await fwd.locator('.dns-legend').first().boundingBox()).y < (await fwd.locator('.dns-table').boundingBox()).y, 'the legend sits above the table');
const bar = await text(fwd.locator('.dns-fwd-bar'));
check(/Read only for now\. 2 forwarders are defined in UCI \(zone sections of \/etc\/config\/unbound\)/.test(bar) && /88 only exist in \/etc\/unbound\/unbound_ext\.conf and stay read only here/.test(bar) && await fwd.locator('.dns-fwd-bar button:has-text("Add forwarder")').isDisabled(), 'the card says what can be changed later (2 UCI forwarders, 88 from the extension file) and has a disabled Add button', bar);
const fileRows = zoneRows().filter({ hasText: 'unbound_ext.conf' });
check((await fileRows.count()) === 88 && !/UCI/.test(await text(fileRows.first())) && await fileRows.first().locator('button.dns-act-btn').count() === 0, 'the 88 zones of the extension file are marked as such and have no edit or remove buttons');
const vod = zoneRows().filter({ hasText: 'proxy.dsl.vodafone.it' });
check(/UCI/.test(await text(vod)) && await vod.locator('button.dns-act-btn').count() === 2 && await vod.locator('button.dns-act-btn:not([disabled])').count() === 0 && await vod.locator('.fl-badge', { hasText: 'UCI' }).getAttribute('title') === 'The zone section fwd_vodafone of /etc/config/unbound.', 'a UCI zone says so (naming its section) and has disabled Edit and Remove buttons', await text(vod));
const defRow = zoneRows().first();
check(await defRow.locator('.fl-badge', { hasText: 'UCI' }).getAttribute('title') === 'The zone section fwd_cloudflare of /etc/config/unbound.' && await defRow.locator('button.dns-act-btn').count() === 2 && await fwd.locator('button.dns-act-btn:not([disabled])').count() === 0, 'the default row shows its UCI section too; no button of the card is enabled');
check(same(await fwd.locator('thead th').allInnerTexts(), ['Zone', 'Forwarded to', 'Flags', 'Defined in']), 'the table has a Defined in column');
const wanBlk = fwd.locator('.blk').filter({ hasText: 'Resolvers from the WAN' });
check(same(await texts(wanBlk.locator('.dns-server')), ['192.0.2.53 not used', '2001:db8:53::1 not used']) && /Unbound does not ask them: it sends queries to its own forwarders/.test(await text(wanBlk)) && /WAN resolvers not used/.test(await text(fwd.locator('.card-header'))), 'the WAN resolvers are in the Forwarding card, above the table, each marked "not used" because no forwarder in force lists them; the header says so too', await text(wanBlk));
check((await wanBlk.boundingBox()).y < (await fwd.locator('.dns-table').boundingBox()).y && Math.abs((await fwd.boundingBox()).width - (await cardOf('Activity').boundingBox()).width) < 2, 'the block sits above the table, in a card as wide as the others');
{
  const used = load('unbound');
  used.forwards.push({ zone: 'wan.example', servers: ['192.0.2.53'], flags: [], tls: false, source: 'file' });
  await show(used);
  check(same(await texts(wanBlk.locator('.dns-server')), ['192.0.2.53 in use', '2001:db8:53::1 not used']) && /Unbound asks some of them through a forward zone with option resolv_conf '1', for wan\.example/.test(await text(wanBlk)) && /some WAN resolvers in use/.test(await text(fwd.locator('.card-header'))), 'a WAN resolver that a forward zone lists is "in use", and the zone is named', await text(wanBlk));
  await show(load('unbound'));
}
await shot('unbound');

console.log('\n== Activity, Configuration ==');
const act = cardOf('Activity');
const actRows = await texts(act.locator('tbody tr'));
check(/since the resolver started 3d 4h ago/.test(await text(act.locator('.card-header'))), 'the age of the counters is in the header');
check(actRows.some(r => r.startsWith('Answered from the cache') && r.includes(num(T.hits)) && r.includes('65%')) && actRows.some(r => r.startsWith('Rate limited') && r.includes('12')) && actRows.some(r => r.startsWith('DNSSEC bogus answers') && r.includes('3')), 'counters with their shares', actRows.join(' | '));
check(actRows.some(r => r.startsWith('NOERROR') && r.includes(num(44100))) && actRows.some(r => r.startsWith('SERVFAIL') && r.includes('910')) && actRows.some(r => r.startsWith('NXDOMAIN')), 'extended statistics: the answer codes', actRows.join(' | '));
check((await act.locator('.dns-legend').boundingBox()).y < (await act.locator('table').first().boundingBox()).y, 'the legend sits above the counters');
const conf = () => cardOf('Configuration');
const areaTitles = await texts(conf().locator('.dns-area-title'));
const areaOpen = () => conf().locator('.dns-area').evaluateAll(d => d.map(x => x.open));
check(j(areaTitles) === '["General","Security and privacy","Local names and DHCP","Performance and cache"]' && j(await areaOpen()) === '[true,false,false,false]', 'General stays open once the user opened it, the others are folded', areaTitles.join(' | '));
const areaSums = await texts(conf().locator('.dns-area-sum'));
check(areaSums.length === 2 && areaSums[0] === 'port 53 · 3 LAN interfaces · remote control: local host, unencrypted · basic statistics' && areaSums[1] === 'DNSSEC on · rebind protection: block private addresses (rfc 1918 and 4193) · local clients only · 300 queries/s per client', 'a folded area still says how it is set: the port, interfaces and monitoring; the security switches', areaSums.join(' // '));
check((await texts(conf().locator('.dns-area-count'))).join() === '14 options,11 options,8 options,5 options', 'each area says how many options it holds');
await conf().locator('.dns-area').nth(1).locator('summary').first().click();
await show(load('unbound'));
check(j(await areaOpen()) === '[true,true,false,false]', 'an area the user opened stays open when the page redraws');
await conf().locator('.dns-area').nth(1).locator('summary').first().click();
check(j(await areaOpen()) === '[true,false,false,false]', 'and folds again');
await page.evaluate(() => document.querySelectorAll('.dns-area').forEach(d => { d.open = true; }));
const chev = await conf().locator('.dns-area > summary .dns-chevron').evaluateAll(c => c.map(x => ({ w: x.getBoundingClientRect().width, t: getComputedStyle(x).transform })));
check(chev.length === 4 && chev.every(c => c.w > 0 && c.t !== 'none'), 'every area header has the chevron that marks it as collapsible, pointing down when open', JSON.stringify(chev));
await conf().locator('.dns-area').nth(3).locator('summary').click();
await page.waitForTimeout(400);
check((await conf().locator('.dns-area').nth(3).locator('summary .dns-chevron').evaluate(x => getComputedStyle(x).transform)) === 'none', 'and right when folded');
await conf().locator('.dns-area').nth(3).locator('summary').click();
const confText = await text(conf());
check(/These are the settings of Unbound in \/etc\/config\/unbound/.test(confText) && /DNSSEC validation/.test(confText) && /Rate limit \(queries per second\)/.test(confText), 'the configuration says what it is and how a change is applied, with plain labels', confText.slice(0, 300));
// A control by its label: the field of a text box, number, drop-down or list, or the checkbox of a yes/no option.
const ctl = label => conf().locator('.set-field').filter({ has: page.locator('label.form-label', { hasText: new RegExp(`^${label}$`) }) });
const chk = label => conf().locator('.set-check').filter({ hasText: new RegExp(`^${label}`) });
const picked = label => ctl(label).locator('select option:checked').innerText();
check(await picked('Rebind protection') === 'Block private addresses (RFC 1918 and 4193)' && await picked('Remote control') === 'Local host, unencrypted' && await picked('Local domain type') === 'Transparent: may forward or recurse' && await picked('DHCP server linked') === 'odhcpd' && await picked('IP protocols') === 'Built-in setting', 'options with a fixed set of values are drop-downs showing the one in force', [await picked('Rebind protection'), await picked('Remote control'), await picked('Local domain type')].join(' | '));
check((await ctl('IP protocols').locator('select option').allInnerTexts()).join('|') === 'Default (Both IPv4 and IPv6)|IPv4 only|IPv6 only (for testing)|IPv4 upstream, IPv4 and IPv6 locally|Both, IPv6 first|Both IPv4 and IPv6|Built-in setting' && await conf().locator('select:not([disabled])').count() === await conf().locator('select.form-select').count() && await conf().locator('select.form-select').count() >= 8, 'a drop-down lists every choice (and the default) and can be changed', String(await conf().locator('select.form-select').count()));
const numberOf = async label => ctl(label).locator('input').evaluate(i => ({ type: i.type, value: i.value, min: i.min, max: i.max, disabled: i.disabled, ph: i.placeholder }));
const rl = await numberOf('Rate limit \\(queries per second\\)'), thr = await numberOf('Threads'), lp = await numberOf('Listen port'), ttl = await numberOf('Minimum TTL \\(s\\)');
check(rl.type === 'number' && rl.value === '300' && rl.min === '0' && !rl.disabled && thr.type === 'number' && thr.value === '4' && thr.min === '1' && lp.type === 'number' && lp.value === '53' && lp.max === '65535' && ttl.type === 'number' && ttl.value === '0' && ttl.max === '1800', 'numbers are number inputs with their range', JSON.stringify([rl, thr, lp, ttl]));
const str = await ctl('Local domain').locator('input').evaluate(i => ({ type: i.type, value: i.value, disabled: i.disabled }));
const prefix = await ctl('DNS64 prefix').locator('input').evaluate(i => ({ value: i.value, ph: i.placeholder }));
check(str.type === 'text' && str.value === 'lab.formicalab.casa' && !str.disabled && prefix.value === '' && prefix.ph === 'default: 64:ff9b::/96', 'a name is a text box; one that is not set is empty and shows its default', JSON.stringify([str, prefix]));
check(await chk('DNSSEC validation').locator('input').isChecked() && !await chk('Extended statistics').locator('input').isChecked() && await conf().locator('.set-check input[disabled]').count() === 0 && await conf().locator('.form-switch, [role=switch]').count() === 0 && await chk('Service enabled').locator('input').isChecked(), 'yes/no options are checkboxes, checked or not, with no switches');
const lan = await ctl('LAN interfaces').locator('input').evaluateAll(i => i.map(x => `${x.value}${x.disabled ? '' : ' (editable)'}`));
check(lan.join() === 'lan,lan100,wg0' && await ctl('LAN interfaces').locator('button:not([disabled])').count() === 0 && await ctl('LAN interfaces').locator('button').count() === 4, 'a list shows one box per value, still read only: its boxes and its add and remove buttons are disabled', lan.join());
check(/refuses forged ones/.test(confText) && /DNS rebinding|reach devices on the LAN/.test(confText), 'important options carry a short explanation');
const secTitles = (await texts(conf().locator('.dns-area').first().locator('.dns-sec-title'))).map(t => t.toLowerCase());
const secSec = (await texts(conf().locator('.dns-area').nth(1).locator('.dns-sec-title'))).map(t => t.toLowerCase());
check(j(secTitles) === '["service and monitoring","listening on","listening and interfaces"]' && j(secSec) === '["access and abuse","rebind protection","privacy","dnssec","rebind exceptions from the files"]' && await conf().locator('.dns-area').first().locator('.set-field, .set-check').count() === 14 && await conf().locator('.dns-area').first().locator('.dns-sec', { hasText: 'Remote control' }).count() === 1 && await conf().locator('.dns-area').nth(1).locator('.dns-sec', { hasText: 'DNSSEC validation' }).count() === 1, 'General holds the monitoring options, where the resolver listens and the listening and interface options; Security and privacy the access, rebind, privacy and DNSSEC ones', `${secTitles} // ${secSec}`);
const optX = await conf().locator('.dns-area').first().locator('.set-fields').first().locator('> *').evaluateAll(n => [...new Set(n.map(x => Math.round(x.getBoundingClientRect().x)))]);
check(optX.length >= 3, 'on a wide screen the options of a section flow in several columns', optX.join());
const priv = conf().locator('.dns-priv-sec');
check(await priv.count() === 1 && /14 domains may resolve to private addresses although rebind protection is on: 1 generated by UCI for the local names and 13 listed in \/etc\/unbound\/unbound_srv\.conf\. There is no UCI option for this list/.test(await text(priv)) && await priv.locator('details.dns-priv').evaluate(d => !d.open), 'Security and privacy says how many domains are exempt from rebind protection, where they come from, that there is no UCI option for them, and keeps the list folded', await text(priv));
await priv.locator('summary').click();
const privNames = await texts(priv.locator('.dns-priv-list span'));
check(privNames.length === 14 && privNames[0] === 'api.azureml.ms' && privNames.includes('lab.formicalab.casa') && privNames.includes('proxy.dsl.vodafone.it') && await priv.locator('.dns-priv-list span', { hasText: /^lab\.formicalab\.casa$/ }).getAttribute('title') === 'Generated by UCI for the local names' && await priv.locator('.dns-priv-list span', { hasText: /^formicalab\.casa$/ }).getAttribute('title') === 'Listed in /etc/unbound/unbound_srv.conf', 'opened, it lists the domains alphabetically, each saying whether UCI or the file gave it', privNames.slice(0, 4).join());
await priv.locator('summary').click();

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
check((await cardOf('Forwarding').locator('.dns-table .dns-server').first().innerText()).includes('2a06:98c1:54::1c:8e39') && await cardOf('Forwarding').locator('.dns-table .dns-server').filter({ hasText: 'TLS' }).count() === 4, 'TLS is still known for the default forwarders');

console.log('\n== many forwarders, many sockets ==');
await show(load('unbound-many'));
check(/500 forward rules \(cut\)/.test(await text(cardOf('Forwarding').locator('.card-header'))) && /\(cut\)/.test(await text(cardOf('Configuration').locator('.card-header'))) && await page.locator('.dns-sock').count() === 25, 'cut lists are marked; 60 sockets cut at 50 leave 25 addresses', String(await page.locator('.dns-sock').count()));
check((await zoneRows().count()) === 500, 'every forwarder the router listed is a row, however many (500)', String(await zoneRows().count()));
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
const defs = await texts(zoneRows().first().locator('.dns-server'));
check(defs.length === 2 && defs[0] === '127.0.0.1#5053' && defs[1].startsWith('1.1.1.1') && defs[1].includes('clear text'), 'default forwarders: the local proxy, and a public server marked clear text', defs.join(' | '));
rows = await texts(zoneRows());
check(rows.length === 18 && rows.filter(r => r.includes('10.0.2.4')).length === 16 && rows.some(r => r.startsWith('lab.formicalab.casa') && r.includes('192.168.1.1')), 'forwarders: the default row, sixteen zones to one server and one to another, each its own row', rows.join(' | '));
const dfwd = cardOf('Forwarding');
check(/Every forwarder is a "server" entry of the dnsmasq section in \/etc\/config\/dhcp/.test(await text(dfwd.locator('.dns-fwd-bar'))) && rows.every(r => r.includes('UCI')) && !(await text(dfwd)).includes('unbound_ext.conf') && await dfwd.locator('button.dns-act-btn').count() === 36 && await dfwd.locator('button.dns-act-btn:not([disabled])').count() === 0 && await dfwd.locator('.fl-badge', { hasText: 'UCI' }).first().getAttribute('title') === 'A server entry of the dnsmasq section in /etc/config/dhcp.', 'dnsmasq: every forwarder is a UCI server entry, each with disabled Edit and Remove buttons; nothing mentions the extension file', rows.join(' | '));
const dact = await texts(cardOf('Activity').locator('tbody tr'));
check(dact.length === 8 && dact[0].startsWith('Forwarded upstream') && dact[0].includes('568') && dact.some(r => r.startsWith('No answer from upstream') && r.includes('7')) && dact.some(r => r.startsWith('Cache size') && r.includes('1,000')), 'dnsmasq counters: eight rows', dact.join(' | '));
check(!/NOERROR|extended_stats/.test(await text(cardOf('Activity'))) && /reports neither answer codes nor resolution times/.test(await text(cardOf('Activity'))), 'no answer codes for dnsmasq, and the card says why');
const dconf = await text(cardOf('Configuration'));
const cache = await ctl('Cache size \\(names\\)').locator('input').evaluate(i => ({ type: i.type, value: i.value }));
const exceptions = await ctl('Rebind exceptions').locator('input').evaluateAll(i => i.map(x => x.value));
check(cache.type === 'number' && cache.value === '1000' && await chk('Ask servers in order').locator('input').isChecked() && /\/etc\/config\/dhcp/.test(dconf) && exceptions[0] === 'lab.formicalab.casa' && exceptions.length === 17 && exceptions[1].startsWith('blob'), 'dnsmasq options: the set ones, and a long list shown in full, one box per value', `${cache.value} ${exceptions.length} ${exceptions.slice(0, 3)}`);
r = clone(load('dnsmasq')); delete r.config.rebind_protection;
await show(r);
check(await chk('Rebind protection').locator('input').isChecked(), 'an option that is not set takes its default (a checked box here)');
await show(load('dnsmasq'));
const dwan = cardOf('Forwarding').locator('.blk').filter({ hasText: 'Resolvers from the WAN' });
check(same(await texts(dwan.locator('.dns-server')), ['10.133.106.38 in use', '10.128.28.16 in use']) && /dnsmasq asks them in addition to its own servers/.test(await text(dwan)) && /WAN resolvers in use/.test(await text(cardOf('Forwarding').locator('.card-header'))), 'dnsmasq: the WAN resolvers are in use (noresolv is not set), and the header says so');
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
check(/No resolver is listening/.test(await text(cardOf('Configuration'))) && (await tile('Queries')).value === '–' && /not running/.test(await text(cardOf('Configuration').locator('.card-header'))), 'no sockets, no counters, the configuration marked "not running"');
check((await cardOf('Forwarding').count()) === 1 && /These are the settings of Unbound/.test(await text(cardOf('Configuration'))), 'the configured forwarders and options are still shown');
await shot('stopped');
await show(load('none'));
x = await tile('Resolver');
check(x.value === 'None' && /text-danger/.test(x.cls) && (await tile('Upstream servers')).value === '–' && (await tile('DNSSEC')).value === '–', 'no resolver: None and dashes', `${x.value}`);
check((await bannerClass()).includes('bad') && /No DNS resolver is running or installed/.test(await banner()), 'the banner is critical');
check((await headers()).join('|').includes('Listening on') && !(await headers()).join('|').includes('configuration') && await cardOf('Forwarding').count() === 0 && await cardOf('Activity').count() === 0 && /No resolver is installed, so there are no counters/.test(await text(page.locator('main'))), 'Forwarding and Activity give way to a sentence, and the card is only Listening on', (await headers()).join(' | '));
check(!/Resolvers from the WAN/.test(await text(page.locator('main'))) && await page.locator('.dns-try').count() === 0, 'without a resolver the WAN resolvers are not shown (they are part of the Forwarding card)');
await show(ub);
//#endregion

//#region Changing the options
console.log('\n== changing the options (Unbound) ==');
const openAll = () => page.evaluate(() => document.querySelectorAll('.dns-area').forEach(d => { d.open = true; }));
const rbar = () => page.locator('.cmdbar .set-bar');
const rateIn = () => ctl('Rate limit \\(queries per second\\)').locator('input');
const saveBtn = () => rbar().locator('button:has-text("Save and apply")');
// Waits for the outcome of a save to show in the banner, and returns its text.
const outcome = async re => { await page.waitForFunction(r => new RegExp(r).test(document.querySelector('.cmdbar .set-bar')?.innerText ?? ''), re.source, { timeout: 20000 }); return text(rbar().locator('.set-bar-outcome')); };
// The values of a call's `set`, with the keys in a fixed order.
const setValues = call => JSON.stringify(Object.fromEntries(Object.entries(call.args.values).sort()));
await show(ub);
await openAll();
check(await rbar().isHidden(), 'with nothing changed there is no review banner');
check(!/null/.test(await text(page.locator('main > :first-child'))) && !/\bnull\b/.test(await text(page.locator('main'))), 'no stray "null" is drawn (the notes that do not apply draw nothing)');
check(await chk('Extended statistics').locator('input').isEnabled() && await rateIn().isEnabled() && await ctl('Rebind protection').locator('select').isEnabled() && await ctl('Local domain').locator('input').isEnabled() && await ctl('LAN interfaces').locator('input').first().isDisabled() && await ctl('Domains without DNSSEC').locator('button').isDisabled(), 'single-valued options can be edited; lists are still read only');
await chk('Extended statistics').locator('input').check();
await rateIn().fill('500');
await ctl('Rebind protection').locator('select').selectOption('2');
await ctl('Local domain').locator('input').fill('lan.example');
check(await rbar().isVisible() && /4 unsaved changes: Extended statistics, Rate limit \(queries per second\), Rebind protection, Local domain/.test(await text(rbar().locator('.set-bar-summary'))), 'editing shows the review banner with the number of changes and which', await text(rbar()));
await rbar().locator('button:has-text("Details")').click();
const changeList = await text(rbar().locator('.set-changes'));
check(/Extended statistics: off → on/.test(changeList) && /Rate limit \(queries per second\): 300 → 500/.test(changeList) && /Rebind protection: Block private addresses \(RFC 1918 and 4193\) → Also this router's own global \/64/.test(changeList) && /Local domain: lab\.formicalab\.casa → lan\.example/.test(changeList), 'the details list each change from → to, with the words of a choice', changeList);
check(await saveBtn().isEnabled() && await rbar().locator('.set-note.bad').count() === 0 && uciMock.log.every(c => c.method !== 'set'), 'Save is available and nothing has been sent to the router yet');
await shot('editing');
await saveBtn().click();
const saved = await outcome(/Saved: the router applied the change/);
const methods = uciMock.log.map(c => c.method);
check(/Saved: the router applied the change and it was confirmed/.test(saved) && methods.indexOf('set') > -1 && methods.indexOf('set') < methods.indexOf('apply') && methods.indexOf('apply') < methods.indexOf('confirm') && !methods.includes('rollback'), 'Save stages the edits, applies them with the rollback countdown and confirms', methods.join());
const setCall = uciMock.log.find(c => c.method === 'set');
check(setCall.args.config === 'unbound' && setCall.args.section === 'ub_main' && setValues(setCall) === '{"domain":"lan.example","extended_stats":"1","rate_limit":"500","rebind_protection":"2"}', 'only the changed options are written, to the unbound section, a boolean as 1', JSON.stringify(setCall.args));
check(j(uciMock.log.find(c => c.method === 'apply').args) === '{"rollback":true,"timeout":30}', 'the change is applied with a 30 second rollback countdown');
check(await chk('Extended statistics').locator('input').isChecked() && await rateIn().inputValue() === '500' && await picked('Rebind protection') === 'Also this router\'s own global /64' && await ctl('Local domain').locator('input').inputValue() === 'lan.example' && await rbar().locator('.set-bar-summary:has-text("No unsaved changes")').count() === 1, 'afterwards the page shows what the router now has, and there is nothing unsaved');

// Emptying an option deletes it; a risky change is warned about before saving.
await openAll();
await rateIn().fill('');
await chk('Local service only').locator('input').uncheck();
const notes = await text(rbar().locator('.set-notes'));
check(/open resolver/.test(notes) && await rbar().locator('.set-note.warn').count() === 1 && await saveBtn().isEnabled(), 'switching off "local service only" is warned about but can still be saved', notes);
uciMock.log.length = 0;
await saveBtn().click();
await outcome(/Saved: the router applied the change/);
const del = uciMock.log.find(c => c.method === 'delete');
check(setValues(uciMock.log.find(c => c.method === 'set')) === '{"localservice":"0"}' && del && j(del.args.options) === '["rate_limit"]' && del.args.section === 'ub_main', 'an emptied option is deleted, and a switch that was on by default is written as 0', j(uciMock.log.map(c => c.method)));
await openAll();
check((await text(ctl('Rate limit \\(queries per second\\)'))).includes('Default') === false && await rateIn().inputValue() === '' && await rateIn().getAttribute('placeholder') === 'default: 0' && !await chk('Local service only').locator('input').isChecked(), 'the emptied option shows its default again, and the switch is off');

// An invalid value stops the save, marks the control and opens the folded area it is in.
await page.evaluate(() => { document.querySelectorAll('.dns-area').forEach(d => { d.open = false; }); });
await page.evaluate(() => { const el = [...document.querySelectorAll('.dns-area .set-field')].find(f => f.querySelector('label')?.textContent === 'Threads').querySelector('input'); el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
check(await saveBtn().isDisabled() && /Threads.*at least 1/.test(await text(rbar().locator('.set-note.bad'))) && await ctl('Threads').locator('input.is-invalid').count() === 1 && (await page.locator('.dns-area').evaluateAll(d => d.map(x => x.open))).filter(Boolean).length === 1, 'an out-of-range number is an error that stops the save, marks the control and opens the folded area', await text(rbar()));
await rbar().locator('button:has-text("Discard edits")').click();
await page.waitForTimeout(600);
check(await rbar().isHidden() && await ctl('Threads').locator('input').inputValue() === '4', 'Discard edits puts back what the router has');

// A change that makes the resolver stop is rolled back, and the edits stay in the form.
uciMock.engineDown = true;
uciMock.log.length = 0;
await openAll();
await ctl('Log verbosity').locator('select').selectOption('2');
await saveBtn().click();
const rolled = await outcome(/rolled back/);
const m2 = uciMock.log.map(c => c.method);
check(/The change was rolled back: Unbound is not running after the change/.test(rolled) && m2.includes('apply') && m2.includes('rollback') && !m2.includes('confirm'), 'a change after which the resolver does not run is rolled back, not confirmed', `${rolled} / ${m2.join()}`);
check(uciMock.applied.length === 3 && uciMock.staged.length === 0 && await rbar().locator('.set-bar-summary:has-text("1 unsaved change")').count() === 1 && await ctl('Log verbosity').locator('select').inputValue() === '2', 'the router keeps its previous settings, nothing stays staged and the edit stays in the form so it can be fixed');
uciMock.engineDown = false;
// A router that refuses the apply: the staged edits are thrown away and nothing is confirmed.
uciMock.failApply = true;
uciMock.log.length = 0;
await saveBtn().click();
await outcome(/uci\.apply failed \(ubus code 2\)/);
const m3 = uciMock.log.map(c => c.method);
check(m3.includes('apply') && m3.includes('revert') && !m3.includes('confirm') && uciMock.staged.length === 0 && await rbar().locator('.set-note.bad').count() >= 1, 'an apply the router refuses reverts what was staged and says so', m3.join());
uciMock.failApply = false;
await rbar().locator('button:has-text("Discard edits")').click();
await page.waitForTimeout(600);

// Changes already staged in the session are reported and can be discarded, and they block a save.
uciMock.staged = [{ kind: 'set', section: 'ub_main', values: { verbosity: '3' } }];
await refresh(900);
check(/1 change\(s\) are already staged in this session/.test(await text(page.locator('main'))), 'changes left staged in the session are reported');
await page.locator('main button:has-text("Discard them")').click();
await page.waitForTimeout(700);
check(uciMock.staged.length === 0 && !/already staged/.test(await text(page.locator('main'))), 'and can be discarded');

// A login that may not write sees everything, read only.
await page.evaluate(() => {
  const a = JSON.parse(sessionStorage.getItem('acls'));
  a.ubus.uci = (a.ubus.uci ?? []).filter(m => !['set', 'add', 'delete', 'revert', 'apply', 'confirm', 'rollback'].includes(m));
  sessionStorage.setItem('flab-test-acls', JSON.stringify(a));
});
await page.reload();
await page.waitForSelector('.tile');
await openAll();
check(await conf().locator('input:not([disabled]), select:not([disabled])').count() === 0 && /this login cannot change them/.test(await text(conf())) && /not allowed to change the configuration/.test(await text(page.locator('main'))), 'a login that may not write sees the settings read only, and is told why', await text(page.locator('main')).then(t => t.slice(0, 200)));
await page.evaluate(() => sessionStorage.removeItem('flab-test-acls'));
await page.reload();
await page.waitForSelector('.tile');

console.log('\n== changing the options (dnsmasq) ==');
await show(load('dnsmasq'));
await openAll();
uciMock.log.length = 0;
const cacheIn = () => ctl('Cache size \\(names\\)').locator('input');
check(await conf().locator('.dns-priv-sec').count() === 0, 'dnsmasq has no private-domain list to show: its exceptions are the editable rebind exceptions option');
await cacheIn().fill('500');
await chk('Ask servers in order').locator('input').uncheck();
await ctl('Local domain').locator('input').fill('lan.example');
check(/3 unsaved changes: Local domain, Ask servers in order, Cache size \(names\)/.test(await text(rbar().locator('.set-bar-summary'))) || /3 unsaved changes/.test(await text(rbar().locator('.set-bar-summary'))), 'dnsmasq: the review banner counts the changes', await text(rbar()));
await saveBtn().click();
await outcome(/Saved: the router applied the change/);
const dset = uciMock.log.find(c => c.method === 'set');
check(dset.args.config === 'dhcp' && dset.args.section === 'cfg01411c' && setValues(dset) === '{"cachesize":"500","domain":"lan.example","strictorder":"0"}', 'dnsmasq options are written to its section of the dhcp config', JSON.stringify(dset.args));
await openAll();
check(await cacheIn().inputValue() === '500' && !await chk('Ask servers in order').locator('input').isChecked(), 'and shown afterwards');
await ctl('Listen port').locator('input').fill('5353');
check(/port 5353 instead of 53/.test(await text(rbar().locator('.set-notes'))), 'dnsmasq: another port is warned about');
await rbar().locator('button:has-text("Discard edits")').click();
await page.waitForTimeout(600);
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

check(mock.writes.length === 0, 'the page wrote to no other config than the one it edits (and the mock never reached the router)', mock.writes.join());
check(uciMock.log.every(c => c.args.config === undefined || ['unbound', 'dhcp'].includes(c.args.config)), 'every uci call named the unbound or the dhcp config', [...new Set(uciMock.log.map(c => c.args.config))].join());
check([...mock.dnsMethods].join() === 'status' && mock.unknownFlab.length === 0, 'the only flab.dns call is status, and no other flab object is called', `${[...mock.dnsMethods]} ${mock.unknownFlab}`);
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);

// Whether two values are equal as JSON.
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
