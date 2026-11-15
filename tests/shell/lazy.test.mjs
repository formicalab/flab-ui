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

async function shell({ signedIn = true, imports = {}, loads = {}, boards = [] } = {}) {
  const events = {}, calls = [], styles = [], timers = new Map(), renders = [], controls = {};
  const element = (tag, props = {}, ...children) => ({
    tag, ...props, children: children.flat().filter(c => c != null),
    replaceChildren(...next) { this.children = next; },
  });
  const app = element('div');
  let timer = 0, onLogin;
  class AuthError extends Error {}
  const context = vm.createContext({
    location: { hash: '#overview', replace(hash) { this.hash = hash; }, hostname: 'test' },
    document: { hidden: false, head: { append: node => styles.push(node) }, addEventListener: (name, fn) => { events[name] = fn; } },
    addEventListener: (name, fn) => { events[name] = fn; },
    setInterval: fn => { timers.set(++timer, fn); return timer; },
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
      return synthetic({ openTool: (tool, host) => calls.push(`tool:${tool}:${host}`), default: {
        id, label: id, interval: 1000, css: `css/${id}.css`,
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
      ubus: () => boards.shift()?.promise ?? Promise.resolve({ hostname: 'test', model: 'image' }),
      logout: async () => { signedIn = false; }, clearSession: () => { signedIn = false; },
    }),
    './login.js': await synthetic({ showLogin: callback => { onLogin = callback; app.replaceChildren('LOGIN'); } }),
    './freshness.js': await synthetic({ ensureCurrent: async () => false }),
    './ui.js': await synthetic({ card: (_, child) => child }),
    '../pages/index.js': registry,
  };
  const module = new vm.SourceTextModule(await source('core/app.js'), { context });
  await module.link(specifier => deps[specifier]);
  await module.evaluate();
  module.namespace.start();
  await tick();
  return {
    app, calls, renders, styles, timers, controls, AuthError, context, openTool: registry.namespace.openTool,
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
  assert.equal(links.map(n => n.href).join(','), '#overview,#network,#wifi,#mesh,#ipsec,#wireguard,#firewall,#dhcp,#dns,#ddns,#interfaces,#routing,#traffic,#services,#toolbox,#logs,#settings');
  assert.equal(links.at(-1).children.at(-1), 'System settings');
});

test('aliases invalidate the old route; unknown routes retain the default page', async () => {
  const s = await shell();
  await s.navigate('#bridges');
  assert.equal(s.context.location.hash, '#interfaces');
  assert.equal(s.timers.size, 0);
  await s.navigate('#interfaces');
  assert.equal(s.calls.at(-1), 'load:interfaces');
  await s.navigate('#missing');
  assert.equal(s.calls.at(-1), 'load:overview');
});

test('a late import cannot install controls, CSS or polling after navigation or login', async () => {
  const pending = deferred();
  const s = await shell({ imports: { overview: pending } });
  await s.navigate('#wifi');
  pending.resolve();
  await tick();
  assert.equal(text(s.app).includes('wifi'), true);
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
  await s.navigate('#wifi');
  s.controls.overview.rerender();
  assert.equal(text(s.app).includes('wifi'), true);
  const oldBoard = deferred();
  const t = await shell({ boards: [oldBoard] });
  await t.navigate('#wifi');
  oldBoard.reject(new t.AuthError('old session'));
  await tick();
  assert.equal(text(t.app).includes('wifi'), true);
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
  await s.navigate('#wifi');
  pending.resolve();
  await navigation;
  assert.equal(s.calls.some(call => call.startsWith('tool:')), false, 'A stale import must not activate a deep link.');
  s.openTool('traceroute', '192.0.2.2');
  await s.navigate('#toolbox');
  assert.equal(s.calls.at(-2), 'tool:traceroute:192.0.2.2');
  assert.equal(s.calls.at(-1), 'load:toolbox');
});
