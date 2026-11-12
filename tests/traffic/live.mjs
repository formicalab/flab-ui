// Browser test of the Traffic page. A real browser opens the deployed UI; the flab.traffic calls, flab.network status
// and the interface dump are answered with the outputs the backend run produced (see mkfx.mjs / assert.mjs) and with a
// synthetic network whose counters grow on every poll, so every tab, filter, selector and finding can be driven WITHOUT
// depending on or touching the router. Everything else (login, system board) goes to the real router; the page only
// ever reads.
// Usage: node live.mjs <work dir with out/<case>.json>   (env: FLAB_SID, FLAB_ACLS, FLAB_URL, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const work = process.argv[2];
const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID;   // a session made by tests/TestSession.ps1, so no password is needed
const acls = JSON.parse(process.env.FLAB_ACLS);   // what that session may call, like the ACLs of a real sign-in
const shots = process.env.FLAB_SHOTS;
// The recorded reply of case `name` from the output directory.
const load = name => JSON.parse(fs.readFileSync(path.join(work, 'out', `${name}.json`), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(work, 'cases.json'), 'utf8'));
// A deep copy of `o`, so each scenario can mutate its own state.
const clone = o => JSON.parse(JSON.stringify(o));
// `n` with thousands separators, as the page writes counts.
const num = n => n.toLocaleString('en-US');
// The size text of core/format.js.
const bytes = n => { const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; };

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

//#region The mock router
// The connections request as a lookup key, with the plugin's defaults.
const requestKey = a => JSON.stringify([a.q ?? '', a.limit ?? 300, a.sort ?? 'bytes', a.proto ?? 'all', a.scope ?? 'all']);
// The backend cases whose output answers a request of the same shape.
const answers = new Map(cases.filter(c => c.scenario === 'rich' && c.method === 'connections' && c.args !== undefined && load(c.name).ok).map(c => [requestKey(c.args), c.name]));
answers.set(requestKey({}), 'rich-default');

// Per call growth of each device's counters [rx, tx] in bytes: the WAN VLAN and its port carry the most.
const GROWTH = { eth1: [800000, 20000], 'eth1.1036': [790000, 19000], lan1: [300000, 90000], lan2: [1000, 500], 'phy0-ap0': [2000, 100000], 'phy1-ap0': [10, 10], 'br-lan': [303000, 190500], eth0: [1000000, 1000000] };
const DUMP = { interface: [
  { interface: 'loopback', up: true, l3_device: 'lo', device: 'lo' },
  { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan' },
  { interface: 'wan', up: true, l3_device: 'pppoe-wan', device: 'eth1.1036', route: [{ target: '0.0.0.0', mask: 0, nexthop: '10.0.0.1' }] },
  { interface: 'wan6', up: true, l3_device: 'pppoe-wan', device: 'eth1.1036', route: [{ target: '::', mask: 0 }] },
] };

const mock = {
  status: clone(load('rich-status')), periods: clone(load('rich-periods')), ticks: 0, extraPorts: 0,
  noPlugin: false, patchConn: null, connFixed: null, usageFixed: null, usageError: null,
  calls: { network: 0, status: 0, connections: [], periods: 0, usage: [] }, writes: [],
};

// A network device as flab.network reports it, with counters that have grown `mock.ticks` times.
function dev(name, extra = {}) {
  const [rx, tx] = GROWTH[name] ?? [100, 100];
  return { name, up: true, carrier: true, speed: 1000, stats: { rx_bytes: 5000000 + mock.ticks * rx, tx_bytes: 2000000 + mock.ticks * tx }, ...extra };
}
// The flab.network status of the mock router: a NIC with the WAN VLAN, a switch with two ports and its CPU port, a
// bridge with two ports and two Wi-Fi interfaces, plus `extraPorts` more ports.
function netStatus() {
  mock.ticks++;
  const extra = Array.from({ length: mock.extraPorts }, (_, i) => dev(`port${String(i).padStart(2, '0')}`, { role: 'nic' }));
  return {
    ports: [dev('eth1', { role: 'nic', speed: 2500 }), dev('lan1', { role: 'switch' }), dev('lan2', { role: 'switch', carrier: false, speed: null }), dev('eth0', { role: 'conduit', speed: 10000 }), ...extra],
    bridges: [{ ...dev('br-lan'), members: [dev('lan1', { kind: 'ethernet' }), dev('lan2', { kind: 'ethernet', carrier: false }), dev('phy0-ap0', { kind: 'wifi', ssid: 'home' }), dev('phy1-ap0', { kind: 'wifi', ssid: 'home5' })] }],
    vlans: [{ ...dev('eth1.1036'), parent: 'eth1' }],
    switches: [], tunlinks: [], zones: [], dhcp: [],
  };
}
// The usage reply for a request, from the backend outputs (or the fixed ones of a scenario).
function usageAnswer(args) {
  mock.calls.usage.push(args);
  if (mock.usageError) return mock.usageError;
  if (mock.usageFixed) return clone(mock.usageFixed[args.group]);
  const name = { 'current|mac,ip': 'rich-usage-mac-ip', 'current|layer7': 'rich-usage-layer7', '2026-10-01|mac,ip': 'rich-usage-old', '2026-10-01|layer7': 'rich-usage-old-layer7' }[`${args.period}|${args.group}`];
  return clone(load(name));
}
// The connections reply for a request.
function connectionsAnswer(args) {
  mock.calls.connections.push(args);
  const reply = clone(mock.connFixed ?? load(answers.get(requestKey(args)) ?? 'rich-default'));
  return mock.patchConn ? mock.patchConn(reply) : reply;
}

// The JSON-RPC answer for a request the mock handles, or null to let it through to the real router.
function answer(body) {
  const [, obj, method, args] = body.params;
  // A successful JSON-RPC reply carrying `data`.
  const ok = data => ({ jsonrpc: '2.0', id: body.id, result: [0, data] });
  if (obj === 'uci' && ['set', 'add', 'delete', 'apply', 'commit'].includes(method)) { mock.writes.push(`${obj}.${method}`); return { jsonrpc: '2.0', id: body.id, result: [6] }; }
  if (obj === 'flab.network' && method === 'status') { mock.calls.network++; return ok(netStatus()); }
  if (obj === 'network.interface' && method === 'dump') return ok(DUMP);
  if (obj === 'flab.traffic') {
    if (mock.noPlugin) return { jsonrpc: '2.0', id: body.id, result: [6] };
    if (method === 'status') { mock.calls.status++; return ok(clone(mock.status)); }
    if (method === 'connections') return ok(connectionsAnswer(args));
    if (method === 'usage_periods') { mock.calls.periods++; return ok(clone(mock.periods)); }
    if (method === 'usage') return ok(usageAnswer(args));
  }
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

// Helpers: tiles, banner, tabs, controls, tables and screenshots.
const tile = async label => {
  const t = page.locator('.tile').filter({ has: page.locator('.label', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }) });
  return { value: (await t.locator('.value').innerText()).trim(), sub: (await t.locator('.sub').innerText()).trim(), cls: await t.locator('.value').getAttribute('class') };
};
// The network health banner text, whitespace collapsed.
const banner = () => page.locator('.net-health').first().innerText().then(t => t.replace(/\s+/g, ' ').trim());
// The CSS class of the network health banner, which carries its severity.
const bannerClass = () => page.locator('.net-health').first().getAttribute('class');
// The tab button labeled `name`.
const tabButton = name => page.locator('.seg-tab', { hasText: name });
// The labels of all tabs, in order.
const tabNames = () => page.locator('.seg-tab').allInnerTexts().then(t => t.map(x => x.trim()));
// The label of the selected tab.
const activeTab = () => page.locator('.seg-tab.active').innerText();
// Clicks Refresh and waits `ms` for the page to settle.
const refresh = async (ms = 800) => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(ms); };
// Opens the tab labeled `name` and waits for its data.
const openTab = async name => { await tabButton(name).click(); await page.waitForTimeout(900); };
// The command-bar dropdown that offers an option containing `text`.
const selectOf = text => page.locator('.cmdbar select').filter({ has: page.locator('option', { hasText: text }) });
// The connection filter input in the command bar.
const connFilter = () => page.locator('.cmdbar input[placeholder^="Filter: host"]');
// The text of every element in `loc`, whitespace collapsed.
const texts = loc => loc.allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
// The rows of the connections table.
const connRows = () => page.locator('.tr-conns tbody tr');
// The rows of the first usage table.
const hostRows = () => page.locator('.tr-usage').first().locator('tbody tr');
// The arguments of the most recent `connections` call the mock received.
const lastConn = () => mock.calls.connections.at(-1);
// Saves a full-page screenshot named after `label`, only when a screenshot directory is configured.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `traffic-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// The card whose header contains `title`.
const cardOf = title => page.locator('.card').filter({ has: page.locator('.card-header', { hasText: title }) });

//#region Live
await page.goto(`${baseUrl}#traffic`);
await page.waitForSelector('.tr-live', { timeout: 20000 });
console.log('== the Live tab ==');
const nav = (await page.locator('.nav-pane a.nav-link-fl').allInnerTexts()).map(t => t.trim());
check(nav.indexOf('Traffic') === nav.indexOf('Routing') + 1 && (await page.locator('.nav-pane a.active').innerText()).trim() === 'Traffic', 'Traffic is in the navigation right after Routing, and active', nav.join(' | '));
check((await page.locator('.cmdbar h1').innerText()).trim() === 'Traffic', 'the page title');
check((await tabNames()).join() === 'Live,Connections,Usage' && (await activeTab()) === 'Live', 'three tabs, Live open (the router has nlbw and conntrack)', (await tabNames()).join());
for (let i = 0; i < 4; i++) await refresh();
const live = await tile('WAN throughput');
check(/^↓ /.test(live.value) && /↑ .*· wan \(eth1\.1036\)/.test(live.sub), 'WAN throughput: the interface with the default route, carried by its VLAN device', `${live.value} | ${live.sub}`);
check((await tile('All interfaces')).sub.includes('5 ports'), 'all interfaces: the ports and Wi-Fi interfaces that count (not the bridge, the VLAN or the CPU port)', (await tile('All interfaces')).sub);
const busy = await tile('Busiest interface');
check(busy.value === 'eth1' && /↓ .* · ↑ /.test(busy.sub), 'the busiest interface is eth1', `${busy.value} | ${busy.sub}`);
const conns = await tile('Connections');
check(conns.value === '141' && conns.sub === `of ${num(31232)} · 0.5% used`, 'the connection count against its limit', `${conns.value} | ${conns.sub}`);
const since = await tile('WAN since boot');
check(/^↓ \d+(\.\d)? (MiB|GiB)$/.test(since.value) && /^↑ \d/.test(since.sub), 'the WAN counters since boot', `${since.value} | ${since.sub}`);
check(await page.locator('.net-health.ok').count() === 1 && /Nothing needs attention/.test(await banner()), 'no findings: all clear');

const rowTexts = await texts(page.locator('.tr-live tbody tr'));
const names = await page.locator('.tr-live tbody tr td:first-child strong').allInnerTexts();
check(rowTexts.length === 8 && rowTexts[0].startsWith('eth1.1036') && rowTexts[0].includes('WAN') && rowTexts[0].includes('wan') && rowTexts[0].includes('wan6') && rowTexts[0].includes('VLAN on eth1'), 'eight devices, the WAN first with its badge and logical interfaces', rowTexts.map(t => t.slice(0, 30)).join(' | '));
check(names.join() === 'eth1.1036,eth1,lan1,lan2,phy0-ap0,phy1-ap0,br-lan,eth0', 'then ports, Wi-Fi, the bridge and the CPU port', names.join());
check(await page.locator('.tr-live tr.tr-dim').count() === 3, 'bridges, VLANs and the CPU port are dimmed', String(await page.locator('.tr-live tr.tr-dim').count()));
check(rowTexts.find(t => t.startsWith('phy0-ap0')).includes('Wi-Fi · home') && rowTexts.find(t => t.startsWith('lan2')).includes('down') && rowTexts.find(t => t.startsWith('eth1 ')).includes('2.5 Gbit/s'), 'Wi-Fi rows name the SSID, an unplugged port is "down", links show their speed');
check(await page.locator('.tr-live svg.spark').count() >= 7 && await page.locator('.tr-live .spark-empty').count() === 0, 'every interface has a history chart once a few samples exist');
check(/Mbit\/s|Gbit\/s|kbit\/s/.test(rowTexts[1]) && await page.locator('.tr-live .tr-share').count() >= 4, 'rates in line units, and a load bar for links with a known speed');
check(/Rates are measured in this browser/.test(await page.locator('.tr-legend').first().innerText()) && (await page.locator('.tr-legend').first().boundingBox()).y < (await page.locator('.tr-live').boundingBox()).y, 'the legend sits above the table');
await shot('live');

console.log('\n== Live findings ==');
mock.status.count = 27000; mock.status.nlbwmon_running = false;
await refresh();
check(/86% full \(27,000 of 31,232\)/.test(await banner()) && /nlbwmon is installed but not running/.test(await banner()) && (await bannerClass()).includes('warn'), 'a nearly full table and a stopped nlbwmon are reported', await banner());
check((await tile('Connections')).cls.includes('text-warning'), 'the connections tile turns amber');
mock.status.count = 31000;
await refresh();
check((await bannerClass()).includes('bad') && (await tile('Connections')).cls.includes('text-danger'), 'over 95% is critical');
mock.status.count = 141; mock.status.nlbwmon_running = true;
await refresh();
check(await page.locator('.net-health.ok').count() === 1, 'the findings go away again');

console.log('\n== Live: many devices, pause, no plugin ==');
mock.extraPorts = 45;
await refresh();
check(await page.locator('.tr-live tbody tr').count() === 40 && /Showing the first 40 of 53 devices/.test(await page.locator('.tr-more').innerText()), 'a long list shows its first 40 rows', String(await page.locator('.tr-live tbody tr').count()));
await page.click('button:has-text("Show all 53")');
check(await page.locator('.tr-live tbody tr').count() === 53 && await page.locator('.tr-more').count() === 0, 'Show all draws every device');
mock.extraPorts = 0;
await refresh();
await page.click('button:has-text("Pause")');
const before = mock.calls.network;
await page.waitForTimeout(3600);
check(mock.calls.network === before && (await page.locator('button:has-text("Resume")').count()) === 1, 'Pause stops the polling', `${before} -> ${mock.calls.network}`);
await page.click('button:has-text("Resume")');
await page.waitForTimeout(3600);
check(mock.calls.network > before, 'Resume polls again');
mock.noPlugin = true;
await refresh();
const bare = await tile('Connections');
check(bare.value === 'n/a' && (await tabNames()).join() === 'Live' && await page.locator('.tr-live').count() === 1, 'without the flab.traffic plugin the Live tab still works and is the only tab', `${bare.value} | ${(await tabNames()).join()}`);
mock.noPlugin = false;
await refresh();
check((await tabNames()).join() === 'Live,Connections,Usage', 'the tabs come back with the plugin');
//#endregion

//#region Connections
console.log('\n== the Connections tab ==');
await openTab('Connections');
await page.waitForSelector('.tr-conns', { timeout: 10000 });
const rd = load('rich-default');
check(await activeTab() === 'Connections' && mock.calls.connections.length >= 1 && j(lastConn()) === j({ q: '', limit: 300, sort: 'bytes', proto: 'all', scope: 'all' }), 'the first request: no filter, 300 rows, most traffic first', JSON.stringify(lastConn()));
// `x` as JSON text, for comparing structures by value.
function j(x) { return JSON.stringify(x); }
let c = await tile('Connections');
check(c.value === '141' && /of 31,232/.test(c.sub), 'the connection count tile');
const ps = rd.aggregates.protocols;
// The number of connections the protocol aggregate `n` counts, or 0 when it is absent.
const count = n => ps.find(p => p.name === n)?.count ?? 0;
c = await tile('By protocol');
check(c.value === `${count('tcp')} TCP` && c.sub.startsWith(`${count('udp')} UDP · ${count('icmp') + count('icmpv6')} ICMP`), 'by protocol', `${c.value} | ${c.sub}`);
c = await tile('Established');
check(c.value === String(rd.aggregates.states.find(s => s.name === 'ESTABLISHED').count) && /waiting to close/.test(c.sub), 'established connections');
c = await tile('Unanswered');
check(c.value === String(rd.aggregates.unreplied) && /never got a reply/.test(c.sub), 'unanswered connections', `${c.value} | ${c.sub}`);
check((await tile('Translated (NAT)')).value === String(rd.aggregates.nat), 'translated connections');
c = await tile('Busiest source');
check(c.value === 'nas' && c.sub === '40 connections', 'the busiest source, by its name', `${c.value} | ${c.sub}`);
check(await page.locator('.net-health.ok').count() === 1, 'a calm table: all clear (a host with 40 of 70 connections is below the 100 minimum)', await banner());
check((await page.locator('.cmdbar .search').first().isVisible()) && (await selectOf('All protocols').isVisible()) && (await selectOf('All traffic').isVisible()) && (await selectOf('Most traffic first').isVisible()) && (await selectOf('300 rows').isVisible()), 'the Connections controls are shown');
check(!(await selectOf('Current period').isVisible()), 'the Usage controls are hidden');

console.log('\n== the entries ==');
check(await connRows().count() === 70, 'all 70 entries are listed', String(await connRows().count()));
let rows = await texts(connRows());
check(/^v4 UDP 192\.168\.1\.10:50000 → 142\.250\.180\.14:443/.test(rows[0]) && rows[0].includes('laptop → 142.250.180.14') && rows[0].includes('SNAT') && rows[0].includes('source becomes 203.0.113.9:50000') && rows[0].includes('assured') && rows[0].includes('2m 59s') && rows[0].includes('29.3 KiB ↑ · 878.9 KiB ↓') && rows[0].includes('30 ↑ · 700 ↓ packets'), 'the largest connection first, with names, SNAT, state, time left and sizes', rows[0]);
const dnat = rows.find(r => r.includes('198.51.100.99:60000'));
check(dnat.includes('DNAT') && dnat.includes('destination becomes 192.168.1.20:80') && dnat.includes('ESTABLISHED'), 'a port forward shows the translated destination', dnat);
check(rows.some(r => r.includes('[2001:db8:1::10]:52000 → [2606:4700:4700::1111]:443') && r.includes('v6')) && rows.some(r => r.includes('[2001:db8:0:1::2]:4000')) && rows.some(r => r.includes('[2001:db8::1:0:0:1]:4002')) && rows.some(r => r.includes('[fe80::639e:1bc5:db9e:45b2]:546')), 'IPv6 endpoints are bracketed and compressed');
check(rows.some(r => r.includes('ICMP echo request') && r.includes('192.168.1.10 → 1.1.1.1')) && rows.some(r => r.includes('ICMPV6 router advertisement')) && rows.some(r => r.startsWith('v4 GRE')), 'ICMP types and other protocols');
const offload = rows.find(r => r.includes('192.168.1.10:52000'));
check(offload.includes('offloaded') && offload.includes('replied'), 'an offloaded flow says so and has no countdown', offload);
const nocount = rows.find(r => r.includes('192.168.1.14:51500'));
check(nocount.includes('ESTABLISHED') && nocount.endsWith('–'), 'an entry without counters shows a dash for its size', nocount);
const lostCount = rd.entries.filter(e => e.flags.includes('UNREPLIED')).length;
check(await page.locator('.tr-conns tr.tr-lost').count() === lostCount && rows.filter(r => r.includes('UNREPLIED')).length === lostCount, `${lostCount} unanswered connections are tinted and badged`);
check(/One row per tracked connection/.test(await page.locator('.tr-legend').first().innerText()) && (await page.locator('.tr-legend').first().boundingBox()).y < (await page.locator('.tr-conns').boundingBox()).y, 'the legend of the table explains Original, Translated and UNREPLIED above it');
// The header text of the card titled `title`, whitespace collapsed.
const cardHead = async title => (await cardOf(title).first().locator('.card-header').innerText()).replace(/\s+/g, ' ');
check(/Connections 70 shown of 70 matching · most traffic first/.test(await cardHead('Connections')), 'the header counts the entries and says how they are ordered', await cardHead('Connections'));

console.log('\n== the busiest hosts ==');
const topSrc = cardOf('Busiest sources');
const topRows = await texts(topSrc.locator('.tr-hosts').first().locator('tbody tr'));
check(topRows.length === rd.aggregates.sources.by_connections.length && /^nas 192\.168\.1\.50 40 10 unanswered/.test(topRows[0]), 'sources by connections: the heavy host first, with its unanswered count', topRows[0]);
check(await topSrc.locator('.tr-hosts').count() === 2 && await cardOf('Busiest destinations').locator('.tr-hosts').count() === 2, 'sources and destinations each list by connections and by traffic');
const byTraffic = await texts(topSrc.locator('.tr-hosts').nth(1).locator('tbody tr'));
check(/KiB|B$/.test(byTraffic[0]) && byTraffic.length <= 10, 'by traffic: at most ten hosts with their sizes', byTraffic[0]);
const callsBefore = mock.calls.connections.length;
await topSrc.locator('.tr-hosts').first().locator('tbody tr').first().click();
await page.waitForTimeout(900);
check(await connFilter().inputValue() === '192.168.1.50' && j(lastConn()) === j({ q: '192.168.1.50', limit: 300, sort: 'bytes', proto: 'all', scope: 'all' }) && mock.calls.connections.length === callsBefore + 1, 'a click on a host filters the table to it', j(lastConn()));
check(await connRows().count() === load('rich-q-nas').entries.length, 'the table shows that host\'s connections', String(await connRows().count()));
await shot('connections');

console.log('\n== the controls ==');
await connFilter().fill('');
await page.waitForTimeout(800);
check(lastConn().q === '' && await connRows().count() === 70, 'clearing the filter shows everything');
await connFilter().fill('laptop');
await page.waitForTimeout(150);
const typed = mock.calls.connections.length;
await page.waitForTimeout(900);
check(lastConn().q === 'laptop' && mock.calls.connections.length === typed + 1 && await connRows().count() === load('rich-name').entries.length, 'typing waits for a pause, then asks once; the table follows', `${lastConn().q} ${await connRows().count()}`);
await connFilter().fill('');
await page.waitForTimeout(800);
const protoOptions = await selectOf('All protocols').locator('option').allInnerTexts();
check(protoOptions.join() === ['All protocols', ...rd.aggregates.protocols.map(p => p.name.toUpperCase())].join(), 'the protocol selector lists the protocols the table holds', protoOptions.join());
await selectOf('All protocols').selectOption({ label: 'TCP' });
await page.waitForTimeout(800);
check(lastConn().proto === 'tcp' && await connRows().count() === load('rich-tcp').entries.length && (await texts(connRows())).every(r => /TCP/.test(r)), 'the protocol selector filters to TCP', j(lastConn()));
await selectOf('All protocols').selectOption({ label: 'UDP' });
await page.waitForTimeout(800);
check(lastConn().proto === 'udp' && await connRows().count() === load('rich-udp').entries.length, 'and to UDP');
await selectOf('All protocols').selectOption('all');
await selectOf('All traffic').selectOption({ label: 'Internet traffic' });
await page.waitForTimeout(800);
check(lastConn().scope === 'internet' && await connRows().count() === load('rich-scope-internet').entries.length, 'Internet traffic', j(lastConn()));
await selectOf('All traffic').selectOption({ label: 'Internal only' });
await page.waitForTimeout(800);
check(lastConn().scope === 'internal' && await connRows().count() === load('rich-scope-internal').entries.length, 'Internal only', j(lastConn()));
await selectOf('Internal only').selectOption('all');
await selectOf('Most traffic first').selectOption({ label: 'Most packets first' });
await page.waitForTimeout(800);
// The text an entry's first line shows: its endpoints, as the page writes them.
const endpointOf = (addr, port) => (port == null ? addr : addr.includes(':') ? `[${addr}]:${port}` : `${addr}:${port}`);
// The text an entry's first line shows for the flow: source endpoint, arrow, destination endpoint.
const flowOf = e => `${endpointOf(e.src, e.sport)} → ${endpointOf(e.dst, e.dport)}`;
check(lastConn().sort === 'packets' && (await texts(connRows()))[0].includes(flowOf(load('rich-sort-packets').entries[0])) && /most packets first/.test(await cardHead('Connections')) && load('rich-sort-packets').entries[0].packets[0] + load('rich-sort-packets').entries[0].packets[1] >= load('rich-default').entries.map(e => e.packets ? e.packets[0] + e.packets[1] : 0).reduce((a, b) => Math.max(a, b), 0), 'sorted by packets: the entry with the most packets first', j(lastConn()));
await selectOf('Most packets first').selectOption({ label: 'Longest timeout first' });
await page.waitForTimeout(800);
check(lastConn().sort === 'timeout' && (await texts(connRows()))[0].includes(flowOf(load('rich-sort-timeout').entries[0])) && (await texts(connRows()))[0].includes('4d 23h') && /longest remaining life first/.test(await cardHead('Connections')), 'sorted by timeout: the longest-lived first', (await texts(connRows()))[0]);
await selectOf('Longest timeout first').selectOption('bytes');
await selectOf('300 rows').selectOption({ label: '1,000 rows' });
await page.waitForTimeout(800);
check(lastConn().limit === 1000, 'the row limit is sent', j(lastConn()));
await selectOf('1,000 rows').selectOption('300');
await page.waitForTimeout(800);
const callsInvalid = mock.calls.connections.length;
await connFilter().fill('a;b');
await page.waitForTimeout(900);
check(mock.calls.connections.length === callsInvalid && /The filter may hold letters, digits/.test(await banner()) && (await bannerClass()).includes('bad'), 'a filter the router would refuse is not sent, and the reason is shown', await banner());
await connFilter().fill('x'.repeat(65));
await page.waitForTimeout(900);
check(mock.calls.connections.length === callsInvalid && /limited to 64 characters/.test(await banner()), 'a filter over 64 characters is not sent either');
await connFilter().fill('');
await page.waitForTimeout(900);
check(await connRows().count() === 70, 'a valid filter again shows the table');

console.log('\n== the connections findings ==');
mock.patchConn = r => {
  r.count = 27000; r.parsed = 1000; r.truncated = true; r.total = 1500;
  r.aggregates.sources.by_connections[0] = { addr: '192.168.1.50', connections: 450, bytes: 100, unreplied: 30 };
  r.aggregates.unreplied = 300;
  r.aggregates.unreplied_sources = [{ addr: '192.168.1.50', connections: 450, bytes: 100, unreplied: 35 }];
  return r;
};
await refresh();
const text = await banner();
check(/86% full \(27,000 of 31,232\)/.test(text) && /Only the first 1,000 of 1,500 entries were analyzed/.test(text) && /nas \(192\.168\.1\.50\) holds 450 of 1,000 connections \(45%\)/.test(text) && /300 connections \(30%\) have never been answered/.test(text) && /has 35 connections that were never answered \(see above\)/.test(text), 'findings: a nearly full table, a cut analysis, a host with a large share, unanswered connections', text);
check((await bannerClass()).includes('warn') && (await tile('Unanswered')).cls.includes('text-warning') && (await tile('Connections')).cls.includes('text-warning'), 'warnings tint the banner and the tiles');
mock.patchConn = null;
mock.connFixed = load('noacct-connections');
await refresh();
check(/counters are off/.test(await banner()) && (await page.locator('.tr-conns th').allInnerTexts()).includes('Size (counters off)') && await page.locator('.tr-hosts').count() === 2, 'without byte counters the table says so, and the top lists drop their traffic ranking', await banner());
check((await texts(connRows())).every(r => r.endsWith('–')), 'every size is a dash');
mock.connFixed = load('noct-connections');
await refresh();
check(/Connection tracking is not available/.test(await banner()) && await page.locator('.tile').count() === 0, 'without connection tracking only a note is shown');
mock.connFixed = { ok: false, error: 'The limit must be a whole number from 1 to 2000.' };
await refresh();
check(/The limit must be a whole number/.test(await banner()) && (await bannerClass()).includes('bad'), 'an error from the plugin is shown');

console.log('\n== a long table, caching ==');
mock.connFixed = load('big-limit2000');
await refresh(1500);
check(await connRows().count() === 100 && /Showing the first 100 of 2000 entries/.test(await page.locator('.tr-more').first().innerText()) && /Only the first 20,000 of 60,000 entries were analyzed/.test(await banner()), 'a long table draws its first 100 rows, and the cut analysis is called out', String(await connRows().count()));
await page.click('button:has-text("Show all 2000")');
await page.waitForTimeout(500);
check(await connRows().count() === 2000, 'Show all draws all 2000 rows');
mock.connFixed = null;
await selectOf('300 rows').selectOption('300').catch(() => {});
await refresh();
const settled = mock.calls.connections.length;
await page.waitForTimeout(4000);
check(mock.calls.connections.length === settled, 'polls within ten seconds reuse the last answer (no new request)', `${settled} -> ${mock.calls.connections.length}`);
await refresh();
check(mock.calls.connections.length === settled + 1, 'Refresh asks the router again', `${settled} -> ${mock.calls.connections.length}`);
//#endregion

//#region Usage
console.log('\n== the Usage tab ==');
await openTab('Usage');
await page.waitForSelector('.tr-usage', { timeout: 10000 });
check(await activeTab() === 'Usage' && (await selectOf('Current period').isVisible()) && !(await selectOf('All protocols').isVisible()) && (await page.locator('.cmdbar input[placeholder^="Filter hosts"]').isVisible()), 'the Usage controls replace the Connections ones');
const periodOptions = await selectOf('Current period').locator('option').allInnerTexts();
check(periodOptions.join() === 'Current period (since 2026-11-01),Period from 2026-10-01,Period from 2026-09-01', 'the period selector names the start of the running period and lists the older stored ones, newest first, without listing the running one twice', periodOptions.join());
const bar = (await page.locator('.tr-note').innerText()).replace(/\s+/g, ' ');
check(/^Accounting period: 2026-11-01 to now \(12 days\)\. Counting since 2026-11-01\. The period ends on 2026-12-01, in 19 days, and counting starts again from zero\. These are the bytes/.test(bar) && await page.locator('.tr-note').count() === 1, 'one box leads the tab: the accounting period (its dates, how long it has run, when it ends), then what the numbers are', bar);
check(await page.locator('.tr-note-period strong').evaluate(e => getComputedStyle(e).fontSize === getComputedStyle(e.parentElement.parentElement).fontSize), 'the period is in the normal font size of the note');
check(j(mock.calls.usage.slice(-2).map(a => `${a.period}|${a.group}`).sort()) === j(['current|layer7', 'current|mac,ip']), 'the tab asks for the hosts (by MAC and IP) and the protocols of the current period', j(mock.calls.usage.slice(-2)));
const note = await page.locator('.tr-note').innerText();
check(/since the selected period started/.test(note) && /nlbwmon must be running/.test(note) && /Download.* is what a host received/.test(note.replace(/\s+/g, ' ')) && (await page.locator('.tr-note').boundingBox()).y < (await page.locator('.tile').first().boundingBox()).y, 'a note above the tiles says what the numbers are and that nlbwmon must be running');
const us = load('rich-usage-mac-ip');
const total = us.totals.rx_bytes + us.totals.tx_bytes;
check((await tile('Period total')).value === bytes(total) && (await tile('Download')).value === bytes(us.totals.rx_bytes) && (await tile('Upload')).value === bytes(us.totals.tx_bytes), 'the period total, download and upload come from the plugin\'s totals', `${(await tile('Period total')).value} vs ${bytes(total)}`);
check((await tile('Period total')).sub.includes(`${bytes(total / 12)} a day on average`), 'the total says what that is per day over the days the period has run', (await tile('Period total')).sub);
check(await page.locator('.tr-suspect').count() === 0 && !/counters look wrong/.test(await banner()), 'ordinary counters raise no warning');
const top = await tile('Top host');
check(top.value === 'tv' && /% of the total/.test(top.sub), 'the top host', `${top.value} | ${top.sub}`);
check((await tile('Hosts')).value === '6' && (await tile('Connections')).value === String(us.totals.conns), 'six devices (the IPv4 and IPv6 rows of a MAC are one host)');
check(await page.locator('.net-health.ok').count() === 1 && /nlbwmon is counting: the current period holds traffic of 6 hosts/.test(await banner()), 'the banner says nlbwmon is counting');
let hrows = await texts(hostRows());
check(hrows.length === 6 && hrows[0].startsWith('tv aa:bb:cc:00:00:11 192.168.1.11') && hrows[0].includes(bytes(9000000000)), 'hosts are ordered by total: the TV first', hrows[0]);
const laptopRow = hrows.find(r => r.startsWith('laptop'));
check(laptopRow.includes('192.168.1.10') && laptopRow.includes('2001:db8:1::10') && laptopRow.includes(bytes(7000000)) && laptopRow.includes(bytes(1100000)) && laptopRow.includes('150'), 'one row per device: the IPv4 and IPv6 rows of the laptop together, summed', laptopRow);
check(hrows.find(r => r.startsWith('phone')).includes('2001:db8:1::12') && hrows.some(r => r.startsWith('nas')), 'names from MACs and addresses (a lease, odhcpd, a static host)');
check(hrows.some(r => r.startsWith('10.133.106.38')) && !hrows.some(r => r.startsWith('00:00:00')), 'traffic without a device (the all-zero MAC) is listed by its address');
check(await page.locator('.tr-usage').first().locator('.tr-share').count() === 6 && /^\d+(\.\d)?%$|%/.test((await page.locator('.tr-usage').first().locator('.tr-share span').first().innerText())), 'every host has a share bar');
const l7 = await texts(page.locator('.tr-usage').nth(1).locator('tbody tr'));
check(l7[0].startsWith('HTTPS') && l7.some(r => r.startsWith('TCP 8443')) && l7.some(r => r.startsWith('Other IP')) && l7.some(r => r.startsWith('QUIC')) && l7.length === 7, 'protocols by application, by port when nlbwmon does not know it, and "Other IP"', l7.join(' | '));
check(/names a flow after its application protocol/.test(await page.locator('.tr-legend').last().innerText()), 'the protocol card explains its names above the table');
await shot('usage');

console.log('\n== usage: filter, sort, period ==');
await page.locator('.cmdbar input[placeholder^="Filter hosts"]').fill('laptop');
await page.waitForTimeout(300);
check((await texts(hostRows())).length === 1 && /1 of 6/.test(await cardOf('Hosts').locator('.card-header').innerText()), 'the host filter matches names', String((await texts(hostRows())).length));
await page.locator('.cmdbar input[placeholder^="Filter hosts"]').fill('aa:bb:cc:00:00:5');
await page.waitForTimeout(300);
check((await texts(hostRows())).length === 1 && (await texts(hostRows()))[0].startsWith('nas'), 'and MAC addresses');
await page.locator('.cmdbar input[placeholder^="Filter hosts"]').fill('2001:db8');
await page.waitForTimeout(300);
check((await texts(hostRows())).length === 2, 'and IPv6 addresses', String((await texts(hostRows())).length));
await page.locator('.cmdbar input[placeholder^="Filter hosts"]').fill('nobody');
await page.waitForTimeout(300);
check(/No host matches the filter/.test((await texts(hostRows()))[0]), 'nothing matches');
await page.locator('.cmdbar input[placeholder^="Filter hosts"]').fill('');
await page.waitForTimeout(300);
await page.locator('.tr-usage').first().locator('th', { hasText: 'Host' }).click();
hrows = await texts(hostRows());
check(hrows[0].startsWith('10.133.106.38') && /▲/.test(await page.locator('.tr-usage').first().locator('th', { hasText: 'Host' }).innerText()), 'sort by host name, ascending', hrows[0]);
await page.locator('.tr-usage').first().locator('th', { hasText: 'Upload' }).click();
hrows = await texts(hostRows());
check(hrows[0].startsWith('tv') && /▼/.test(await page.locator('.tr-usage').first().locator('th', { hasText: 'Upload' }).innerText()), 'sort by upload: a click sorts descending first', hrows[0]);
await page.locator('.tr-usage').first().locator('th', { hasText: 'Connections' }).click();
hrows = await texts(hostRows());
check(hrows[0].startsWith('laptop'), 'sort by connections', hrows[0]);
await page.locator('.tr-usage').first().locator('th', { hasText: 'Connections' }).click();
check((await texts(hostRows()))[0].startsWith('192.168.1.99') && /▲/.test(await page.locator('.tr-usage').first().locator('th', { hasText: 'Connections' }).innerText()), 'a second click reverses it: the host with the fewest connections first', (await texts(hostRows()))[0]);
await page.locator('.tr-usage').first().locator('th.sortable', { hasText: /^Total/ }).click();
await selectOf('Current period').selectOption('2026-10-01');
await page.waitForTimeout(900);
check(j(mock.calls.usage.slice(-2).map(a => `${a.period}|${a.group}`).sort()) === j(['2026-10-01|layer7', '2026-10-01|mac,ip']) && (await texts(hostRows())).length === 2 && /the period from 2026-10-01/.test(await banner()), 'another period is requested and shown', j(mock.calls.usage.slice(-2)));
check((await tile('Period total')).value === bytes(70000000 + 9000000 + 60000 + 200 + 100000 + 50000 + 100), 'its total', (await tile('Period total')).value);
const oldBar = (await page.locator('.tr-note').innerText()).replace(/\s+/g, ' ');
check(/^Accounting period: 2026-10-01 to 2026-11-01 \(31 days\)\. A finished period: it ran from 2026-10-01 up to, not including, 2026-11-01\./.test(oldBar), 'a stored period shows both its dates and that it is finished', oldBar);
check((await texts(page.locator('.tr-usage').nth(1).locator('tbody tr'))).length === 1, 'and its protocols');
await selectOf('Period from 2026-10-01').selectOption('current');
await page.waitForTimeout(900);

console.log('\n== usage: counters that cannot be right ==');
mock.usageFixed = { 'mac,ip': load('inflated-usage-mac-ip'), layer7: load('inflated-usage-layer7') };
await refresh(1500);
const warn = await banner();
check((await bannerClass()).includes('warn') && /nlbwmon's counters look wrong: 2 hosts average as little as 1\.0 bytes per packet/.test(warn) && /at least 28 bytes/.test(warn) && /flow_offloading_hw/.test(warn) && /unreliable/.test(warn), 'impossible counters are a warning above the table, with the reason and a known cause', warn);
hrows = await texts(hostRows());
check(await page.locator('.tr-suspect').count() === 2 && hrows.filter(r => /counters look wrong/.test(r)).length === 2 && hrows.filter(r => /counters look wrong/.test(r)).every(r => /192\.168\.1\.(9|10)\b/.test(r)), 'the two hosts with impossible counters are marked in the table, the others are not', hrows.join(' | '));
check(!hrows.find(r => r.startsWith('10.133.106.38')).includes('counters look wrong'), 'a host with a handful of packets is never judged');
check((await tile('Period total')).sub.includes('a day on average'), 'the per-day figure still shows, so it can be compared with what the link can carry');
await shot('usage-inflated');
mock.usageFixed = null;
await refresh(1500);

console.log('\n== usage: long lists, empty period, errors ==');
mock.usageFixed = { 'mac,ip': load('big-usage'), layer7: load('rich-usage-layer7') };
await refresh(1500);
check((await texts(hostRows())).length === 50 && /Showing the first 50 of 3000 hosts/.test(await page.locator('.tr-more').innerText()) && /Only the 3,000 entries with the most traffic of 3,500/.test(await banner()), 'a long host list draws its first 50 rows, and rows left out by the router are mentioned', String((await texts(hostRows())).length));
await page.click('button:has-text("Show all 3000")');
check((await texts(hostRows())).length === 3000, 'Show all draws every host');
const empty = clone(load('rich-usage-mac-ip')); empty.rows = []; empty.total_rows = 0; empty.totals = { conns: 0, rx_bytes: 0, rx_pkts: 0, tx_bytes: 0, tx_pkts: 0 };
mock.usageFixed = { 'mac,ip': empty, layer7: { ...empty, columns: [] } };
await refresh(1500);
check(/has not counted any traffic in this period yet/.test(await banner()) && (await tile('Hosts')).value === '0' && (await tile('Top host')).value === '–' && /No host has traffic/.test((await texts(hostRows()))[0]), 'an empty period is explained and nothing breaks', await banner());
mock.usageFixed = null;
mock.usageError = { ok: false, error: 'nlbw returned no data for that period.' };
await refresh(1500);
check(/nlbw returned no data for that period/.test(await banner()) && (await bannerClass()).includes('warn'), 'an error from nlbw is shown');
mock.usageError = null;

console.log('\n== usage: nlbwmon stopped, nlbw missing ==');
mock.status.nlbwmon_running = false; mock.periods = { ok: true, present: true, running: false, periods: [] };
await refresh(1500);
check(/nlbwmon is installed but not running, so nothing is being counted/.test(await banner()) && (await bannerClass()).includes('warn') && await page.locator('.tile').count() === 0 && await page.locator('.tr-note').count() === 1, 'a stopped nlbwmon is a warning and the note stays', await banner());
check((await tabNames()).join() === 'Live,Connections,Usage', 'the Usage tab is still offered (nlbw exists)');
await openTab('Live');
check(/nlbwmon is installed but not running/.test(await banner()), 'the Live tab warns too');
await openTab('Usage');
mock.status.nlbw = false; mock.status.nlbwmon_running = false; mock.periods = { ok: true, present: false, running: false, periods: [] };
await refresh(2000);
check((await tabNames()).join() === 'Live,Connections' && await activeTab() === 'Live' && await page.locator('.tr-live').count() === 1, 'without nlbw the Usage tab disappears and the page falls back to Live', `${(await tabNames()).join()} / ${await activeTab()}`);
check(!/nlbwmon/.test(await banner()), 'and nothing complains about nlbwmon', await banner());
mock.status.conntrack = false;
await refresh(1500);
check((await tabNames()).join() === 'Live', 'without connection tracking the Connections tab is not offered either', (await tabNames()).join());
mock.status = clone(load('rich-status'));
await refresh(1500);
check((await tabNames()).join() === 'Live,Connections,Usage', 'everything comes back with the features');
//#endregion

check(mock.writes.length === 0, 'the page wrote nothing to the router', mock.writes.join());
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
