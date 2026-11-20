// Browser test for the editable Firewall page. A real browser opens the deployed UI.
// 1. Against the real router, read only: the page shows the router's own firewall with its editing controls, and every uci write (including
//    `order`) that might be sent in this phase is blocked and fails the test.
// 2. Against a stateful mock of rpcd's `uci` object and mocked flab.firewall replies: the matrix, zones, forwardings, rules, port forwards and
//    defaults are edited, validated, reviewed and saved; a change the router does not keep, a firewall that stops loading, a lock-out, a login
//    without write permission, a login that cannot read the config, a reply of the plugin that does not match the config, a missing plugin and
//    an expired session are exercised - WITHOUT touching the router's configuration.
// Usage: node live.mjs   (env: FLAB_SID and FLAB_ACLS from tests/TestSession.ps1, FLAB_URL, FLAB_SHOTS; FLAB_DEV=1 answers everything from the
// mock, for developing the test against a local copy of the UI without a router)
import { chromium } from 'playwright-core';
import path from 'node:path';

const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID ?? '0'.repeat(32);
const rootAcls = JSON.parse(process.env.FLAB_ACLS ?? '{"ubus":{"flab.firewall":["status"],"uci":["get","changes","set","add","delete","order","revert","apply","confirm","rollback"],"system":["board"]},"uci":{"firewall":["read","write"]}}');
const shots = process.env.FLAB_SHOTS;
const dev = process.env.FLAB_DEV === '1';
// The host name the page is opened with: the mock gives one of its interfaces this "address", so the page recognizes where the administrator is.
const HOST = new URL(baseUrl).hostname;

let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));
const j = JSON.stringify;
// Escapes text for a regular expression.
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

//#region The mock router
const WRITES = ['set', 'add', 'delete', 'apply', 'confirm', 'rollback', 'revert', 'commit', 'order', 'rename'];

// One section of `uci get firewall` as a [name, section] pair.
const sec = (name, type, values, anonymous = name.startsWith('cfg')) => [name, { '.anonymous': anonymous, '.type': type, '.name': name, ...values }];
// The firewall config of the mock router: lan, wan and vpn, forwardings between them, anonymous and named rules, a port forward, an include.
const baseCfg = () => {
  const list = [
    sec('cfg01', 'defaults', { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', synflood_protect: '1', flow_offloading: '1' }),
    sec('cfg02', 'zone', { name: 'lan', input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT', network: ['lan', 'lan100'] }),
    sec('cfg03', 'zone', { name: 'wan', input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: '1', mtu_fix: '1', network: ['wan', 'wan6'] }),
    sec('cfg04', 'forwarding', { src: 'lan', dest: 'wan' }),
    sec('cfg05', 'rule', { name: 'Allow-Ping', src: 'wan', proto: 'icmp', icmp_type: 'echo-request', family: 'ipv4', target: 'ACCEPT' }),
    sec('cfg06', 'rule', { name: 'Allow-IPSec', src: 'wan', proto: 'udp', dest_port: ['500', '4500'], family: 'ipv4', target: 'ACCEPT' }),
    sec('wg', 'rule', { name: 'Allow-WireGuard', src: 'wan', dest_port: '51820', proto: 'udp', target: 'ACCEPT' }, false),
    sec('cfg07', 'zone', { name: 'vpn', input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT', mtu_fix: '1', network: ['xfrm0'] }),
    sec('cfg08', 'forwarding', { src: 'lan', dest: 'vpn' }),
    sec('cfg09', 'forwarding', { src: 'vpn', dest: 'lan' }),
    sec('cfg0a', 'rule', { src: 'vpn', proto: 'tcp', dest_port: '3128', target: 'REJECT' }),
    sec('cfg0b', 'redirect', { name: 'Web', src: 'wan', src_dport: '8080', dest: 'lan', dest_ip: '192.168.1.10', dest_port: '80', proto: 'tcp', target: 'DNAT' }),
    sec('cfg0c', 'include', { path: '/etc/firewall.user' }),
  ];
  return Object.fromEntries(list.map(([name, s], i) => [name, { ...s, '.index': i }]));
};
// The router's interfaces: lan answers to the host name the page was opened with.
const NETWORKS = [
  { name: 'guest', disabled: false, proto: 'static', addrs: ['192.168.50.1'] }, { name: 'lan', disabled: false, proto: 'static', addrs: [HOST, '192.168.1.1'] },
  { name: 'lan100', disabled: false, proto: 'static', addrs: ['192.168.100.1'] }, { name: 'loopback', disabled: false, proto: 'static', addrs: ['127.0.0.1'] },
  { name: 'voip', disabled: false, proto: 'dhcp', addrs: [] }, { name: 'wan', disabled: false, proto: 'dhcp', addrs: [] },
  { name: 'wan6', disabled: false, proto: 'dhcpv6', addrs: [] }, { name: 'xfrm0', disabled: false, proto: 'none', addrs: [] },
];
// The hit counters the mock gives rules by name.
const HITS = { 'Allow-Ping': { packets: 40, bytes: 4000 }, 'Allow-WireGuard': { packets: 9, bytes: 900 }, Web: { packets: 3, bytes: 180 } };

// The state of the mock: its config, what is staged, the snapshot an apply keeps for a rollback, and switches that make it misbehave.
const mock = { on: false, cfg: baseCfg(), staged: [], restage: [], snapshot: null, calls: [], applied: [], dropWrites: false, confirmFails: false, expired: false, noPlugin: false,
  running: true, reloadFails: false, loaded: ['lan', 'vpn', 'wan'], noConfigRead: false, mismatch: false, unsafe: [], seq: 1, added: 100 };

// A list option as an array.
const asList = v => (v == null ? [] : [].concat(v));
// The sections of a config in file order.
const ordered = cfg => Object.values(cfg).sort((a, b) => a['.index'] - b['.index']);

// The reply of flab.firewall status for the mock's config, built the way the plugin does it.
function status() {
  const list = ordered(mock.cfg);
  const dflt = list.find(s => s['.type'] === 'defaults') ?? {};
  // A policy as the plugin reports it: upper case, from the defaults when the zone has none, DROP when nothing is set.
  const pol = (v, d) => String(v ?? d ?? 'DROP').toUpperCase();
  const counts = {};
  const zones = [], rules = [], redirects = [];
  for (const s of list) {
    const n = counts[s['.type']] ?? 0;
    counts[s['.type']] = n + 1;
    const key = s.name ?? (s['.anonymous'] ? `@${s['.type']}[${n}]` : s['.name']);
    if (s['.type'] === 'zone') {
      zones.push({ name: s.name, networks: asList(s.network), devices: s.name === 'lan' ? ['br-lan'] : s.name === 'wan' ? ['eth1'] : [], input: pol(s.input, dflt.input), output: pol(s.output, dflt.output), forward: pol(s.forward, dflt.forward),
        masq: s.masq === '1', mtu_fix: s.mtu_fix === '1', enabled: s.enabled !== '0',
        forwards: list.filter(f => f['.type'] === 'forwarding' && f.src === s.name && f.dest && f.enabled !== '0').map(f => f.dest),
        blocked_from: s.name === 'wan' ? { action: 'reject', packets: 12, bytes: 1200 } : null, blocked_to: null });
    } else if (s['.type'] === 'rule') {
      rules.push({ name: s.name ?? null, key, section: s['.name'], src: s.src, dest: s.dest, proto: asList(s.proto), src_ip: asList(s.src_ip), dest_ip: asList(s.dest_ip), src_port: asList(s.src_port), dest_port: asList(s.dest_port),
        icmp_type: asList(s.icmp_type), family: s.family ?? 'any', target: String(s.target ?? 'DROP').toUpperCase(), limit: s.limit, scheduled: false, enabled: s.enabled !== '0', hits: s.enabled === '0' ? null : HITS[key] ?? null });
    } else if (s['.type'] === 'redirect' || s['.type'] === 'nat') {
      redirects.push({ name: s.name ?? null, key, section: s['.name'], kind: s['.type'], src: s.src, dest: s.dest, proto: s.proto ? asList(s.proto) : ['tcp', 'udp'], src_ip: asList(s.src_ip), src_dip: asList(s.src_dip),
        src_dport: asList(s.src_dport), dest_ip: s.dest_ip ?? s.snat_ip, dest_port: asList(s.dest_port ?? s.snat_port), family: s.family ?? 'any', target: String(s.target ?? (s['.type'] === 'nat' ? 'SNAT' : 'DNAT')).toUpperCase(),
        enabled: s.enabled !== '0', hits: s.enabled === '0' ? null : HITS[key] ?? null });
    }
  }
  // A reply made for another config: a rule the file does not have.
  if (mock.mismatch) rules.push({ name: 'Ghost-Rule', key: 'Ghost-Rule', section: 'ghost', src: 'wan', proto: ['tcp'], src_ip: [], dest_ip: [], src_port: [], dest_port: ['1234'], icmp_type: [], family: 'any', target: 'ACCEPT', scheduled: false, enabled: true, hits: null });
  const zoned = zones.flatMap(z => z.networks);
  return {
    generated: Math.floor(Date.now() / 1000), engine: mock.running ? 'nftables' : 'none', running: mock.running,
    defaults: { input: pol(dflt.input), output: pol(dflt.output), forward: pol(dflt.forward), synflood_protect: dflt.synflood_protect === '1', flow_offloading: dflt.flow_offloading === '1', flow_offloading_hw: dflt.flow_offloading_hw === '1', drop_invalid: dflt.drop_invalid === '1' },
    zones, rules, redirects, includes: [], ipsets: 0, hooks: null, flowtable: dflt.flow_offloading === '1' ? { devices: ['eth0', 'eth1'] } : null, nft: { chains: 40, rules: 120 },
    loaded_zones: mock.running ? mock.loaded : null, conntrack: { count: 100, max: 1000 }, networks: NETWORKS, unzoned: NETWORKS.filter(n => n.name !== 'loopback' && !zoned.includes(n.name)).map(n => n.name),
  };
}

// The zones the firewall loads for a config: the enabled ones that have a name.
const loadedFor = list => list.filter(s => s['.type'] === 'zone' && s.enabled !== '0' && s.name).map(s => s.name).sort();

// Applies the staged calls to the mock's config, the way rpcd's uci apply commits them; new anonymous sections are named again afterwards (the
// router derives such names from the content and position, so they change when the file is read again).
function commit() {
  let list = ordered(mock.cfg).map(clone);
  const fresh = [];
  for (const { method, args } of mock.staged) {
    if (method === 'set') {
      const s = list.find(x => x['.name'] === args.section);
      for (const [k, v] of Object.entries(args.values)) s[k] = v;
    } else if (method === 'add') {
      list.push({ '.anonymous': !args.name, '.type': args.type, '.name': args.assigned, ...args.values });
      if (!args.name) fresh.push(args.assigned);
    } else if (method === 'delete') {
      if (args.options) for (const o of args.options) delete list.find(x => x['.name'] === args.section)[o];
      else list = list.filter(x => x['.name'] !== args.section);
    } else if (method === 'order') {
      list = args.sections.map(n => list.find(x => x['.name'] === n)).filter(Boolean).concat(list.filter(x => !args.sections.includes(x['.name'])));
    }
  }
  for (const s of list) if (fresh.includes(s['.name'])) s['.name'] = `cfgf${String(mock.seq++).padStart(2, '0')}`;
  mock.cfg = Object.fromEntries(list.map((s, i) => [s['.name'], { ...s, '.index': i }]));
  mock.applied.push(mock.staged.map(c => c.method));
  if (!mock.reloadFails) mock.loaded = loadedFor(list);
}
// What a rollback or a failed confirmation puts back: the config, the staged edits (rpcd gives them back), and the ruleset of that config.
const restore = () => { mock.cfg = mock.snapshot; mock.staged = mock.restage; mock.snapshot = null; mock.loaded = loadedFor(ordered(mock.cfg)); };

// The `changes` reply for the staged calls, in rpcd's shape.
const changesOf = () => mock.staged.flatMap(({ method, args }) => method === 'set' ? Object.entries(args.values).map(([k, v]) => ['set', args.section, k, v])
  : method === 'add' ? [['add', args.assigned, args.type]] : method === 'delete' ? [['remove', args.section, ...(args.options ?? [])]] : [['order', args.config, args.sections.join()]]);

// One uci method of the mock: [ubus status, data].
function uci(method, args) {
  if (method === 'get') {
    if (mock.noConfigRead || args.config !== 'firewall') return [6];
    return [0, { values: clone(mock.cfg) }];
  }
  if (method === 'changes') {
    const list = args.config && args.config !== 'firewall' ? [] : changesOf();
    return [0, { changes: args.config ? list : (list.length ? { firewall: list } : {}) }];
  }
  if (method === 'set') { mock.staged.push({ method, args }); return [0, {}]; }
  if (method === 'add') {
    const assigned = args.name ?? `cfg${mock.added++}`;
    mock.staged.push({ method, args: { ...args, assigned } });
    return [0, { section: assigned }];
  }
  if (method === 'delete' || method === 'order') { mock.staged.push({ method, args }); return [0, {}]; }
  if (method === 'revert') { if (args.config !== 'firewall') return [4]; mock.staged = []; return [0, {}]; }
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

// The mock's reply to one call, or null for a call it does not know.
function mockAnswer(obj, method, args, ok) {
  if (obj === 'uci') { mock.calls.push(`uci.${method}`); return ok(uci(method, args)); }
  if (obj === 'flab.firewall') return mock.noPlugin ? ok([4]) : ok([0, status()]);
  if (obj === 'system' && method === 'board') return ok([0, { hostname: 'openwrt', model: 'GL.iNet GL-MT6000' }]);
  if (obj === 'session' && method === 'access') return ok([0, { access: true }]);
  return null;
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
    return dev ? mockAnswer(obj, method, args, ok) : null;
  }
  if (mock.expired && ['uci', 'flab.firewall', 'system', 'service', 'session'].includes(obj)) return denied;
  return mockAnswer(obj, method, args, ok);
}
//#endregion

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1300 }, colorScheme: 'light', ignoreHTTPSErrors: true });
const errors = [];
await ctx.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const reply = body ? answer(body) : null;
  return reply ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) }) : route.continue();
});
// Opens the Firewall page with a session in sessionStorage, the way a real sign-in leaves the tab.
const open = async acls => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(([id, a]) => {
    sessionStorage.setItem('sid', id);
    sessionStorage.setItem('acls', JSON.stringify(a));
  }, [sid, acls ?? rootAcls]);
  await p.goto(`${baseUrl}#firewall`);
  await p.waitForSelector('.fwm, main .card-body.text-danger, .login-form', { timeout: 20000 });
  return p;
};
let page = await open();

// Helpers: cards, tables, the dialog, the banner and screenshots.
const card = title => page.locator('.card').filter({ has: page.locator(`.card-header span:text-is("${title}")`) });
// The rows of the table of the card called `title`.
const rows = title => card(title).locator('.fw-table tbody tr');
// The text of every row of that table.
const rowTexts = async title => (await rows(title).allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
// The row of a table whose text matches.
const row = (title, re) => rows(title).filter({ hasText: re }).first();
// A tile's value.
const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
// The open dialog.
const dlg = () => page.locator('dialog.fl-dialog[open]');
// A form field of the dialog by its label.
const dfield = label => dlg().locator('.set-field').filter({ has: page.locator('label.form-label', { hasText: new RegExp(`^\\s*${esc(label)}\\s*$`) }) }).first();
// A text input / select of the dialog by its label.
const dinput = label => dfield(label).locator('input:not([type=checkbox]), select, textarea').first();
// A boolean switch of the dialog by the start of its label.
const dcheck = label => dlg().locator('label.set-check', { hasText: new RegExp(`^\\s*${esc(label)}`) }).locator('input');
// A check box of a choice (an interface, a protocol, a day) in the dialog.
const dchoice = text => dlg().locator('label.fw-check', { hasText: new RegExp(`^\\s*${esc(text)}(\\s|$)`) }).locator('input').first();
// Opens a group of the dialog by its title when it is closed.
const dgroup = async title => {
  const d = dlg().locator('details.fw-group').filter({ has: page.locator('summary', { hasText: title }) });
  if ((await d.getAttribute('open')) === null) await d.locator('summary').click();
};
// The messages under the dialog's form.
const dnotes = () => dlg().locator('.set-notes .set-note').allInnerTexts().then(t => t.join(' | '));
// The accept button of the dialog.
const dsave = () => dlg().locator('.modal-footer button.btn-primary');
// The banner at the top and its save button.
const bar = () => page.locator('.set-bar');
const saveBtn = () => page.locator('button:has-text("Save and apply")');
// The text of the review of pending changes.
const changes = async () => { if (!(await page.locator('.set-changes').isVisible())) await page.click('.set-bar button:has-text("Details")'); return page.locator('.set-changes').evaluate(e => e.textContent); };
// The notes in the banner.
const bnotes = () => page.locator('.set-bar .set-notes .set-note').allInnerTexts().then(t => t.join(' | '));
// Waits for the outcome of a save and returns its text.
const outcome = async () => { const n = page.locator('.set-bar .set-outcome.ok, .set-bar .set-outcome.bad').first(); await n.waitFor({ timeout: 60000 }); return (await n.innerText()).trim(); };
// A cell of the zone matrix: the row of `from`, the column of `to`.
const cellAt = async (from, to) => {
  const heads = (await page.locator('.fwm thead th').allInnerTexts()).map(t => t.trim());
  return page.locator('.fwm tbody tr').filter({ has: page.locator(`th:text-is("${from}")`) }).locator('td').nth(heads.indexOf(to) - 1);
};
// Clicks a matrix cell, and reads its text.
const clickCell = async (from, to) => (await cellAt(from, to)).click();
const cellText = async (from, to) => (await cellAt(from, to)).innerText();
// Saves a full-page screenshot named after `label`, when a screenshot folder is set.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `fw-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Waits a moment for a redraw.
const settle = () => page.waitForTimeout(300);
// Throws away the edits of the page.
const discard = async () => { await page.click('.set-bar button:has-text("Discard edits")'); await settle(); };
// Clicks a switch of a table row or of the defaults card (the click redraws the page, so it is not checked afterwards).
const flip = async locator => { await locator.click(); await settle(); };

//#region The real router (read only)
if (!dev) {
  console.log('== the real router (read only) ==');
  const real = await page.evaluate(async () => {
    const sid = sessionStorage.getItem('sid');
    // One ubus call, answering its result.
    const call = async (obj, m, a) => (await (await fetch('/ubus', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [sid, obj, m, a] }) })).json()).result;
    const st = (await call('flab.firewall', 'status', {}))[1];
    const cfg = (await call('uci', 'get', { config: 'firewall' }))[1]?.values ?? null;
    return { zones: st.zones.length, rules: st.rules.length, sections: st.rules.every(r => r.section), cfg: Boolean(cfg), loaded: st.loaded_zones };
  });
  check(real.sections && real.cfg, 'the plugin reports section names and the login may read the firewall config', j(real));
  check((await rows('Zones').count()) === real.zones && (await rows('Traffic rules').count()) === real.rules, 'every zone and rule of the router is listed', j(real));
  check(await page.locator('button:has-text("Add zone")').isEnabled() && await page.locator('button:has-text("Add rule")').isEnabled() && await page.locator('button:has-text("Add port forward")').isEnabled(), 'the editing controls are there');
  check(await bar().isHidden() && await saveBtn().isDisabled(), 'nothing is pending');
  check(await page.locator('.fwm-click[role=button]').count() >= 2, 'cells between two zones are switches');
  check(await card('Global settings').locator('.set-fields').first().isHidden(), 'the global settings are folded');
  await shot('real');
  // Dialogs are opened and cancelled against the real router: nothing is sent.
  await page.locator('button:has-text("Add zone")').click();
  check(await dlg().isVisible() && /Add a zone/.test(await dlg().innerText()), 'Add zone opens a dialog');
  await dlg().locator('button:has-text("Cancel")').click();
  await rows('Traffic rules').first().locator('button[title="Edit"]').click();
  check(await dlg().isVisible() && /Edit traffic rule/.test(await dlg().innerText()), 'a rule opens in a dialog');
  await dlg().locator('button:has-text("Cancel")').click();
  check(await bar().isHidden(), 'cancelling changes nothing');
}
//#endregion

//#region Reading
mock.on = true;
await page.reload();
await page.waitForSelector('.fwm');
console.log('\n== reading (mock router) ==');
check(await tile(0) === '3' && await tile(1) === '4 / 4' && await tile(2) === '1', 'tiles: zones, rules, port forwards', `${await tile(0)} ${await tile(1)} ${await tile(2)}`);
const zones0 = await rowTexts('Zones');
check(zones0.length === 3 && /^lan/.test(zones0[0]) && /NAT/.test(zones0[1]), 'the zones are listed', zones0.join(' / '));
const rules0 = await rowTexts('Traffic rules');
check(rules0.length === 4 && /Allow-Ping/.test(rules0[0]) && /Allows ICMP echo-request from zone wan to the router itself, IPv4 only/.test(rules0[0]) && /40 packets/.test(rules0[0]), 'a rule has its words and its counters', rules0[0]);
check(/@rule\[3\]/.test(rules0[3]) && /Rejects TCP port 3128 from zone vpn to the router itself/.test(rules0[3]), 'an unnamed rule is listed by its position and in words', rules0[3]);
check(/Forwards TCP port 8080 arriving from zone wan to 192\.168\.1\.10 port 80 in zone lan/.test((await rowTexts('Port forwards and NAT'))[0]), 'a port forward says what it does');
check(await (await cellAt('lan', 'wan')).getAttribute('role') === 'button' && /accept/.test(await cellText('lan', 'wan')) && /blocked/.test(await cellText('vpn', 'wan')), 'the matrix shows what is allowed and what is blocked', `${await cellText('lan', 'wan')} / ${await cellText('vpn', 'wan')}`);
check(await page.locator('.fw-forwardings').count() === 0 && !/Reachable from the Internet/.test(await page.locator('.card-header').allInnerTexts().then(t => t.join(' '))), 'there is no separate list of forwardings and no "Reachable from the Internet" table');
check(await bar().isHidden(), 'the banner is hidden while nothing is edited');
await shot('mock-base');
//#endregion

//#region The matrix
console.log('\n== the matrix ==');
await clickCell('vpn', 'wan');
check(await bar().isVisible() && /1 unsaved change/.test(await page.locator('.set-bar-summary').innerText()), 'clicking a closed cell adds a forwarding and shows it in the banner');
check(/forwarding added, not saved/.test(await cellText('vpn', 'wan')) && /accept/.test(await cellText('vpn', 'wan')), 'and the cell shows it: open, not saved', await cellText('vpn', 'wan'));
check(/New forwarding/.test(await changes()) && /Lets zone vpn send traffic to zone wan/.test(await changes()), 'the review says what it does', await changes());
await clickCell('vpn', 'wan');
check(await bar().isHidden(), 'clicking again takes it back: nothing is pending');
await clickCell('lan', 'vpn');
check(/forwarding removed, not saved/.test(await cellText('lan', 'vpn')) && /Remove forwarding lan › vpn/.test(await changes()), 'clicking an open cell removes its forwarding', await changes());
await discard();
check(await bar().isHidden(), 'Discard edits brings it back');
check(await (await cellAt('lan', 'lan')).getAttribute('role') === null && await (await cellAt('Router itself', 'wan')).getAttribute('role') === null, 'the diagonal and the router are not switches');
// The same forwardings in the zone's dialog: one box per other zone and direction.
await row('Zones', /^vpn/).locator('button[title="Edit zone vpn"]').click();
const fwdTo = () => dfield('May forward to').locator('label.fw-check');
const fwdFrom = () => dfield('May receive from').locator('label.fw-check');
check((await fwdTo().allInnerTexts()).map(t => t.trim()).join() === 'lan,wan' && await fwdTo().filter({ hasText: /^\s*lan/ }).locator('input').isChecked() && !await fwdTo().filter({ hasText: /^\s*wan/ }).locator('input').isChecked(), 'the zone dialog shows where the zone may forward to', (await fwdTo().allInnerTexts()).join());
check(await fwdFrom().filter({ hasText: /^\s*lan/ }).locator('input').isChecked() && !await fwdFrom().filter({ hasText: /^\s*wan/ }).locator('input').isChecked(), 'and who may forward to it');
await fwdTo().filter({ hasText: /^\s*lan/ }).locator('input').uncheck();
await fwdTo().filter({ hasText: /^\s*wan/ }).locator('input').check();
await dsave().click();
await settle();
check(/Remove forwarding vpn › lan/.test(await changes()) && /Lets zone vpn send traffic to zone wan/.test(await changes()) && !/Zone vpn:/.test(await changes()), 'the boxes become forwardings in the review, and the zone itself is unchanged', await changes());
check(/forwarding removed, not saved/.test(await cellText('vpn', 'lan')) && /forwarding added, not saved/.test(await cellText('vpn', 'wan')), 'and the matrix shows them');
await discard();
await row('Zones', /^lan/).locator('button[title="Edit zone lan"]').click();
await fwdFrom().filter({ hasText: /^\s*wan/ }).locator('input').check();
await dsave().click();
await settle();
check(/Lets zone wan send traffic to zone lan/.test(await changes()), 'ticking "May receive from" adds the forwarding in the other direction', await changes());
await discard();
//#endregion

//#region Zones
console.log('\n== zones ==');
await page.locator('button:has-text("Add zone")').click();
check(await dinput('Name').inputValue() === 'zone1', 'a new zone gets a free name');
await dinput('Name').fill('bad name!');
check(/must start with a letter/.test(await dnotes()) && await dsave().isDisabled() && await dinput('Name').evaluate(e => e.classList.contains('is-invalid')), 'a bad name is marked and blocks Add', await dnotes());
await dinput('Name').fill('lan');
check(/unique/.test(await dnotes()) && await dsave().isDisabled(), 'so is a name that is taken', await dnotes());
await dinput('Name').fill('guest');
check(/no interface, device or subnet/.test(await dnotes()), 'a zone with nothing in it is a warning', await dnotes());
await dchoice('guest').check();
await dchoice('lan100').check();
check(/now in zone lan: choosing it moves it here/.test(await dfield('Interfaces').innerText()), 'an interface of another zone says it will move');
await dinput('Input policy').selectOption('DROP');
await dcheck('Masquerade IPv4').check();
check(await dfield('Masquerade only these sources').isVisible(), 'masquerading shows its limits');
await dcheck('Masquerade IPv4').uncheck();
check(await dfield('Masquerade only these sources').isHidden(), 'and they go away again');
await dfield('Subnets').locator('button:has-text("Add subnet")').click();
await dfield('Subnets').locator('input').first().fill('300.1.1.0/24');
check(/Subnets: "300\.1\.1\.0\/24"/.test(await dnotes()) && await dsave().isDisabled(), 'a bad subnet is an error', await dnotes());
await dfield('Subnets').locator('input').first().fill('10.9.0.0/16');
await shot('zone-dialog');
await dsave().click();
check(await dlg().count() === 0, 'Add closes the dialog');
const zones1 = await rowTexts('Zones');
check(zones1.length === 4 && /^guest/.test(zones1[3]) && /new/.test(zones1[3]) && !/lan100/.test(zones1[0]), 'the zone is listed as new, and lan100 left lan', zones1.join(' / '));
check(/2 unsaved changes/.test(await page.locator('.set-bar-summary').innerText()) && /New zone guest/.test(await changes()) && /Zone lan: Interfaces/.test(await changes()), 'the banner lists the new zone and the interface that moved', await changes());
check(await tile(0) === '4', 'the tile counts the new zone');
await clickCell('guest', 'wan');
check(/accept/.test(await cellText('guest', 'wan')), 'the new zone is in the matrix and can be given a forwarding');
await discard();
check(await bar().isHidden() && (await rowTexts('Zones')).length === 3, 'Discard edits forgets the zones');

// A zone that is not the one the page was opened through: the generic warning names the zone.
await row('Zones', /^vpn/).locator('button[title="Edit zone vpn"]').click();
await dinput('Input policy').selectOption('REJECT');
await dsave().click();
const w1 = await bnotes();
check(/Zone vpn lets its hosts reach the web interface \(port \d+\) today and would not after this change/.test(w1) && !/Lock-out risk/.test(w1), 'closing the input of a zone that accepts warns, naming the zone', w1);
check(await saveBtn().isEnabled(), 'a warning does not block Save');
await discard();

// The name cannot change.
await row('Zones', /^lan/).locator('button[title="Edit zone lan"]').click();
check(await dinput('Name').isDisabled() && /cannot be renamed/.test(await dinput('Name').getAttribute('title')), 'an existing zone cannot be renamed');
await dlg().locator('button:has-text("Cancel")').click();

// Removing a zone takes its forwardings along and leaves the rules that name it as errors.
await row('Zones', /^wan/).locator('button[title="Remove zone wan"]').click();
check(/Remove zone wan/.test(await changes()) && /Remove forwarding lan › wan/.test(await changes()), 'removing a zone removes the forwardings that name it', await changes());
const bn = await bnotes();
check(/Rule "Allow-Ping": The source zone "wan" is being removed/.test(bn) && await saveBtn().isDisabled(), 'rules that still name it are errors and block Save', bn);
await row('Zones', /^wan/).locator('button[title^="Keep this zone"]').click();
await settle();
check(await bar().isHidden(), 'Undo brings the zone and its forwardings back');
//#endregion

//#region Rules
console.log('\n== rules ==');
await page.locator('button:has-text("Add rule")').click();
check(/Allows TCP and UDP traffic from the router itself/.test(await dlg().locator('.fw-words').innerText()), 'a new rule says in words what it does', await dlg().locator('.fw-words').innerText());
await dinput('Name').fill('Allow-SSH');
await dinput('Source zone').selectOption('wan');
await dchoice('tcp').check();
check(/^Allows TCP traffic from zone wan to the router itself\.$/.test(await dlg().locator('.fw-words').innerText()), 'the sentence follows the form', await dlg().locator('.fw-words').innerText());
await dfield('Destination ports').locator('button:has-text("Add port")').click();
await dfield('Destination ports').locator('input').first().fill('70000');
check(/Destination ports: "70000" is above 65535/.test(await dnotes()) && await dsave().isDisabled(), 'a port above 65535 is an error', await dnotes());
await dfield('Destination ports').locator('input').first().fill('22');
await dinput('Address family').selectOption('ipv4');
await dfield('Source addresses').locator('button:has-text("Add address")').click();
await dfield('Source addresses').locator('input').first().fill('10.0.0.0/8');
await dchoice('icmp').check();
check(await dfield('ICMP types').isVisible(), 'choosing ICMP shows the ICMP types');
await dchoice('icmp').uncheck();
check(await dfield('ICMP types').isHidden(), 'and unchoosing hides them');
await dfield('Protocols').locator('input[placeholder]').fill('47');
await dfield('Protocols').locator('button:has-text("Add")').click();
check(await dchoice('47').isChecked(), 'any other protocol can be added by name or number');
await dchoice('47').uncheck();
await dgroup('Rate limit and mark');
await dinput('Rate limit').fill('3/min');
check(await dfield('Burst').isVisible(), 'a rate limit shows its burst');
await dinput('Rate limit').fill('');
await dgroup('Schedule');
await dchoice('Mon').check();
await dchoice('Tue').check();
await dinput('From time of day').fill('08:00');
check(/, on mon and tue, from 08:00, IPv4 only\./.test(await dlg().locator('.fw-words').innerText()), 'the schedule is in the sentence', await dlg().locator('.fw-words').innerText());
await dinput('From time of day').fill('08:99');
check(/From time of day "08:99"/.test(await dnotes()), 'a bad time is an error', await dnotes());
await dinput('From time of day').fill('');
await dchoice('Mon').uncheck();
await dchoice('Tue').uncheck();
await shot('rule-dialog');
await dsave().click();
const rules1 = await rowTexts('Traffic rules');
check(rules1.length === 5 && /Allow-SSH/.test(rules1[4]) && /new/.test(rules1[4]) && /not saved yet/.test(rules1[4]), 'the new rule is the last row, marked new, with no counters', rules1[4]);
check(/New rule/.test(await changes()) && /Allows TCP port 22 from zone wan to the router itself, from 10\.0\.0\.0\/8, IPv4 only/.test(await changes()), 'the review says in words what it does', await changes());
await row('Traffic rules', /Allow-SSH/).locator('button[title^="Move up"]').click();
check(/Allow-SSH/.test((await rowTexts('Traffic rules'))[3]) && !/Traffic rules: order/.test(await changes()), 'a new rule can be moved among the others (the order of old rules is unchanged)', (await rowTexts('Traffic rules'))[3]);
await flip(row('Traffic rules', /Allow-Ping/).locator('.form-switch input'));
check(/Rule "Allow-Ping": Enabled: on → off/.test(await changes()) && await row('Traffic rules', /Allow-Ping/).evaluate(e => e.classList.contains('fw-off')), 'a rule is disabled with its switch');
await row('Traffic rules', /Allow-IPSec/).locator('button[title^="Move up"]').click();
check(/Traffic rules: order/.test(await changes()) && /Allow-IPSec › Allow-Ping/.test(await changes()), 'moving an old rule shows the new order', await changes());
check((await rowTexts('Traffic rules'))[0].startsWith('1 Allow-IPSec'), 'and the table follows', (await rowTexts('Traffic rules'))[0]);
check(await row('Traffic rules', /Allow-IPSec/).locator('button[title^="Move up"]').isDisabled(), 'the first rule cannot move up');
await row('Traffic rules', /Allow-WireGuard/).locator('button[title="Remove"]').click();
check(await row('Traffic rules', /Allow-WireGuard/).evaluate(e => e.classList.contains('fw-removed')) && /Remove rule "Allow-WireGuard"/.test(await changes()), 'a rule is removed (struck out until saved)');
await row('Traffic rules', /Allow-WireGuard/).locator('button[title^="Keep this one"]').click();
await settle();
check(!/Remove rule "Allow-WireGuard"/.test(await changes()), 'and Undo takes it back');
await shot('mock-rules-edited');
await discard();
//#endregion

//#region Port forwards
console.log('\n== port forwards ==');
await page.locator('button:has-text("Add port forward")').click();
await dinput('Source zone').selectOption('wan');
check(/Give an internal address or a port/.test(await dnotes()) && await dsave().isDisabled(), 'a forward to nothing is flagged', await dnotes());
await dinput('Name').fill('SSH to server');
await dchoice('tcp').check();
await dinput('Arrives at the port').fill('2222');
await dinput('Internal address').fill('192.168.1.5');
await dinput('Internal port').fill('22');
check(/Forwards TCP port 2222 arriving from zone wan to 192\.168\.1\.5 port 22/.test(await dlg().locator('.fw-words').innerText()) && await dsave().isEnabled(), 'the forward is described', await dlg().locator('.fw-words').innerText());
await dinput('Internal address').fill('!192.168.1.5');
check(/cannot be negated/.test(await dnotes()), 'the internal address cannot be negated');
await dinput('Internal address').fill('192.168.1.5');
await dinput('Kind').selectOption('SNAT');
check(await dfield('Rewrite the source address to').isVisible() && /needs a destination zone/.test(await dnotes()), 'a source NAT words its fields differently and needs a destination', await dnotes());
await dinput('Kind').selectOption('DNAT');
check(await dfield('Arrives at the port').isVisible(), 'and DNAT brings the others back');
await dsave().click();
const redirects1 = await rowTexts('Port forwards and NAT');
check(redirects1.length === 2 && /SSH to server/.test(redirects1[1]) && /new/.test(redirects1[1]), 'the port forward is listed', redirects1.join(' / '));
await page.locator('button:has-text("Add port forward")').click();
await dinput('Kind').selectOption('SNAT');
await dinput('Source zone').selectOption('lan');
await dinput('Destination zone').selectOption('wan');
await dinput('Rewrite the source address to').fill('203.0.113.5');
check(/Rewrites the source address of TCP and UDP traffic in zone lan leaving through zone wan to 203\.0\.113\.5/.test(await dlg().locator('.fw-words').innerText()) && await dsave().isEnabled(), 'a complete source NAT is accepted', await dnotes());
await dlg().locator('button:has-text("Cancel")').click();
await discard();
//#endregion

//#region Global settings
console.log('\n== global settings ==');
const defaults = card('Global settings');
check(await defaults.locator('.set-fields').first().isHidden(), 'the card starts folded');
await defaults.locator('.card-header').click();
check(await defaults.locator('.set-fields').first().isVisible(), 'and opens when its header is clicked');
// A switch of the defaults card by the start of its label.
const dswitch = label => defaults.locator('label.set-check', { hasText: new RegExp(`^\\s*${esc(label)}`) }).locator('input');
check(await defaults.locator('.set-field', { hasText: 'SYN rate' }).count() === 1 && await defaults.locator('.set-field', { hasText: 'Hardware flow offloading' }).count() === 0 && await dswitch('Hardware flow offloading').count() === 1, 'options that depend on a switch show when it is on', `${await defaults.locator('.set-field', { hasText: 'SYN rate' }).count()}`);
await flip(dswitch('Drop invalid packets'));
check(/Global settings: Drop invalid packets: off → on/.test(await changes()), 'a switch is a change', await changes());
await flip(dswitch('SYN-flood protection'));
check(await defaults.locator('.set-field', { hasText: 'SYN rate' }).count() === 0, 'a dependent option goes away with its switch');
await flip(dswitch('SYN-flood protection'));
await defaults.locator('.set-field', { hasText: 'SYN rate' }).locator('input').fill('50/fast');
check(/Global settings: SYN rate "50\/fast"/.test(await bnotes()) && await saveBtn().isDisabled(), 'a bad rate is an error', await bnotes());
await defaults.locator('.set-field', { hasText: 'SYN rate' }).locator('input').fill('50/second');
check(await saveBtn().isEnabled() && /Global settings: SYN rate: default → 50\/second/.test(await changes()), 'and a good one is fine', await changes());
await shot('defaults');
await discard();
//#endregion

//#region Saving
console.log('\n== saving ==');
await page.locator('button:has-text("Add rule")').click();
await dinput('Name').fill('Allow-SSH');
await dinput('Source zone').selectOption('wan');
await dchoice('tcp').check();
await dfield('Destination ports').locator('button:has-text("Add port")').click();
await dfield('Destination ports').locator('input').first().fill('22');
await dsave().click();
await row('Traffic rules', /Allow-SSH/).locator('button[title^="Move up"]').click();
await flip(row('Traffic rules', /Allow-Ping/).locator('.form-switch input'));
await row('Traffic rules', /Allow-IPSec/).locator('button[title^="Move up"]').click();
await row('Traffic rules', /@rule\[3\]/).locator('button[title="Remove"]').click();
await clickCell('vpn', 'wan');
await page.locator('button:has-text("Add zone")').click();
await dinput('Name').fill('guest');
await dchoice('guest').check();
await dsave().click();
await page.locator('button:has-text("Add port forward")').click();
await dinput('Source zone').selectOption('wan');
await dinput('Name').fill('SSH to server');
await dchoice('tcp').check();
await dinput('Arrives at the port').fill('2222');
await dinput('Internal address').fill('192.168.1.5');
await dsave().click();
const review = await changes();
check(/New zone guest/.test(review) && /New rule/.test(review) && /New forwarding/.test(review) && /New port forward/.test(review) && /Remove rule #\d/.test(review) && /Allow-Ping": Enabled/.test(review) && /Traffic rules: order/.test(review), 'the review lists everything that will change', review);
mock.calls = [];
await saveBtn().click();
const done = await outcome();
check(/^Saved/.test(done), 'a successful save says so', done);
check(/^uci\.changes( uci\.(set|add|delete|order))+ uci\.apply( uci\.get)+ uci\.confirm/.test(mock.calls.join(' ')), 'it checked for leftovers, staged, applied, read the config back and confirmed', mock.calls.join(' '));
check(['set', 'add', 'delete', 'order'].every(m => mock.applied.at(-1).includes(m)), 'it staged sets, adds, a delete and the order of the sections', mock.applied.at(-1).join());
const cfgNow = ordered(mock.cfg);
const ruleNames = cfgNow.filter(s => s['.type'] === 'rule').map(s => s.name ?? '(unnamed)');
check(ruleNames.join() === 'Allow-IPSec,Allow-Ping,Allow-WireGuard,Allow-SSH', 'the rules are in the order of the page, the removed one is gone', ruleNames.join());
check(cfgNow.find(s => s.name === 'Allow-Ping').enabled === '0' && cfgNow.find(s => s.name === 'Allow-WireGuard')['.name'] === 'wg', 'the disabled rule is disabled, the named section keeps its name');
check(cfgNow.some(s => s['.type'] === 'zone' && s.name === 'guest' && j(s.network) === '["guest"]') && cfgNow.some(s => s['.type'] === 'forwarding' && s.src === 'vpn' && s.dest === 'wan'), 'the new zone and forwarding are in the file');
check(cfgNow.some(s => s['.type'] === 'redirect' && s.name === 'SSH to server' && s.src_dport === '2222' && s.dest_ip === '192.168.1.5' && s.proto && j(asList(s.proto)) === '["tcp"]'), 'and the new port forward');
check(mock.staged.length === 0 && mock.snapshot === null, 'nothing stays staged');
await page.waitForSelector('.fwm');
check((await rowTexts('Zones')).length === 4 && (await rowTexts('Traffic rules')).length === 4 && /^1 Allow-IPSec/.test((await rowTexts('Traffic rules'))[0]), 'afterwards the page lists what was saved', `${(await rowTexts('Zones')).length} ${(await rowTexts('Traffic rules'))[0]}`);
check(await bar().locator('.set-outcome.ok').count() === 1, 'and the outcome stays in the banner');
//#endregion

//#region A change the router does not keep
console.log('\n== a change the router does not keep ==');
mock.dropWrites = true;
await row('Zones', /^lan/).locator('button[title="Edit zone lan"]').click();
await dcheck('MSS clamping').check();
await dsave().click();
mock.calls = [];
await saveBtn().click();
const lost = await outcome();
check(/rolled back/.test(lost) && /Zone lan: MSS clamping/.test(lost), 'a change that does not read back is rolled back and named', lost);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && mock.staged.length === 0, 'rollback is called, confirm is not, nothing stays staged', mock.calls.join(' '));
mock.dropWrites = false;
await discard();

console.log('\n== a firewall that keeps the old ruleset ==');
mock.reloadFails = true;
await row('Zones', /^guest/).locator('button[title="Edit zone guest"]').click();
await dcheck('Enabled').uncheck();
await dsave().click();
await saveBtn().click();
const stuck = await outcome();
check(/rolled back/.test(stuck) && /still has rules for zone guest/.test(stuck), 'a firewall that does not load the new config is noticed and the change is rolled back', stuck);
mock.reloadFails = false;
await discard();

console.log('\n== a firewall that stops loading ==');
await row('Zones', /^guest/).locator('button[title="Edit zone guest"]').click();
await dcheck('Enabled').uncheck();
await dsave().click();
mock.running = false;
await saveBtn().click();
const stopped = await outcome();
check(/rolled back/.test(stopped) && /no longer loaded/.test(stopped), 'a firewall that is no longer loaded is rolled back', stopped);
mock.running = true;
check(ordered(mock.cfg).find(s => s.name === 'guest').enabled === undefined, 'and the router has the previous config');
await discard();

console.log('\n== the router refuses the confirmation ==');
mock.confirmFails = true;
await row('Zones', /^lan/).locator('button[title="Edit zone lan"]').click();
await dcheck('MSS clamping').check();
await dsave().click();
await saveBtn().click();
const refused = await outcome();
check(/^Confirmation failed; the outcome is uncertain\./.test(refused) && /Rollback could not be confirmed/.test(refused) && !/was rolled back/.test(refused), 'a refused confirmation without an active rollback is reported as uncertain, not as confirmed recovery', refused);
mock.confirmFails = false;
await discard();

console.log('\n== leftovers from an earlier attempt ==');
mock.staged = [{ method: 'set', args: { config: 'firewall', section: 'cfg02', values: { masq: '1' } } }];
await page.click('button:has-text("Refresh")');
await page.waitForTimeout(700);
check(/1 change\(s\) are already staged/.test(await page.locator('main').innerText()), 'staged changes in the session are shown');
await page.getByRole('button', { name: "Discard this page's staged changes", exact: true }).click();
await page.waitForTimeout(700);
check(mock.staged.length === 0 && !/already staged/.test(await page.locator('main').innerText()), "Discard clears this page's staged changes");
//#endregion

//#region Lock-out
console.log('\n== lock-out ==');
await row('Zones', /^lan/).locator('button[title="Edit zone lan"]').click();
await dinput('Input policy').selectOption('DROP');
await dsave().click();
const lock = await bnotes();
check(/Lock-out risk: you are reaching the router at/.test(lock) && new RegExp(esc(HOST)).test(lock) && /interface lan, zone lan/.test(lock), 'the zone you are in is recognized by the address you used, and named', lock);
mock.calls = [];
await saveBtn().click();
await dlg().waitFor();
check(/may cut you off/.test(await dlg().innerText()) && /Lock-out risk/.test(await dlg().innerText()), 'saving asks first, listing the risks');
await dlg().locator('button:has-text("Cancel")').click();
await settle();
check(!mock.calls.includes('uci.apply') && await bar().isVisible(), 'Cancel applies nothing and keeps the edits');
await saveBtn().click();
await dlg().waitFor();
await dlg().locator('button:has-text("Apply anyway")').click();
check(/^Saved/.test(await outcome()) && mock.calls.includes('uci.apply') && ordered(mock.cfg).find(s => s.name === 'lan').input === 'DROP', 'Apply anyway goes ahead');
// Back to accepting, then closing the input again with a rule that keeps HTTPS reachable.
await row('Zones', /^lan/).locator('button[title="Edit zone lan"]').click();
await dinput('Input policy').selectOption('ACCEPT');
await dsave().click();
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'opening the zone again needs no question');
await row('Zones', /^lan/).locator('button[title="Edit zone lan"]').click();
await dinput('Input policy').selectOption('REJECT');
await dsave().click();
await page.locator('button:has-text("Add rule")').click();
await dinput('Name').fill('Allow-HTTPS-LAN');
await dinput('Source zone').selectOption('lan');
await dchoice('tcp').check();
await dfield('Destination ports').locator('button:has-text("Add port")').click();
await dfield('Destination ports').locator('input').first().fill(new URL(baseUrl).port || '443');
await dsave().click();
const lock2 = await bnotes();
check(/SSH/.test(lock2) && !/web interface/.test(lock2), 'a rule that accepts HTTPS keeps the web interface reachable: only SSH is warned about', lock2);
await discard();
//#endregion

//#region Other states
console.log('\n== a login that may not write ==');
const ro = await open({ ubus: { system: ['board'], 'flab.firewall': ['status'], uci: ['get', 'changes'] } });
check(/not allowed to change the configuration/.test(await ro.locator('main').innerText()) && await ro.locator('button:has-text("Add zone")').isDisabled() && await ro.locator('button:has-text("Add rule")').isDisabled(), 'the controls are disabled and the page says why');
check(await ro.locator('.fwm-click[role=button]').count() === 0 && await ro.locator('button[title="Edit"]').first().isDisabled(), 'the matrix is not clickable and rows cannot be edited');
await ro.close();

console.log('\n== a login that cannot read the config ==');
const nr = await open({ ubus: { system: ['board'], 'flab.firewall': ['status'] } });
check(await nr.locator('.fwm').count() === 1 && await nr.locator('button:has-text("Add zone")').count() === 0 && await nr.locator('.fw-table').count() >= 3, 'the page is the read-only page it was before editing: no controls', await nr.locator('main').innerText().then(t => t.slice(0, 80)));
await nr.close();

console.log('\n== a reply of the plugin that does not match the config ==');
mock.mismatch = true;
await page.click('button:has-text("Refresh")');
await page.waitForTimeout(700);
check(/Ghost-Rule/.test(await card('Traffic rules').innerText()) && await page.locator('button:has-text("Add zone")').count() === 0, 'the page shows what the plugin reports, read only', await card('Traffic rules').innerText());
mock.mismatch = false;
await page.click('button:has-text("Refresh")');
await page.waitForTimeout(700);
check(await page.locator('button:has-text("Add zone")').count() === 1 && !/Ghost-Rule/.test(await card('Traffic rules').innerText()), 'and the editor is back when they agree');

console.log('\n== the plugin is missing ==');
mock.noPlugin = true;
await page.click('button:has-text("Refresh")');
await page.waitForTimeout(700);
check(/flab\.firewall\.status failed/.test(await page.locator('main').innerText()), 'a router without the plugin shows the error');
mock.noPlugin = false;
await page.click('button:has-text("Refresh")');
await page.waitForSelector('.fwm');

console.log('\n== theme ==');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(300);
await shot('dark');
await page.emulateMedia({ colorScheme: 'light' });

console.log('\n== the session expires ==');
await row('Zones', /^lan/).locator('button[title="Edit zone lan"]').click();
await dcheck('MSS clamping').check();
await dsave().click();
mock.expired = true;
// A poll may notice the expiry before the click lands; either way the sign-in screen must appear.
await saveBtn().click({ timeout: 5000 }).catch(() => {});
await page.waitForSelector('.login-form', { timeout: 20000 });
check(/Session expired/.test(await page.locator('.login-error').innerText()), 'an expired session returns to the sign-in screen');
//#endregion

check(mock.unsafe.length === 0, 'no uci write reached the real router', mock.unsafe.join());
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall Firewall browser checks passed');
process.exit(failed ? 1 : 0);
