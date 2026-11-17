// Browser test for the WireGuard page. A real browser opens the deployed UI.
// 1. Against the real router, read only: the page shows the router's own interfaces and peers, no key is on the page, and every uci write
//    that might be sent in this phase is blocked and fails the test, as does any `uci get` of the network config.
// 2. Against a mock of the flab.wireguard plugin built from a stateful mock of rpcd's `uci` object: the editing flow of interfaces, peers
//    and keys (validation, the write-only keys and the generator, adding and removing, the add-a-client dialog, the warnings about the
//    tunnel you are working through, saving, a change the router does not keep, an interface that does not come up, leftovers, a login
//    that may not write, a missing plugin, an expired session) WITHOUT touching the router's configuration.
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
const WRITES = ['set', 'add', 'delete', 'apply', 'confirm', 'rollback', 'revert', 'commit', 'order', 'rename'];
// A valid WireGuard key made of one repeated byte, for the mock's peers.
const K = n => Buffer.alloc(32, n).toString('base64');
const SERVER = K(1), PHONE = K(2), SITE = K(3), OLD = K(4), TABLET = K(7);
// Secrets of the mock router: they must never reach the page.
const SECRET_PRIV = 'MOCK-PRIVATE-KEY-CANARY-0123456789abcdef=', SECRET_PSK = 'MOCK-PSK-CANARY-0123456789abcdef012345=';
const SECRET_KEYS = ['private_key', 'preshared_key'];

// The network config of the mock router: wg0 with three peers (a phone that is connected, a site, a disabled one) and a few other sections.
const baseCfg = () => ({
  loopback: { '.type': 'interface', device: 'lo', proto: 'static' },
  lan: { '.type': 'interface', device: 'br-lan', proto: 'static', ipaddr: '192.168.1.1' },
  wan: { '.type': 'interface', device: 'eth1', proto: 'dhcp' },
  wg0: { '.type': 'interface', proto: 'wireguard', private_key: SECRET_PRIV, listen_port: '51820', addresses: ['10.8.0.1/24', 'fd00:8::1/64'], odd_option: 'x' },
  cfg0a1b2c: { '.type': 'wireguard_wg0', '.anonymous': true, description: 'Phone', public_key: PHONE, preshared_key: SECRET_PSK, allowed_ips: ['10.8.0.2/32', 'fd00:8::2/128'], persistent_keepalive: '25' },
  cfg0b2c3d: { '.type': 'wireguard_wg0', '.anonymous': true, description: 'Site', public_key: SITE, allowed_ips: ['192.168.8.0/24'], route_allowed_ips: '1', endpoint_host: 'site.example.com', endpoint_port: '51820' },
  cfg0c3d4e: { '.type': 'wireguard_wg0', '.anonymous': true, description: 'Old', public_key: OLD, allowed_ips: ['10.8.0.9/32'], disabled: '1' },
});
const mock = { on: false, cfg: baseCfg(), staged: [], restage: [], snapshot: null, calls: [], dropWrites: false, confirmFails: false, expired: false, noPlugin: false, protoInstalled: true, failUp: [], sessions: [{ remote: '10.8.0.2', port: 443 }], zones: { wg0: 'lan' }, reads: [], unsafe: [], kernelOnly: false };
let nextId = 1;

// An option list as an array (a UCI option may be one string of words).
const asList = v => (v == null ? [] : Array.isArray(v) ? v : String(v).split(/\s+/).filter(Boolean));
// The options of a section as the plugin reports them: no bookkeeping keys, no keys, and which keys are set.
const split = s => ({
  values: Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith('.') && !SECRET_KEYS.includes(k))),
  secrets: Object.fromEntries(SECRET_KEYS.filter(k => s[k]).map(k => [k, true])),
});

// The reply of flab.wireguard status for the mock's config: an interface is up when it is enabled, has a key and is not made to fail.
function status() {
  const interfaces = [];
  let n = 0;
  for (const [name, s] of Object.entries(mock.cfg)) {
    if (s['.type'] !== 'interface' || s.proto !== 'wireguard') continue;
    const up = s.disabled !== '1' && Boolean(s.private_key) && !mock.failUp.includes(name);
    const peers = Object.entries(mock.cfg).filter(([, p]) => p['.type'] === `wireguard_${name}`).map(([section, p]) => {
      const loaded = up && p.disabled !== '1';
      const connected = loaded && p.public_key === PHONE;
      return {
        name: p.description, public_key: p.public_key, section, ...split(p), endpoint: p.endpoint_host ? `${p.endpoint_host}:${p.endpoint_port ?? 51820}` : null,
        allowed_ips: asList(p.allowed_ips), route_allowed_ips: p.route_allowed_ips === '1', keepalive: Number(p.persistent_keepalive) || null,
        handshake_age: connected ? 20 : null, state: !loaded ? 'down' : connected ? 'connected' : 'never', rx_bytes: connected ? 1000 : 0, tx_bytes: connected ? 2000 : 0, configured: true, enabled: p.disabled !== '1',
      };
    });
    interfaces.push({
      name, configured: true, enabled: s.disabled !== '1', up, zone: mock.zones[name] ?? null, listen_port: s.listen_port ? Number(s.listen_port) : null, mtu: up ? 1420 : null, fwmark: s.fwmark ?? null,
      addresses: asList(s.addresses), ...split(s), ...(up ? { public_key: name === 'wg0' ? SERVER : K(60 + n++), rx_bytes: 5000, tx_bytes: 6000 } : {}), peers,
    });
  }
  if (mock.kernelOnly) interfaces.push({ name: 'wg9', configured: false, enabled: true, up: true, zone: null, listen_port: 51900, mtu: 1420, addresses: [], values: {}, secrets: {}, public_key: K(9), peers: [] });
  return {
    generated: Math.floor(Date.now() / 1000), proto_installed: mock.protoInstalled, interfaces, sessions: mock.sessions,
    names: Object.entries(mock.cfg).filter(([, s]) => !s['.anonymous']).map(([name]) => name).sort(),
  };
}

// Applies the staged edits to the mock's config, the way rpcd's uci apply does.
function commit() {
  for (const [op, section, option, value] of mock.staged) {
    if (op === 'set') mock.cfg[section][option] = value;
    else if (op === 'delete') (option ? delete mock.cfg[section][option] : delete mock.cfg[section]);
    else if (op === 'add') mock.cfg[section] = { '.type': option, ...(value.name ? {} : { '.anonymous': true }), ...value.values };
  }
}
// What a rollback or a failed confirmation puts back.
const restore = () => { mock.cfg = mock.snapshot; mock.staged = mock.restage; mock.snapshot = null; };

// One uci method of the mock: [ubus status, data].
function uci(method, args) {
  if (method === 'get') { mock.reads.push(`${args.config}`); return [6]; }
  if (method === 'changes') {
    const list = args.config && args.config !== 'network' ? [] : mock.staged.map(c => c.slice(0, 4));
    return [0, { changes: args.config ? list : (list.length ? { network: list } : {}) }];
  }
  if (method === 'set') { for (const [k, v] of Object.entries(args.values)) mock.staged.push(['set', args.section, k, v]); return [0, {}]; }
  if (method === 'add') {
    const name = args.name ?? `cfg${(0x100000 + nextId++).toString(16)}`;
    mock.staged.push(['add', name, args.type, { name: args.name, values: args.values ?? {} }]);
    return [0, { section: name }];
  }
  if (method === 'delete') { for (const o of args.options ?? [undefined]) mock.staged.push(['delete', args.section, o, undefined]); return [0, {}]; }
  if (method === 'revert') { if (args.config !== 'network') return [4]; mock.staged = []; return [0, {}]; }
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
    // Real router: reads only. A write would change something, so it is blocked and the test fails.
    if (obj === 'uci' && WRITES.includes(method)) { mock.unsafe.push(`${obj}.${method}`); return ok([6]); }
    if (obj === 'uci' && method === 'get') mock.reads.push(`real:${args.config}`);
    return null;
  }
  if (mock.expired && ['uci', 'flab.wireguard', 'system', 'service', 'session'].includes(obj)) return denied;
  if (obj === 'uci') { mock.calls.push(`uci.${method}`); return ok(uci(method, args)); }
  if (obj === 'flab.wireguard') return mock.noPlugin ? ok([4]) : ok([0, status()]);
  if (obj === 'system' && method === 'board') return ok([0, { hostname: 'openwrt', model: 'GL.iNet GL-MT6000' }]);
  return null;
}
//#endregion

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1300 }, colorScheme: 'light', acceptDownloads: true });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseUrl).origin });
const errors = [];
await ctx.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const reply = body ? answer(body) : null;
  return reply ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) }) : route.continue();
});
// Opens the WireGuard page with a session in sessionStorage, the way a real sign-in leaves the tab.
const open = async acls => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(([id, a]) => {
    sessionStorage.setItem('sid', id);
    sessionStorage.setItem('acls', JSON.stringify(a));
  }, [sid, acls ?? rootAcls]);
  await p.goto(`${baseUrl}#wireguard`);
  await p.waitForSelector('.wg-form, main .set-note, .login-form', { timeout: 20000 });
  return p;
};
let page = await open();

// Helpers: tiles, interface cards and their parts, the banner, and screenshots.
const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
// The card of the interface called `name`.
const card = name => page.locator('.wg-card').filter({ has: page.locator(`.wg-head .name:text-is("${name}")`) });
// The form field (or checkbox) labeled `label` within `scope`.
const field = (scope, label) => scope.locator('.set-field, .set-check').filter({ has: page.locator('label', { hasText: new RegExp(`^\\s*${label}\\s*(?:\\n[\\s\\S]*)?$`) }) }).first();
// The input of that field.
const input = (scope, label) => field(scope, label).locator('input, select').first();
// The table row of the peer called `name` in `scope`.
const peerRow = (scope, name) => scope.locator('.wg-table tbody tr:not(.wg-peer-edit)').filter({ has: page.locator(`strong:text-is("${name}")`) });
// The open editor of a peer in `scope` (the one that follows the row of `name`).
const peerEditor = (scope, name) => peerRow(scope, name).locator('xpath=following-sibling::tr[1][contains(@class,"wg-peer-edit")]');
// All the notes under the form, joined into one string.
const notes = () => page.locator('.set-notes .set-note').allInnerTexts().then(t => t.join(' | '));
// How many error notes the form shows.
const errorCount = () => page.locator('.set-notes .set-note.bad').count();
// The save bar and its buttons.
const bar = () => page.locator('.set-bar');
const saveBtn = () => page.locator('button:has-text("Save and apply")');
// The text of the review of pending changes.
const changes = () => page.locator('.set-changes').evaluate(e => e.textContent);
// Saves a full-page screenshot named after `label`, when a screenshot folder is set.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `wireguard-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Waits for the save bar to report the result of a save and returns its text.
const outcome = async () => { const n = page.locator('.set-bar .set-outcome.ok, .set-bar .set-outcome.bad').first(); await n.waitFor({ timeout: 30000 }); return (await n.innerText()).trim(); };
// Clicks Refresh and gives the page a moment to redraw.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };
// Opens the settings panel of an interface card.
const openSettings = async name => { const d = card(name).locator('details.wg-panel'); if (!(await d.evaluate(e => e.open))) await d.locator('summary').click(); };
// The page's WireGuard key module, evaluated in the browser, to work out the public key of a private key.
const publicKeyOf = priv => page.evaluate(async ([url, k]) => (await import(url)).publicKeyOf(k), [new URL('js/pages/wireguard/keys.js', baseUrl).href, priv]);

//#region The real router (read only)
console.log('== navigation ==');
const nav = (await page.locator('.nav-pane a.nav-link-fl').allInnerTexts()).map(t => t.trim());
check(nav.includes('WireGuard'), 'WireGuard is in the navigation', nav.join(' | '));
check((await page.locator('.cmdbar h1').innerText()).trim() === 'WireGuard · VPN', 'the page title');

console.log('\n== the real router (read only, nothing is written) ==');
const real = await page.evaluate(async () => {
  const sid = sessionStorage.getItem('sid');
  const r = (await (await fetch('/ubus', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [sid, 'flab.wireguard', 'status', {}] }) })).json()).result[1];
  return { names: r.interfaces.map(i => i.name), configured: r.interfaces.filter(i => i.configured).map(i => i.name), peers: r.interfaces.reduce((n, i) => n + i.peers.length, 0) };
});
check(real.names.length >= 1 && await page.locator('.wg-card').count() === real.names.length, 'every interface of the router has a card', JSON.stringify(real));
check(await page.locator('.wg-table tbody tr').count() >= real.peers && await page.locator('.wg-toolbar button:has-text("Add site-to-site peer")').count() === real.configured.length, 'the peers are listed and every configured interface has its buttons', JSON.stringify(real));
await page.locator('details.wg-panel summary').first().click();
const pw = page.locator('.wg-form input[type=password]');
check(await pw.count() >= 1 && await pw.evaluateAll(els => els.every(e => e.value === '')), 'a stored private key is never shown: the box is empty', String(await pw.count()));
check(await pw.evaluateAll(els => els.some(e => /stored; leave empty/.test(e.placeholder))), 'and says that one is stored');
check(!/private_key|preshared_key/.test(await page.locator('main').innerText()), 'no secret option on the page');
check(await saveBtn().isDisabled() && await bar().isHidden(), 'nothing is pending');
await page.locator('.wg-toolbar button:has-text("Add site-to-site peer")').first().click();
check(await page.locator('tr.wg-peer-edit').count() === 1 && /1 unsaved change/.test(await page.locator('.set-bar-summary').innerText()), 'Add site-to-site peer adds a draft peer (nothing is written)');
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);
await shot('real');
//#endregion

//#region Mock: reading
mock.on = true;
await page.reload();
await page.waitForSelector('.wg-form');
console.log('\n== reading (mock router) ==');
check(await tile(0) === '1 / 1' && await tile(1) === '1 / 2', 'tiles: the interface is up and one of two enabled peers is connected', `${await tile(0)} | ${await tile(1)}`);
check(await card('wg0').count() === 1 && await peerRow(card('wg0'), 'Phone').count() === 1 && await card('wg0').locator('.wg-table tbody tr').count() === 3, 'a card with three peers');
check(/connected/.test(await peerRow(card('wg0'), 'Phone').innerText()) && /site-to-site/.test(await peerRow(card('wg0'), 'Site').innerText()) && /routes installed/.test(await peerRow(card('wg0'), 'Site').innerText()), 'the live state and the role of each peer are shown next to the configuration');
check(await card('wg0').locator('button:has-text("Edit")').count() === 3 && await card('wg0').locator('button:has-text("Add client")').isEnabled(), 'each peer can be edited, and a client can be added');
check(!(await card('wg0').locator('details.wg-panel').evaluate(e => e.open)), 'the settings panel starts closed');
check(!(await page.locator('main').innerText()).includes('CANARY') && !(await page.content()).includes('CANARY'), 'no secret of the mock router is anywhere in the page');
await shot('mock');
await openSettings('wg0');
check(/odd_option/.test(await card('wg0').locator('.wg-extra').innerText()) && !/private_key|preshared/.test(await card('wg0').locator('.wg-extra').innerText()), 'an option without a control is listed read only (the key is not among them)');
check(await input(card('wg0'), 'Listen port').inputValue() === '51820' && await card('wg0').locator('.wg-keyfield input[type=password]').getAttribute('placeholder') === 'stored; leave empty to keep it', 'the form shows the router\'s values, and that a key is stored');
//#endregion

//#region Editing an interface
console.log('\n== editing an interface ==');
await input(card('wg0'), 'Listen port').fill('70000');
check(/Listen port must be at most 65535/.test(await notes()) && await saveBtn().isDisabled() && await input(card('wg0'), 'Listen port').evaluate(e => e.classList.contains('is-invalid')), 'a bad port is marked and blocks Save', await notes());
await input(card('wg0'), 'Listen port').fill('51821');
check(await bar().isVisible() && /1 unsaved change/.test(await page.locator('.set-bar-summary').innerText()) && await saveBtn().isEnabled(), 'a valid edit shows the banner and enables Save');
check(/restarts the tunnel/.test(await notes()) && /your own connection/.test(await notes()), 'the banner warns that this restarts the tunnel your own session is using', await notes());
await field(card('wg0'), 'Addresses').locator('input').first().fill('10.8.0.300/24');
check(/is not an address with a prefix length/.test(await notes()) && await saveBtn().isDisabled(), 'a bad address is refused');
await field(card('wg0'), 'Addresses').locator('input').first().fill('10.8.0.1/24');
await field(card('wg0'), 'Addresses').locator('button:has-text("Add address")').click();
await field(card('wg0'), 'Addresses').locator('input').last().fill('10.8.5.1');
check(/no prefix length/.test(await notes()) && await saveBtn().isEnabled(), 'an address without a prefix is only a warning');
await field(card('wg0'), 'Addresses').locator('input').last().fill('10.8.5.1/24');
await input(card('wg0'), 'MTU').fill('1500');
check(/MTU above 1420/.test(await notes()), 'an MTU that may fragment is a warning');
await input(card('wg0'), 'MTU').fill('');

console.log('\n== the private key: generated in the browser, write-only ==');
await card('wg0').locator('button:has-text("Replace with a new key")').click();
const privBox = card('wg0').locator('.wg-keyfield input').first();
const typed = await privBox.inputValue();
check(/^[A-Za-z0-9+/]{43}=$/.test(typed) && await privBox.getAttribute('type') === 'password', 'Generate puts a key in the masked box', typed);
await card('wg0').locator('.wg-derived .wg-key').waitFor();
const pubShown = (await card('wg0').locator('.wg-derived .wg-key').innerText()).trim();
check(/^[A-Za-z0-9+/]{43}=$/.test(pubShown) && pubShown === await publicKeyOf(typed) && pubShown !== typed, 'its public key is shown (worked out in the browser)', pubShown);
check(/a new private key means a new public key/.test(await notes()), 'replacing the key warns that every peer needs the new public key');
await page.click('.set-bar button:has-text("Details")');
const review = await changes();
check(/Private key: set \(hidden\) → new value \(hidden\)/.test(review) && !review.includes(typed) && /Listen port: 51820 → 51821/.test(review) && /Addresses/.test(review), 'the review lists the changes and shows the key only as "new value (hidden)"', review);
await page.click('.set-bar button:has-text("Hide details")');
await shot('interface-edited');

console.log('\n== saving ==');
mock.calls = [];
await saveBtn().click();
const done = await outcome();
check(/^Saved/.test(done), 'a successful save says so', done);
check(/^uci\.changes( uci\.(set|add|delete))+ uci\.apply uci\.confirm/.test(mock.calls.join(' ')), 'checked for leftovers, staged, applied, confirmed', mock.calls.join(' '));
check(mock.cfg.wg0.private_key === typed && mock.cfg.wg0.listen_port === '51821' && JSON.stringify(mock.cfg.wg0.addresses) === JSON.stringify(['10.8.0.1/24', 'fd00:8::1/64', '10.8.5.1/24']) && mock.cfg.wg0.odd_option === 'x' && mock.cfg.cfg0a1b2c.preshared_key === SECRET_PSK, 'the key was stored as typed, the options changed, the rest was kept', JSON.stringify({ ...mock.cfg.wg0, private_key: '(set)' }));
check(await input(card('wg0'), 'Listen port').inputValue() === '51821' && await card('wg0').locator('.wg-keyfield input').first().inputValue() === '' && await bar().locator('.set-outcome.ok').count() === 1, 'afterwards the key box is empty again, and the outcome stays');
check(mock.reads.length === 0, 'the page never reads the network config with uci get (so it can never receive a key)', mock.reads.join());
//#endregion

//#region Peers
console.log('\n== peers ==');
await peerRow(card('wg0'), 'Site').locator('button:has-text("Edit")').click();
check(await peerEditor(card('wg0'), 'Site').count() === 1, 'Edit opens the editor under the row');
const ed = peerEditor(card('wg0'), 'Site');
await input(ed, 'Keepalive \\(seconds\\)').fill('25');
await input(ed, 'Endpoint host').fill('127.0.0.1');
check(/endpoint 127\.0\.0\.1 is this router itself/.test(await notes()), 'an endpoint that does not look reachable is a warning', await notes());
await input(ed, 'Endpoint host').fill('site.example.com');
await input(ed, 'Public key').fill('nope');
check(/public key must be 44 characters/.test(await notes()) && await saveBtn().isDisabled() && await input(ed, 'Public key').evaluate(e => e.classList.contains('is-invalid')), 'a bad public key is marked and blocks Save');
await input(ed, 'Public key').fill(PHONE);
check(/same public key/.test(await notes()), 'a key another peer has is refused');
await input(ed, 'Public key').fill(SITE);
await ed.locator('.wg-keyfield button:has-text("Generate a key")').click();
const pskTyped = await ed.locator('.wg-keyfield input').first().inputValue();
check(/^[A-Za-z0-9+/]{43}=$/.test(pskTyped), 'a pre-shared key can be generated for a peer', pskTyped);
await field(ed, 'Allowed IPs').locator('button:has-text("Add allowed IP")').click();
await field(ed, 'Allowed IPs').locator('input').last().fill('10.8.0.2/32');
check(/the peers Phone and Site overlap/.test(await notes()) && /belong to one peer only/.test(await notes()), 'an address two peers claim is a warning that says which wins', await notes());
await field(ed, 'Allowed IPs').locator('input').last().fill('0.0.0.0/0');
check(/default route of the router/.test(await notes()), '0.0.0.0/0 with routes on is called the default route');
await field(ed, 'Allowed IPs').locator('input').last().fill('');
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'saving the peer works');
check(mock.cfg.cfg0b2c3d.persistent_keepalive === '25' && mock.cfg.cfg0b2c3d.preshared_key === pskTyped && mock.cfg.cfg0b2c3d.endpoint_host === 'site.example.com', 'the peer\'s section was changed in place', JSON.stringify(mock.cfg.cfg0b2c3d));

console.log('\n== adding and removing a peer ==');
await card('wg0').locator('.wg-toolbar button:has-text("Add site-to-site peer")').click();
const fresh = card('wg0').locator('tr.wg-peer-edit').last();
check(await fresh.count() === 1 && /new/.test(await card('wg0').locator('.wg-table tbody tr:not(.wg-peer-edit)').nth(3).innerText()), 'Add site-to-site peer opens an editor for the new peer');
await input(fresh, 'Name').fill('Laptop');
await input(fresh, 'Public key').fill(TABLET);
await field(fresh, 'Allowed IPs').locator('button:has-text("Add allowed IP")').click();
await field(fresh, 'Allowed IPs').locator('input').first().fill('10.8.0.20/32');
check(await errorCount() === 0 && /Laptop/.test(await page.locator('.set-bar-summary').innerText()), 'a valid new peer is listed in the banner', await notes());
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'saving the new peer works');
const added = Object.entries(mock.cfg).find(([, s]) => s['.type'] === 'wireguard_wg0' && s.description === 'Laptop');
check(added && added[1]['.anonymous'] && added[1].public_key === TABLET && JSON.stringify(added[1].allowed_ips) === JSON.stringify(['10.8.0.20/32']) && !('preshared_key' in added[1]) && added[1].route_allowed_ips === '1', 'the new peer is an anonymous wireguard_wg0 section with only the options that were set (a site-to-site peer starts with routes on)', JSON.stringify(added));
check(await peerRow(card('wg0'), 'Laptop').count() === 1, 'the peer is listed after the save');
// Removing a peer that is not the one your session comes through.
await peerRow(card('wg0'), 'Old').locator('button:has-text("Remove")').click();
check(/to be removed/.test(await peerRow(card('wg0'), 'Old').innerText()) && /Remove peer Old from wg0/.test(await page.locator('.set-bar-summary').innerText()), 'Remove marks a peer (it is not gone until saved)');
await peerRow(card('wg0'), 'Old').locator('button:has-text("Undo")').click();
check(!/to be removed/.test(await peerRow(card('wg0'), 'Old').innerText()) && await bar().isHidden(), 'Undo brings it back and leaves nothing pending');
await peerRow(card('wg0'), 'Old').locator('button:has-text("Remove")').click();
await saveBtn().click();
check(/^Saved/.test(await outcome()) && !Object.values(mock.cfg).some(s => s.description === 'Old'), 'saving removes the peer\'s section');

console.log('\n== the peer you are connected through ==');
await peerRow(card('wg0'), 'Phone').locator('button:has-text("Remove")').click();
const dlg = page.locator('dialog.fl-dialog');
await dlg.waitFor();
check(/Remove peer Phone/.test(await dlg.innerText()) && /your own connection[\s\S]*10\.8\.0\.2[\s\S]*this peer on wg0/.test(await dlg.innerText()), 'removing it asks first and says why', await dlg.innerText());
await dlg.locator('button:has-text("Cancel")').click();
await page.waitForTimeout(300);
check(!/to be removed/.test(await peerRow(card('wg0'), 'Phone').innerText()) && await saveBtn().isHidden(), 'Cancel changes nothing');
await peerRow(card('wg0'), 'Phone').locator('button:has-text("Remove")').click();
await page.locator('dialog.fl-dialog button:has-text("Remove peer")').click();
await peerRow(card('wg0'), 'Phone').locator('button:has-text("Undo")').waitFor({ timeout: 10000 }).catch(() => {});
check(/to be removed/.test(await peerRow(card('wg0'), 'Phone').innerText()) && /Removing peer Phone from wg0 cuts your own connection/.test(await notes()), 'confirming marks it, and the banner repeats the warning', await notes());
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);
await card('wg0').locator('button:has-text("Remove interface")').click();
await page.locator('dialog.fl-dialog').waitFor();
check(/Remove wg0\?/.test(await page.locator('dialog.fl-dialog').innerText()) && /ends that connection/.test(await page.locator('dialog.fl-dialog').innerText()), 'removing the interface your session uses asks too');
await page.locator('dialog.fl-dialog button:has-text("Cancel")').click();
await page.waitForTimeout(300);
mock.sessions = [];
await refresh();
await peerRow(card('wg0'), 'Phone').locator('button:has-text("Remove")').click();
await page.waitForTimeout(300);
check(await page.locator('dialog.fl-dialog').count() === 0 && /Peer Phone is connected right now/.test(await notes()) && !/your own connection/.test(await notes()), 'with no session through the tunnel there is no dialog, only the generic warning', await notes());
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);
mock.sessions = [{ remote: '10.8.0.2', port: 443 }];
await refresh();
//#endregion

//#region Adding a client
console.log('\n== adding a client ==');
await card('wg0').locator('button:has-text("Add client")').click();
const dev = page.locator('dialog.fl-dialog');
await dev.waitFor();
check(/Add a client to wg0/.test(await dev.innerText()) && /10\.8\.0\.3\/32 and fd00:8::3\/128/.test(await dev.innerText()), 'the dialog offers the next free address of each family', await dev.innerText());
await shot('client-dialog-form');
await dev.locator('button:has-text("Create the client")').click();
check(/Give the client a name/.test(await dev.innerText()), 'a name is required');
await dev.locator('input[placeholder="My phone"]').fill('My tablet');
await dev.locator('select').selectOption('custom');
check(await dev.locator('input[placeholder^="192.168.1.0"]').isVisible(), 'choosing "These networks…" shows a box for them');
await dev.locator('select').selectOption('all');
check(await dev.locator('input[placeholder^="192.168.1.0"]').isHidden(), 'and the other choices hide it');
await dev.locator('button:has-text("Create the client")').click();
await dev.locator('pre.wg-conf').waitFor();
const conf = await dev.locator('pre.wg-conf').innerText();
await shot('client-dialog-config');
await dev.locator('.fl-qr svg').waitFor();
check(await dev.locator('.fl-qr svg path').count() === 1 && (await dev.locator('.fl-qr svg').getAttribute('viewBox')).split(' ')[2] >= 29 && await dev.locator('.modal-dialog.modal-xl').count() === 1, 'the configuration is also shown as a QR code, in the wide dialog');
const privLine = /PrivateKey = (\S+)/.exec(conf)?.[1];
const pskLine = /PresharedKey = (\S+)/.exec(conf)?.[1];
check(/^\[Interface\]/.test(conf) && /Address = 10\.8\.0\.3\/32, fd00:8::3\/128/.test(conf) && new RegExp(`PublicKey = ${SERVER.replace(/[+/=]/g, c => `\\${c}`)}`).test(conf) && /AllowedIPs = 0\.0\.0\.0\/0, ::\/0/.test(conf) && /PersistentKeepalive = 25/.test(conf) && /Endpoint = .+:51821/.test(conf), 'the configuration for the device is shown: its address, the router\'s public key, the endpoint and port, what it routes', conf);
check(/^[A-Za-z0-9+/]{43}=$/.test(privLine ?? '') && /^[A-Za-z0-9+/]{43}=$/.test(pskLine ?? '') && !conf.includes(SECRET_PRIV), 'it holds a key pair and a pre-shared key made in the browser');
check(/only time/.test(await dev.innerText()) && /Save and apply/.test(await dev.innerText()), 'it says that it is shown once, and that the peer is not saved yet');
await dev.locator('button:has-text("Copy")').click();
await page.waitForTimeout(300);
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
check(clip === conf || /Copied|Copy failed/.test(await dev.locator('button:has-text("Cop")').innerText()), 'Copy copies the text', String(clip));
const [download] = await Promise.all([page.waitForEvent('download'), dev.locator('button:has-text("Download")').click()]);
check(download.suggestedFilename() === 'wg0-My-tablet.conf', 'Download offers the configuration as a file', download.suggestedFilename());
await dev.locator('button:has-text("Close")').click();
await page.waitForTimeout(300);
check(await page.locator('dialog.fl-dialog').count() === 0 && await peerRow(card('wg0'), 'My tablet').count() === 1 && /New peer on wg0 \(My tablet\)/.test(await page.locator('.set-bar-summary').innerText() + await page.locator('.set-bar').innerText()), 'the dialog closes; the peer is in the form, not saved');
await shot('client-added');
mock.calls = [];
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'saving adds the client');
const dev1 = Object.values(mock.cfg).find(s => s.description === 'My tablet');
check(dev1 && dev1.public_key === await publicKeyOf(privLine) && dev1.preshared_key === pskLine && JSON.stringify(dev1.allowed_ips) === JSON.stringify(['10.8.0.3/32', 'fd00:8::3/128']), 'the router got the public key of the shown private key, the pre-shared key and the addresses', JSON.stringify(dev1));
await card('wg0').locator('button:has-text("Add client")').click();
check(/10\.8\.0\.4\/32/.test(await page.locator('dialog.fl-dialog').innerText()), 'the next client gets the next address');
await page.locator('dialog.fl-dialog button:has-text("Cancel")').click();
await page.waitForTimeout(300);
check(await saveBtn().isHidden(), 'Cancel adds nothing');
//#endregion

//#region Adding an interface
console.log('\n== adding an interface ==');
await page.click('button:has-text("Add WireGuard interface")');
const nw = page.locator('.wg-card.wg-new');
await nw.waitFor();
await page.waitForTimeout(500);
check(/new/.test(await nw.locator('.wg-head').innerText()) && await nw.locator('details.wg-panel').evaluate(e => e.open), 'a new card opens with its settings');
check(await nw.locator('input[placeholder="wg0"]').inputValue() === 'wg1' && await input(nw, 'Listen port').inputValue() === '51820', 'it starts with the next free name and the first port no interface uses');
check(/^[A-Za-z0-9+/]{43}=$/.test(await nw.locator('.wg-keyfield input').first().inputValue()), 'and a private key made in the browser');
check(await nw.locator('button:has-text("Add client")').isDisabled(), 'a client cannot be added before the interface is saved');
check(/is in no firewall zone yet/.test(await notes()), 'the banner says the interface will be in no firewall zone');
await nw.locator('input[placeholder="wg0"]').fill('lan');
check(/already an interface or section called "lan"/.test(await notes()) && await saveBtn().isDisabled(), 'a name that is taken by any section is refused');
await nw.locator('input[placeholder="wg0"]').fill('wg-1');
check(/may only contain letters, digits and underscores/.test(await notes()), 'a name with a dash is refused');
await nw.locator('input[placeholder="wg0"]').fill('home_vpn');
await input(nw, 'Listen port').fill('51821');
check(/also the listen port of wg0/.test(await notes()), 'a port another interface uses is refused');
await input(nw, 'Listen port').fill('51830');
await field(nw, 'Addresses').locator('input').first().fill('10.9.0.1/24');
await nw.locator('button:has-text("Add site-to-site peer")').click();
const nped = nw.locator('tr.wg-peer-edit');
await input(nped, 'Name').fill('First');
await input(nped, 'Public key').fill(K(21));
await field(nped, 'Allowed IPs').locator('button:has-text("Add allowed IP")').click();
await field(nped, 'Allowed IPs').locator('input').first().fill('10.9.0.2/32');
check(await errorCount() === 0, 'a valid new interface with a peer has no errors', await notes());
await shot('interface-new');
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'saving adds the interface');
const hv = mock.cfg.home_vpn;
check(hv && hv['.type'] === 'interface' && hv.proto === 'wireguard' && /^[A-Za-z0-9+/]{43}=$/.test(hv.private_key) && hv.listen_port === '51830' && JSON.stringify(hv.addresses) === JSON.stringify(['10.9.0.1/24']), 'the interface was added by name with proto wireguard, its key and options', JSON.stringify({ ...hv, private_key: '(set)' }));
const hp = Object.values(mock.cfg).find(s => s['.type'] === 'wireguard_home_vpn');
check(hp && hp.public_key === K(21) && hp.description === 'First', 'and its peer as a wireguard_home_vpn section');
check(await card('home_vpn').count() === 1 && /no firewall zone/.test(await card('home_vpn').innerText()) && await card('home_vpn').locator('a[href="#firewall"]').count() === 1, 'the saved interface is listed with a note and a link to the Firewall page, since it is in no zone');
check(await card('home_vpn').locator('button:has-text("Add client")').isEnabled() && /up/.test(await card('home_vpn').locator('.wg-head').innerText()), 'it is running, so clients can be added');

console.log('\n== an interface that does not come up ==');
mock.failUp = ['broken'];
await page.click('button:has-text("Add WireGuard interface")');
const bw = page.locator('.wg-card.wg-new');
await bw.waitFor();
await page.waitForTimeout(400);
await bw.locator('input[placeholder="wg0"]').fill('broken');
await field(bw, 'Addresses').locator('input').first().fill('10.10.0.1/24');
mock.calls = [];
await saveBtn().click();
const failedUp = await outcome();
check(/rolled back/.test(failedUp) && /broken did not come up/.test(failedUp) && /wireguard-tools/.test(failedUp), 'the save is rolled back and says which interface did not come up', failedUp);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && !mock.cfg.broken && mock.staged.length === 0, 'rollback is called, confirm is not, the config is unchanged, nothing stays staged', mock.calls.join(' '));
check(await page.locator('.wg-card.wg-new').count() === 1 && await bar().isVisible(), 'the new interface stays in the form to be fixed');
mock.failUp = [];
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);

console.log('\n== removing an interface ==');
await card('home_vpn').locator('button:has-text("Remove interface")').click();
check(await page.locator('dialog.fl-dialog').count() === 0 && /to be removed/.test(await card('home_vpn').locator('.wg-head').innerText()) && /Remove interface home_vpn/.test(await page.locator('.set-bar').innerText() + await changes().catch(() => '')), 'an interface that carries no session is marked for removal at once');
await card('home_vpn').locator('button:has-text("Undo")').click();
check(!/to be removed/.test(await card('home_vpn').locator('.wg-head').innerText()) && await bar().isHidden(), 'Undo brings it back');
await card('home_vpn').locator('button:has-text("Remove interface")').click();
await saveBtn().click();
check(/^Saved/.test(await outcome()) && !mock.cfg.home_vpn && !Object.values(mock.cfg).some(s => s['.type'] === 'wireguard_home_vpn'), 'saving deletes the interface and its peers');
check(await card('home_vpn').count() === 0, 'the card is gone');
//#endregion

//#region Failures and other states
console.log('\n== a change the router does not keep ==');
mock.dropWrites = true;
await openSettings('wg0');
await input(card('wg0'), 'Listen port').fill('51822');
mock.calls = [];
await saveBtn().click();
const lost = await outcome();
check(/rolled back/.test(lost) && /Listen port/.test(lost), 'a change that does not read back is rolled back and named', lost);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && mock.staged.length === 0 && mock.cfg.wg0.listen_port === '51821', 'rollback is called, confirm is not, nothing stays staged, and the router is unchanged', mock.calls.join(' '));
mock.dropWrites = false;
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);
check(await bar().isHidden() && await input(card('wg0'), 'Listen port').inputValue() === '51821', 'Discard edits returns to what the router has');

console.log('\n== a confirmation that comes too late ==');
mock.confirmFails = true;
await openSettings('wg0');
await input(card('wg0'), 'Listen port').fill('51823');
await saveBtn().click();
const refused = await outcome();
check(/^Confirmation failed; the outcome is uncertain\./.test(refused) && /Rollback could not be confirmed/.test(refused) && !/was rolled back/.test(refused)
  && mock.cfg.wg0.listen_port === '51821', 'the mock restored the config, but the page reports uncertainty without a rollback acknowledgement', refused);
mock.confirmFails = false;
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);

console.log('\n== leftovers from an earlier attempt ==');
mock.staged = [['set', 'wg0', 'mtu', '1400']];
await refresh();
check(/1 change\(s\) are already staged/.test(await page.locator('main').innerText()), 'staged changes in the session are shown');
await page.getByRole('button', { name: "Discard this page's staged changes", exact: true }).click();
await page.waitForTimeout(700);
check(mock.staged.length === 0 && !/already staged/.test(await page.locator('main').innerText()), "Discard clears this page's staged changes");

console.log('\n== other states ==');
mock.kernelOnly = true;
await refresh();
check(await card('wg9').count() === 1 && /not in \/etc\/config\/network/.test(await card('wg9').innerText()) && await card('wg9').locator('button:has-text("Remove interface")').count() === 0, 'an interface only the kernel has is shown read only, with a note');
mock.kernelOnly = false;
mock.protoInstalled = false;
await refresh();
check(/wireguard-tools package\) is not installed/.test(await page.locator('main').innerText()), 'a router without the protocol handler says so');
mock.protoInstalled = true;
mock.zones = {};
await refresh();
check(/in no firewall zone/.test(await card('wg0').locator('.wg-notes').innerText()) && await card('wg0').locator('.wg-notes a[href="#firewall"]').count() === 1, 'an interface in no firewall zone links to the Firewall page');
mock.zones = { wg0: 'lan' };
const saved = mock.cfg;
mock.cfg = Object.fromEntries(Object.entries(saved).filter(([, s]) => !(s['.type'] === 'interface' && s.proto === 'wireguard') && !String(s['.type']).startsWith('wireguard_')));
await refresh();
check(/No WireGuard interface is configured/.test(await page.locator('main').innerText()) && await page.locator('button:has-text("Add WireGuard interface")').isEnabled(), 'with no interface the page says so and offers to add one');
mock.cfg = saved;
mock.noPlugin = true;
await refresh();
check(/flab\.wireguard\) is not available/.test(await page.locator('main').innerText()), 'a router without the plugin says so');
mock.noPlugin = false;
await refresh();

console.log('\n== a login that may not write ==');
const ro = await open({ ubus: { system: ['board', 'info'], service: ['list'], 'flab.wireguard': ['status'], uci: ['get', 'changes'] } });
check(/not allowed to change the configuration/.test(await ro.locator('main').innerText()) && await ro.locator('button:has-text("Add WireGuard interface")').isDisabled() && await ro.locator('button:has-text("Add site-to-site peer")').first().isDisabled() && await ro.locator('button:has-text("Edit")').first().isDisabled(), 'the controls are disabled and the page says why');
await ro.locator('details.wg-panel summary').first().click();
check(await ro.locator('.wg-panel input').first().isDisabled() && /Phone/.test(await ro.locator('.wg-table').first().innerText()), 'the form is read only, and the status is still shown');
await ro.close();

console.log('\n== theme ==');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(300);
await shot('dark');
await page.emulateMedia({ colorScheme: 'light' });

console.log('\n== the session expires ==');
await openSettings('wg0');
await input(card('wg0'), 'Listen port').fill('51899');
mock.expired = true;
// A poll may notice the expiry before the click lands; either way the sign-in screen must appear.
await saveBtn().click({ timeout: 5000 }).catch(() => {});
await page.waitForSelector('.login-form', { timeout: 20000 });
check(/Session expired/.test(await page.locator('.login-error').innerText()), 'an expired session returns to the sign-in screen');
//#endregion

check(mock.unsafe.length === 0, 'no uci write reached the real router', mock.unsafe.join());
check(!mock.reads.some(r => r.startsWith('real:network')), 'the page never read the real network config with uci get', mock.reads.join());
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall WireGuard browser checks passed');
process.exit(failed ? 1 : 0);
