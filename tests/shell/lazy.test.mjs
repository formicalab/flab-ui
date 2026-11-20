// node --experimental-vm-modules --test tests/shell/lazy.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = name => readFile(new URL(`../../www/js/${name}`, import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join(' ');
const find = (node, match) => match(node) ? node : (node?.children ?? []).map(child => find(child, match)).find(Boolean);

test('the shipped shell enforces a same-origin content security policy', async () => {
  const html = await readFile(new URL('../../www/index.html', import.meta.url), 'utf8');
  const policy = html.match(/Content-Security-Policy"[\s\S]*?content="([^"]+)"/)?.[1];
  assert.ok(policy, 'index.html has a CSP meta policy');
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
});

const allModules = [
  { entries: [
    { id: 'network', label: 'Ethernet ports', icon: 'ethernet', order: 10, module: './network/index.js' },
    { id: 'interfaces', label: 'Devices and Interfaces', icon: 'diagram-3', order: 60, module: './interfaces/index.js' },
  ] },
  { entries: [{ id: 'radios', label: 'Wi-Fi radios', icon: 'wifi', order: 20, module: './radios/index.js' }] },
  { entries: [{ id: 'firewall', label: 'Firewall', icon: 'brick-wall', order: 30, module: './firewall/index.js' }] },
  { entries: [
    { id: 'ipsec', label: 'VPN: IPsec', icon: 'shield-lock', order: 40, module: './ipsec/index.js' },
    { id: 'wireguard', label: 'VPN: WireGuard', icon: 'shield-lock', order: 50, module: './wireguard/index.js' },
  ] },
  { entries: [{ id: 'dhcp', label: 'DHCP', icon: 'hdd-network', order: 70, module: './dhcp/index.js' }] },
  { entries: [
    { id: 'dns', label: 'DNS', icon: 'list-ul', order: 80, module: './dns/index.js', tab: 'resolver' },
    { id: 'ddns', label: 'Dynamic DNS', title: 'DNS', icon: 'cloud', nav: 'hidden', navId: 'dns', order: 81, module: './dns/index.js', tab: 'dynamic' },
  ] },
  { entries: [{ id: 'routing', label: 'Routing', icon: 'signpost-split', order: 90, module: './routing/index.js' }] },
  { entries: [{ id: 'traffic', label: 'Traffic', icon: 'activity', order: 100, module: './traffic/index.js' }] },
  { entries: [{ id: 'services', label: 'Services', icon: 'hdd-stack', order: 110, module: './services/index.js' }] },
  { entries: [{ id: 'toolbox', label: 'Toolbox', icon: 'tools', order: 120, module: './toolbox/index.js', activation: 'toolbox' }] },
  { entries: [{ id: 'logs', label: 'Logs', icon: 'journal-text', order: 130, module: './logs/index.js' }] },
];

async function shell({ signedIn = true, imports = {}, loads = {}, boards = [], modules = allModules } = {}) {
  const events = {}, calls = [], styles = [], timers = new Map(), renders = [], controls = {}, paused = { on: false };
  const element = (tag, props = {}, ...children) => ({
    tag, ...props, children: children.flat().filter(c => c != null),
    replaceChildren(...next) { this.children = next; },
    setAttribute(name, value) { this[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; },
  });
  const app = element('div');
  let timer = 0, onLogin;
  class AuthError extends Error {}
  const context = vm.createContext({
    location: { hash: '#overview', replace(hash) { this.hash = hash; }, hostname: 'test' },
    document: { hidden: false, head: { append: node => styles.push(node) }, addEventListener: (name, fn) => { events[name] = fn; } },
    addEventListener: (name, fn) => { events[name] = fn; },
    setInterval: fn => { timers.set(++timer, fn); return timer; },
    setTimeout: fn => { timers.set(++timer, fn); return timer; },
    clearInterval: id => timers.delete(id),
  });
  async function synthetic(values) {
    const module = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
    await module.link(() => {});
    await module.evaluate();
    return module;
  }
  const registry = new vm.SourceTextModule(await source('pages/index.js'), {
    context,
    importModuleDynamically: async specifier => {
      const id = specifier.split('/')[1].replace('.js', '');
      calls.push(`import:${id}`);
      if (imports[id]) await imports[id].promise;
      return synthetic({
        openTool: (tool, host) => calls.push(`tool:${tool}:${host}`),
        openTab: tab => calls.push(`tab:${tab}`),
        default: {
        id, label: id, interval: id === 'interfaces' ? () => 2000 : 1000, css: `css/${id}.css`, isPaused: () => paused.on,
        load: () => { calls.push(`load:${id}`); return loads[id]?.() ?? Promise.resolve({ value: id }); },
        controls: ctl => { controls[id] = ctl; return { nodes: [] }; },
        view: data => { renders.push(data.value); return [element('p', {}, data.value)]; },
      } });
    },
  });
  await registry.link(() => { throw new Error('Registry must not statically import pages'); });
  await registry.evaluate();
  assert.equal(calls.length, 0, 'loading navigation metadata must not import pages');
  const deps = {
    './dom.js': await synthetic({ h: element, byId: () => app }),
    './icons.js': await synthetic({ icon: () => null }),
    './ubus.js': await synthetic({
      hasSession: () => signedIn, AuthError,
      ubus: (object, method) => object === 'flab.system' && method === 'modules'
        ? Promise.resolve(typeof modules === 'function' ? modules() : modules).then(modules => ({ modules }))
        : boards.shift()?.promise ?? Promise.resolve({ hostname: 'test', model: 'image' }),
      logout: async () => { signedIn = false; }, clearSession: () => { signedIn = false; },
    }),
    './login.js': await synthetic({ showLogin: callback => { onLogin = callback; app.replaceChildren('LOGIN'); } }),
    './freshness.js': await synthetic({ ensureCurrent: async () => false }),
    './ui.js': await synthetic({
      card: (_, child) => child,
      button: (label, _icon, onclick) => element('button', { onclick }, label),
      spinner: text => element('span', { className: 'spinner-border', role: 'status' }, text),
    }),
    '../pages/index.js': registry,
  };
  const module = new vm.SourceTextModule(await source('core/app.js'), { context });
  await module.link(specifier => deps[specifier]);
  await module.evaluate();
  module.namespace.start();
  await tick();
  return {
    app, calls, renders, styles, timers, controls, paused, AuthError, context, openTool: registry.namespace.openTool,
    navigate: async hash => { context.location.hash = hash; await events.hashchange(); },
    signedOut: async () => { signedIn = false; await events.hashchange(); },
    signIn: async () => { signedIn = true; await onLogin(); },
  };
}

test('login imports no page modules; successful sign-in resolves only the selected page', async () => {
  const s = await shell({ signedIn: false });
  assert.equal(text(s.app), 'LOGIN');
  assert.deepEqual(s.calls, []);
  await s.signIn();
  assert.deepEqual(s.calls, ['import:overview', 'load:overview']);
  const links = s.app.children[0].children[0].children.filter(n => n?.href);
  assert.equal(links.map(n => n.href).join(','), '#overview,#network,#radios,#firewall,#ipsec,#wireguard,#interfaces,#dhcp,#dns,#routing,#traffic,#services,#toolbox,#logs,#settings');
  assert.deepEqual(links.slice(3, 6).map(n => n.children.at(-1)), ['Firewall', 'VPN: IPsec', 'VPN: WireGuard']);
  assert.equal(links.at(-1).children.at(-1), 'System settings');
  assert.equal(links[0].ariaCurrent, 'page');
});

test('the base package renders without feature modules', async () => {
  const s = await shell({ modules: [] });
  const links = s.app.children[0].children[0].children.filter(n => n?.href);
  assert.equal(links.map(n => n.href).join(','), '#overview,#settings');
  assert.equal(s.calls.at(-1), 'load:overview');
  await s.navigate('#firewall');
  assert.equal(s.calls.at(-1), 'load:overview', 'an unavailable module route falls back safely');
});

test('a transient module discovery failure is retried on the next route', async () => {
  let attempts = 0;
  const s = await shell({ modules: () => {
    attempts += 1;
    if (attempts === 1) throw new Error('rpcd is restarting');
    return allModules;
  } });
  assert.equal(s.app.children[0].children[0].children.filter(n => n?.href).map(n => n.href).join(','), '#overview,#settings');
  await s.navigate('#missing');
  assert.equal(attempts, 2);
  assert.equal(s.app.children[0].children[0].children.filter(n => n?.href).some(n => n.href === '#network'), true);
});

test('aliases invalidate the old route; unknown routes retain the default page', async () => {
  const s = await shell();
  await s.navigate('#bridges');
  assert.equal(s.context.location.hash, '#interfaces');
  assert.equal(s.timers.size, 0);
  await s.navigate('#interfaces');
  assert.equal(s.calls.at(-1), 'load:interfaces');
  await s.navigate('#wifi');
  assert.equal(s.context.location.hash, '#radios');
  await s.navigate('#mesh');
  assert.equal(s.context.location.hash, '#radios');
  await s.navigate('#ddns');
  assert.equal(s.calls.at(-2), 'tab:dynamic');
  assert.equal(s.calls.at(-1), 'load:dns');
  assert.equal(s.app.children[0].children[0].children.filter(n => n?.href).find(n => n.href === '#dns').className.includes('active'), true);
  await s.navigate('#missing');
  assert.equal(s.calls.at(-1), 'load:overview');
  await s.navigate('#constructor');
  assert.equal(s.context.location.hash, '#constructor');
  assert.equal(s.calls.at(-1), 'load:overview');
});

test('a late import cannot install controls, CSS or polling after navigation or login', async () => {
  const pending = deferred();
  const s = await shell({ imports: { overview: pending } });
  await s.navigate('#radios');
  pending.resolve();
  await tick();
  assert.equal(text(s.app).includes('radios'), true);
  assert.equal(s.calls.includes('load:overview'), false);
  assert.equal(s.styles.some(n => n.href === 'css/overview.css'), false);
  const later = deferred();
  const t = await shell({ imports: { overview: later } });
  await t.signedOut();
  later.resolve();
  await tick();
  assert.equal(text(t.app), 'LOGIN');
  assert.equal(t.timers.size, 0);
});

test('import failure has explicit retry UX and does not start polling', async () => {
  const pending = deferred();
  const s = await shell({ imports: { overview: pending } });
  pending.reject(new Error('network unavailable'));
  await tick();
  assert.match(text(s.app), /Unable to load Overview/);
  assert.match(text(s.app), /network unavailable/);
  assert.equal(s.timers.size, 0);
  const retry = find(s.app, n => n?.tag === 'button' && text(n) === 'Retry');
  assert.equal(typeof retry.onclick, 'function');
  await s.navigate('#toolbox');
  assert.equal(s.calls.at(-1), 'load:toolbox');
});

test('late page data, old errors and rerenders cannot replace the newest route or request', async () => {
  const pending = deferred();
  let count = 0;
  const s = await shell({ loads: { overview: () => ++count === 1 ? pending.promise : Promise.resolve({ value: 'newest' }) } });
  await s.controls.overview.reload();
  pending.resolve({ value: 'obsolete' });
  await tick();
  assert.equal(text(s.app).includes('newest'), true);
  assert.equal(s.renders.includes('obsolete'), false);
  await s.navigate('#radios');
  s.controls.overview.rerender();
  assert.equal(text(s.app).includes('radios'), true);
  const oldBoard = deferred();
  const t = await shell({ boards: [oldBoard] });
  await t.navigate('#radios');
  oldBoard.reject(new t.AuthError('old session'));
  await tick();
  assert.equal(text(t.app).includes('radios'), true);
});

test('a poll reply that arrives after the page became paused is dropped, an explicit reload is not', async () => {
  const slow = deferred();
  let count = 0;
  const s = await shell({ loads: { overview: () => ++count === 2 ? slow.promise : Promise.resolve({ value: `load ${count}` }) } });
  assert.equal(text(s.app).includes('load 1'), true);
  // The timer fires while nothing is being edited, and the router is slow to answer...
  [...s.timers.values()][0]();
  await tick();
  // ...the user clicks into the form meanwhile, so the page pauses; the late reply must not rebuild the form under them.
  s.paused.on = true;
  slow.resolve({ value: 'late poll' });
  await tick();
  assert.equal(text(s.app).includes('late poll'), false, 'a poll reply must not redraw a page the user started editing');
  assert.equal(text(s.app).includes('load 1'), true);
  // A reload the page asked for itself (a save, Refresh) is applied even while it is paused.
  await s.controls.overview.reload();
  assert.equal(text(s.app).includes('load 3'), true);
  // Unpaused again, the next timer poll refreshes it.
  s.paused.on = false;
  [...s.timers.values()][0]();
  await tick();
  assert.equal(text(s.app).includes('load 4'), true);
});

test('a page that gives its period as a function is polled with a timeout that schedules the next one', async () => {
  const s = await shell();
  await s.navigate('#interfaces');
  assert.equal(s.timers.size, 1, 'one poll timer');
  const loads = () => s.calls.filter(call => call === 'load:interfaces').length;
  const before = loads();
  [...s.timers.values()][0]();
  await tick();
  assert.equal(loads(), before + 1, 'the timer polls the page');
  assert.equal(s.timers.size, 2, 'and schedules the next poll');
  await s.navigate('#radios');
});

test('openTool still retains its target/autorun state across a lazy Toolbox import', async () => {
  let newDiag;
  const context = vm.createContext({ location: { hash: '#routing' }, document: {} });
  const module = new vm.SourceTextModule(await source('pages/toolbox/index.js'), { context });
  const make = async values => {
    const m = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
    await m.link(() => {});
    await m.evaluate();
    return m;
  };
  await module.link(specifier => make(specifier.endsWith('controls.js') ? { refreshControl: () => null } : {
    newDiag: () => (newDiag = { form: {}, job: 'old', formError: 'old error' }),
    loadDiag: () => ({}), diagView: () => [],
  }));
  await module.evaluate();
  module.namespace.openTool('ping', '192.0.2.1');
  assert.equal(context.location.hash, '#toolbox');
  assert.equal(newDiag.form.tool, 'ping');
  assert.equal(newDiag.form.host, '192.0.2.1');
  assert.equal(newDiag.autorun, true);
  assert.equal(newDiag.job, null);
});

test('the lightweight openTool bridge waits for current Toolbox navigation and keeps only the newest target', async () => {
  const pending = deferred();
  const s = await shell({ imports: { toolbox: pending } });
  s.openTool('ping', '192.0.2.1');
  assert.equal(s.context.location.hash, '#toolbox');
  assert.equal(s.calls.includes('import:toolbox'), false);
  const navigation = s.navigate('#toolbox');
  await tick();
  await s.navigate('#radios');
  pending.resolve();
  await navigation;
  assert.equal(s.calls.some(call => call.startsWith('tool:')), false, 'A stale import must not activate a deep link.');
  s.openTool('traceroute', '192.0.2.2');
  await s.navigate('#toolbox');
  assert.equal(s.calls.at(-2), 'tool:traceroute:192.0.2.2');
  assert.equal(s.calls.at(-1), 'load:toolbox');
});
