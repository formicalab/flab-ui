// Shared description of the Dynamic DNS backend test: the command lines flab.ddns builds (fixtures are named after them, see
// rpcd/lib/flab/util.uc), the calls made against the fake router and the refusals that are expected. Used by mkfx.mjs
// (fixtures) and assert.mjs (checks).

// The fixture file name of a command: the command with every run of non-alphanumerics turned into "_".
export const slug = cmd => cmd.replace(/ 2>\/dev\/null$/, '').replace(/[^A-Za-z0-9]+/g, '_') + '.txt';

// The commands the plugin reads the router with.
export const CMD = {
  providers: String.raw`for f in /usr/share/ddns/default/*.json /usr/share/ddns/custom/*.json; do [ -f "$f" ] && { printf "%s\t" "$f"; tr -d "\n\t" < "$f"; echo; }; done 2>/dev/null`,
  scripts: 'ls -1 /usr/lib/ddns 2>/dev/null',
  devices: 'ls -1 /sys/class/net 2>/dev/null',
  tools: 'for t in curl wget uclient-fetch host; do command -v $t >/dev/null 2>&1 && echo $t; done',
  installed: '[ -x /usr/lib/ddns/dynamic_dns_updater.sh ] && echo 1',
  boot: 'ls -1 /etc/rc.d 2>/dev/null',
  ca: 'if [ -f /etc/ssl/certs/ca-certificates.crt ]; then echo /etc/ssl/certs/ca-certificates.crt; elif [ -d /etc/ssl/certs ]; then echo /etc/ssl/certs; fi',
  eth1v6: 'ip -o -6 addr show dev eth1 scope global 2>/dev/null',
  // The command a service whose device is named "-r" must NOT run (it would be read as an option).
  dashDevice: 'ip -o -4 addr show dev -r scope global 2>/dev/null',
};
// The commands that restart one service's updater, forget its last update, and collect what the init script printed.
export const forceCmd = name => `rm -f /var/run/ddns/${name}.update`;
// The command line that restarts the updater of service `name`.
export const restartCmd = name => `timeout 30 /etc/init.d/ddns stop ${name} </dev/null >/tmp/flab-ddns.out 2>&1; timeout 30 /etc/init.d/ddns start ${name} </dev/null >>/tmp/flab-ddns.out 2>&1; echo $?`;
export const OUTPUT_CMD = 'head -c 4096 /tmp/flab-ddns.out 2>/dev/null; rm -f /tmp/flab-ddns.out';

// The secrets of the fake router: they must never appear in any reply. The short one is below the length the plugin masks in
// log text (four characters), the others are masked there.
export const SECRETS = { password: 's3cr3t-pass', token: 'tok-9999-abc', proxy: 'proxypass', short: 'abc', v6password: 'pw-v6-1234' };

// The services of the fake router, in file order.
export const SERVICES = ['home', 'v6', 'custom', 'off', 'big', 'evil'];

// Calls that must restart the updater: [section, action].
export const RUN = [['home', 'check'], ['home', 'force'], ['v6', 'check'], ['custom', 'check']];
// Calls that must be refused, with the start of the error each one gets. Every one has a fixture that would report success if its
// command were run, so a refused call that ran anyway shows up as ok.
export const REFUSED = [
  ['nosuch', 'check', /no such service/], ['off', 'check', /service is disabled/], ['off', 'force', /service is disabled/], ['big', 'force', /service is disabled/],
  ['home; reboot', 'check', /name is not valid/], ['../../etc', 'check', /name is not valid/], ['a b', 'check', /name is not valid/], ['', 'check', /name is not valid/],
  ['home\nv6', 'check', /name is not valid/], ['x'.repeat(65), 'check', /name is not valid/], ['home-v6', 'check', /name is not valid/], ['$(id)', 'check', /name is not valid/], ['`id`', 'force', /name is not valid/],
  ['home', 'restart', /must be check or force/], ['home', 'stop', /must be check or force/], ['home', 'CHECK', /must be check or force/], ['home', 'check; reboot', /must be check or force/], ['home', '', /must be check or force/], ['home', 'start', /must be check or force/],
];
// Log requests that must be refused.
export const REFUSED_LOG = ['nosuch', '../../etc/passwd', 'home; reboot', '', 'x'.repeat(65), 'home\nv6', '$(id)'];

// Every call, as { id, method, args } for the harness.
export const CASES = [
  { id: 'status', method: 'status', args: {} },
  { id: 'status-args', method: 'status', args: { section: 'home; reboot', anything: 1 } },
  ...SERVICES.map(s => ({ id: `log:${s}`, method: 'log', args: { section: s } })),
  ...REFUSED_LOG.map(s => ({ id: `refusedlog:${s}`, method: 'log', args: { section: s } })),
  { id: 'refusedlog:no-args', method: 'log', args: {} },
  { id: 'refusedlog:number', method: 'log', args: { section: 5 } },
  { id: 'refusedlog:list', method: 'log', args: { section: ['home'] } },
  ...RUN.map(([section, action]) => ({ id: `run:${section}:${action}`, method: 'control', args: { section, action } })),
  ...REFUSED.map(([section, action]) => ({ id: `refused:${section}:${action}`, method: 'control', args: { section, action } })),
  { id: 'refused:no-args', method: 'control', args: {} },
  { id: 'refused:number', method: 'control', args: { section: 5, action: 'check' } },
  { id: 'refused:list', method: 'control', args: { section: ['home'], action: 'check' } },
  { id: 'refused:object-action', method: 'control', args: { section: 'home', action: { a: 1 } } },
  { id: 'refused:no-action', method: 'control', args: { section: 'home' } },
];
