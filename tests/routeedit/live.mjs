// Browser test for the Static routes tab of the Routing page. A real browser opens the deployed UI.
// 1. Against the real router, read only: the tab opens, every uci write it might send is blocked and fails the test, the network config
//    is read only by section type (the whole config holds secrets), and nothing is staged.
// 2. Against a stateful mock of rpcd's `uci` object, a `network.interface dump` and a `flab.routing status` whose kernel routes follow the
//    mocked config: reading, the state of each route, editing cells, validation, adding and removing a route, an older netmask, the
//    confirmation before a change to a default route, a change the router does not keep, a refused confirmation, leftovers staged in
//    the session, a login without write permission, one without read permission and an expired session - WITHOUT touching the router's
//    configuration.
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
const SECRET = 'mock-pppoe-password-never-read';
const mock = {
  on: false, cfg: null, staged: [], restage: [], snapshot: null, calls: [], gets: [], dropWrites: false, confirmFails: false, expired: false,
  unsafe: [], whole: [], realGets: [],
};
let nextId = 1;

// The network config of the mock router: an interface with a secret (which the page must never ask for), and the route sections of
// the sample router: a default route, a route with an older netmask, a disabled one, a blackhole in a table of its own, an IPv6 default.
const makeConfig = () => ({
  wan: { '.type': 'interface', proto: 'pppoe', username: 'me', password: SECRET },
  cfg01: { '.type': 'route', interface: 'wan', target: '0.0.0.0/0', gateway: '192.0.2.1', metric: '10' },
  cfg03: { '.type': 'route', interface: 'lan', target: '10.9.0.0', netmask: '255.255.0.0', gateway: '192.168.1.254', mtu: '1400' },
  cfg04: { '.type': 'route', interface: 'lan', target: '172.16.0.0/12', gateway: '192.168.1.254', disabled: '1' },
  cfg05: { '.type': 'route', interface: 'lan', target: '203.0.113.0/24', type: 'blackhole', table: 'voip' },
  cfg11: { '.type': 'route6', interface: 'wan', target: '::/0', gateway: 'fe80::1' },
});

// netifd's interface list of the mock router (wan2 is down).
const interfaces = () => [
  { interface: 'lan', up: true, l3_device: 'br-lan', 'ipv4-address': [{ address: '192.168.1.1', mask: 24 }], 'ipv6-address': [{ address: 'fd00::1', mask: 64 }] },
  { interface: 'wan', up: true, l3_device: 'wan', 'ipv4-address': [{ address: '192.0.2.50', mask: 24 }], 'ipv6-address': [] },
  { interface: 'wan2', up: false, 'ipv4-address': [], 'ipv6-address': [] },
  { interface: 'loopback', up: true, 'ipv4-address': [{ address: '127.0.0.1', mask: 8 }], 'ipv6-address': [] },
];

// The prefix length of a dotted netmask.
const maskLen = m => m.split('.').reduce((n, o) => n + (+o).toString(2).replace(/0/g, '').length, 0);

// The kernel's routes of the mock router: every enabled route whose interface is up.
function kernelRoutes() {
  const up = new Set(interfaces().filter(i => i.up).map(i => i.interface));
  return Object.values(mock.cfg).filter(s => ['route', 'route6'].includes(s['.type']) && s.disabled !== '1' && up.has(s.interface) && s.target !== mock.hideRoute).map(s => {
    const v6 = s['.type'] === 'route6';
    const prefix = s.target.includes('/') ? s.target : `${s.target}/${s.netmask ? maskLen(s.netmask) : v6 ? 128 : 32}`;
    return {
      family: v6 ? 6 : 4, table: s.table ?? 'main', type: s.type ?? 'unicast', prefix, len: +prefix.split('/')[1], from: s.source ?? null, proto: 'static', metric: Number(s.metric ?? (v6 ? 1024 : 0)), flags: [],
      nexthops: s.type ? [] : [{ via: s.gateway ?? null, dev: s.interface === 'lan' ? 'br-lan' : s.interface, flags: [] }],
    };
  });
}

// Applies the staged edits to the mock's config, the way rpcd's uci apply does. A section named for a staged add gets a new name.
function commit() {
  for (const [op, section, option, value] of mock.staged) {
    if (op === 'set') mock.cfg[section][option] = value;
    else if (op === 'delete') (option ? delete mock.cfg[section][option] : delete mock.cfg[section]);
    else if (op === 'add') mock.cfg[section] = { '.type': option, ...value };
  }
}
// What a rollback or a failed confirmation puts back: the config from before, the edits back in the staging area.
const restore = () => { mock.cfg = mock.snapshot; mock.staged = mock.restage; mock.snapshot = null; };

// One uci method of the mock: [ubus status, data].
function uci(method, args) {
  if (method === 'get') {
    mock.gets.push(args);
    if (!args.type) { mock.whole.push(args.config); return [0, { values: mock.cfg }]; }
    return [0, { values: Object.fromEntries(Object.entries(mock.cfg).filter(([, s]) => s['.type'] === args.type).map(([name, s]) => [name, { '.anonymous': true, '.name': name, '.index': Object.keys(mock.cfg).indexOf(name), ...s }])) }];
  }
  if (method === 'changes') {
    const changes = mock.staged.map(c => c.slice(0, 4));
    return [0, { changes: args.config ? changes : changes.length ? { network: changes } : {} }];
  }
  if (method === 'set') { for (const [k, v] of Object.entries(args.values)) mock.staged.push(['set', args.section, k, v]); return [0, {}]; }
  if (method === 'add') {
    const name = args.name ?? `cfg${100 + nextId++}`;
    mock.staged.push(['add', name, args.type, args.values ?? {}]);
    return [0, { section: name }];
  }
  if (method === 'delete') { for (const o of args.options ?? [undefined]) mock.staged.push(['delete', args.section, o, undefined]); return [0, {}]; }
  if (method === 'revert') { mock.staged = []; return [0, {}]; }
  if (method === 'apply') {
    mock.snapshot = clone(mock.cfg);
    mock.restage = mock.staged;
    if (!mock.dropWrites) commit();
    mock.staged = [];
    return [0, {}];
  }
  if (method === 'confirm') {
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

// Answers the ubus calls the mock handles; null lets a call through to the real router.
async function answer(body, route) {
  const [, obj, method, args] = body.params;
  // Wraps a ubus status code and optional data as a JSON-RPC result.
  const ok = ([code, data]) => ({ jsonrpc: '2.0', id: body.id, result: data === undefined ? [code] : [code, data] });
  const denied = { jsonrpc: '2.0', id: body.id, error: { code: -32002, message: 'Access denied' } };

  if (!mock.on) {
    // The real router: reads only. A write would change something, so it is blocked and the test fails.
    if (obj === 'uci' && WRITES.includes(method)) { mock.unsafe.push(`${obj}.${method}`); return ok([6]); }
    if (obj === 'uci' && method === 'get') mock.realGets.push(args);
    return null;
  }
  mock.cfg ??= makeConfig();
  if (mock.expired && ['uci', 'flab.routing', 'network.interface', 'session'].includes(obj)) return denied;
  if (mock.noRead && obj === 'uci' && method === 'get') return denied;
  if (obj === 'uci') { mock.calls.push(`uci.${method}`); return ok(uci(method, args)); }
  if (obj === 'network.interface' && method === 'dump') return ok([0, { interface: interfaces() }]);
  if (obj === 'flab.routing' && method === 'status') {
    // The real answer (rules, tables) with the kernel's routes replaced by those of the mocked config.
    const real = (await (await route.fetch()).json()).result[1];
    return ok([0, { ...real, available: !mock.noKernel, routes: mock.noKernel ? [] : kernelRoutes(), table_ids: { main: 254, local: 255, default: 253, voip: 100 } }]);
  }
  return null;
}
//#endregion

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1300 }, colorScheme: 'light' });
const errors = [];
await ctx.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const reply = body ? await answer(body, route) : null;
  return reply ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) }) : route.continue();
});
// Opens the Static routes tab of the Routing page with a session in sessionStorage, the way a real sign-in leaves the tab.
const open = async acls => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(([id, a]) => {
    sessionStorage.setItem('sid', id);
    sessionStorage.setItem('acls', JSON.stringify(a));
  }, [sid, acls ?? rootAcls]);
  await p.goto(`${baseUrl}#routing`);
  await p.waitForSelector('.rt-static, .set-note.bad, .login-form', { timeout: 20000 });
  return p;
};
// The ACLs of a login that may read the config but not change it, and of one that may change it but not read it.
const readOnlyAcls = (() => { const a = clone(rootAcls); a.ubus.uci = a.ubus.uci.filter(m => ['get', 'changes', 'configs'].includes(m)); return a; })();
const noReadAcls = (() => { const a = clone(rootAcls); a.ubus.uci = a.ubus.uci.filter(m => !['get'].includes(m)); return a; })();
let page = await open();

// Helpers: the banner, the rows, the dialog and screenshots.
// All the notes of the review banner, joined into one string.
const notes = () => page.locator('.set-notes .set-note').allInnerTexts().then(t => t.join(' | '));
const bar = () => page.locator('.set-bar');
// Whether the banner reports unsaved edits (the outcome of the last save keeps it visible).
const pending = async () => await bar().isVisible() && /\d+ unsaved change/.test(await bar().innerText());
const saveBtn = () => page.locator('button:has-text("Save and apply")');
// The text of the banner's summary line and of the review of pending changes.
const summary = () => page.locator('.set-bar-summary').innerText();
const changes = () => page.locator('.set-changes').evaluate(e => e.textContent);
// The row whose Target box holds `target`.
const rowOf = async target => {
  const id = await page.evaluate(t => [...document.querySelectorAll('tr[id^="rt-static-"]')].find(r => r.querySelector('input[title="Target"]').value === t)?.id, target);
  return id ? page.locator(`#${id}`) : page.locator('#rt-static-none');
};
// The box (or drop-down) of a column in a row, and the badge of the state column.
const cell = (row, title) => row.locator(`[title="${title}"]`).first();
const badgeOf = async row => (await row.locator('td:not(.rt-s-reach) .fl-badge').allInnerTexts()).join('|').trim();
// What the "Consulted by" column says: the table and the policy rules that look it up.
const reachOf = async row => (await row.locator('.rt-s-reach').innerText()).replace(/\s+/g, ' ').trim();
// The two checkboxes of a row: On-link, then Enabled.
const boxes = row => row.locator('input[type=checkbox]');
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `routeedit-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Waits for the review banner to report the result of a save and returns its text.
const outcome = async () => { const n = page.locator('.set-bar .set-outcome.ok, .set-bar .set-outcome.bad').first(); await n.waitFor({ timeout: 20000 }); return (await n.innerText()).trim(); };
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(800); };
const discard = async () => { await page.click('.set-bar button:has-text("Discard edits")'); await bar().waitFor({ state: 'hidden' }); };
// The confirmation before a change to a default route.
const confirmation = () => page.locator('.modal:has-text("This change affects the default route")');
// The routes of one family in the mock config, by target.
const sectionOf = target => Object.entries(mock.cfg).find(([, s]) => s.target === target);

//#region The real router (read only)
console.log('== the real router (read only: nothing is written, nothing is staged) ==');
check(await page.locator('.rt-static-table').count() === 2 && await page.locator('.rt-routes').count() === 1, 'one Routes view shows static editors and the final route list', await page.locator('main').innerText());
check(await bar().isHidden() && await page.locator('.rt-static button:has-text("Add IPv4 route")').count() === 1, 'nothing is pending, and a route can be added');
const realTypes = mock.realGets.filter(g => g.config === 'network').map(g => g.type);
check(realTypes.length >= 2 && realTypes.every(Boolean) && realTypes.includes('route') && realTypes.includes('route6'), 'the tab read the network config only by section type (route, route6) and never the whole config', JSON.stringify(mock.realGets));
await shot('real');
const staged = await page.evaluate(async () => {
  const sid = sessionStorage.getItem('sid');
  return (await (await fetch('/ubus', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [sid, 'uci', 'changes', {}] }) })).json()).result[1].changes;
});
check(Object.keys(staged).length === 0 && mock.unsafe.length === 0, 'nothing is staged on the router and no write was attempted', JSON.stringify({ staged, unsafe: mock.unsafe }));
//#endregion

//#region Mock: reading
mock.on = true;
await page.close();
page = await open();
console.log('\n== reading (mock router) ==');
check(await page.locator('.rt-static-table').nth(0).locator('tbody tr').count() === 4 && await page.locator('.rt-static-table').nth(1).locator('tbody tr').count() === 1, 'four IPv4 routes and one IPv6 route', await page.locator('main').innerText());
check((await cell(await rowOf('10.9.0.0/16'), 'MTU').inputValue()) === '1400', 'an older netmask is shown as one prefix in the target');
const rDef = await rowOf('0.0.0.0/0'), rOld = await rowOf('10.9.0.0/16'), rOff = await rowOf('172.16.0.0/12'), rBh = await rowOf('203.0.113.0/24'), r6 = await rowOf('::/0');
check(await cell(rDef, 'Interface').inputValue() === 'wan' && await cell(rBh, 'Type').inputValue() === 'blackhole' && await cell(rBh, 'Table').inputValue() === 'voip', 'interface, type and table are shown');
check(await boxes(rOff).nth(1).isChecked() === false && await boxes(rDef).nth(1).isChecked() === true, 'a disabled route has Enabled unchecked');
const states = [await badgeOf(rDef), await badgeOf(rOld), await badgeOf(rOff), await badgeOf(rBh), await badgeOf(r6)];
check(states.join() === 'installed,installed,disabled,installed,installed', 'the state column says what the kernel holds of each route', states.join());
const reach = [await reachOf(rDef), await reachOf(r6)];
check(/^main\b.*rule 32766/.test(reach[0]) && /^main\b.*rule 32766/.test(reach[1]), 'the Consulted by column names the table and the kernel rule that looks it up', reach.join(' | '));
check(/^voip\b/.test(await reachOf(rBh)), 'a route in a named table shows that table', await reachOf(rBh));
const tileText = (await page.locator('.tile:has(.label:text-is("Static routes"))').innerText()).replace(/\s+/g, ' ').trim();
check(/Static routes 5 4 installed · 0 not installed · 1 disabled/.test(tileText), 'one tile counts the routes: configured, installed, not installed, disabled', tileText);
check(mock.gets.length >= 2 && mock.gets.every(g => g.type) && mock.whole.length === 0 && !(await page.locator('main').innerHTML()).includes(SECRET), 'in the mock too the config is read by section type only, and a secret is never in the page');
check(!(await page.locator('.seg-tab').allInnerTexts()).includes('Static routes'), 'static routes are not hidden on a separate tab');
const order = await page.evaluate(() => ['.rt-how', '.rt-rules', '.rt-static', '.rt-tables', '.rt-routes'].map(s => document.querySelector(s)).map((n, i, all) => i === 0 || Boolean(all[i - 1].compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)));
check(order.every(Boolean), 'the view follows the lookup: how it works, policy rules, static routes, routing tables, final list', JSON.stringify(order));
const topTiles = await page.locator('main .tile .label').allInnerTexts();
check(topTiles.includes('Static routes') && topTiles.length >= 7 && await page.locator('.rt-static-section .tile').count() === 0, 'the static-route tile is with the other tiles at the top', topTiles.join('|'));
check(/Where static routes fit[\s\S]*Consulted by/.test(await page.locator('.rt-how').innerText()) && await page.locator('.rt-static .set-legend').count() === 1, 'the static-route description is part of "How the kernel picks a route"');
const finalRoutes = await page.locator('.rt-routes tbody').innerText();
check(/172\.16\.0\.0\/12[\s\S]*disabled/.test(finalRoutes) && /203\.0\.113\.0\/24/.test(finalRoutes),
  'the final list includes disabled and custom-table static routes', finalRoutes);
await shot('reading');
mock.noKernel = true;
await refresh();
check(await page.locator('.rt-static-table').count() === 2 && /10\.9\.0\.0\/16[\s\S]*state unknown/.test(await page.locator('.rt-routes tbody').innerText()),
  'configured routes remain visible in the final list when kernel state is unavailable');
mock.noKernel = false;
await refresh();
//#endregion

//#region Editing
console.log('\n== editing cells ==');
await cell(rOld, 'Target').fill('not a network');
check(await saveBtn().isDisabled() && await cell(rOld, 'Target').evaluate(e => e.classList.contains('is-invalid')), 'an invalid target is marked and blocks Save', await notes());
await cell(rOld, 'Target').fill('10.9.0.0/24');
check(await bar().isVisible() && /1 unsaved change/.test(await summary()) && await saveBtn().isEnabled(), 'a valid edit shows the banner and enables Save', await summary());
await page.click('.set-bar button:has-text("Details")');
check(/IPv4 route 10\.9\.0\.0\/16: Target.*10\.9\.0\.0\/16.*→.*10\.9\.0\.0\/24/.test(await changes()), 'the review says what the route was and becomes', await changes());
await page.click('.set-bar button:has-text("Hide details")');
await shot('edited');
mock.calls = [];
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'a successful save says so');
check(/^uci\.changes( uci\.(set|add|delete))+ uci\.apply( uci\.get)+/.test(mock.calls.join(' ')), 'it checked all leftovers, staged, applied and read back by type', mock.calls.join(' '));
check(mock.cfg.cfg03.target === '10.9.0.0/24' && !('netmask' in mock.cfg.cfg03) && mock.cfg.cfg03.mtu === '1400', 'the prefix went into target, the older netmask option was removed and the other options kept', JSON.stringify(mock.cfg.cfg03));

console.log('\n== adding and removing routes ==');
await page.click('button:has-text("Add IPv4 route")');
const fresh = page.locator('tr.rt-s-new');
await page.waitForTimeout(300);
check(await fresh.count() === 1 && await fresh.locator('[title="Target"]').evaluate(e => e === document.activeElement), 'a new row opens and its target box has the focus');
check(!await pending(), 'an empty new row is not a change');
await fresh.locator('[title="Target"]').fill('10.20.0.0/16');
await fresh.locator('[title="Gateway"]').fill('192.168.1.253');
await fresh.locator('[title="Interface"]').selectOption('lan');
check(/1 unsaved change/.test(await summary()), 'a filled-in row is one change', await summary());
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'the new route is saved without a question (it is not a default route)');
const added = sectionOf('10.20.0.0/16');
check(added && added[1]['.type'] === 'route' && added[1].interface === 'lan' && added[1].gateway === '192.168.1.253' && !('disabled' in added[1]), 'the route was added as a route section with its options', JSON.stringify(added));
check(await badgeOf(await rowOf('10.20.0.0/16')) === 'installed', 'and the kernel now holds it');
await page.click('button:has-text("Add IPv6 route")');
await page.locator('tr.rt-s-new [title="Target"]').fill('2001:db8:5::/48');
await page.locator('tr.rt-s-new [title="Gateway"]').fill('fd00::fe');
await page.locator('tr.rt-s-new [title="Interface"]').selectOption('lan');
// Diagnostic for an intermittent failure: say what the page shows when the button cannot be used.
try { await saveBtn().click({ timeout: 8000 }); } catch (e) { console.log('SAVE BUTTON UNUSABLE', JSON.stringify({ bar: await bar().innerText().catch(() => null), rows: await page.locator('tr.rt-s-new').count(), targets: await page.locator('tr.rt-s-new [title="Target"]').evaluateAll(n => n.map(x => x.value)), main: (await page.locator('.rt-static').innerText()).slice(0, 600) })); throw e; }
await outcome();
check(sectionOf('2001:db8:5::/48')?.[1]['.type'] === 'route6', 'an IPv6 route is added as a route6 section');
await (await rowOf('172.16.0.0/12')).locator('button[title="Remove this route"]').click();
check(await (await rowOf('172.16.0.0/12')).evaluate(e => e.classList.contains('rt-s-removed')) && /to be removed/.test(await badgeOf(await rowOf('172.16.0.0/12'))), 'a removed route is struck through until saved');
await (await rowOf('172.16.0.0/12')).locator('button:has-text("Undo")').click();
check(!await pending(), 'Undo puts it back, and nothing is pending');
await (await rowOf('172.16.0.0/12')).locator('button[title="Remove this route"]').click();
await saveBtn().click();
check(/^Saved/.test(await outcome()) && !sectionOf('172.16.0.0/12'), 'a removed route is deleted from the config');
await shot('after-save');
//#endregion

//#region The default route
console.log('\n== a change to a default route ==');
const dRow = await rowOf('0.0.0.0/0');
await boxes(dRow).nth(1).uncheck();
mock.calls = [];
await saveBtn().click();
await confirmation().waitFor({ timeout: 10000 });
check(/default route/.test(await confirmation().innerText()) && !mock.calls.includes('uci.apply'), 'the page asks first, and nothing is applied yet', await confirmation().innerText());
await shot('confirm');
await confirmation().locator('button:has-text("Cancel")').click();
await confirmation().waitFor({ state: 'detached' });
await page.waitForTimeout(500);
check(!mock.calls.includes('uci.apply') && mock.staged.length === 0 && mock.cfg.cfg01.disabled === undefined, 'Cancel leaves the router as it was and nothing staged', mock.calls.join(' '));
check(await bar().isVisible() && await boxes(dRow).nth(1).isChecked() === false, 'the edit stays in the form');
await saveBtn().click();
await confirmation().waitFor({ timeout: 10000 });
await confirmation().locator('button:has-text("Apply the change")').click();
check(/^Saved/.test(await outcome()) && mock.cfg.cfg01.disabled === '1', 'Apply the change saves it', JSON.stringify(mock.cfg.cfg01));
check(await badgeOf(await rowOf('0.0.0.0/0')) === 'disabled', 'and the route shows as disabled');
//#endregion

//#region Failures
console.log('\n== a change the router does not keep ==');
mock.dropWrites = true;
await cell(await rowOf('203.0.113.0/24'), 'MTU').fill('1300');
await saveBtn().click();
const bad = await outcome();
check(/rolled back/.test(bad) && /does not hold the routes that were saved/.test(bad), 'a router that applies nothing is detected, and the outcome says the change was rolled back', bad);
check(mock.staged.length === 0 && mock.cfg.cfg05.mtu === undefined && /1 unsaved change/.test(await summary()), 'nothing is left staged, the config is as before and the edit stays in the form');
mock.dropWrites = false;
mock.confirmFails = true;
await saveBtn().click();
const refused = await outcome();
check(/confirmation failed/i.test(refused) && /outcome is uncertain/.test(refused) && mock.cfg.cfg05.mtu === undefined,
  'an expired confirmation with no active rollback snapshot is reported as uncertain, not as acknowledged recovery', refused);
mock.confirmFails = false;
await saveBtn().click();
check(/^Saved/.test(await outcome()) && mock.cfg.cfg05.mtu === '1300', 'and the retry succeeds');

console.log('\n== a saved route that never reaches the kernel ==');
mock.hideRoute = '10.9.0.0/24';
await cell(await rowOf('10.9.0.0/24'), 'Metric').fill('13');
await saveBtn().click();
const absent = await outcome();
check(/installation.*could not be verified/.test(absent) && /confirmed by the router/.test(absent)
  && mock.cfg.cfg03.metric === undefined, 'failed kernel installation is detected and rolled back even though UCI saved it', absent);
mock.hideRoute = null;
await discard();

console.log('\n== leftovers staged in the session ==');
mock.staged = [['set', 'cfg05', 'metric', '5']];
await refresh();
check(/1 change\(s\) are already staged in this session/.test(await page.locator('main').innerText()), 'changes staged earlier are said so above the tables');
await page.click('button:has-text("Discard this page\'s staged changes")');
await page.waitForTimeout(800);
check(mock.staged.length === 0 && !/already staged/.test(await page.locator('main').innerText()), 'Discard them reverts them');
//#endregion

//#region Permissions and the session
console.log('\n== a login that may not write ==');
mock.cfg = null;
await page.close();
page = await open(readOnlyAcls);
check(await page.locator('.rt-static-table input[type=text], .rt-static-table input:not([type])').first().isDisabled() && await page.locator('button:has-text("Add IPv4 route")').isDisabled(), 'the tables are read only and no route can be added', await notes());
check(/not allowed to change the configuration/.test(await page.locator('main').innerText()), 'and the page says why');
await shot('no-write');
await page.close();
mock.noRead = true;
page = await open(noReadAcls);
check(await page.locator('.rt-static-table').count() === 0 && /cannot be read/.test(await page.locator('main').innerText()), 'a login that may not read the config sees a message instead of the tables', await page.locator('main').innerText());
await page.close();
mock.noRead = false;

console.log('\n== the session expires while saving ==');
page = await open();
await cell(await rowOf('203.0.113.0/24'), 'MTU').fill('1200');
mock.expired = true;
await saveBtn().click();
await page.waitForSelector('.login-form', { timeout: 20000 });
check(await page.locator('.login-form').isVisible(), 'the page returns to the sign-in screen');
mock.expired = false;
await page.close();
//#endregion

check(mock.unsafe.length === 0, 'no write ever reached the real router', mock.unsafe.join());
check(errors.length === 0, 'the page logged no errors', errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failed ? `\nFAILED: ${failed}` : '\nall static routes browser checks passed');
process.exit(failed ? 1 : 0);
