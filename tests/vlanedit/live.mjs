// Browser test for the VLAN editor of the Ethernet page. A real browser opens the deployed UI.
// 1. Against the real router, read only: the page shows the Ethernet page, the editor opens and closes, and every uci write it
//    might send is blocked and fails the test. The editor must read the network config only by section type (the whole config holds
//    secrets), and nothing may be staged.
// 2. Against a stateful mock of rpcd's `uci` object and a flab.network status that follows the mocked config: the editing flow of a
//    bridge (cells, validation, adding and removing a VLAN, VLAN filtering, warnings, a change the router does not keep, a refused
//    confirmation, leftovers staged in the session, the kernel table differing from the config), of a swconfig switch (an older board:
//    the router of this repository has none, so it only exists here), a login without write permission and an expired session -
//    WITHOUT touching the router's configuration.
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
  on: false, mode: 'bridge', cfg: null, staged: [], restage: [], snapshot: null, calls: [], gets: [], dropWrites: false, confirmFails: false, expired: false,
  kernel: false, unsafe: [], whole: [], realGets: [],
};
let nextId = 1;

// The network config of the mock router for a mode, built from the real status so the port names are the real ones. Besides the
// VLAN sections it holds an interface with a secret, which the page must never ask for.
function makeConfig(real) {
  if (mock.mode === 'switch') {
    return {
      wan: { '.type': 'interface', proto: 'pppoe', username: 'me', password: SECRET },
      sw: { '.type': 'switch', name: 'switch0', reset: '1', enable_vlan: '1' },
      s1: { '.type': 'switch_vlan', device: 'switch0', vlan: '1', ports: '0t 1 2 3' },
      s2: { '.type': 'switch_vlan', device: 'switch0', vlan: '2', vid: '1036', ports: '0t 4' },
      sp: { '.type': 'switch_port', device: 'switch0', port: '4', pvid: '1036' },
    };
  }
  const eth = real.bridges.find(b => b.name === 'br-lan').members.filter(m => m.kind === 'ethernet').map(m => m.name);
  return {
    wan: { '.type': 'interface', proto: 'pppoe', username: 'me', password: SECRET },
    brdev: { '.type': 'device', name: 'br-lan', type: 'bridge', ports: eth, vlan_filtering: '1' },
    dev20: { '.type': 'device', name: 'br-lan.20', type: '8021q', ifname: 'br-lan', vid: '20' },
    v1: { '.type': 'bridge-vlan', device: 'br-lan', vlan: '1', ports: [`${eth[0]}:u*`, `${eth[1]}:u*`, `${eth[2]}`, `${eth[3]}:t`] },
    v20: { '.type': 'bridge-vlan', device: 'br-lan', vlan: '20', ports: [`${eth[2]}:t`, `${eth[3]}:t`] },
    v90: { '.type': 'bridge-vlan', device: 'br-lan', vlan: '90', ports: [`${eth[3]}:u*`], local: '0' },
    guest: { '.type': 'bridge-vlan', device: 'br-guest', vlan: '5', ports: ['lan9:t'] },
  };
}

// The VLAN table the plugin builds from the bridge-vlan sections of a bridge.
function tableFromConfig(device) {
  const by = {};
  for (const s of Object.values(mock.cfg)) {
    if (s['.type'] !== 'bridge-vlan' || s.device !== device) continue;
    for (const e of [].concat(s.ports ?? [])) {
      const m = /^([^:]+)(:(.*))?$/.exec(e);
      (by[+s.vlan] ??= { vid: +s.vlan, ports: [] }).ports.push({ name: m[1], tagged: /t/.test(m[3] ?? ''), pvid: /\*/.test(m[3] ?? '') });
    }
  }
  return Object.values(by).sort((a, b) => a.vid - b.vid);
}

// The flab.network status the mock router answers: the real one with the bridge's VLAN table and filtering following the mocked
// config (bridge mode), or turned into an older board whose switch is driven through swconfig (switch mode).
function statusFor(real) {
  const net = clone(real);
  net.generated = Math.floor(Date.now() / 1000);
  if (mock.mode === 'bridge') {
    const b = net.bridges.find(x => x.name === 'br-lan');
    const dev = Object.values(mock.cfg).find(s => s['.type'] === 'device' && s.name === 'br-lan');
    b.vlan_filtering = dev?.vlan_filtering === '1';
    net.vlans = [...net.vlans, { name: 'br-lan.20', parent: 'br-lan', vid: 20, up: true, carrier: true, mac: null, stats: {} }];
    const vlans = tableFromConfig('br-lan');
    if (mock.kernel) {
      // The kernel's own table: VLAN 20 is untagged on its first port and VLAN 77 exists that the config does not know.
      b.vlan_table = { source: 'kernel', vlans: [...vlans.map(v => (v.vid === 20 ? { ...v, ports: v.ports.map((p, i) => (i ? p : { ...p, tagged: false })) } : v)), { vid: 77, ports: [] }] };
    } else {
      b.vlan_table = vlans.length || b.vlan_filtering ? { source: 'config', vlans } : null;
    }
    return net;
  }
  const conduit = net.ports.find(p => p.role === 'conduit');
  const template = net.ports.find(p => p.role === 'switch');
  const sw = Object.values(mock.cfg).find(s => s['.type'] === 'switch');
  net.ports = [conduit, ...[1, 2, 3, 4].map(n => ({
    ...clone(template), name: `port${n}`, type: 'swconfig', mac: null, mtu: null, autoneg: null, max_speed: null, partner_max: null, downshifted: false, flow: [], carrier_changes: null,
    link_ups: null, link_downs: null, stats: {}, conduit: conduit.name, pvid: n === 4 ? 1036 : 1, board: { role: n === 4 ? 'wan' : 'lan', index: 500 + n }, diagnostics: null, sfp: null,
    bridge: null, brport: null, macs: null, vlans: [], hardware: { driver: 'swconfig', switch: 'AR8327', switch_node: 'swconfig:switch0', switch_port: n, external_phy: false },
  }))];
  net.bridges = [];
  net.vlans = [];
  net.switches = [{
    node: 'swconfig:switch0', kind: 'swconfig', label: 'AR8327', ports: ['port1', 'port2', 'port3', 'port4'], cpu_ports: [{ port: 0, conduit: conduit.name, mode: null, speed: null }],
    vlan_enabled: sw?.enable_vlan === '1',
    vlans: Object.values(mock.cfg).filter(s => s['.type'] === 'switch_vlan').map(s => ({
      vid: +(s.vid ?? s.vlan),
      ports: s.ports.split(' ').map(t => /^([0-9]+)(t?)$/.exec(t)).filter(m => m && m[1] !== '0').map(m => ({ name: `port${m[1]}`, tagged: Boolean(m[2]) })),
    })),
  }];
  return net;
}

// netifd's interface list of the mock router: the LAN on the bridge (or on the switch's untagged VLAN device), and in bridge mode an
// interface on VLAN 20.
function interfaces() {
  const lan = (device, address) => ({ interface: 'lan', up: true, l3_device: device, device, 'ipv4-address': [{ address, mask: 24 }], 'ipv6-address': [] });
  return mock.mode === 'bridge'
    ? [lan('br-lan', '192.168.1.1'), { ...lan('br-lan.20', '192.168.20.1'), interface: 'iot' }]
    : [lan('eth0.1', '192.168.1.1')];
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
    return [0, { values: Object.fromEntries(Object.entries(mock.cfg).filter(([, s]) => s['.type'] === args.type).map(([name, s]) => [name, { '.anonymous': false, '.name': name, '.index': Object.keys(mock.cfg).indexOf(name), ...s }])) }];
  }
  if (method === 'changes') {
    const list = args.config && args.config !== 'network' ? [] : mock.staged.map(c => c.slice(0, 4));
    return [0, { changes: args.config ? list : (list.length ? { network: list } : {}) }];
  }
  if (method === 'set') { for (const [k, v] of Object.entries(args.values)) mock.staged.push(['set', args.section, k, v]); return [0, {}]; }
  if (method === 'add') {
    const name = args.name ?? `cfg${100 + nextId++}`;
    mock.staged.push(['add', name, args.type, args.values ?? {}]);
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
  if (mock.expired && ['uci', 'flab.network', 'network.interface', 'session'].includes(obj)) return denied;
  if (obj === 'uci') { mock.calls.push(`uci.${method}`); return ok(uci(method, args)); }
  if (obj === 'network.interface' && method === 'dump') return ok([0, { interface: interfaces() }]);
  if (obj === 'flab.network' && method === 'status') {
    const real = (await (await route.fetch()).json()).result[1];
    mock.cfg ??= makeConfig(real);
    return ok([0, statusFor(real)]);
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
// Opens the Ethernet page with a session in sessionStorage, the way a real sign-in leaves the tab.
const open = async acls => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(([id, a]) => {
    sessionStorage.setItem('sid', id);
    sessionStorage.setItem('acls', JSON.stringify(a));
  }, [sid, acls ?? rootAcls]);
  await p.goto(`${baseUrl}#network`);
  await p.waitForSelector('.port-ic, .login-form', { timeout: 20000 });
  return p;
};
// The ACLs of a login that may read the config but not change it, and of one that may change it but not read it.
const readOnlyAcls = (() => { const a = clone(rootAcls); a.ubus.uci = a.ubus.uci.filter(m => ['get', 'changes', 'configs'].includes(m)); return a; })();
const noReadAcls = (() => { const a = clone(rootAcls); a.ubus.uci = a.ubus.uci.filter(m => !['get'].includes(m)); return a; })();
let page = await open();

// Helpers: the cards, the matrix cells, the banner, and screenshots.
// All the notes of the review banner, joined into one string.
const notes = () => page.locator('.set-notes .set-note').allInnerTexts().then(t => t.join(' | '));
// The review banner and its buttons.
const bar = () => page.locator('.set-bar');
const saveBtn = () => page.locator('button:has-text("Save and apply")');
// The text of the review of pending changes.
const changes = () => page.locator('.set-changes').evaluate(e => e.textContent);
// The text of the banner's summary line.
const summary = () => page.locator('.set-bar-summary').innerText();
// The matrix of the editor, the headings of its columns, the row of VLAN `vid`, and the drop-down of a port in a VLAN.
const heads = () => page.locator('.vlan-edit-table thead th').allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
const rowOf = vid => page.locator('.vlan-edit-table tbody tr').filter({ has: page.locator(`td.vlan-edit-vid strong:text-is("${vid}")`) });
const cellOf = async (vid, port) => rowOf(vid).locator('td').nth((await heads()).findIndex(t => t === port || t.startsWith(`${port} `)));
const selectOf = async (vid, port) => (await cellOf(vid, port)).locator('select');
// Chooses a state for a port in a VLAN ('' not a member, t, u, u*).
const pick = async (vid, port, state) => (await selectOf(vid, port)).selectOption(state);
// The state a port has in a VLAN.
const stateOf = async (vid, port) => (await selectOf(vid, port)).inputValue();
// Saves a full-page screenshot named after `label`, when a screenshot folder is set.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `vlanedit-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Waits for the review banner to report the result of a save and returns its text.
const outcome = async () => { const n = page.locator('.set-bar .set-outcome.ok, .set-bar .set-outcome.bad').first(); await n.waitFor({ timeout: 20000 }); return (await n.innerText()).trim(); };
// Clicks Refresh and gives the page a moment to redraw.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(800); };
// Opens the editor (the button of the card whose header says `name`) and waits for the matrix.
const openEditor = async (name = 'Edit VLANs') => { await page.locator(`button:has-text("${name}")`).first().click(); await page.waitForSelector('.vlan-edit', { timeout: 15000 }); };
// Discards the edits with the banner's button and waits for the banner to go away.
const discard = async () => { await page.click('.set-bar button:has-text("Discard edits")'); await bar().waitFor({ state: 'hidden' }); };
// The "Done" button that closes the editor.
const done = () => page.locator('.card-header button:has-text("Done")').first();
// The port names of the bridge in the mock (what the real router's br-lan has).
let eth = [];

//#region The real router (read only)
console.log('== the real router (read only: nothing is written, nothing is staged) ==');
check(await page.locator('.port-table tbody tr strong').count() >= 5, 'the Ethernet page shows the real router\'s ports');
const setup = page.locator('.card:has(.card-header:has-text("Bridge br-lan · VLAN filtering"))');
check(await page.locator('.vlan-table').count() === 0, 'a router that does not filter VLANs has no VLAN matrix');
check(await setup.count() === 1 && await setup.locator('button:has-text("Set up VLAN filtering")').count() === 1 && !/VLANs/.test(await setup.locator('.card-header').innerText()), 'its bridge offers a way into the editor (and the card does not take the name of the VLAN tables)', await page.locator('main').innerText());
await setup.locator('button').click();
await page.waitForSelector('.vlan-edit');
await page.waitForTimeout(500);
const ed = page.locator('.vlan-edit').first();
check(/Bridge br-lan · VLANs/.test(await page.locator('.card-header').filter({ hasText: 'Bridge br-lan' }).first().innerText()) && await page.locator('.vlan-add-id').count() === 1, 'the editor opens with the bridge\'s card and a box to add a VLAN');
check(await ed.locator('input[type=checkbox]').first().isChecked() === false && /VLAN filtering/.test(await ed.innerText()), 'it shows VLAN filtering of the bridge as the config has it');
check(/No VLAN in the config yet/.test(await ed.innerText()) && await bar().isHidden(), 'no VLAN is configured on the real router, and nothing is pending');
const realTypes = mock.realGets.filter(g => g.config === 'network').map(g => g.type);
check(realTypes.length >= 4 && realTypes.every(Boolean) && ['bridge-vlan', 'device'].every(t => realTypes.includes(t)), 'the editor read the network config only by section type (bridge-vlan, device, ...) and never the whole config', JSON.stringify(mock.realGets));
await shot('real-editor');
await done().click();
await page.waitForSelector('.vlan-edit', { state: 'detached' });
await page.waitForSelector('.card-header:has-text("VLAN filtering")');
check(await page.locator('.vlan-edit').count() === 0 && await setup.count() === 1, 'Done closes the editor');
const staged = await page.evaluate(async () => {
  const sid = sessionStorage.getItem('sid');
  return (await (await fetch('/ubus', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [sid, 'uci', 'changes', {}] }) })).json()).result[1].changes;
});
check(Object.keys(staged).length === 0 && mock.unsafe.length === 0, 'nothing is staged on the router and no write was attempted', JSON.stringify({ staged, unsafe: mock.unsafe }));
//#endregion

//#region Mock: reading
mock.on = true;
await page.reload();
await page.waitForSelector('.port-ic');
console.log('\n== a bridge with VLANs (mock router) ==');
eth = (await page.evaluate(async () => {
  const sid = sessionStorage.getItem('sid');
  return (await (await fetch('/ubus', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [sid, 'flab.network', 'status', {}] }) })).json()).result[1].bridges[0].members.filter(m => m.kind === 'ethernet').map(m => m.name);
}));
check(eth.length >= 4, 'the mock bridge has the real router\'s Ethernet ports', eth.join());
const vcard = page.locator('.card:has(.card-header:has-text("Bridge br-lan · VLANs"))');
check(await vcard.count() === 1 && /network config \(bridge-vlan sections\)/.test(await vcard.locator('.card-header').innerText()) && await vcard.locator('tbody tr').count() === 3, 'the read-only card shows the three VLANs of the config', await page.locator('main').innerText());
check(await vcard.locator('button:has-text("Edit VLANs")').count() === 1, 'and offers the editor');
await shot('read-only');
await openEditor();
const h0 = await heads();
check(h0[0] === 'VLAN' && eth.every(p => h0.includes(p)) && h0.includes('Router'), 'the editor shows a column per port of the bridge and one for the router', h0.join());
check(await rowOf('1').count() === 1 && await rowOf('20').count() === 1 && await rowOf('90').count() === 1 && await page.locator('.vlan-edit-table tbody tr').count() === 3, 'one row per VLAN of the config');
check(await stateOf('1', eth[0]) === 'u*' && await stateOf('1', eth[2]) === 'u' && await stateOf('1', eth[3]) === 't' && await stateOf('1', eth[4] ?? eth[3]) !== undefined && await stateOf('20', eth[0]) === '', 'every cell shows the port\'s state: untagged + PVID, untagged, tagged, not a member');
check(await rowOf('90').locator('input[type=checkbox]').isChecked() === false && await rowOf('1').locator('input[type=checkbox]').isChecked() === true, 'the Router column is the local option of each VLAN');
check(await bar().isHidden() && await done().isEnabled(), 'nothing is pending yet, and the editor can be closed');
check(/The router has addresses on:\s*lan \(192\.168\.1\.1\/24, VLAN 1\), iot \(192\.168\.20\.1\/24, VLAN 20\)/.test(await page.locator('.vlan-edit').innerText()), 'the interfaces of the router on the bridge\'s VLANs are listed under the matrix');
check(mock.gets.length >= 4 && mock.gets.every(g => g.type) && mock.whole.length === 0, 'in the mock too the config is read by section type only', JSON.stringify(mock.gets));
check(!(await page.locator('main').innerHTML()).includes(SECRET), 'a secret of the config is never in the page');
check(await page.locator('.set-note', { hasText: 'differs' }).count() === 0, 'a table that matches what the router runs shows no difference note');
await shot('editor');
//#endregion

//#region Editing a bridge
console.log('\n== editing cells ==');
await pick('20', eth[0], 'u*');
check(await saveBtn().isDisabled() && /is the PVID of VLAN 1 and VLAN 20/.test(await notes()) && (await (await selectOf('20', eth[0])).evaluate(e => e.classList.contains('is-invalid'))) && (await (await selectOf('1', eth[0])).evaluate(e => e.classList.contains('is-invalid'))), 'a second PVID on a port is an error that marks both cells and blocks Save', await notes());
await pick('20', eth[0], 't');
check(await bar().isVisible() && /1 unsaved change/.test(await summary()) && await saveBtn().isEnabled() && await done().isDisabled(), 'a valid edit shows the banner, enables Save and keeps the editor open');
await page.click('.set-bar button:has-text("Details")');
check(new RegExp(`br-lan VLAN 20: .*${eth[2]} tagged.* → .*${eth[0]} tagged`).test(await changes()), 'the review says what the VLAN was and becomes', await changes());
await page.click('.set-bar button:has-text("Hide details")');
await shot('edited');
mock.calls = [];
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'a successful save says so');
check(/^uci\.changes( uci\.(set|add|delete))+ uci\.apply( uci\.get)+ uci\.confirm/.test(mock.calls.join(' ')), 'it checked the whole session for leftovers, staged, applied, read back by type and confirmed', mock.calls.join(' '));
check(JSON.stringify(mock.cfg.v20.ports) === JSON.stringify([`${eth[2]}:t`, `${eth[3]}:t`, `${eth[0]}:t`]) && mock.cfg.v1.ports.join() === `${eth[0]}:u*,${eth[1]}:u*,${eth[2]},${eth[3]}:t`, 'only the ports of that VLAN changed, in the notation of the file (an untouched untagged port kept its spelling)', JSON.stringify(mock.cfg.v20.ports));
check(mock.gets.every(g => g.type) && mock.whole.length === 0 && await stateOf('20', eth[0]) === 't' && await page.locator('.set-outcome.ok').count() === 1 && await done().isEnabled(), 'afterwards the form shows the stored state, the outcome stays and the editor can be closed');

console.log('\n== adding and removing a VLAN ==');
await page.fill('.vlan-add-id', '0');
await page.click('.vlan-add button');
check(/whole number from 1 to 4094/.test(await page.locator('.vlan-add-error').innerText()), 'a VLAN id out of range is refused next to the box');
await page.fill('.vlan-add-id', '20');
await page.click('.vlan-add button');
check(/VLAN 20 is already in the table/.test(await page.locator('.vlan-add-error').innerText()) && await rowOf('20').count() === 1, 'so is one that is already in the table');
await page.fill('.vlan-add-id', '30');
await page.press('.vlan-add-id', 'Enter');
check(await rowOf('30').count() === 1 && await rowOf('30').locator('.fl-badge:text-is("new")').count() === 1 && await rowOf('30').locator('input[type=checkbox]').isChecked() && /1 unsaved change/.test(await summary()) && /VLAN 30 added/.test(await summary()), 'Enter adds the VLAN as a new row with the router as a member');
await pick('30', eth[1], 't');
await pick('30', eth[0], 'u*');
check(/is the PVID of VLAN 1 and VLAN 30/.test(await notes()), 'the new row takes part in the validation');
await pick('30', eth[0], 'u');
check(/untagged in VLAN 1 and VLAN 30/.test(await notes()), 'an untagged port in two VLANs is a warning, not an error');
await pick('30', eth[0], '');
await saveBtn().click();
await outcome();
const sec30 = Object.entries(mock.cfg).find(([, s]) => s.vlan === '30');
check(sec30 && sec30[1]['.type'] === 'bridge-vlan' && sec30[1].device === 'br-lan' && JSON.stringify(sec30[1].ports) === JSON.stringify([`${eth[1]}:t`]) && sec30[1].local === undefined, 'the new VLAN is a bridge-vlan section with its device, id and ports', JSON.stringify(sec30));
check(await rowOf('30').count() === 1 && await rowOf('30').locator('.fl-badge:text-is("new")').count() === 0, 'after the save it is an ordinary row');
await rowOf('30').locator('button[title="Remove VLAN 30"]').click();
check(await rowOf('30').count() === 0 && /VLAN 30 removed/.test(await summary()), 'Remove takes the row out and the review lists it');
await saveBtn().click();
await outcome();
check(!Object.values(mock.cfg).some(s => s.vlan === '30') && Object.values(mock.cfg).some(s => s.vlan === '20'), 'saving deleted that section and no other');

console.log('\n== warnings ==');
await rowOf('20').locator('input[type=checkbox]').uncheck();
check(await saveBtn().isEnabled() && /VLAN 20 carries iot \(192\.168\.20\.1\/24\).*the router leaves this VLAN/.test(await notes()), 'the router leaving a VLAN that carries one of its interfaces warns, but does not block', await notes());
await discard();
check(await rowOf('20').locator('input[type=checkbox]').isChecked() && await bar().locator('.set-note.warn').count() === 0, 'Discard edits puts the form back');
await rowOf('20').locator('button[title="Remove VLAN 20"]').click();
check(/VLAN 20 carries iot .*loses its traffic/.test(await notes()) && /br-lan\.20 is a VLAN device on br-lan/.test(await notes()), 'removing a VLAN that carries an interface names the interface (and the VLAN device that needs it)', await notes());
await discard();
await page.locator('.vlan-switch input').uncheck();
check(/Turning VLAN filtering off removes the separation/.test(await notes()) && /VLAN filtering/.test(await summary()), 'turning VLAN filtering off is its own change, with a warning');
await discard();

console.log('\n== VLAN filtering off ==');
delete mock.cfg.brdev.vlan_filtering;
await refresh();
check(await page.locator('.vlan-switch input').isChecked() === false && /VLAN filtering off/.test(await page.locator('.vlan-edit').first().locator('xpath=ancestor::div[contains(@class,"card")]').locator('.card-header').innerText()), 'the editor shows the bridge as it is: VLAN filtering off');
await pick('90', eth[0], 't');
check(/VLAN filtering is off on br-lan, so this table has no effect until it is turned on/.test(await notes()) && await saveBtn().isEnabled(), 'editing the table while the bridge does not filter warns that it has no effect', await notes());
await page.locator('.vlan-switch input').check();
check(/Turning VLAN filtering on changes how every port of br-lan forwards at once/.test(await notes()) && !/has no effect/.test(await notes()) && /2 unsaved changes/.test(await summary()), 'turning it on is a separate, flagged change', await notes());
await shot('filtering-on');
await saveBtn().click();
await outcome();
check(mock.cfg.brdev.vlan_filtering === '1' && mock.cfg.v90.ports.includes(`${eth[0]}:t`), 'both changes were written: the option of the bridge device and the VLAN', JSON.stringify(mock.cfg.brdev));

console.log('\n== a change the router does not keep ==');
mock.dropWrites = true;
await pick('20', eth[1], 't');
await saveBtn().click();
const bad = await outcome();
check(/rolled back/.test(bad) && /did not keep the change/.test(bad), 'a router that applies nothing is detected, and the outcome says the change was rolled back', bad);
check(mock.staged.length === 0 && !mock.cfg.v20.ports.some(p => p.startsWith(eth[1])), 'nothing is left staged and the config is as before');
check(await stateOf('20', eth[1]) === 't' && /1 unsaved change/.test(await summary()), 'the edit stays in the form, so it can be retried');
mock.dropWrites = false;
mock.confirmFails = true;
await saveBtn().click();
const refused = await outcome();
check(/^Confirmation failed; the outcome is uncertain\./.test(refused) && /Rollback could not be confirmed/.test(refused) && !/was rolled back/.test(refused)
  && !mock.cfg.v20.ports.some(p => p.startsWith(eth[1])), 'the mock restores the config, but the page reports uncertainty without a rollback acknowledgement', refused);
mock.confirmFails = false;
await saveBtn().click();
check(/^Saved/.test(await outcome()) && mock.cfg.v20.ports.some(p => p === `${eth[1]}:t`), 'and the retry succeeds');

console.log('\n== leftovers staged in the session ==');
mock.staged = [['set', 'v1', 'local', '0']];
await done().click();
await page.waitForSelector('button:has-text("Edit VLANs")');
await openEditor();
check(/1 change\(s\) are already staged in this session/.test(await page.locator('main').innerText()), 'changes staged earlier are said so above the cards');
const discardStaged = page.getByRole('button', { name: "Discard this page's staged changes", exact: true });
await discardStaged.click();
await discardStaged.waitFor({ state: 'hidden' });
await page.waitForSelector('.vlan-edit');
check(mock.staged.length === 0 && !/already staged/.test(await page.locator('main').innerText()), "Discard reverts this page's staged changes");

console.log('\n== the kernel table differs from the config ==');
mock.kernel = true;
await refresh();
const diff = await page.locator('.set-note.warn', { hasText: 'differs' }).innerText();
check(/The table the kernel runs differs from this config/.test(diff) && /VLAN 77 is in the kernel but not in the config/.test(diff), 'the editor says so and names the differences', diff);
await done().click();
await page.waitForSelector('button:has-text("Edit VLANs")');
check(/read from the kernel \(bridge vlan show\)/.test(await page.locator('.card-header').filter({ hasText: 'Bridge br-lan' }).first().innerText()), 'the read-only card keeps saying it shows the kernel table');
mock.kernel = false;
//#endregion

//#region swconfig
console.log('\n== a switch driven through swconfig (an older board, mock only) ==');
mock.mode = 'switch';
mock.cfg = null;
await page.reload();
await page.waitForSelector('.port-ic');
const scard = page.locator('.card:has(.card-header:has-text("VLAN groups"))');
check(await scard.count() === 1 && /Switch AR8327 · VLAN groups/.test(await scard.locator('.card-header').innerText()) && await scard.locator('tbody tr').count() === 2, 'the read-only card shows the two groups');
await shot('switch-read-only');
await openEditor();
const sh = await heads();
check(sh.join() === 'VLAN,port1,port2,port3,port4,CPU (0),', 'the editor has a column per user port and the CPU port', sh.join());
check(await stateOf('1', 'port1') === 'u' && await stateOf('1', 'CPU (0)') === 't' && await stateOf('1036', 'port4') === 'u' && await stateOf('1036', 'port1') === '', 'the cells follow the ports option of each group (a trailing t is tagged)');
check(await rowOf('1036').locator('.muted:has-text("group 2")').count() === 1, 'a group whose id differs from its number says so');
check(/switch_port section sets the PVID of port 4 \(VLAN 1036\)/.test(await page.locator('.vlan-edit').innerText()), 'the PVID of a switch_port section is mentioned and left alone');
check(await page.locator('.vlan-switch input').isChecked() && /The router has addresses on:\s*lan \(192\.168\.1\.1\/24, VLAN 1\)/.test(await page.locator('.vlan-edit').innerText()), 'enable_vlan is shown, and so is the interface of the router that sits on VLAN 1');
await pick('1', 'port4', 'u');
check(/port4 is untagged in VLAN 1 and VLAN 1036, but an untagged port can only be in one VLAN/.test(await notes()) && await saveBtn().isDisabled(), 'an untagged port in two groups is an error', await notes());
await pick('1', 'port4', 't');
await pick('1', 'port3', '');
await page.fill('.vlan-add-id', '1');
await page.press('.vlan-add-id', 'Enter');
check(/already/.test(await page.locator('.vlan-add-error').innerText()), 'a VLAN id that is in use cannot be added');
await page.fill('.vlan-add-id', '50');
await page.press('.vlan-add-id', 'Enter');
check(await rowOf('50').count() === 1 && await stateOf('50', 'CPU (0)') === 't', 'a new group starts with the CPU port tagged');
await pick('50', 'port3', 'u');
await shot('switch-edited');
check(/2 unsaved changes/.test(await summary()) && /VLAN 1\b/.test(await summary()) && /VLAN 50 \(group 3\) added/.test(await summary()), 'the review lists the edited group and the new one', await summary());
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'the save goes through the same safety net');
check(mock.cfg.s1.ports === '0t 1 2 4t' && mock.cfg.s2.ports === '0t 4', 'the ports option of the edited group is rewritten as tokens, in order; the other group is untouched', `${mock.cfg.s1.ports} | ${mock.cfg.s2.ports}`);
const g50 = Object.values(mock.cfg).find(s => s.vid === '50');
check(g50 && g50['.type'] === 'switch_vlan' && g50.device === 'switch0' && g50.vlan === '3' && g50.ports === '0t 3' && mock.cfg.sp.pvid === '1036', 'the new group is a switch_vlan section with the lowest free group number and its vid; the switch_port section was not touched', JSON.stringify(g50));
await page.locator('.vlan-switch input').uncheck();
check(/Turning VLANs off on switch0/.test(await notes()) && /enable_vlan/.test(await summary()), 'turning the switch\'s VLANs off is its own change, with a warning');
await saveBtn().click();
await outcome();
check(mock.cfg.sw.enable_vlan === '0', 'enable_vlan was written on the switch section');
await shot('switch-after');
//#endregion

//#region Permissions and the session
console.log('\n== a login that may not write ==');
mock.mode = 'bridge';
mock.cfg = null;
await page.close();
page = await open(readOnlyAcls);
check(await page.locator('.vlan-table').count() === 1 && await page.locator('button:has-text("Edit VLANs")').count() === 0 && await page.locator('button:has-text("Set up VLAN filtering")').count() === 0, 'the VLAN card stays and shows no edit control');
await shot('no-write');
await page.close();
page = await open(noReadAcls);
check(await page.locator('.vlan-table').count() === 1 && await page.locator('button:has-text("Edit VLANs")').count() === 0, 'nor does a login that may change the config but not read it');
await page.close();

console.log('\n== the session expires while saving ==');
page = await open();
await openEditor();
await pick('20', eth[0], 't');
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
console.log(failed ? `\nFAILED: ${failed}` : '\nall VLAN editor browser checks passed');
process.exit(failed ? 1 : 0);
