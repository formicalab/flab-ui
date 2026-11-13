// Pure model of the Services page: merges the init scripts with procd's service list, decides which actions a row
// offers, which ones need a confirmation (and what to tell the user), and describes the outcome of a call.
// No DOM access, so it is unit-tested on its own.

// The actions a service can be given, and how they read in a button and in a sentence. enable and disable change whether
// the service starts at boot; they do not start or stop it.
export const ACTIONS = ['start', 'stop', 'restart', 'enable', 'disable'];
export const LABELS = { start: 'Start', stop: 'Stop', restart: 'Restart', enable: 'Enable', disable: 'Disable' };
const PAST = { start: 'started', stop: 'stopped', restart: 'restarted', enable: 'enabled at boot', disable: 'disabled at boot' };
// The same while the call runs.
export const PROGRESS = { start: 'Starting', stop: 'Stopping', restart: 'Restarting', enable: 'Enabling', disable: 'Disabling' };

// Services whose stop, restart or disabling at boot can lock the user out or cut the connection, and what to tell the user first.
// `end: true` marks the calls that end the signed-in session (rpcd keeps the sessions in memory).
// level: 'danger' = can cut this page or the router's management access, 'warning' = interrupts a function.
const RISKS = {
  rpcd: {
    restart: { level: 'danger', end: true, text: 'rpcd is the service this page talks to. Restarting it signs everyone out, including you: the page returns to the sign-in screen and you must sign in again.' },
    stop: { level: 'danger', end: true, text: 'rpcd is the service this page talks to. Stopping it signs everyone out, and nobody can sign in again until it is started from a shell (ssh: /etc/init.d/rpcd start).' },
    disable: { level: 'danger', text: 'rpcd is the service this page talks to. If it does not start at boot, nobody can sign in to this page after the next restart of the router until it is enabled again from a shell (ssh: /etc/init.d/rpcd enable).' },
  },
  uhttpd: {
    restart: { level: 'danger', text: 'uhttpd is the web server that serves this page. Restarting it makes the page unavailable for a few seconds; reload it afterwards.' },
    stop: { level: 'danger', text: 'uhttpd is the web server that serves this page. Stopping it makes the page unreachable, and it cannot be started again from here: use a shell (ssh: /etc/init.d/uhttpd start).' },
    disable: { level: 'danger', text: 'uhttpd is the web server that serves this page. If it does not start at boot, this page is gone after the next restart of the router until it is enabled again from a shell (ssh: /etc/init.d/uhttpd enable).' },
  },
  network: {
    restart: { level: 'danger', text: 'Restarting the network takes every interface down and up again. The connection to this page and to ssh is interrupted until it is back, and may not come back if the configuration is wrong.' },
    stop: { level: 'danger', text: 'Stopping the network takes every interface down, including the one you are connected through. The router stays unreachable until it is started from the console or by a reboot.' },
    disable: { level: 'danger', text: 'If the network does not start at boot, the router comes up with no interfaces configured after its next restart and is unreachable until it is enabled again from the console.' },
  },
  dropbear: {
    restart: { level: 'warning', text: 'Restarting dropbear (the ssh server) refuses new ssh connections for a moment. Open sessions stay connected.' },
    stop: { level: 'danger', text: 'Stopping dropbear (the ssh server) refuses new ssh connections. It can be started again from here, but not from ssh.' },
    disable: { level: 'warning', text: 'If dropbear (the ssh server) does not start at boot, ssh stops working after the next restart of the router until it is enabled again from here.' },
  },
  firewall: {
    restart: { level: 'warning', text: 'Restarting the firewall reloads all rules. Connections through the router may be reset and traffic is briefly unfiltered.' },
    stop: { level: 'danger', text: 'Stopping the firewall removes all filtering and network address translation. Devices behind the router lose internet access and the router is unprotected until it is started again.' },
    disable: { level: 'danger', text: 'If the firewall does not start at boot, the router comes up without filtering or network address translation after its next restart: devices lose internet access and the router is unprotected.' },
  },
  wpad: {
    restart: { level: 'warning', text: 'Restarting wpad restarts the Wi-Fi access points and mesh. Every wireless client is disconnected; if you are connected over Wi-Fi, this page is cut for a while.' },
    stop: { level: 'danger', text: 'Stopping wpad shuts down the Wi-Fi access points and mesh. If you are connected over Wi-Fi, you lose this page.' },
    disable: { level: 'warning', text: 'If wpad does not start at boot, the Wi-Fi access points and the mesh stay off after the next restart of the router.' },
  },
  dnsmasq: {
    restart: { level: 'warning', text: 'Restarting dnsmasq interrupts DNS (and DHCPv4 when it serves it) for a moment.' },
    stop: { level: 'warning', text: 'Stopping dnsmasq stops DNS and, when it serves it, DHCPv4: devices cannot resolve names until it is started again.' },
    disable: { level: 'warning', text: 'If dnsmasq does not start at boot, there is no DNS and, when it serves it, no DHCPv4 after the next restart of the router.' },
  },
  odhcpd: {
    restart: { level: 'warning', text: 'Restarting odhcpd interrupts DHCPv6 and router advertisements for a moment.' },
    stop: { level: 'warning', text: 'Stopping odhcpd stops DHCPv6 and router advertisements: IPv6 clients cannot get addresses or routes until it is started again.' },
    disable: { level: 'warning', text: 'If odhcpd does not start at boot, there is no DHCPv6 or router advertisement after the next restart of the router: IPv6 clients cannot get addresses or routes.' },
  },
  log: {
    restart: { level: 'warning', text: 'Restarting the log service empties the system log kept in memory.' },
    stop: { level: 'warning', text: 'Stopping the log service empties the system log kept in memory and stops logging.' },
    disable: { level: 'warning', text: 'If the log service does not start at boot, nothing is logged after the next restart of the router.' },
  },
};

// The warning to show before `action` runs on `name`: { level, end, title, text }, or null when it needs none.
export function riskOf(name, action) {
  const r = RISKS[name]?.[action];
  return r ? { level: r.level, end: Boolean(r.end), title: `${LABELS[action]} ${name}?`, text: r.text } : null;
}

// procd's `service list` reply as { name: { running, pids } }. A service is running when it has instances and all
// of them run; an entry without instances (a one-shot service) is known to procd but not running.
export function readProcd(svc) {
  const out = {};
  for (const [name, s] of Object.entries(svc ?? {})) {
    const inst = Object.values(s?.instances ?? {});
    out[name] = { running: inst.length > 0 && inst.every(i => i.running), pids: inst.map(i => i.pid).filter(Boolean) };
  }
  return out;
}

// The listening sockets that belong to the processes `pids`, as one entry per protocol and port:
// [{ proto, port, addresses, scope }], TCP before UDP and by port. `scope` is 'all' when it listens on a wildcard address,
// 'local' when only on loopback and 'some' for specific addresses. `sockets` is the `listening` array of flab.services list.
export function portsOf(sockets, pids) {
  const groups = new Map();
  for (const s of sockets ?? []) {
    if (!pids.includes(s.pid)) continue;
    const key = `${s.proto}/${s.port}`;
    const g = groups.get(key) ?? { proto: s.proto, port: s.port, addresses: [] };
    if (!g.addresses.includes(s.address)) g.addresses.push(s.address);
    groups.set(key, g);
  }
  const loopback = a => /^127\./.test(a) || a === '::1';
  return [...groups.values()].map(g => ({ ...g, scope: g.addresses.some(a => a === '0.0.0.0' || a === '::') ? 'all' : g.addresses.every(loopback) ? 'local' : 'some' }))
    .sort((a, b) => (a.proto === b.proto ? 0 : a.proto === 'tcp' ? -1 : 1) || a.port - b.port);
}

// One row per init script, plus one per procd service that has no init script, sorted by name.
// state: 'running' (procd reports every instance running), 'idle' (procd knows it but nothing runs) or 'none'
// (procd does not list it: stopped, a one-shot service or one procd does not manage). `controllable` rows are the
// ones the buttons work on. `ports` are the sockets the service's processes listen on (see portsOf).
export function buildRows(list, procd) {
  const scripts = new Map((list?.services ?? []).map(s => [s.name, s]));
  const names = new Set([...scripts.keys(), ...Object.keys(procd ?? {})]);
  return [...names].sort().map(name => {
    const script = scripts.get(name);
    const p = procd?.[name];
    return {
      name,
      installed: Boolean(script),
      enabled: script ? script.enabled : null,
      start: script?.start ?? null,
      protected: Boolean(script?.protected),
      controllable: Boolean(script) && !script.protected,
      state: p ? (p.running ? 'running' : 'idle') : 'none',
      pids: p?.pids ?? [],
      ports: portsOf(list?.listening, p?.pids ?? []),
    };
  });
}

// Rows whose name contains every word of the filter text (case-insensitive).
export function filterRows(rows, text) {
  const words = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(r => words.every(w => r.name.toLowerCase().includes(w)));
}

// Counts for the summary tiles: running, not running, installed init scripts and those that start at boot.
export function summarize(rows) {
  const scripts = rows.filter(r => r.installed);
  return {
    running: rows.filter(r => r.state === 'running').length,
    notRunning: rows.filter(r => r.state !== 'running').length,
    scripts: scripts.length,
    enabled: scripts.filter(r => r.enabled).length,
  };
}

// The buttons a row offers: [{ action, disabled }] (none for a row the page cannot control): Start, Stop and Restart, then
// the one that changes the boot setting, Disable for a service that starts at boot and Enable for one that does not. Start
// is disabled while procd reports the service running.
export function actionsFor(row) {
  if (!row.controllable) return [];
  return [...['start', 'stop', 'restart'].map(action => ({ action, disabled: action === 'start' && row.state === 'running' })),
    { action: row.enabled ? 'disable' : 'enable', disabled: false }];
}

// Describes the reply of flab.services control (or the error that replaced it) for display:
// { kind: 'ok' | 'bad' | 'info', text, output, end }. `end` is true when the call ends the signed-in session.
export function describeOutcome(name, action, reply, error) {
  const risk = riskOf(name, action);
  if (error) return { kind: 'bad', text: `${LABELS[action]} ${name} failed: ${error}`, output: '', end: false };
  if (reply?.detached) {
    return {
      kind: 'info',
      text: `${LABELS[action]} ${name} was requested. It runs in the background, so its result is not reported; the list refreshes in a moment.`
        + (risk?.end ? ' This ends your session: sign in again when the page asks.' : ''),
      output: '',
      end: Boolean(risk?.end),
    };
  }
  if (reply?.ok) return { kind: 'ok', text: `${name} ${PAST[action]}.`, output: reply.output ?? '', end: false };
  return { kind: 'bad', text: `${LABELS[action]} ${name} failed: ${reply?.error ?? 'no reason was given'}`, output: reply?.output ?? '', end: false };
}
