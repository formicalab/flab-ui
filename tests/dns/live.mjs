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
// The parsed output of scenario `name`.
const load = name => JSON.parse(fs.readFileSync(path.join(work, 'out', `${name}.json`), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(work, 'facts.json'), 'utf8'));
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));
// A value as JSON, for comparing structures.
const j = o => JSON.stringify(o);
// A number the way the page writes it, with thousands separators.
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
  // The options of the main section: the scenario's, with the applied edits (and the staged ones when asked). The `server` list of
  // dnsmasq is kept apart (see servers()), and zone sections are not options.
  values(withStaged) {
    const vals = clone(mock.reply.config ?? {});
    const main = mock.reply.config_section?.name;
    for (const op of [...this.applied, ...(withStaged ? this.staged : [])]) {
      if (op.section !== main) continue;
      if (op.kind === 'set') Object.assign(vals, op.values);
      else for (const o of op.options ?? []) delete vals[o];
    }
    delete vals.server;
    return vals;
  },
  // dnsmasq's `server` entries: the scenario's, with the applied edits of the list (and the staged ones when asked).
  servers(withStaged) {
    let list = (mock.reply.forward_uci ?? []).map(e => e.value);
    const main = mock.reply.config_section?.name;
    for (const op of [...this.applied, ...(withStaged ? this.staged : [])]) {
      if (op.section !== main) continue;
      if (op.kind === 'set' && op.values.server) list = [...op.values.server];
      if (op.kind === 'delete' && op.options?.includes('server')) list = [];
    }
    return list;
  },
  // Unbound's zone sections: the scenario's, with the applied edits (add, set, delete). Each is { section, type, enabled, zones,
  // servers, options } as the plugin reports it.
  zones() {
    const map = new Map((mock.reply.forward_uci ?? []).map(e => [e.section, clone(e)]));
    const main = mock.reply.config_section?.name;
    for (const op of this.applied) {
      if (op.section === main) continue;
      if (op.kind === 'add') {
        const { zone_type: type, enabled, zone_name: zones, server: servers, ...options } = op.values;
        map.set(op.section, { section: op.section, type, enabled: enabled === '1', zones: [...zones], servers: [...(servers ?? [])], options });
      } else if (op.kind === 'set' && map.has(op.section)) {
        const e = map.get(op.section);
        for (const [k, v] of Object.entries(op.values)) {
          if (k === 'enabled') e.enabled = v === '1';
          else if (k === 'zone_name') e.zones = [...v];
          else if (k === 'server') e.servers = [...v];
          else e.options[k] = v;
        }
      } else if (op.kind === 'delete' && map.has(op.section)) {
        if (!op.options) map.delete(op.section);
        else for (const o of op.options) { const e = map.get(op.section); if (o === 'server') e.servers = []; else if (o === 'zone_name') e.zones = []; else delete e.options[o]; }
      }
    }
    return [...map.values()];
  },
  // What a status shows after the applied edits: the options, the zones and, for Unbound, the running forwarders of the enabled
  // forward zones (the rows of the extension file stay as they were).
  apply(r) {
    if (!r.config_section) return;
    r.config = this.values(false);
    // Until an edit was applied the scenario's own rows are what the status shows.
    if (!this.applied.length) return;
    if (r.configured === 'dnsmasq') r.forward_uci = this.servers(false).map((value, index) => ({ index, value }));
    if (r.configured !== 'unbound') return;
    const flags = new Map((r.forwards ?? []).map(f => [f.zone, f.flags]));
    r.forward_uci = this.zones();
    r.forwards = [
      ...(r.forwards ?? []).filter(f => f.source !== 'uci'),
      ...r.forward_uci.filter(e => e.enabled && e.type === 'forward_zone').flatMap(e => e.zones.map(zone => ({ zone, servers: e.servers, flags: flags.get(zone) ?? [], tls: e.options.tls_upstream === '1', source: 'uci', section: e.section }))),
    ];
  },
  // Answers one call of the uci object, or null for a method the mock does not know.
  call(method, args, ok, denied, invalid) {
    const sec = mock.reply.config_section;
    const own = sec && args?.config === sec.config;
    this.log.push({ method, args: clone(args ?? {}) });
    if (['set', 'delete', 'add'].includes(method) && !own) { mock.writes.push(`uci.${method} ${args?.config}`); return denied; }
    if (method === 'get') return own ? ok({ values: { [sec.name]: { '.type': mock.reply.configured === 'unbound' ? 'unbound' : 'dnsmasq', '.name': sec.name, ...this.values(true) } } }) : ok({ values: {} });
    if (method === 'set') { this.staged.push({ kind: 'set', section: args.section, values: args.values }); return ok({}); }
    if (method === 'add') { this.staged.push({ kind: 'add', section: args.name, type: args.type, values: args.values }); return ok({ section: args.name }); }
    if (method === 'delete') { this.staged.push({ kind: 'delete', section: args.section, options: args.options }); return ok({}); }
    if (method === 'changes') {
      const list = this.staged.flatMap(op => op.kind === 'add' ? [['add', op.section, op.type]]
        : op.kind === 'set' ? Object.entries(op.values).map(([k, v]) => ['set', op.section, k, v]) : (op.options ?? [null]).map(o => (o ? ['remove', op.section, o] : ['remove', op.section])));
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
  // Wraps data as a successful JSON-RPC result.
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
    if (r.config_section) uciMock.apply(r);
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
// The labels of all the tiles.
const tileLabels = () => page.locator('.tile .label').allInnerTexts().then(t => t.map(x => x.trim()));
// The text of the network health banner.
const banner = () => page.locator('.net-health').first().innerText().then(t => t.replace(/\s+/g, ' ').trim());
// The CSS classes of the network health banner, which carry its severity.
const bannerClass = () => page.locator('.net-health').first().getAttribute('class');
// The card whose header contains `title`.
const cardOf = title => page.locator('.card').filter({ has: page.locator('.card-header', { hasText: title }) });
// The headers of all the cards.
const headers = () => page.locator('.card-header').allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
// The text of an element with its white space collapsed.
const text = loc => loc.innerText().then(t => t.replace(/\s+/g, ' ').trim());
// The texts of all the matching elements, each with its white space collapsed.
const texts = loc => loc.allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
// Clicks Refresh and waits `ms` for the page to redraw.
const refresh = async (ms = 700) => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(ms); };
// Shows a reply: sets the mock and refreshes.
const show = async (reply, ms) => { mock.reply = clone(reply); uciMock.reset(); await refresh(ms); };
// Saves a full-page screenshot named after `label`, when a screenshot folder is set.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `dns-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// The browser's span text of core/format.js fmtSpan.
const span = s => { s = Math.round(s); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h`; };
// All the rows of the zones table.
const zoneRows = () => page.locator('.dns-table tbody tr');
// The rows as text, without the number of the first column.
const zoneTexts = async () => (await texts(zoneRows())).map(r => r.replace(/^\d+\s+/, ''));
// The row of the zone with this name (a section of /etc/config/unbound).
const zoneRow = name => zoneRows().filter({ has: page.locator('.dns-zone-name', { hasText: new RegExp(`^${name}$`) }) });
// The text box that filters the zones.
const filterBox = () => page.locator('input[placeholder^="Filter zones"]');

//#region Unbound
await page.goto(`${baseUrl}#dns`);
await page.waitForSelector('.tile', { timeout: 20000 });
console.log('== Unbound with extended statistics ==');
const nav = (await page.locator('.nav-pane a.nav-link-fl').allInnerTexts()).map(t => t.trim());
check(nav.indexOf('DNS') === nav.indexOf('DHCP') + 1 && nav.indexOf('Dynamic DNS') === nav.indexOf('DNS') + 1 && (await page.locator('.nav-pane a.active').innerText()).trim() === 'DNS', 'DNS is in the navigation after DHCP and before Dynamic DNS, and active', nav.join(' | '));
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
check(['Configuration', 'Zones', 'Activity'].every((t, i) => heads[i]?.startsWith(t)) && heads.length === 3 && await page.locator('.dns-try').count() === 0, 'three cards in order: Configuration, Zones, Activity; no Forwarding, Upstream from the WAN or Try it card', heads.join(' | '));
check(Math.abs((await cardOf('Activity').boundingBox()).width - (await cardOf('Zones').boundingBox()).width) < 2, 'Activity is as wide as Zones');
{
  const state = cardOf('Configuration').locator('.card-header .fl-badge');
  check(await state.count() === 1 && (await text(state)) === 'Unbound running' && /\bsuccess\b/.test(await state.getAttribute('class')) && /answers on port 53/.test(await state.getAttribute('title')) && /\/etc\/config\/unbound/.test(await text(cardOf('Configuration').locator('.card-header .sub'))), 'the header of the Configuration card says in green that Unbound is running (like the daemon card of the DHCP page), with the file and the sockets beside it', await text(cardOf('Configuration').locator('.card-header')));
}
check(await cardOf('Activity').locator('details.dns-fold').evaluate(d => !d.open) && !(await cardOf('Activity').locator('table').first().isVisible()) && (await cardOf('Activity').locator('.dns-chevron').evaluate(c => getComputedStyle(c).transform)) === 'none' && /since the resolver started/.test(await text(cardOf('Activity').locator('.card-header'))), 'the Activity card is folded when the page opens: only its header shows (with the age of the counters), the chevron pointing right');
await cardOf('Activity').locator('summary').click();
await page.waitForTimeout(400);
check(await cardOf('Activity').locator('table').first().isVisible() && (await cardOf('Activity').locator('.dns-chevron').evaluate(c => getComputedStyle(c).transform)) !== 'none', 'clicking its header opens it, and the chevron points down');
await refresh();
check(await cardOf('Activity').locator('details.dns-fold').evaluate(d => d.open), 'it stays open when the page redraws');
const actTables = await cardOf('Activity').locator('table').evaluateAll(t => t.map(x => Math.round(x.getBoundingClientRect().x)));
check(actTables.length === 2 && actTables[1] > actTables[0] + 300, 'the counters and the answer codes sit side by side', actTables.join());
check(Math.abs((await cardOf('Configuration').boundingBox()).width - (await cardOf('Zones').boundingBox()).width) < 2 && (await cardOf('Configuration').boundingBox()).y < (await cardOf('Zones').boundingBox()).y, 'the configuration card is on top and as wide as Zones');

console.log('\n== Listening on ==');
check(j(await texts(cardOf('Configuration').locator('.dns-area-title'))) === '["General","Security and privacy","Local names and DHCP","Performance and cache"]' && j(await cardOf('Configuration').locator('.dns-area').evaluateAll(d => d.map(x => x.open))) === '[false,false,false,false]' && await cardOf('Configuration').locator('.dns-part').count() === 0, 'the options are in four collapsible areas, General first and Security and privacy second, all folded when the page opens; no separate "Listening on" part');
check(!(await page.locator('.dns-sock').first().isVisible()), 'the sockets are inside the folded General area');
await cardOf('Configuration').locator('.dns-area').first().locator('summary').first().click();
let chips = await texts(page.locator('.dns-sock'));
check(chips.length === 2 && chips[0].startsWith('0.0.0.0:53 TCP/UDP') && chips[0].includes('all addresses') && chips[1].startsWith('[::]:53 TCP/UDP') && chips[1].includes('all addresses'), 'one chip per address and port, protocols together, wildcard marked "all addresses"', chips.join(' | '));
const sectionTitles = await texts(cardOf('Configuration').locator('.dns-area').first().locator('.dns-sec-title'));
check(sectionTitles.map(t => t.toLowerCase()).join() === 'service and monitoring,listening on,listening and interfaces', 'General holds the sockets as a "Listening on" section between the service options and the listening options', sectionTitles.join(','));
check((await cardOf('Configuration').locator('.dns-listen .dns-area-legend').boundingBox()).y < (await page.locator('.dns-sock').first().boundingBox()).y, 'the legend sits above the chips');

console.log('\n== Zones ==');
const zc = cardOf('Zones');
check(/Unbound · 92 zones · 93 domains/.test(await text(zc.locator('.card-header'))), 'the header counts the zones (blocks) and their domains', await text(zc.locator('.card-header')));
check(await zc.locator('details.dns-fold').evaluate(d => !d.open) && !(await zoneRows().first().isVisible()) && (await zc.locator('.dns-chevron').evaluate(c => getComputedStyle(c).transform)) === 'none', 'the card is folded when the page opens: only its header shows, with the chevron pointing right');
await zc.locator('summary.card-header').click();
await page.waitForTimeout(400);
check(await zc.locator('details.dns-fold').evaluate(d => d.open) && (await zc.locator('.dns-chevron').evaluate(c => getComputedStyle(c).transform)) !== 'none' && await zoneRows().first().isVisible(), 'clicking the header opens it, and the chevron points down');
await refresh();
check(await zc.locator('details.dns-fold').evaluate(d => d.open), 'it stays open when the page redraws');
check(same(await zc.locator('thead th').allInnerTexts(), ['#', 'Zone', 'Domains', 'Servers', 'Flags', 'Defined in']), 'the table has a column for the position, the zone, its domains, servers, flags and where it is defined');
let rows = await zoneTexts();
check((await zoneRows().count()) === 92 && rows.slice(0, 4).map(r => r.split(' ')[0]).join() === 'auth_icann,fwd_cloudflare,fwd_google,fwd_vodafone', 'one row per zone, in the order of the configuration: the 4 blocks of /etc/config/unbound, then the 88 zones of the extension file', String(await zoneRows().count()));
check(same(await texts(zoneRows().locator('td.dns-order')), Array.from({ length: 92 }, (_, i) => String(i + 1))) && /read after every block/.test(await zoneRows().nth(10).locator('td.dns-order').getAttribute('title')) && /longest matching domain wins/.test(await zc.locator('thead th').first().getAttribute('title')), 'the first column numbers them 1 to 92 (the extension file after the blocks), and says that the longest matching domain decides which zone answers');
const cfRow = zoneRow('fwd_cloudflare');
check(/Forward/.test(await text(cfRow.locator('td').nth(1))) && /^\. \(every other name\)/.test(await text(cfRow.locator('td').nth(2))) && await cfRow.locator('.dns-server').count() === 4 && (await texts(cfRow.locator('.dns-server'))).every(d => d.endsWith('TLS')) && (await cfRow.locator('.dns-server').nth(2).innerText()).startsWith('1.1.1.1'), 'the default forwarders are a forward zone for "." with four servers, each marked TLS', rows[1]);
const ggRow = zoneRows().filter({ hasText: 'fwd_google' });
check(/disabled/.test(await text(ggRow)) && /\. \(every other name\)/.test(await text(ggRow)), 'a disabled block is listed and says so');
const icRow = zoneRows().filter({ hasText: 'auth_icann' });
check(/Authoritative/.test(await text(icRow)) && /lax\.xfr\.dns\.icann\.org/.test(await text(icRow)) && await icRow.locator('.dns-domain').count() === 2 && !/ TLS|clear text/.test(await text(icRow)), 'an authoritative zone shows its type, servers and domains (two here), and no TLS state', await text(icRow));
const vod = zoneRows().filter({ hasText: 'fwd_vodafone' });
check(/clear text/.test(await text(vod)) && /proxy\.dsl\.vodafone\.it/.test(await text(vod)), 'a block keeps its clear-text badge');
const clearBadge = vod.locator('.fl-badge', { hasText: 'clear text' }).first();
const clearTip = await clearBadge.getAttribute('title');
check(/public address/.test(clearTip) && /read every name/.test(clearTip) && /Use TLS/.test(clearTip) && /private addresses are not flagged/.test(clearTip), 'the "clear text" badge explains itself: a public address, no encryption, who can read the names, what to turn on, and that private addresses are not flagged', clearTip);
const insecureBadge = zoneRows().filter({ hasText: 'unbound_ext.conf' }).filter({ hasText: 'lab.formicalab.casa' }).locator('.fl-badge', { hasText: 'not DNSSEC-validated' });
check(/domain_insecure/.test(await insecureBadge.getAttribute('title')) && /Domains without DNSSEC/.test(await insecureBadge.getAttribute('title')), 'the "not DNSSEC-validated" badge says where it comes from');
const legendBox = zc.locator('.dns-labels');
check(await legendBox.isVisible() && await legendBox.locator('summary').count() === 0 && await zc.locator('details.dns-labels').count() === 0 && /what the labels mean/i.test(await text(legendBox.locator('.dns-labels-title'))) && (await legendBox.boundingBox()).y < (await zc.locator('.dns-toolbar').boundingBox()).y && (await zc.locator('.dns-fwd-bar').boundingBox()).y < (await legendBox.boundingBox()).y, '"What the labels mean" is in the header of the card, always visible (no expander), above the toolbar');
const legendText = await text(legendBox);
check(same(await texts(legendBox.locator('dt')), ['clear text', 'TLS', 'not DNSSEC-validated', 'disabled', 'new']) && /public address/.test(legendText) && /Domains without DNSSEC/.test(legendText) && /not saved yet/.test(legendText), 'it explains clear text, TLS, not DNSSEC-validated, disabled and the pending states', legendText.slice(0, 200));
const searchBox = await zc.locator('.dns-toolbar .search').boundingBox();
const addBox = await zc.locator('.dns-toolbar button:has-text("Add zone")').boundingBox();
check(addBox.y < searchBox.y + searchBox.height && addBox.y + addBox.height > searchBox.y && addBox.x > searchBox.x + searchBox.width && addBox.x - (searchBox.x + searchBox.width) < 24 && await zc.locator('.dns-fwd-bar button').count() === 0, 'Add zone is on the toolbar, on the same line as the filter box and right next to it, and no longer in the header');
rows = await zoneTexts();
check(rows.some(r => r.startsWith('unbound_ext.conf') && /lab\.formicalab\.casa/.test(r) && /not DNSSEC-validated/.test(r)) && rows.some(r => r.startsWith('unbound_ext.conf') && /flumini\.formicalab\.casa/.test(r) && /192\.168\.8\.1/.test(r)), 'the zones of the extension file keep their flags');
await filterBox().fill('vodafone');
check((await zoneRows().count()) === 1 && /^\d+ fwd_vodafone/.test(await text(zoneRows())), 'the filter narrows the list to one');
check(await page.evaluate(() => document.activeElement?.placeholder?.startsWith('Filter zones')), 'typing in the filter does not take the focus away');
await filterBox().fill('10.1.252.68 privatelink');
check((await zoneRows().count()) === 43, 'every word must match: 43 zones of the extension file with that server and "privatelink"', String(await zoneRows().count()));
await filterBox().fill('authoritative');
check((await zoneRows().count()) === 1 && /^\d+ auth_icann/.test(await text(zoneRows())), 'the filter also knows the type of a zone');
await filterBox().fill('zzz');
check(/No zone matches the filter/.test(await text(zc)) && await zoneRows().count() === 0, 'a filter that matches nothing says so');
await filterBox().fill('');
check((await zc.locator('.dns-legend').first().boundingBox()).y < (await zc.locator('.dns-table').boundingBox()).y, 'the legend sits above the table');
const bar = await text(zc.locator('.dns-fwd-bar'));
check(/A zone is a block of \/etc\/config\/unbound with the servers and settings for a list of domains: 4 here, for 5 domains\./.test(bar) && /listed in the order of the configuration; the zone with the longest matching domain answers a query/.test(bar) && /88 more only exist in \/etc\/unbound\/unbound_ext\.conf, which is read last, and stay read only here/.test(bar) && await zc.locator('.dns-toolbar button:has-text("Add zone")').isEnabled(), 'the card explains what a zone is, counts them, says in which order they are listed and which one answers, and has an enabled Add zone button', bar);
const fileRows = zoneRows().filter({ hasText: 'unbound_ext.conf' });
check((await fileRows.count()) === 88 && !/UCI/.test(await text(fileRows.first())) && await fileRows.first().locator('button.dns-act-btn').count() === 0, 'the 88 zones of the extension file are marked as such and have no edit or remove buttons');
check(await cfRow.locator('.fl-badge', { hasText: 'UCI' }).getAttribute('title') === 'The zone section fwd_cloudflare of /etc/config/unbound.' && await cfRow.locator('button.dns-act-btn:not([disabled])').count() === 2, 'a block says which section it is, and has an enabled Edit and Remove button');
const wanBlk = zc.locator('.blk').filter({ hasText: 'Resolvers from the WAN' });
check(same(await texts(wanBlk.locator('.dns-server')), ['192.0.2.53 not used', '2001:db8:53::1 not used']) && /Unbound does not ask them: it sends queries to its own forwarders/.test(await text(wanBlk)) && /WAN resolvers not used/.test(await text(zc.locator('.card-header'))), 'the WAN resolvers are in the Zones card, above the table, each marked "not used" because no forwarder in force lists them; the header says so too', await text(wanBlk));
check((await wanBlk.boundingBox()).y < (await zc.locator('.dns-table').boundingBox()).y && Math.abs((await zc.boundingBox()).width - (await cardOf('Activity').boundingBox()).width) < 2, 'the block sits above the table, in a card as wide as the others');
{
  const used = load('unbound');
  used.forwards.push({ zone: 'wan.example', servers: ['192.0.2.53'], flags: [], tls: false, source: 'file' });
  await show(used);
  check(same(await texts(wanBlk.locator('.dns-server')), ['192.0.2.53 in use', '2001:db8:53::1 not used']) && /Unbound asks some of them through a forward zone with option resolv_conf '1', for wan\.example/.test(await text(wanBlk)) && /some WAN resolvers in use/.test(await text(zc.locator('.card-header'))), 'a WAN resolver that a forward zone lists is "in use", and the zone is named', await text(wanBlk));
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
// The Configuration card.
const conf = () => cardOf('Configuration');
const areaTitles = await texts(conf().locator('.dns-area-title'));
// Whether each area of the Configuration card is open.
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
// The checkbox of the yes/no option labeled `label`.
const chk = label => conf().locator('.set-check').filter({ hasText: new RegExp(`^${label}`) });
// The text of the selected entry of the drop-down labeled `label`.
const picked = label => ctl(label).locator('select option:checked').innerText();
check(await picked('Rebind protection') === '1: Block private addresses (RFC 1918 and 4193)' && await picked('Remote control') === '1: Local host, unencrypted' && await picked('Local domain type') === 'Transparent: may forward or recurse' && await picked('DHCP server linked') === 'odhcpd' && await picked('IP protocols') === 'Built-in setting', 'options with a fixed set of values are drop-downs showing the one in force, with its number when the file holds a number', [await picked('Rebind protection'), await picked('Remote control'), await picked('Local domain type')].join(' | '));
{
  // The texts of the entries of the drop-down labeled `label`.
  const numberedTexts = async label => (await ctl(label).locator('select option').allInnerTexts()).map(t => t.trim());
  const rb = await numberedTexts('Rebind protection');
  const vb = await numberedTexts('Log verbosity');
  check(/^Default \(1: /.test(rb[0]) && rb.slice(1).every((t, i) => t.startsWith(`${i}: `)) && rb.length === 5 && vb.slice(1).every((t, i) => t.startsWith(`${i}: `)) && vb.length === 7 && (await numberedTexts('Remote control')).slice(1).every((t, i) => t.startsWith(`${i}: `)), 'every choice that is a number in the file shows it first ("0: Off", "1: …"), the default entry too; the others (IP protocols, local domain type) show words only', `${rb.join(' | ')} // ${vb.join(' | ')}`);
}
check((await ctl('IP protocols').locator('select option').allInnerTexts()).join('|') === 'Default (Both IPv4 and IPv6)|IPv4 only|IPv6 only (for testing)|IPv4 upstream, IPv4 and IPv6 locally|Both, IPv6 first|Both IPv4 and IPv6|Built-in setting' && await conf().locator('select:not([disabled])').count() === await conf().locator('select.form-select').count() && await conf().locator('select.form-select').count() >= 8, 'a drop-down lists every choice (and the default) and can be changed', String(await conf().locator('select.form-select').count()));
// The type, value, limits, disabled state and placeholder of the number box labeled `label`.
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
{
  const g = conf().locator('.set-group');
  const edns = ctl('EDNS buffer \\(bytes\\)');
  const gb = await g.boundingBox();
  const eb = await edns.boundingBox();
  check(await g.count() === 1 && same(await texts(g.locator('.set-check, label.form-label')), ['DNS64 Builds IPv6 addresses for names that only have IPv4 ones, for networks with no IPv4 (RFC 6052).', 'DNS64 prefix']) && Math.abs(gb.y - eb.y) < 3 && gb.x > eb.x, 'DNS64 and its prefix share one cell, in the same row as the options before it (not alone on a row of its own)', `${gb.y} ${eb.y}`);
}
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
check(await picked('Rebind protection') === '0: Off' && (await text(zc)).includes('clear text'), 'the configuration and the zones show it too');
r = clone(ub); r.truncated.forwards = true; r.stats.bogus = 0; r.stats.ratelimited = 0; r.forwards = r.forwards.slice(0, 20);
await show(r);
check(/only the first 500 are shown/.test(await banner()) && /\(cut\)/.test(await text(zc.locator('.card-header'))), 'a cut list is said');
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
check(/The resolver reports no counters/.test(await text(cardOf('Activity'))) && /come from Unbound's generated configuration/.test(await text(zc)) && /90 zones/.test(await text(zc.locator('.card-header'))), 'the Activity card says so and the zones come from the generated configuration');
check((await cardOf('Zones').locator('.dns-table .dns-server').first().innerText()).includes('2a06:98c1:54::1c:8e39') && await cardOf('Zones').locator('.dns-table .dns-server').filter({ hasText: 'TLS' }).count() === 4, 'TLS is still known for the default forwarders');

console.log('\n== many forwarders, many sockets ==');
await show(load('unbound-many'));
check(/413 zones · 1,?000 domains \(cut\)/.test(await text(cardOf('Zones').locator('.card-header'))) && /\(cut\)/.test(await text(cardOf('Configuration').locator('.card-header'))) && await page.locator('.dns-sock').count() === 25, 'cut lists are marked; 60 sockets cut at 50 leave 25 addresses', `${await text(cardOf('Zones').locator('.card-header'))} / ${await page.locator('.dns-sock').count()}`);
check((await zoneRows().count()) === 413, 'two blocks of /etc/config/unbound and 411 zones of the extension file are 413 rows, however many', String(await zoneRows().count()));
const hugeRow = zoneRows().filter({ hasText: 'fwd_huge' });
check(await hugeRow.locator('.dns-domain').count() === 6 && /494 more/.test(await text(hugeRow)) && /500 domains/.test(await text(hugeRow)) && await hugeRow.locator('button.dns-act-btn').count() === 2 && await hugeRow.locator('button.dns-act-btn:not([disabled])').count() === 0 && /cannot be changed here/.test(await hugeRow.locator('.fl-badge', { hasText: 'UCI' }).getAttribute('title')), 'a block with more domains than the page can read is read only: the first six domains, "494 more", and disabled buttons that say why', await text(hugeRow));
await hugeRow.locator('button.dns-toggle').click();
check(await hugeRow.locator('.dns-domain').count() === 500 && /Show fewer/.test(await text(hugeRow)), 'its domains open on request');
await hugeRow.locator('button.dns-toggle').click();
check(await hugeRow.locator('.dns-domain').count() === 6, 'and fold again');
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
const defs = [...await texts(zoneRows().nth(17).locator('.dns-server')), ...await texts(zoneRows().nth(18).locator('.dns-server'))];
check(defs.length === 2 && defs[0] === '127.0.0.1#5053' && defs[1].startsWith('1.1.1.1') && defs[1].includes('clear text'), 'the two default entries come where they are in the list (the end), one entry each: the local proxy, and a public server marked clear text', defs.join(' | '));
rows = await zoneTexts();
check(rows.length === 19 && rows.filter(r => r.includes('10.0.2.4')).length === 16 && rows.some(r => r.includes('lab.formicalab.casa') && r.includes('192.168.1.1')), 'zones: two default entries, sixteen entries to one server and one to another, each its own row', rows.join(' | '));
const dfwd = cardOf('Zones');
check(/Each entry of the server list of dnsmasq in \/etc\/config\/dhcp is a zone: 19 here, for 19 domains/.test(await text(dfwd.locator('.dns-fwd-bar'))) && rows.every(r => r.includes('UCI')) && !(await text(dfwd)).includes('unbound_ext.conf') && await dfwd.locator('button.dns-act-btn').count() === 38 && await dfwd.locator('button.dns-act-btn:not([disabled])').count() === 38 && await dfwd.locator('.fl-badge', { hasText: 'UCI' }).first().getAttribute('title') === 'A server entry of the dnsmasq section in /etc/config/dhcp.' && /Server entry/.test(await text(dfwd.locator('thead'))), 'dnsmasq: every server entry is a zone of UCI with an Edit and a Remove button; nothing mentions the extension file', rows.join(' | '));
check(await text(cardOf('Configuration').locator('.card-header .fl-badge')) === 'dnsmasq running' && /\bsuccess\b/.test(await cardOf('Configuration').locator('.card-header .fl-badge').getAttribute('class')) && /\/etc\/config\/dhcp/.test(await text(cardOf('Configuration').locator('.card-header .sub'))), 'with dnsmasq as the resolver the header says in green that dnsmasq is running');
const dlegend = dfwd.locator('.dns-labels');
check(same(await texts(dlegend.locator('dt')), ['clear text', 'TLS', 'answered locally, never forwarded', 'uses the default servers', 'disabled', 'new']) && /cannot encrypt/.test(await text(dlegend)) && /\/domain\/#/.test(await text(dlegend)), 'dnsmasq: the legend explains its own labels (a clear-text entry cannot be encrypted by dnsmasq; local-only and default servers)', await text(dlegend));
check(/cannot encrypt/.test(await zoneRows().filter({ hasText: '1.1.1.1' }).locator('.fl-badge', { hasText: 'clear text' }).getAttribute('title')), 'and so does the clear-text badge of a dnsmasq server');
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
const dwan = cardOf('Zones').locator('.blk').filter({ hasText: 'Resolvers from the WAN' });
check(same(await texts(dwan.locator('.dns-server')), ['10.133.106.38 in use', '10.128.28.16 in use']) && /dnsmasq asks them in addition to its own servers/.test(await text(dwan)) && /WAN resolvers in use/.test(await text(cardOf('Zones').locator('.card-header'))), 'dnsmasq: the WAN resolvers are in use (noresolv is not set), and the header says so');
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
check(await text(cardOf('Configuration').locator('.card-header .fl-badge')) === 'Unbound not running' && /\bdanger\b/.test(await cardOf('Configuration').locator('.card-header .fl-badge').getAttribute('class')), 'and the badge in its header is red: "Unbound not running"');
check((await cardOf('Zones').count()) === 1 && /These are the settings of Unbound/.test(await text(cardOf('Configuration'))), 'the configured zones and options are still shown');
await shot('stopped');
await show(load('none'));
x = await tile('Resolver');
check(x.value === 'None' && /text-danger/.test(x.cls) && (await tile('Upstream servers')).value === '–' && (await tile('DNSSEC')).value === '–', 'no resolver: None and dashes', `${x.value}`);
check((await bannerClass()).includes('bad') && /No DNS resolver is running or installed/.test(await banner()), 'the banner is critical');
check((await headers()).join('|').includes('Listening on') && !(await headers()).join('|').includes('configuration') && await cardOf('Zones').count() === 0 && await cardOf('Activity').count() === 0 && /No resolver is installed, so there are no counters/.test(await text(page.locator('main'))), 'Zones and Activity give way to a sentence, and the card is only Listening on', (await headers()).join(' | '));
check(!/Resolvers from the WAN/.test(await text(page.locator('main'))) && await page.locator('.dns-try').count() === 0, 'without a resolver the WAN resolvers are not shown (they are part of the Zones card)');
await show(ub);
//#endregion

//#region Changing the options
console.log('\n== changing the options (Unbound) ==');
// Opens every area of the Configuration card.
const openAll = () => page.evaluate(() => document.querySelectorAll('.dns-area').forEach(d => { d.open = true; }));
// The save bar of the command bar.
const rbar = () => page.locator('.cmdbar .set-bar');
// The input of the rate limit option.
const rateIn = () => ctl('Rate limit \\(queries per second\\)').locator('input');
// The "Save and apply" button of the save bar.
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
check(await chk('Extended statistics').locator('input').isChecked() && await rateIn().inputValue() === '500' && await picked('Rebind protection') === '2: Also this router\'s own global /64' && await ctl('Local domain').locator('input').inputValue() === 'lan.example' && await rbar().locator('.set-bar-summary:has-text("No unsaved changes")').count() === 1, 'afterwards the page shows what the router now has, and there is nothing unsaved');

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
await zc.locator('summary.card-header').click();
check(await zc.locator('button.dns-act-btn:not([disabled])').count() === 0 && await zc.locator('button.dns-act-btn').count() > 0 && await zc.locator('.dns-toolbar button:has-text("Add zone")').isDisabled(), 'and so are the Edit, Remove and Add zone buttons of the Zones card');
await page.evaluate(() => sessionStorage.removeItem('flab-test-acls'));
await page.reload();
await page.waitForSelector('.tile');

console.log('\n== changing the options (dnsmasq) ==');
await show(load('dnsmasq'));
await openAll();
uciMock.log.length = 0;
// The input of the cache size option.
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

//#region Changing the zones
console.log('\n== changing the zones (Unbound) ==');
// The main router as it keeps its zones: the Azure, lab and flumini domains in blocks of /etc/config/unbound.
function zonesReply() {
  const r = load('unbound');
  // Moves the forwarding blocks for `zones` from the file to a UCI forward_zone section called `name`.
  const move = (name, zones, servers, options) => {
    r.forward_uci.push({ section: name, type: 'forward_zone', enabled: true, zones, servers, options });
    for (const f of r.forwards) if (zones.includes(f.zone) && f.source === 'file') { f.source = 'uci'; f.section = name; }
  };
  const azure = r.forwards.filter(f => f.source === 'file' && !/^(lab|flumini)\.formicalab\.casa$/.test(f.zone));
  move('fwd_azure', azure.map(f => f.zone), azure[0].servers, { fallback: '0' });
  move('fwd_lab', ['lab.formicalab.casa'], r.forwards.find(f => f.zone === 'lab.formicalab.casa').servers, { fallback: '1' });
  move('fwd_flumini', ['flumini.formicalab.casa'], ['192.168.8.1'], { fallback: '0' });
  return r;
}
const azureFirst = zonesReply().forward_uci.find(e => e.section === 'fwd_azure').zones[0];
// The open zone dialog.
const dlg = () => page.locator('dialog.fl-dialog[open]');
// The Done button of the open dialog.
const doneBtn = () => dlg().locator('button.btn-brand');
// The list field labeled `label` in the open dialog.
const listIn = label => dlg().locator('.set-field').filter({ has: page.locator('label.form-label', { hasText: new RegExp(`^${label}$`) }) });
// The text of the header of the Zones card.
const headerText = () => text(cardOf('Zones').locator('.card-header'));
// The button with the given aria-label in the row of the zone `name`.
const rowButton = (name, label) => zoneRow(name).locator(`button[aria-label="${label}"]`);
await show(zonesReply());
if (!await zc.locator('details.dns-fold').evaluate(d => d.open)) await zc.locator('summary.card-header').click();
await page.waitForTimeout(400);
check(/Unbound · 7 zones · 93 domains/.test(await headerText()) && (await zoneRows().count()) === 7 && (await zoneTexts()).map(r => r.split(' ')[0]).join() === 'auth_icann,fwd_cloudflare,fwd_google,fwd_vodafone,fwd_azure,fwd_lab,fwd_flumini', 'the router as it is configured: 7 zones for 93 domains (the 86 Azure domains are one block), in the order of the configuration', await headerText());
const azRow = zoneRow('fwd_azure');
check(await azRow.locator('.dns-domain').count() === 6 && /80 more/.test(await text(azRow)) && /86 domains/.test(await text(azRow)) && await azRow.locator('.dns-server').count() === 2, 'one block holds the 86 domains: six shown, "80 more", the two servers once');
await azRow.locator('button.dns-toggle').click();
check(await azRow.locator('.dns-domain').count() === 86 && /Show fewer/.test(await text(azRow)), 'they open on request');
await azRow.locator('button.dns-toggle').click();
check(await azRow.locator('.dns-domain').count() === 6, 'and fold again');
check(await rbar().isHidden() && !(await dlg().count()), 'nothing is pending and no dialog is open');

// Escape closes the dialog without changing anything.
await rowButton('fwd_vodafone', 'Edit').click();
await dlg().waitFor();
const dtitle = await text(dlg().locator('.fl-dialog-title'));
const dbody = await text(dlg());
check(dtitle === 'Edit zone fwd_vodafone' && /Forward zone/.test(dbody) && ['Domains', 'Servers', 'Use TLS', 'TLS certificate name', 'TLS port', 'Port', 'Fall back to recursion', 'Local resolver check', 'Also use the WAN resolvers', 'Enabled'].every(t => dbody.includes(t)) && !/Zone files URL/.test(dbody), 'Edit opens a dialog with the fields of a forward zone (and not the URL of an authoritative one); its type is shown, not editable', dtitle);
check(await listIn('Domains').locator('.set-row input').count() === 1 && await listIn('Domains').locator('.set-row input').inputValue() === 'proxy.dsl.vodafone.it' && await listIn('Servers').locator('.set-row input').count() === 2, 'the form holds the values of the block');
check(await doneBtn().isEnabled() && /Update the changes/.test(await text(doneBtn())) && await dlg().locator('select').count() === 1, 'it can be accepted as it is; the only drop-down is "Local resolver check" (the type is fixed)');
await page.keyboard.press('Escape');
await dlg().waitFor({ state: 'detached' });
check(await rbar().isHidden(), 'Escape closes it and nothing changed');

// Editing a block: add a server.
await rowButton('fwd_vodafone', 'Edit').click();
await dlg().waitFor();
await dlg().locator('button:has-text("Add server")').click();
await listIn('Servers').locator('.set-row input').last().fill('91.80.35.1');
await doneBtn().click();
await dlg().waitFor({ state: 'detached' });
check(await rbar().isVisible() && /1 unsaved change: fwd_vodafone: Servers/.test(await text(rbar().locator('.set-bar-summary'))), 'accepting the form puts the change into the review banner', await text(rbar().locator('.set-bar-summary')));
check(/edited/.test(await text(zoneRow('fwd_vodafone'))) && await zoneRow('fwd_vodafone').locator('.dns-server').count() === 3, 'the row shows the new servers and says it is edited');
await rbar().locator('button:has-text("Details")').click();
check(/fwd_vodafone: Servers: 2 servers → 2 servers\|3 servers: \+91\.80\.35\.1|fwd_vodafone: Servers: 2 servers → 3 servers: \+91\.80\.35\.1/.test(await text(rbar().locator('.set-changes'))), 'the details say what was added', await text(rbar().locator('.set-changes')));
check(await rbar().locator('.set-note.warn').count() === 1 && /public server .* in clear text/.test(await text(rbar().locator('.set-notes'))) && await saveBtn().isEnabled(), 'sending queries to public servers in clear text is warned about, not refused');
uciMock.log.length = 0;
await saveBtn().click();
await outcome(/Saved: the router applied the change/);
const zset = uciMock.log.find(c => c.method === 'set');
check(zset.args.config === 'unbound' && zset.args.section === 'fwd_vodafone' && j(zset.args.values) === j({ server: [...zonesReply().forward_uci.find(e => e.section === 'fwd_vodafone').servers, '91.80.35.1'] }) && uciMock.log.map(c => c.method).join().includes('apply,') && j(uciMock.log.find(c => c.method === 'apply').args) === '{"rollback":true,"timeout":30}', 'saving sets the list of that section only, applies it with the 30 second countdown and confirms', j(zset));
check(await rbar().locator('.set-bar-summary:has-text("No unsaved changes")').count() === 1 && !/edited/.test(await text(zoneRow('fwd_vodafone'))) && await zoneRow('fwd_vodafone').locator('.dns-server').count() === 3, 'afterwards the status shows the three servers and nothing is pending');

// A form that is not valid cannot be accepted.
await rowButton('fwd_lab', 'Edit').click();
await dlg().waitFor();
await listIn('Servers').locator('.set-row input').first().fill('bad server');
check(await doneBtn().isDisabled() && /Server "bad server"/.test(await text(dlg().locator('.set-note.bad'))) && await listIn('Servers').locator('input.is-invalid').count() === 1, 'a wrong server stops the form: the error is listed and the input marked');
await dlg().locator('button:has-text("Cancel")').click();
await dlg().waitFor({ state: 'detached' });
check(await rbar().locator('.set-bar-summary:has-text("No unsaved changes")').count() === 1, 'Cancel throws the edit away');

// Switching a block off, and a second default forwarder.
await rowButton('fwd_google', 'Edit').click();
await dlg().waitFor();
await dlg().locator('.set-check', { hasText: 'Enabled' }).locator('input').check();
check(await doneBtn().isDisabled() && /Domain "\." is already taken by fwd_cloudflare/.test(await text(dlg().locator('.set-note.bad'))), 'switching on a second block for the root zone is refused: the other block is named');
await dlg().locator('button:has-text("Cancel")').click();

// Adding a zone: a stub zone, which needs addresses.
await page.click('.dns-toolbar button:has-text("Add zone")');
await dlg().waitFor();
check(/Add a zone/.test(await text(dlg().locator('.fl-dialog-title'))) && await doneBtn().isDisabled() && await dlg().locator('.set-note.bad').count() === 0 && /Add to the changes/.test(await text(doneBtn())), 'Add zone opens an empty form; nothing is flagged before the user starts typing, but it cannot be accepted yet');
check(same(await dlg().locator('select').first().locator('option').allInnerTexts(), ['Forward zone', 'Stub zone', 'Authoritative zone']), 'the type of a new zone is chosen from the three kinds');
await dlg().locator('select').first().selectOption('stub_zone');
const stubBody = await text(dlg());
check(!/Use TLS|TLS certificate name|Zone files URL/.test(stubBody) && /Port/.test(stubBody) && /Asks the authoritative servers/.test(stubBody), 'a stub zone shows the fields of a stub zone only, and says what it does');
await dlg().locator('button:has-text("Add domain")').click();
await listIn('Domains').locator('.set-row input').last().fill('corp.example');
await dlg().locator('button:has-text("Add server")').click();
await listIn('Servers').locator('.set-row input').last().fill('ns.corp.example');
check(await doneBtn().isDisabled() && /must be an IP address/.test(await text(dlg().locator('.set-note.bad'))), 'a stub zone refuses a host name as its server');
await shot('zone-dialog');
await listIn('Servers').locator('.set-row input').last().fill('10.9.9.9');
await listIn('Port').locator('input').fill('5353');
check(await doneBtn().isEnabled() && await dlg().locator('.set-note.bad').count() === 0, 'with an address the form is valid');
await doneBtn().click();
await dlg().waitFor({ state: 'detached' });
check(/1 unsaved change: New zone stub_corp_example/.test(await text(rbar().locator('.set-bar-summary'))) && /new/.test(await text(zoneRow('stub_corp_example'))) && /Stub/.test(await text(zoneRow('stub_corp_example'))), 'the new zone is named from its type and domain, listed as new, and counted in the banner', await text(rbar().locator('.set-bar-summary')));
uciMock.log.length = 0;
await saveBtn().click();
await outcome(/Saved: the router applied the change/);
const zadd = uciMock.log.find(c => c.method === 'add');
check(zadd.args.config === 'unbound' && zadd.args.type === 'zone' && zadd.args.name === 'stub_corp_example' && j(zadd.args.values) === j({ zone_type: 'stub_zone', enabled: '1', zone_name: ['corp.example'], server: ['10.9.9.9'], port: '5353' }), 'saving adds a named section of type zone with only the settings that differ from the defaults', j(zadd?.args));
check(!/new/.test(await text(zoneRow('stub_corp_example'))) && /Stub/.test(await text(zoneRow('stub_corp_example'))) && /8 zones · 94 domains/.test(await headerText()), 'afterwards it is a zone like the others (8 zones, 94 domains)', await headerText());

// A domain that another enabled block already takes.
await page.click('.dns-toolbar button:has-text("Add zone")');
await dlg().waitFor();
await dlg().locator('button:has-text("Add domain")').click();
await listIn('Domains').locator('.set-row input').last().fill(azureFirst);
await dlg().locator('button:has-text("Add server")').click();
await listIn('Servers').locator('.set-row input').last().fill('10.3.3.3');
check(await doneBtn().isDisabled() && new RegExp(`Domain "${azureFirst.replace(/\./g, '\\.')}" is already taken by fwd_azure`).test(await text(dlg().locator('.set-note.bad'))), 'a domain that another enabled zone takes is refused, naming the zone');
await dlg().locator('button:has-text("Cancel")').click();

// Editing the big block: take one domain out.
await rowButton('fwd_azure', 'Edit').click();
await dlg().waitFor();
check(/applies to 86 domains/.test(await text(dlg())) && await listIn('Domains').locator('.set-row input').count() === 86, 'the form of a block with many domains says so, and lists all 86');
await listIn('Domains').locator('.set-row button').first().click();
check(await listIn('Domains').locator('.set-row input').count() === 85 && await doneBtn().isEnabled(), 'a domain is removed with its button');
await doneBtn().click();
await dlg().waitFor({ state: 'detached' });
await rbar().locator('button:has-text("Details")').click();
check(new RegExp(`fwd_azure: Domains: 86 domains → 85 domains: −${azureFirst.replace(/\./g, '\\.')}`).test(await text(rbar().locator('.set-changes'))), 'the details say that one of 86 domains goes', await text(rbar().locator('.set-changes')));
uciMock.log.length = 0;
await saveBtn().click();
await outcome(/Saved: the router applied the change/);
const zdom = uciMock.log.find(c => c.method === 'set');
check(zdom.args.section === 'fwd_azure' && j(Object.keys(zdom.args.values)) === '["zone_name"]' && zdom.args.values.zone_name.length === 85 && !zdom.args.values.zone_name.includes(azureFirst) && /85 domains/.test(await text(zoneRow('fwd_azure'))), 'only the list of domains is written, without that domain', j(Object.keys(zdom.args.values)));

// Removing a zone, restoring it, removing it for good.
await rowButton('fwd_flumini', 'Remove').click();
check(/removed/.test(await text(zoneRow('fwd_flumini'))) && await rowButton('fwd_flumini', 'Keep this zone (undo the removal)').isEnabled() && /1 unsaved change: Remove zone fwd_flumini/.test(await text(rbar().locator('.set-bar-summary'))), 'Remove marks the row and offers to keep it; the banner counts it');
await rowButton('fwd_flumini', 'Keep this zone (undo the removal)').click();
check(await rbar().locator('.set-bar-summary:has-text("No unsaved changes")').count() === 1 && !/removed/.test(await text(zoneRow('fwd_flumini'))), 'keeping it undoes the removal');
await rowButton('fwd_flumini', 'Remove').click();
uciMock.log.length = 0;
await saveBtn().click();
await outcome(/Saved: the router applied the change/);
const zdel = uciMock.log.find(c => c.method === 'delete');
check(zdel.args.section === 'fwd_flumini' && zdel.args.options === undefined && await zoneRow('fwd_flumini').count() === 0 && /7 zones/.test(await headerText()), 'saving deletes the whole section, and the zone is gone', j(zdel?.args));

// Taking the only default forwarder away is warned about.
await rowButton('fwd_cloudflare', 'Remove').click();
check(/No forward zone takes every other name/.test(await text(rbar().locator('.set-notes'))) && await saveBtn().isEnabled(), 'removing the only forwarder of the root zone warns that Unbound will recurse');
await rbar().locator('button:has-text("Discard edits")').click();
await page.waitForTimeout(700);
check(await zoneRow('fwd_cloudflare').count() === 1 && !/removed/.test(await text(zoneRow('fwd_cloudflare'))), 'Discard edits puts the zone back');

// A zone change that makes the resolver stop is rolled back and the edit stays.
await rowButton('fwd_lab', 'Edit').click();
await dlg().waitFor();
await listIn('Servers').locator('.set-row input').first().fill('10.0.252.99');
await doneBtn().click();
await dlg().waitFor({ state: 'detached' });
uciMock.engineDown = true;
uciMock.log.length = 0;
await saveBtn().click();
const zrolled = await outcome(/rolled back/);
const zm = uciMock.log.map(c => c.method);
check(/The change was rolled back: Unbound is not running after the change/.test(zrolled) && zm.includes('rollback') && !zm.includes('confirm') && /1 unsaved change: fwd_lab: Servers/.test(await text(rbar().locator('.set-bar-summary'))), 'a zone change that stops the resolver is rolled back, and the edit stays in the banner', zrolled);
uciMock.engineDown = false;
await rbar().locator('button:has-text("Discard edits")').click();
await page.waitForTimeout(700);

// An authoritative zone: its URL, and a server or the URL is required.
await rowButton('auth_icann', 'Edit').click();
await dlg().waitFor();
const authBody = await text(dlg());
check(/Authoritative zone/.test(authBody) && /Zone files URL/.test(authBody) && !/Use TLS|TLS port/.test(authBody) && await listIn('Domains').locator('.set-row input').count() === 2, 'an authoritative zone shows its URL and not the TLS fields');
await listIn('Zone files URL').locator('input').fill('ftp://x');
check(await doneBtn().isDisabled() && /Zone files URL must be an http or https address/.test(await text(dlg().locator('.set-note.bad'))), 'the URL must be http or https');
await dlg().locator('button:has-text("Cancel")').click();
await dlg().waitFor({ state: 'detached' });

console.log('\n== changing the zones (dnsmasq) ==');
await show(load('dnsmasq'));
check(await rbar().isHidden() && (await zoneRows().count()) === 19, 'dnsmasq: 19 entries, nothing pending');
const labRow = zoneRows().filter({ hasText: '192.168.1.1' });
await labRow.locator('button[aria-label="Edit"]').click();
await dlg().waitFor();
check(/Edit zone/.test(await text(dlg().locator('.fl-dialog-title'))) && /dnsmasq/.test(await text(dlg().locator('.muted').first())) && await listIn('Domains').locator('.set-row input').inputValue() === '*.lab.formicalab.casa' && await listIn('Server').locator('input').inputValue() === '192.168.1.1' && await doneBtn().isEnabled(), 'a dnsmasq entry opens with its domains, what dnsmasq does and its server; an entry written with "*." is valid');
await listIn('Server').locator('input').fill('192.168.1.2');
await doneBtn().click();
await dlg().waitFor({ state: 'detached' });
check(/1 unsaved change: Zone lab\.formicalab\.casa/.test(await text(rbar().locator('.set-bar-summary'))) && /edited/.test(await text(zoneRows().filter({ hasText: '192.168.1.2' }))), 'the entry is edited in the draft', await text(rbar().locator('.set-bar-summary')));
uciMock.log.length = 0;
await saveBtn().click();
await outcome(/Saved: the router applied the change/);
const dm1 = uciMock.log.find(c => c.method === 'set');
const dmBase = load('dnsmasq').forward_uci.map(e => e.value);
check(dm1.args.config === 'dhcp' && dm1.args.section === 'cfg01411c' && dm1.args.values.server.length === 19 && dm1.args.values.server.filter(v => v.endsWith('/192.168.1.2')).length === 1 && j(dm1.args.values.server.filter(v => !v.endsWith('/192.168.1.2'))) === j(dmBase.filter(v => !v.endsWith('/192.168.1.1'))) && dm1.args.values.server.findIndex(v => v.endsWith('/192.168.1.2')) === dmBase.findIndex(v => v.endsWith('/192.168.1.1')), 'saving writes the whole server list of the dnsmasq section with that entry changed in place', j(dm1.args.values.server.slice(0, 3)));
await page.click('.dns-toolbar button:has-text("Add zone")');
await dlg().waitFor();
await dlg().locator('button:has-text("Add domain")').click();
await listIn('Domains').locator('.set-row input').last().fill('new.example');
await listIn('Server').locator('input').fill('a b');
check(await doneBtn().isDisabled() && /Server "a b"/.test(await text(dlg().locator('.set-note.bad'))), 'a wrong server stops the dnsmasq form too');
await dlg().locator('select').selectOption('local');
check(await listIn('Server').count() === 0 && await doneBtn().isEnabled(), 'answering locally needs no server');
await doneBtn().click();
await dlg().waitFor({ state: 'detached' });
await page.click('.dns-toolbar button:has-text("Add zone")');
await dlg().waitFor();
await dlg().locator('button:has-text("Add domain")').click();
await listIn('Domains').locator('.set-row input').last().fill('.');
await listIn('Server').locator('input').fill('9.9.9.9');
await doneBtn().click();
await dlg().waitFor({ state: 'detached' });
check(/2 unsaved changes: New zone new\.example, New zone every other name/.test(await text(rbar().locator('.set-bar-summary'))), 'two new entries are two changes', await text(rbar().locator('.set-bar-summary')));
await zoneRows().filter({ hasText: '10.0.2.4' }).first().locator('button[aria-label="Remove"]').click();
uciMock.log.length = 0;
await saveBtn().click();
await outcome(/Saved: the router applied the change/);
const dm2 = uciMock.log.find(c => c.method === 'set').args.values.server;
check(dm2.length === 20 && dm2.at(-2) === '/new.example/' && dm2.at(-1) === '9.9.9.9' && !dm2.includes(dmBase.find(v => v.endsWith('/10.0.2.4'))), 'new entries go to the end of the list (a default forwarder as a plain address), a removed one is left out', j(dm2.slice(-3)));
check((await zoneRows().count()) === 20, 'and the table shows the list as it is now (20 entries)');
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
