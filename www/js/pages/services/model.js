// Pure model of the Services page: merges the init scripts with procd's service list, decides which actions a row
// offers, which ones need a confirmation (and what to tell the user), and describes the outcome of a call.
// No DOM access, so it is unit-tested on its own.

// The actions a service can be given, and how they read in a button and in a sentence.
export const ACTIONS = ['start', 'stop', 'restart'];
export const LABELS = { start: 'Start', stop: 'Stop', restart: 'Restart' };
const PAST = { start: 'started', stop: 'stopped', restart: 'restarted' };
// The same while the call runs.
export const PROGRESS = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' };

// Services whose stop or restart can lock the user out or cut the connection, and what to tell the user first.
// `end: true` marks the calls that end the signed-in session (rpcd keeps the sessions in memory).
// level: 'danger' = can cut this page or the router's management access, 'warning' = interrupts a function.
const RISKS = {
  rpcd: {
    restart: { level: 'danger', end: true, text: 'rpcd is the service this page talks to. Restarting it signs everyone out, including you: the page returns to the sign-in screen and you must sign in again.' },
    stop: { level: 'danger', end: true, text: 'rpcd is the service this page talks to. Stopping it signs everyone out, and nobody can sign in again until it is started from a shell (ssh: /etc/init.d/rpcd start).' },
  },
  uhttpd: {
    restart: { level: 'danger', text: 'uhttpd is the web server that serves this page. Restarting it makes the page unavailable for a few seconds; reload it afterwards.' },
    stop: { level: 'danger', text: 'uhttpd is the web server that serves this page. Stopping it makes the page unreachable, and it cannot be started again from here: use a shell (ssh: /etc/init.d/uhttpd start).' },
  },
  network: {
    restart: { level: 'danger', text: 'Restarting the network takes every interface down and up again. The connection to this page and to ssh is interrupted until it is back, and may not come back if the configuration is wrong.' },
    stop: { level: 'danger', text: 'Stopping the network takes every interface down, including the one you are connected through. The router stays unreachable until it is started from the console or by a reboot.' },
  },
  dropbear: {
    restart: { level: 'warning', text: 'Restarting dropbear (the ssh server) refuses new ssh connections for a moment. Open sessions stay connected.' },
    stop: { level: 'danger', text: 'Stopping dropbear (the ssh server) refuses new ssh connections. It can be started again from here, but not from ssh.' },
  },
  firewall: {
    restart: { level: 'warning', text: 'Restarting the firewall reloads all rules. Connections through the router may be reset and traffic is briefly unfiltered.' },
    stop: { level: 'danger', text: 'Stopping the firewall removes all filtering and network address translation. Devices behind the router lose internet access and the router is unprotected until it is started again.' },
  },
  wpad: {
    restart: { level: 'warning', text: 'Restarting wpad restarts the Wi-Fi access points and mesh. Every wireless client is disconnected; if you are connected over Wi-Fi, this page is cut for a while.' },
    stop: { level: 'danger', text: 'Stopping wpad shuts down the Wi-Fi access points and mesh. If you are connected over Wi-Fi, you lose this page.' },
  },
  dnsmasq: {
    restart: { level: 'warning', text: 'Restarting dnsmasq interrupts DNS (and DHCPv4 when it serves it) for a moment.' },
    stop: { level: 'warning', text: 'Stopping dnsmasq stops DNS and, when it serves it, DHCPv4: devices cannot resolve names until it is started again.' },
  },
  odhcpd: {
    restart: { level: 'warning', text: 'Restarting odhcpd interrupts DHCPv6 and router advertisements for a moment.' },
    stop: { level: 'warning', text: 'Stopping odhcpd stops DHCPv6 and router advertisements: IPv6 clients cannot get addresses or routes until it is started again.' },
  },
  log: {
    restart: { level: 'warning', text: 'Restarting the log service empties the system log kept in memory.' },
    stop: { level: 'warning', text: 'Stopping the log service empties the system log kept in memory and stops logging.' },
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

// One row per init script, plus one per procd service that has no init script, sorted by name.
// state: 'running' (procd reports every instance running), 'idle' (procd knows it but nothing runs) or 'none'
// (procd does not list it: stopped, a one-shot service or one procd does not manage). `controllable` rows are the
// ones the buttons work on.
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

// The buttons a row offers: [{ action, disabled }] (none for a row the page cannot control). Start is disabled
// while procd reports the service running.
export function actionsFor(row) {
  if (!row.controllable) return [];
  return ACTIONS.map(action => ({ action, disabled: action === 'start' && row.state === 'running' }));
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
