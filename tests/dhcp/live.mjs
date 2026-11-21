// Browser test for the DHCP page. A real browser opens the deployed UI.
// 1. Against the real router, read only: the page shows the router's own clients, static leases and pools. Any uci
//    write the page might send in this phase is blocked and fails the test.
// 2. Against a stateful mock of rpcd's `uci` object, of odhcpd's `dhcp` object and of the interfaces: the whole
//    editing flow - validation, making a lease static, editing a pool and the daemon, a successful save, a change the
//    router does not keep, a stopped odhcpd, a login that may not write, an expired session - WITHOUT touching the
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
const section = (name, type, values) => ({ '.anonymous': false, '.type': type, '.name': name, ...values });
// The dhcp config like the real router's: the daemon, two pools, and four static leases (one with only a name and a MAC).
const baseCfg = () => ({
  odhcpd: section('odhcpd', 'odhcpd', { maindhcp: '1', leasefile: '/tmp/odhcpd.leases', loglevel: '6' }),
  lan: section('lan', 'dhcp', { interface: 'lan', start: '128', limit: '120', leasetime: '8h', dhcpv4: 'server', dhcpv6: 'server', ra: 'server', ra_slaac: '0', ra_flags: ['managed-config', 'other-config'], dns: '192.168.1.1', domain: 'lab.example.com', dhcp_option: ['3,192.168.1.254'], force: '1' }),
  lan100: section('lan100', 'dhcp', { interface: 'lan100', start: '128', limit: '120', dhcpv4: 'server', ra: 'server' }),
  cfg1: section('cfg1', 'host', { mac: '88:AE:DD:66:16:05', ip: '192.168.1.2', name: 'flabn01' }),
  cfg2: section('cfg2', 'host', { mac: '38:A6:CE:49:BF:D6', name: 'SkyQ-L2-Mesh' }),
  cfg3: section('cfg3', 'host', { mac: ['02:F0:F4:50:6B:7D', '02:F0:F4:50:6B:7E'], ip: '192.168.1.3', name: 'homeassistant', leasetime: '1h' }),
  cfg4: section('cfg4', 'host', { duid: '000100011ee0f1ed4cbad7bba6ae', hostid: '11', name: 'soundbar' }),
  boot1: section('boot1', 'boot6', { url: 'tftp://[fd11::1]/pxe.efi', arch: '07' }),
});
// The globals section of the network config (the only part of it the page reads), with a second option the page ignores.
const baseNet = () => ({ globals: section('globals', 'globals', { ula_prefix: 'fd00::/48', dhcp_default_duid: '0004b324b3332b47450aaa442f1f235bff2b' }) });
const DUMP = { interface: [
  { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [{ address: '192.168.1.1', mask: 24 }] },
  { interface: 'lan100', up: true, l3_device: 'br-lan.100', 'ipv4-address': [{ address: '192.168.100.1', mask: 24 }] },
  { interface: 'wan', up: true, l3_device: 'eth1', 'ipv4-address': [{ address: '203.0.113.7', mask: 29 }] },
  { interface: 'guest', up: true, l3_device: 'br-guest', 'ipv4-address': [{ address: '192.168.50.1', mask: 24 }] },
] };
const LEASES4 = { device: { 'br-lan': { leases: [
  { mac: '88aedd661605', hostname: 'flabn01', flags: ['bound', 'static'], address: '192.168.1.2', valid: 19688 },
  { mac: 'aabbccddeeff', hostname: 'laptop', flags: ['bound'], address: '192.168.1.150', valid: 3600 },
  { mac: '112233445566', hostname: '', flags: ['bound', 'broken-hostname'], address: '192.168.1.140', valid: 100 },
] }, 'br-lan.100': { leases: [{ mac: '665544332211', hostname: 'iot', flags: ['bound'], address: '192.168.100.130', valid: 7000 }] } } };
const LEASES6 = { device: { 'br-lan': { leases: [
  { duid: '000100011ee0f1ed4cbad7bba6ae', iaid: 7, hostname: 'soundbar', flags: ['bound', 'static'], valid: 4544,
    'ipv6-addr': [{ address: '2a01:827::11', 'preferred-lifetime': 1844, 'valid-lifetime': 4544 }, { address: 'fd92::11', 'preferred-lifetime': 1844, 'valid-lifetime': 4544 }],
    'ipv6-prefix': [{ address: 'fd00:1:2:3::', 'prefix-length': 64, 'preferred-lifetime': 10, 'valid-lifetime': 20 }] },
  { duid: '00030001aabbccddeeff', iaid: 9, hostname: '', flags: ['bound'], valid: 3000, 'ipv6-addr': [{ address: '2a01:827::596', 'preferred-lifetime': 1000, 'valid-lifetime': 3000 }] },
] } } };
const RA = { interfaces: { 'br-lan': [{ prefix: '2a01:827::1', length: 60, stale: false }, { prefix: 'fd92::1', length: 60, stale: true }] } };

const WRITES = ['set', 'add', 'delete', 'apply', 'confirm', 'rollback', 'revert', 'commit', 'order', 'rename'];
const mock = { on: false, cfg: baseCfg(), net: baseNet(), staged: [], restage: [], snapshot: null, calls: [], dropWrites: false, confirmFails: false, expired: false, noDaemon: false, dnsmasq: false, leaseFile: null, unsafe: [] };
let nextId = 1;

// The staged edits are [op, section, option or type, value, config]; an edit without a config belongs to dhcp.
const configOf = c => c[4] ?? 'dhcp';
// The mock's copy of a config: dhcp is the whole config, network only the globals section.
const target = config => (config === 'network' ? mock.net : mock.cfg);

// Applies the staged edits to the mock's config, the way rpcd's uci apply does.
function commit() {
  for (const c of mock.staged) {
    const [op, section, option, value] = c;
    const cfg = target(configOf(c));
    if (op === 'set') cfg[section][option] = value;
    else if (op === 'delete') (option ? delete cfg[section][option] : delete cfg[section]);
    else if (op === 'add') cfg[section] = section_(section, option, value);
  }
}
// `section` under another name, for the code above that has a `section` parameter of its own.
const section_ = (name, type, values) => section(name, type, values);
// What a rollback or a failed confirmation puts back.
const restore = () => { mock.cfg = mock.snapshot.cfg; mock.net = mock.snapshot.net; mock.staged = mock.restage; mock.snapshot = null; };

// One uci method of the mock: [ubus status, data].
function uci(method, args) {
  if (method === 'get') {
    if (args.config === 'network') return args.section ? (mock.net[args.section] ? [0, { values: clone(mock.net[args.section]) }] : [4]) : [0, { values: clone(mock.net) }];
    return [0, { values: clone(mock.cfg) }];
  }
  if (method === 'changes') {
    // rpcd answers a bare list for one named config and a table keyed by config otherwise.
    if (args.config) return [0, { changes: mock.staged.filter(c => configOf(c) === args.config).map(c => c.slice(0, 4)) }];
    const keyed = {};
    for (const c of mock.staged) (keyed[configOf(c)] ??= []).push(c.slice(0, 4));
    return [0, { changes: keyed }];
  }
  if (method === 'set') { for (const [k, v] of Object.entries(args.values)) mock.staged.push(['set', args.section, k, v, args.config]); return [0, {}]; }
  if (method === 'add') {
    const name = args.name ?? `cfg${100 + nextId++}`;
    mock.staged.push(['add', name, args.type, args.values ?? {}, args.config]);
    return [0, { section: name }];
  }
  if (method === 'delete') { for (const o of args.options ?? [undefined]) mock.staged.push(['delete', args.section, o, undefined, args.config]); return [0, {}]; }
  if (method === 'revert') { mock.staged = mock.staged.filter(c => configOf(c) !== args.config); return [0, {}]; }
  if (method === 'apply') {
    mock.snapshot = { cfg: clone(mock.cfg), net: clone(mock.net) };
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
    // Real router: reads only. A write would change its configuration, so it is blocked and the test fails.
    if (obj === 'uci' && WRITES.includes(method)) { mock.unsafe.push(`${obj}.${method}`); return ok([6]); }
    return null;
  }
  if (mock.expired && ['uci', 'dhcp', 'system', 'service', 'session', 'network.interface'].includes(obj)) return denied;
  if (obj === 'uci') { mock.calls.push(`uci.${method}`); return ok(uci(method, args)); }
  if (obj === 'dhcp') return mock.noDaemon ? ok([4]) : mock.dnsmasq && method === 'ipv4leases' ? ok([4]) : ok([0, method === 'ipv4leases' ? LEASES4 : method === 'ipv6leases' ? LEASES6 : RA]);
  if (obj === 'file' && method === 'read') return ok([0, { data: mock.leaseFile }]);
  if (obj === 'network.interface' && method === 'dump') return ok([0, DUMP]);
  if (obj === 'system' && method === 'board') return ok([0, { hostname: 'openwrt', model: 'GL.iNet GL-MT6000' }]);
  if (obj === 'service' && method === 'list') return ok([0, mock.noDaemon ? {} : { odhcpd: { instances: { instance1: { running: true } } }, ...(mock.dnsmasq ? { dnsmasq: { instances: { cfg01: { running: true } } } } : {}) }]);
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
// Opens the DHCP page with a session in sessionStorage, the way a real sign-in leaves the tab.
const open = async acls => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(([id, a]) => {
    sessionStorage.setItem('sid', id);
    sessionStorage.setItem('acls', JSON.stringify(a));
  }, [sid, acls ?? rootAcls]);
  await p.goto(`${baseUrl}#dhcp`);
  await p.waitForSelector('.dhcp-form, .login-form', { timeout: 20000 });
  return p;
};
let page = await open();

// Helpers: tiles, the clients list, static lease rows and pool controls, the banner, and screenshots.
const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
// The small text under the value of tile number `i`.
const tileSub = async i => (await page.locator('.tile .sub').nth(i).innerText()).trim();
// The card whose header contains `title`.
const cardOf = title => page.locator('.card').filter({ has: page.locator('.card-header', { hasText: title }) });
// The table body rows of the card titled `title`.
const bodyRows = title => cardOf(title).locator('tbody tr');
// A static lease by the name it has now. Rows are found by their draft key (h0, h1, ... in the order of the config, new
// ones after them), which the page puts in the id of the client's <tbody>; the keys start over after a save.
let KEYS = { flabn01: 'h0', 'SkyQ-L2-Mesh': 'h1', homeassistant: 'h2', soundbar: 'h3' };
// The <tbody> of the static lease for the host called `name`.
const hostRow = name => page.locator(`#dhcp-host-${KEYS[name]}`);
// Every static lease (a client list entry with a draft key).
const hostRows = () => page.locator('.dhcp-clients tbody[id^="dhcp-host-"]');
// Every client of the list, static or dynamic, as its first row.
const clientRows = () => page.locator('.dhcp-clients > tbody.dhcp-client-body > tr:not(.dhcp-edit-row)');
// The client row whose first cell says `text`.
const clientOf = text => clientRows().filter({ hasText: text });
// The input of a static lease whose title is `field`; the lease's editor is opened first when it is closed.
const hostInput = (row, field) => row.locator(`input[title="${field}"]`);
// Opens the editor of a static lease (a no-op when it is open) and returns its <tbody>.
const edit = async row => {
  if (!(await row.locator('.dhcp-edit').count())) await row.locator('button[aria-label="Edit this static lease"]').click();
  return row;
};
// The card of the DHCP pool on interface `iface`.
const poolCard = iface => page.locator('.card').filter({ has: page.locator('.card-header span:text-is("Pool ' + iface + '")') });
// The folding group of a pool card whose summary contains `title`.
const group = (iface, title) => poolCard(iface).locator('details').filter({ has: page.locator('summary', { hasText: title }) });
// The form field (or checkbox) labeled `label` within `scope`.
const field = (scope, label) => scope.locator('.set-field, .set-check').filter({ hasText: label }).first();
// All the notes under the form, joined into one string.
const notes = () => page.locator('.set-notes .set-note').allInnerTexts().then(t => t.join(' | '));
// The save bar.
const bar = () => page.locator('.set-bar');
// How many error notes the form shows.
const errorCount = () => page.locator('.set-notes .set-note.bad').count();
// The "Save and apply" button.
const saveBtn = () => page.locator('button:has-text("Save and apply")');
// The text of the review of pending changes.
const changes = () => page.locator('.set-changes').evaluate(e => e.textContent);
// Saves a full-page screenshot named after `label`, when a screenshot folder is set.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `dhcp-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Waits for the save bar to report the result of a save and returns its text.
const outcome = async () => { const n = page.locator('.set-bar .set-outcome.ok, .set-bar .set-outcome.bad').first(); await n.waitFor({ timeout: 20000 }); return (await n.innerText()).trim(); };
// Clicks Refresh and gives the page a moment to redraw.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };

//#region Navigation and the real router (read only)
console.log('== navigation ==');
const nav = (await page.locator('.nav-pane a.nav-link-fl').allInnerTexts()).map(t => t.trim());
check(nav.indexOf('Devices and Interfaces') === nav.indexOf('VPN: WireGuard') + 1 && nav.indexOf('DHCP') === nav.indexOf('Devices and Interfaces') + 1 && nav.indexOf('DNS') === nav.indexOf('DHCP') + 1, 'Devices and Interfaces follows the VPN pages and precedes DHCP and the combined DNS page', nav.join(' | '));
check((await page.locator('.cmdbar h1').innerText()).trim() === 'DHCP', 'the page title');

console.log('\n== the real router (read only, nothing is written) ==');
const real = await page.evaluate(async () => {
  const sid = sessionStorage.getItem('sid');
  // One ubus call from the page with its session, returning the data of the reply.
  const call = async (obj, method, args = {}) => (await (await fetch('/ubus', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [sid, obj, method, args] }) })).json()).result[1];
  const cfg = (await call('uci', 'get', { config: 'dhcp' })).values;
  // The number of leases across all the devices of a DHCP lease reply.
  const count = r => Object.values(r?.device ?? {}).reduce((n, d) => n + (d.leases?.length ?? 0), 0);
  return {
    hosts: Object.values(cfg).filter(s => s['.type'] === 'host').length, pools: Object.values(cfg).filter(s => s['.type'] === 'dhcp').length,
    v4: count(await call('dhcp', 'ipv4leases')), v6: count(await call('dhcp', 'ipv6leases')),
  };
});
check(real.pools >= 1 && real.hosts >= 1, 'the router has pools and static leases to show', JSON.stringify(real));
check(await tile(0) === 'Running' && await tile(1) === String(real.v4) && await tile(2) === String(real.v6) && await tile(3) === String(real.hosts), 'the tiles show the real daemon state, lease counts and static leases', `${await tile(0)} ${await tile(1)} ${await tile(2)} ${await tile(3)} vs ${JSON.stringify(real)}`);
const realClients = await clientRows().count();
check(realClients >= Math.max(real.v4, real.v6, real.hosts) && realClients <= real.v4 + real.v6 + real.hosts, 'every lease and static lease is in the clients list, with a client holding several of them once', `${realClients} clients for ${JSON.stringify(real)}`);
check(await hostRows().count() === real.hosts && await page.locator('.card .card-header:has-text("Pool ")').count() === real.pools, 'every static lease and every pool is shown');
check(await saveBtn().isDisabled() && !(await bar().evaluate(e => e.classList.contains('pending'))) && await hostRows().first().locator('button[aria-label="Edit this static lease"]').isEnabled(), 'the router login may edit; nothing is pending and Save is disabled until something changes');
check(await page.locator('.dhcp-client-id').evaluateAll(els => els.some(e => e.textContent.includes(':'))) && await hostRows().first().locator('button[aria-label="Remove this static lease"]').count() === 1, 'clients show their MAC addresses and static leases have a Remove button');
await shot('real');
//#endregion

//#region Mock: reading
mock.on = true;
await page.reload();
await page.waitForSelector('.dhcp-form');
console.log('\n== reading (mock router) ==');
check(await tile(0) === 'Running' && /main DHCPv4 server/.test(await tileSub(0)) && await tile(1) === '4' && /1 static · 3 dynamic/.test(await tileSub(1)) && await tile(2) === '2' && /1 static · 1 dynamic/.test(await tileSub(2)) && await tile(3) === '4' && /2 with a lease now/.test(await tileSub(3)), 'tiles: daemon, 4 DHCPv4 leases (1 static), 2 DHCPv6 leases, 4 static leases (2 with a lease now)', `${await tile(0)} ${await tile(1)} ${await tileSub(1)} ${await tile(2)} ${await tileSub(2)} ${await tile(3)} ${await tileSub(3)}`);
const clients = (await clientRows().allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
check(clients.length === 7 && /flabn01.*88:ae:dd:66:16:05.*lan.*192\.168\.1\.2.*static/.test(clients[0]) && /homeassistant.*static.*no lease now/.test(clients[1]) && /192\.168\.1\.140.*dynamic.*bad hostname/.test(clients[2]) && /laptop.*192\.168\.1\.150.*2a01:827::596.*dynamic.*IA_NA/.test(clients[3]) && /soundbar.*static.*IA_NA.*IA_PD/.test(clients[4]) && /iot.*lan100.*192\.168\.100\.130.*dynamic/.test(clients[5]) && /SkyQ-L2-Mesh.*static.*no lease now/.test(clients[6]), 'one row per client, sorted by interface and address: a static lease holds its leases, a client with DHCPv4 and DHCPv6 leases is one row, a static lease with none says so', clients.join(' / '));
check(/fd00:1:2:3::\/64/.test(clients[4]) && /1 × \/64/.test(clients[4]) && /2a01:827::11/.test(clients[4]), 'delegated prefixes show with their /64 size next to the addresses', clients[4]);
check(await clientOf('flabn01').locator('button[aria-label="Ping 192.168.1.2"]').count() === 1 && await clientOf('laptop').locator('button[aria-label="Ping 192.168.1.150"]').count() === 1 && await clientOf('soundbar').locator('button[aria-label^="Ping"]').count() === 0 && await clientOf('homeassistant').locator('button[aria-label="Wake this client"]').count() === 1 && await clientOf('SkyQ-L2-Mesh').locator('button[aria-label="Wake this client"]').count() === 1 && await clientOf('flabn01').locator('button[aria-label="Wake this client"]').count() === 0, 'with the Toolbox installed, a client that holds an IPv4 address has Ping and a saved static lease with no lease now has Wake');
check(await clientOf('flabn01').locator('button:has-text("Make static")').count() === 0 && await clientOf('laptop').locator('button:has-text("Make static")').count() === 1 && await clientOf('iot').locator('button:has-text("Make static")').count() === 1, 'only dynamic clients have Make static');
check(await clientOf('laptop').locator('.dhcp-client-id').innerText() === 'aa:bb:cc:dd:ee:ff', 'a link-layer DUID joins the DHCPv6 lease to its DHCPv4 client, which is shown by MAC');
check(await bodyRows('IPv6 prefixes advertised').count() === 2 && /stale/.test(await bodyRows('IPv6 prefixes advertised').nth(1).innerText()), 'advertised prefixes, one of them stale');
check(await hostRows().count() === 4 && await page.locator('.dhcp-edit').count() === 0, 'four static leases, with their editors closed');
await edit(hostRow('flabn01'));
check(await hostInput(hostRow('flabn01'), 'IPv4 address').inputValue() === '192.168.1.2' && await hostRow('flabn01').locator('.form-label').count() === 6 && await hostRow('flabn01').locator('.form-text').count() === 6, 'the editor of a static lease has a labelled, explained box for each of its six options');
await hostRow('flabn01').locator('button[aria-label="Close the editor"]').click();
check(await page.locator('.dhcp-edit').count() === 0, 'its button closes the editor again');
await edit(hostRow('homeassistant'));
check(await hostInput(hostRow('homeassistant'), 'MAC address(es)').inputValue() === '02:F0:F4:50:6B:7D 02:F0:F4:50:6B:7E' && /02:f0:f4:50:6b:7d 02:f0:f4:50:6b:7e/.test(await clientOf('homeassistant').locator('.dhcp-client-id').innerText()), 'two MACs of one static lease are shown in one box, and in the list');
await hostRow('homeassistant').locator('button[aria-label="Close the editor"]').click();
check(await poolCard('lan').locator('.sub').innerText().then(t => /192\.168\.1\.1\/24 · DHCPv4 192\.168\.1\.128 – 192\.168\.1\.247 \(120\) · DHCPv6 server · RA server/.test(t)), 'a pool\'s header says its subnet, range and services', await poolCard('lan').locator('.sub').innerText());
check(await group('lan', 'Services').getAttribute('open') === null && await group('lan', 'DHCPv4 pool and options').getAttribute('open') === null && await group('lan', 'Router advertisements').getAttribute('open') === null, 'the pool option groups start collapsed');
check(await bar().isHidden(), 'the banner is hidden while nothing is edited');
check(await cardOf('Network boot').locator('tbody tr').count() === 1 && await cardOf('Network boot').locator('input[title="Boot file address"]').inputValue() === 'tftp://[fd11::1]/pxe.efi' && await cardOf('Network boot').locator('input[title="Architecture code"]').inputValue() === '07', 'the network boot entry is shown with its address and architecture');
check(/dhcp_option/.test(await poolCard('lan').locator('.dhcp-extra').textContent()) && /3,192\.168\.1\.254/.test(await poolCard('lan').locator('.dhcp-extra').textContent()) && /force/.test(await poolCard('lan').locator('.dhcp-extra').textContent()) && await poolCard('lan100').locator('.dhcp-extra').count() === 0, 'options this page has no control for are listed read only in their pool, and only where there are some');
check((await page.locator('main .page-section-title').allInnerTexts()).join(' | ') === 'Daemon settings | Pool settings | Network boot | Router advertisements | Leases', 'the DHCP page orders the daemon, pools and network boot settings, then the advertised prefixes, before the client list');
await shot('mock-base');

console.log('\n== folding the daemon and the pools ==');
// The clickable header of the pool card on `iface`.
const foldHeader = iface => poolCard(iface).locator('.card-header');
const daemonCard = page.locator('.card:has(.card-header:has-text("odhcpd daemon"))');
check(await daemonCard.locator('.set-fields').first().isHidden() && /main DHCPv4 server · log level 6/.test(await daemonCard.locator('.card-header').innerText()), 'the daemon card starts folded, and its header sums up the main switch and the log level');
await daemonCard.locator('.card-header').click();
check(await daemonCard.locator('.set-fields').first().isVisible(), 'clicking the daemon header opens it');
await daemonCard.locator('.card-header').click();
check(await poolCard('lan').locator('.dhcp-groups').isHidden() && await poolCard('lan100').locator('.dhcp-groups').isHidden() && await foldHeader('lan').getAttribute('aria-expanded') === 'false' && /DHCPv4 192\.168\.100\.128/.test(await poolCard('lan100').locator('.sub').innerText()), 'pools start folded down to their header, which still summarizes the pool');
await foldHeader('lan100').click();
check(await poolCard('lan100').locator('.dhcp-groups').isVisible() && await foldHeader('lan100').getAttribute('aria-expanded') === 'true', 'clicking a pool\'s header opens it');
check(await poolCard('lan').locator('.dhcp-groups').isHidden(), 'the other pool is not affected');
await cardOf('DHCP clients').locator('.search input').fill('x');
await cardOf('DHCP clients').locator('.search input').fill('');
check(await poolCard('lan100').locator('.dhcp-groups').isVisible(), 'the pool stays open when the page is redrawn');
await foldHeader('lan100').focus();
await page.keyboard.press('Enter');
check(await poolCard('lan100').locator('.dhcp-groups').isHidden(), 'Enter on the header folds it again');
await foldHeader('lan').click();
await foldHeader('lan100').click();
await daemonCard.locator('.card-header').click();

console.log('\n== filtering ==');
const clientsCard = cardOf('DHCP clients');
const search = clientsCard.locator('.search input');
await search.fill('laptop');
check(await search.evaluate(el => document.activeElement === el), 'typing in the filter keeps focus while the list redraws');
check(await clientRows().count() === 1 && /1 of 7/.test(await clientsCard.locator('.sub').innerText()), 'the text filter matches names, addresses and identifiers');
await search.fill('2a01:827::11');
check(await clientRows().count() === 1 && /soundbar/.test(await clientRows().first().innerText()), 'it finds a client by an IPv6 address too');
await search.fill('IA_PD');
check(await clientRows().count() === 1, 'and by what the client holds from DHCPv6');
await search.fill('');
await clientsCard.locator('select[title="Show the clients of one interface"]').selectOption('lan100');
check(await clientRows().count() === 1 && /iot/.test(await clientRows().first().innerText()), 'the interface filter shows one network');
await clientsCard.locator('select[title="Show the clients of one interface"]').selectOption('all');
const typeSelect = clientsCard.locator('select[title="Show static or dynamic leases"]');
await typeSelect.selectOption('static');
check(await clientRows().count() === 4, 'the type filter can show only static leases');
await typeSelect.selectOption('dynamic');
check(await clientRows().count() === 3 && await clientsCard.locator('button:has-text("Make static")').count() === 3, 'only dynamic leases');
await typeSelect.selectOption('idle');
check(await clientRows().count() === 2 && /SkyQ|homeassistant/.test((await clientRows().allInnerTexts()).join()), 'or the static leases that hold no lease now');
await typeSelect.selectOption('all');//#endregion

//#region Editing static leases
console.log('\n== editing static leases ==');
const flab = await edit(hostRow('flabn01'));
await hostInput(flab, 'IPv4 address').fill('192.168.1.20');
check(await bar().isVisible() && /1 unsaved change: Static lease flabn01: IPv4 address/.test(await page.locator('.set-bar-summary').innerText()) && await bar().evaluate(e => getComputedStyle(e).backgroundColor) === 'rgb(255, 244, 206)', 'an edit shows the yellow banner naming the change', await page.locator('.set-bar-summary').innerText());
await page.click('.set-bar button:has-text("Details")');
check(/Static lease flabn01: IPv4 address: 192\.168\.1\.2 → 192\.168\.1\.20/.test(await changes()), 'Details show from and to');
await page.click('.set-bar button:has-text("Hide details")');
await hostInput(flab, 'IPv4 address').fill('192.168.1.3');
check(/also reserved for (homeassistant|flabn01)/.test(await notes()) && await hostInput(flab, 'IPv4 address').evaluate(e => e.classList.contains('is-invalid')) && await saveBtn().isDisabled() && await bar().evaluate(e => getComputedStyle(e).backgroundColor) === 'rgb(253, 243, 244)', 'an address already reserved is marked, turns the banner red and blocks Save', await notes());
await hostInput(flab, 'IPv4 address').fill('192.168.1.1');
check(/router's own address/.test(await notes()), 'the router\'s own address is refused');
await hostInput(flab, 'IPv4 address').fill('10.9.9.9');
check(/outside every subnet/.test(await bar().innerText()) && await saveBtn().isEnabled(), 'an address outside the served subnets only warns');
await hostInput(flab, 'IPv4 address').fill('192.168.1.20');
await hostInput(flab, 'MAC address(es)').fill('zz');
check(/not a MAC address/.test(await notes()) && await saveBtn().isDisabled(), 'a bad MAC blocks Save');
await flab.locator('button:has-text("Done")').click();
check(await flab.locator('.dhcp-edit').count() === 1 && await flab.locator('button:has-text("Done")').isDisabled(), 'the editor cannot be closed while it holds an error');
await hostInput(flab, 'MAC address(es)').fill('88-ae-dd-66-16-05');
check(!/MAC/.test(await notes()) && /1 unsaved change/.test(await page.locator('.set-bar-summary').innerText()), 'another spelling of the same MAC is not a change');

await page.locator('button:has-text("Add static lease")').click();
check(await hostRows().count() === 5 && await page.evaluate(() => document.activeElement?.title === 'Name') && await clientRows().first().evaluate(tr => tr.parentElement.id) === 'dhcp-host-h4', 'Add static lease puts a new, open row first and focuses its name');
check(!/unsaved change: .*New static lease/.test(await page.locator('.set-bar-summary').innerText()) && !/needs a MAC/.test(await notes()), 'an empty new row is not a change and is not complained about yet');
const fresh = page.locator('#dhcp-host-h4');
await hostInput(fresh, 'Name').fill('printer');
check(/needs a MAC address or a DUID/.test(await notes()), 'a new static lease with a name but no MAC is refused');
await hostInput(fresh, 'MAC address(es)').fill('dc:cd:2f:a8:b1:7a');
await hostInput(fresh, 'IPv4 address').fill('192.168.1.21');
check(!(await notes()) && /New static lease printer/.test(await page.locator('.set-bar-summary').innerText()), 'filled in, it is valid and listed as a new static lease');

await clientOf('laptop').locator('button:has-text("Make static")').click();
const made = page.locator('#dhcp-host-h5');
check(await hostRows().count() === 6 && await hostInput(made, 'IPv4 address').inputValue() === '192.168.1.150' && await hostInput(made, 'MAC address(es)').inputValue() === 'AA:BB:CC:DD:EE:FF' && await hostInput(made, 'Name').inputValue() === 'laptop', 'Make static turns a dynamic client into a new static lease with its name, address and MAC');
check(await clientOf('laptop').count() === 1 && await clientOf('laptop').locator('button:has-text("Make static")').count() === 0 && /\bnew\b/.test(await clientOf('laptop').innerText()) && /2a01:827::596/.test(await clientOf('laptop').innerText()), 'the client stays one row: it is now the new static lease, still showing what it holds');

const sky = hostRow('SkyQ-L2-Mesh');
await sky.locator('button[aria-label="Remove this static lease"]').click();
check(/to be removed/.test(await sky.innerText()) && await sky.locator('button:has-text("Undo")').count() === 1, 'Remove marks an existing static lease (it is not gone until saved)');
await sky.locator('button:has-text("Undo")').click();
check(!/to be removed/.test(await hostRow('SkyQ-L2-Mesh').innerText()), 'Undo brings it back');
await made.locator('tr').first().locator('button[aria-label="Remove this static lease"]').click();
check(await hostRows().count() === 5 && await clientOf('laptop').locator('button:has-text("Make static")').count() === 1, 'removing a new row drops it at once, and the client offers Make static again');
await clientOf('laptop').locator('button:has-text("Make static")').click();
check(await hostRows().count() === 6, 'which adds it once more');
await shot('mock-static-leases');//#endregion

//#region Editing pools and the daemon
console.log('\n== editing pools and the daemon ==');
const v4group = group('lan', 'DHCPv4 pool and options');
await v4group.locator('summary').click();
await field(v4group, 'Pool start').locator('input').fill('300');
check(/beyond the end of the subnet/.test(await notes()) && await saveBtn().isDisabled(), 'a pool that starts beyond its subnet is refused');
await foldHeader('lan').click();
const keepName = await hostInput(hostRow('flabn01'), 'Name').inputValue();
await hostInput(hostRow('flabn01'), 'Name').fill(`${keepName}-`);
check(await poolCard('lan').locator('.dhcp-groups').isVisible() && await v4group.getAttribute('open') !== null, 'a folded pool that holds an error opens again so the error is not hidden');
await hostInput(hostRow('flabn01'), 'Name').fill(keepName);
await field(v4group, 'Pool start').locator('input').fill('100');
await field(v4group, 'Pool size').locator('input').fill('80');
await field(v4group, 'Lease time').locator('input').fill('12h');
await field(v4group, 'DNS servers').locator('button:has-text("Add DNS server")').click();
await page.keyboard.type('1.1.1.1');
check(/lan: DNS servers/.test(await page.locator('.set-bar-summary').innerText()), 'a list option is edited with Add');
await group('lan', 'Router advertisements').locator('summary').click();
await field(group('lan', 'Router advertisements'), 'Router lifetime').locator('input').fill('9999');
check(/at most 9000/.test(await notes()), 'a collapsed group opens on click and its numbers are checked');
await field(group('lan', 'Router advertisements'), 'Router lifetime').locator('input').fill('1800');
await group('lan', 'Services').locator('summary').click();
await field(group('lan', 'Services'), 'Create leases dynamically').locator('input').uncheck();
await group('lan100', 'Services').locator('summary').click();
await group('lan100', 'Services').locator('select').first().selectOption('disabled');
await page.locator('.card:has(.card-header:has-text("odhcpd daemon"))').locator('.set-field').filter({ hasText: 'Log level' }).locator('input').fill('5');
await page.locator('.card:has(.card-header:has-text("odhcpd daemon"))').locator('.set-check').filter({ hasText: 'main DHCPv4' }).locator('input').uncheck();
check(/no longer the main DHCPv4 server/.test(await bar().innerText()), 'switching odhcpd off as the main DHCPv4 server warns');
await page.locator('.card:has(.card-header:has-text("odhcpd daemon"))').locator('.set-check').filter({ hasText: 'main DHCPv4' }).locator('input').check();
await shot('mock-pools');
//#endregion

//#region Saving
console.log('\n== saving ==');
await page.waitForTimeout(11500);
check(await hostInput(hostRow('flabn01'), 'IPv4 address').inputValue() === '192.168.1.20', 'the page does not poll over unsaved edits');
await hostInput(await edit(hostRow('SkyQ-L2-Mesh')), 'Name').fill('SkyQ-Mesh');
await hostRow('homeassistant').locator('button[aria-label="Remove this static lease"]').click();
mock.calls = [];
await saveBtn().click();
const done = await outcome();
check(/^Saved/.test(done), 'a successful save says so', done);
KEYS = { flabn01: 'h0', renamed: 'h0', 'SkyQ-Mesh': 'h1', soundbar: 'h2', printer: 'h3' };
check(/^uci\.changes( uci\.(set|add|delete))+ uci\.apply( uci\.get)+ uci\.confirm/.test(mock.calls.join(' ')), 'checked the whole session for leftovers, staged, applied, read back, confirmed', mock.calls.join(' '));
const cfg = mock.cfg;
check(cfg.cfg1.ip === '192.168.1.20' && cfg.cfg1.mac === '88:AE:DD:66:16:05' && cfg.cfg2.name === 'SkyQ-Mesh' && !cfg.cfg3, 'changed static leases were written, a removed one is gone, untouched options kept', JSON.stringify([cfg.cfg1, cfg.cfg2, cfg.cfg3]));
const added = Object.values(cfg).filter(s => s['.type'] === 'host' && ['printer', 'laptop'].includes(s.name));
check(added.length === 2 && added.find(s => s.name === 'printer').mac === 'DC:CD:2F:A8:B1:7A' && added.find(s => s.name === 'laptop').ip === '192.168.1.150', 'new static leases were added with their MACs in capitals', JSON.stringify(added));
check(cfg.lan.start === '100' && cfg.lan.limit === '80' && cfg.lan.leasetime === '12h' && cfg.lan.dynamicdhcp === '0' && cfg.lan.ra_lifetime === '1800' && JSON.stringify(cfg.lan.dns) === '["192.168.1.1","1.1.1.1"]' && cfg.lan100.dhcpv4 === 'disabled' && cfg.odhcpd.loglevel === '5' && cfg.odhcpd.maindhcp === '1', 'pool and daemon options were written (a list as a list, switches as 0/1)', JSON.stringify([cfg.lan, cfg.lan100, cfg.odhcpd]));
check(await tile(3) === '5' && await bar().locator('.set-outcome.ok').count() === 1 && await saveBtn().isHidden() && await page.locator('button:has-text("Discard edits")').isHidden() && !/null|undefined/.test(await bar().innerText()), 'the page shows the saved state and keeps the outcome, without Save and Discard buttons');
check(await hostRows().count() === 5 && await hostInput(await edit(hostRow('printer')), 'MAC address(es)').inputValue() === 'DC:CD:2F:A8:B1:7A', 'the list shows the saved static leases');
await shot('mock-saved');

console.log('\n== a change the router does not keep ==');
mock.dropWrites = true;
await hostInput(await edit(hostRow('flabn01')), 'Name').fill('renamed');
mock.calls = [];
await saveBtn().click();
const lost = await outcome();
check(/rolled back/.test(lost) && /Static leases was not saved/.test(lost), 'a change that does not read back is rolled back and reported', lost);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && mock.staged.length === 0, 'rollback is called, confirm is not, and nothing stays staged', mock.calls.join(' '));
check(await hostInput(await edit(hostRow('renamed')), 'Name').inputValue() === 'renamed' && mock.cfg.cfg1.name === 'flabn01', 'the edit stays in the form for a retry, the router is unchanged');
mock.dropWrites = false;
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);
check(await bar().isHidden() && await hostInput(await edit(hostRow('flabn01')), 'Name').inputValue() === 'flabn01', 'Discard edits returns to what the router has and hides the banner');

console.log('\n== leftovers from an earlier attempt ==');
mock.staged = [['set', 'cfg1', 'name', 'stale'], ['delete', 'cfg2', undefined]];
await refresh();
check(/2 change\(s\) are already staged/.test(await page.locator('main').innerText()), 'staged changes in the session are shown');
await page.getByRole('button', { name: "Discard this page's staged changes", exact: true }).click();
await page.waitForTimeout(700);
check(mock.staged.length === 0 && !/already staged/.test(await page.locator('main').innerText()), "Discard clears this page's staged changes");
//#endregion

//#region Pools, network boot entries and the server DUID
console.log('\n== adding and removing pools ==');
mock.cfg.spare = section('spare', 'dhcp', { interface: 'wan', dhcpv4: 'disabled', dhcpv6: 'disabled', ra: 'disabled' });
await refresh();
check(await poolCard('wan').count() === 1 && /DHCPv4 disabled/.test(await poolCard('wan').locator('.sub').innerText()), 'a pool the router has for another interface is shown');
check(JSON.stringify(await page.locator('.dhcp-addpool select option').allInnerTexts()) === '["guest"]', 'only interfaces without a pool are offered for a new one', JSON.stringify(await page.locator('.dhcp-addpool select option').allInnerTexts()));
await page.locator('.dhcp-addpool button:has-text("Add pool")').click();
const guest = poolCard('guest');
check(await guest.count() === 1 && await guest.locator('.dhcp-groups').isVisible() && /\bnew\b/i.test(await guest.locator('.card-header').innerText()) && await guest.locator('.sub').innerText().then(t => /192\.168\.50\.1\/24 · DHCPv4 192\.168\.50\.100 – 192\.168\.50\.249 \(150\) · DHCPv6 server · RA server/.test(t)), 'Add pool opens a new pool for the interface, as a server for DHCPv4, DHCPv6 and RA', await guest.locator('.sub').innerText());
check(/Every interface already has a pool/.test(await page.locator('.dhcp-addpool').innerText()) && await page.locator('.dhcp-addpool select').count() === 0, 'once every interface has a pool there is nothing left to add');
await group('guest', 'DHCPv4 pool and options').locator('summary').click();
await field(group('guest', 'DHCPv4 pool and options'), 'Pool start').locator('input').fill('50');
await field(group('guest', 'DHCPv4 pool and options'), 'Pool start').locator('input').fill('300');
check(/guest: the pool starts beyond the end of the subnet 192\.168\.50\.1\/24/.test(await notes()) && await saveBtn().isDisabled(), 'a new pool is checked against its interface\'s subnet');
await field(group('guest', 'DHCPv4 pool and options'), 'Pool start').locator('input').fill('50');
check(await errorCount() === 0, 'and is fine once the start is inside it');

await foldHeader('wan').click();
await poolCard('wan').locator('button:has-text("Remove pool")').click();
check(/to be removed/.test(await poolCard('wan').locator('.card-header').innerText()) && await poolCard('wan').locator('select').first().isDisabled() && /Pool wan is removed/.test(await bar().innerText()), 'Remove pool marks an existing pool (grayed out, with a warning) until it is saved');
await poolCard('wan').locator('button:has-text("Undo")').click();
check(!/to be removed/.test(await poolCard('wan').locator('.card-header').innerText()) && await poolCard('wan').locator('select').first().isEnabled(), 'Undo brings it back');
await poolCard('wan').locator('button:has-text("Remove pool")').click();

console.log('\n== the server DUID, network boot entries and the options without a control ==');
const duidInput = field(daemonCard, 'Server DUID').locator('input');
check(await duidInput.inputValue() === '0004b324b3332b47450aaa442f1f235bff2b', 'the server DUID of the network config is in the daemon card');
await duidInput.fill('xyz');
check(/Server DUID must be hexadecimal/.test(await notes()) && await duidInput.evaluate(e => e.classList.contains('is-invalid')) && await saveBtn().isDisabled(), 'a DUID that is not hexadecimal is refused');
await duidInput.fill('0004aabbccdd');
const boot = cardOf('Network boot');
await boot.locator('button:has-text("Add entry")').click();
check(await page.evaluate(() => document.activeElement?.title === 'Boot file address') && await errorCount() === 0, 'Add entry appends a row and focuses its address; an empty row is not complained about');
await boot.locator('#dhcp-boot-b1 input[title="Boot file address"]').fill('pxe.efi');
check(/must be an address such as tftp/.test(await notes()), 'a boot address needs a scheme');
await boot.locator('#dhcp-boot-b1 input[title="Boot file address"]').fill('tftp://[fd11::1]/arm.efi');
await boot.locator('#dhcp-boot-b1 input[title="Architecture code"]').fill('7');
check(/already serves architecture 7/.test(await bar().innerText()) && await saveBtn().isEnabled(), 'a second entry for the same architecture ("07" and "7") only warns');
await boot.locator('#dhcp-boot-b1 input[title="Architecture code"]').fill('efi');
check(/Architecture code must be a whole number/.test(await notes()), 'the architecture code is a number');
await boot.locator('#dhcp-boot-b1 input[title="Architecture code"]').fill('11');
await page.click('.set-bar button:has-text("Details")');
const review = await changes();
check(/New pool guest/.test(review) && /Remove pool wan/.test(review) && /odhcpd: Server DUID/.test(review) && /New network boot entry tftp:\/\/\[fd11::1\]\/arm\.efi/.test(review), 'the review lists the new pool, the removed pool, the DUID and the boot entry', review);
await page.click('.set-bar button:has-text("Hide details")');
await shot('mock-new-pool');

mock.calls = [];
await saveBtn().click();
const doneP = await outcome();
check(/^Saved/.test(doneP), 'a change across both configs is saved', doneP);
check(/^uci\.changes( uci\.(set|add|delete))+ uci\.apply( uci\.get)+ uci\.confirm/.test(mock.calls.join(' ')), 'the whole session was checked for leftovers, staged, applied, read back and confirmed', mock.calls.join(' '));
check(mock.cfg.guest?.['.type'] === 'dhcp' && mock.cfg.guest.interface === 'guest' && mock.cfg.guest.dhcpv4 === 'server' && mock.cfg.guest.start === '50' && mock.cfg.guest.limit === undefined && !mock.cfg.spare, 'the new pool was added as a dhcp section named after the interface, with only the options that differ from the defaults, and the removed one is gone', JSON.stringify(mock.cfg.guest));
check(mock.net.globals.dhcp_default_duid === '0004aabbccdd' && mock.net.globals.ula_prefix === 'fd00::/48', 'the DUID was written to the network config and its other options were left alone', JSON.stringify(mock.net));
const boots = Object.values(mock.cfg).filter(s => s['.type'] === 'boot6');
check(boots.length === 2 && boots.some(s => s.url === 'tftp://[fd11::1]/arm.efi' && s.arch === '11') && boots.some(s => s.arch === '07'), 'the new boot entry was added next to the old one', JSON.stringify(boots));
check(await poolCard('guest').count() === 1 && !/\bnew\b/i.test(await poolCard('guest').locator('.card-header').innerText()) && await poolCard('wan').count() === 0 && await boot.locator('tbody tr').count() === 2, 'the page shows the saved state: guest is a normal pool, wan is gone, two boot entries');

console.log('\n== a DUID the router does not keep ==');
mock.dropWrites = true;
await field(daemonCard, 'Server DUID').locator('input').fill('0004ffff');
mock.calls = [];
await saveBtn().click();
const lostDuid = await outcome();
check(/rolled back/.test(lostDuid) && /Server DUID was not saved/.test(lostDuid) && mock.net.globals.dhcp_default_duid === '0004aabbccdd' && mock.staged.length === 0, 'a network change that does not read back is rolled back and named', lostDuid);
mock.dropWrites = false;
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);
check(await field(daemonCard, 'Server DUID').locator('input').inputValue() === '0004aabbccdd', 'Discard edits returns to the saved DUID');
//#endregion

//#region A stopped odhcpd, a login that may not write, theme, expiry
console.log('\n== odhcpd stopped ==');
mock.noDaemon = true;
await refresh();
check(/odhcpd is not running/.test(await page.locator('main').innerText()) && await tile(0) === 'Stopped' && await tile(1) === '0' && await hostRows().count() === 5 && await hostRow('flabn01').locator('button[aria-label="Remove this static lease"]').isEnabled(), 'without the daemon there are no leases, the state says so, and the config can still be edited');
mock.noDaemon = false;
await refresh();

console.log('\n== dnsmasq serves DHCPv4, odhcpd only DHCPv6 and router advertisements ==');
const soon = Math.floor(Date.now() / 1000) + 5000;
mock.cfg.odhcpd.maindhcp = '0';
mock.dnsmasq = true;
mock.leaseFile = `${soon} 88:ae:dd:66:16:05 192.168.1.2 flabn01 *\n${soon} cc:dd:ee:00:11:22 192.168.1.151 phone *\n${soon} 66:55:44:33:22:11 192.168.100.131 * *\n`;
await refresh();
check(await tile(0) === 'Running' && /dnsmasq serves DHCPv4/.test(await tileSub(0)) && await tile(1) === '3' && /from dnsmasq/.test(await tileSub(1)) && await tile(2) === '2', 'the summary says dnsmasq serves DHCPv4 and counts its leases next to odhcpd\'s DHCPv6 ones', `${await tile(0)} | ${await tileSub(0)} | ${await tile(1)} | ${await tileSub(1)} | ${await tile(2)}`);
const row4 = (await clientRows().allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
check(row4.length === 7 && row4.some(t => t.includes('192.168.1.2') && t.includes('flabn01') && t.includes('static')), 'a lease with a static lease is shown on that static lease', row4.join(' || '));
check(row4.some(t => t.includes('phone') && t.includes('dynamic')) && row4.some(t => t.includes('lan100') && t.includes('192.168.100.131')), 'other leases are dynamic and sit on the interface of their subnet', JSON.stringify(row4));
await shot('dnsmasq');
mock.leaseFile = null;
await refresh();
await page.waitForFunction(() => /lease file could not be read/.test(document.body.innerText), null, { timeout: 5000 });
check(/lease file could not be read/.test(await page.locator('body').innerText()) && await tile(1) === '0', 'an unreadable lease file is reported, not shown as no leases');
mock.dnsmasq = false;
mock.cfg.odhcpd.maindhcp = '1';
mock.leaseFile = null;
await refresh();
check(await tile(1) === '4' && !/dnsmasq/.test(await tileSub(0)), 'with odhcpd as the main server its own leases are back');

console.log('\n== a login that may not write ==');
const ro = await open({ ubus: { system: ['board', 'info'], service: ['list'], 'network.interface': ['dump'], dhcp: ['ipv4leases', 'ipv6leases', 'ipv6ra'], uci: ['get', 'changes'] } });
await ro.locator('button[aria-label="Edit this static lease"]').first().click();
check(/not allowed to change the configuration/.test(await ro.locator('main').innerText()) && await ro.locator('.dhcp-edit input').first().isDisabled() && await ro.locator('button:has-text("Add static lease")').isDisabled() && await ro.locator('button:has-text("Make static")').count() === 0, 'the controls are disabled, there is no Make static button, and the page says why');
check(await ro.locator('.dhcp-addpool select').count() === 0 || await ro.locator('.dhcp-addpool select').isDisabled(), 'and so is Add pool');
check(await ro.locator('button:has-text("Remove pool")').first().isDisabled() && await ro.locator('button:has-text("Add entry")').isDisabled(), 'and so are Remove pool and the network boot controls');
await ro.close();

console.log('\n== theme ==');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(300);
await shot('dark');
await page.emulateMedia({ colorScheme: 'light' });

console.log('\n== the session expires ==');
await hostInput(await edit(hostRow('flabn01')), 'Name').fill('x1');
mock.expired = true;
// A poll may notice the expiry before the click lands; either way the sign-in screen must appear.
await saveBtn().click({ timeout: 5000 }).catch(() => {});
await page.waitForSelector('.login-form', { timeout: 20000 });
check(/Session expired/.test(await page.locator('.login-error').innerText()), 'an expired session returns to the sign-in screen');
//#endregion

check(mock.unsafe.length === 0, 'no uci write reached the real router', mock.unsafe.join());
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall DHCP browser checks passed');
process.exit(failed ? 1 : 0);
