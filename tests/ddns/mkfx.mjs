// Builds the fixtures of the Dynamic DNS backend test. Every scenario is a directory with the file names flab.ddns reads when
// FLAB_FIXTURES is set (see rpcd/lib/flab/util.uc), so the plugin never runs a command: it only finds, in the fixture folder,
// what the command would have printed. Also writes cases.json for harness.uc.
// The `main` scenario is a router with five services: `home` (a network as the address source, a secret in several places, an
// option the page does not know), `v6` (IPv6 from a device, with an error in its log that mentions a secret), `custom` (a custom
// provider that reads the address from a web page and has stopped), `off` (disabled) and `big` (disabled, with a log over the
// size limit). The others differ in what an init script does when a service is restarted: fail (exit 1), timeout (exit 124),
// noresult (no exit code at all), and `empty` is a router without ddns-scripts.
// Usage: node mkfx.mjs <output dir>
import fs from 'node:fs';
import path from 'node:path';
import { CASES, CMD, OUTPUT_CMD, SECRETS, forceCmd, restartCmd, slug } from './cases.mjs';

const root = process.argv[2];

// The uptime of the fake router, in seconds, and the stamps its run files hold.
const UPTIME = 5000;

// A uci section in the form the uci module returns it.
const sec = (type, name, index, values) => ({ '.anonymous': false, '.type': type, '.name': name, '.index': index, ...values });

// The ddns config of the main scenario.
const DDNS = {
  global: sec('ddns', 'global', 0, { ddns_dateformat: '%F %R', ddns_loglines: '250', ddns_rundir: '/var/run/ddns', ddns_logdir: '/var/log/ddns' }),
  home: sec('service', 'home', 1, {
    service_name: 'dyn.example', enabled: '1', lookup_host: 'home.example.com', domain: 'home.example.com', username: 'me', password: SECRETS.password, api_token: SECRETS.token,
    proxy: `proxyuser:${SECRETS.proxy}@proxy.example.com:3128`, use_ipv6: '0', ip_source: 'network', ip_network: 'wan', interface: 'wan', check_interval: '1', odd_option: 'x',
  }),
  v6: sec('service', 'v6', 2, {
    service_name: 'duckdns.example', enabled: '1', lookup_host: 'v6.example.com', domain: 'v6', password: SECRETS.v6password, use_ipv6: '1', ip_source: 'interface', ip_interface: 'eth1', interface: 'wan6',
  }),
  custom: sec('service', 'custom', 3, { enabled: '1', update_url: 'http://u.example.com/?h=[DOMAIN]&p=[PASSWORD]', ip_source: 'web', ip_url: 'http://ip.example.com', lookup_host: 'c.example.com', domain: 'c.example.com', password: SECRETS.short, use_https: '1' }),
  off: sec('service', 'off', 4, { enabled: '0', service_name: 'old.example', lookup_host: 'off.example.com' }),
  big: sec('service', 'big', 5, { enabled: '0', service_name: 'old.example', lookup_host: 'big.example.com' }),
  evil: sec('service', 'evil', 6, { enabled: '0', ip_source: 'interface', ip_interface: '-r', lookup_host: 'evil.example.com' }),
};

// The network config: logical interfaces (loopback is left out by the plugin) and a section of another type with a secret.
const NETWORK = {
  loopback: sec('interface', 'loopback', 0, { device: 'lo' }),
  lan: sec('interface', 'lan', 1, {}), wan: sec('interface', 'wan', 2, {}), wan6: sec('interface', 'wan6', 3, {}), guest: sec('interface', 'guest', 4, {}),
  wg0: sec('interface', 'wg0', 5, { private_key: 'do-not-read' }),
  dev: sec('device', 'dev', 6, { name: 'br-lan' }),
};

// procd's list of the ddns instances: home and v6 run, custom has stopped.
const PROCD = { ddns: { instances: { home: { running: true, pid: 4000 }, v6: { running: true, pid: 4001 } } } };
// netifd's dump: wan has an IPv4 address and a link-local plus a global IPv6 one; loopback has addresses that are not used.
const DUMP = { interface: [
  { interface: 'loopback', up: true, 'ipv4-address': [{ address: '127.0.0.1', mask: 8 }] },
  { interface: 'lan', up: true, 'ipv4-address': [{ address: '192.168.1.1', mask: 24 }] },
  { interface: 'wan', up: true, 'ipv4-address': [{ address: '203.0.113.7', mask: 24 }], 'ipv6-address': [{ address: 'fe80::1', mask: 64 }, { address: '2001:db8::7', mask: 64 }] },
  { interface: 'wan6', up: true },
] };

// A line of a ddns-scripts log: " HHMMSS LEVEL : text" (the level column is blank for debug lines).
const line = (time, level, text) => ` ${time} ${level.padStart(5)} : ${text}`;

// The files of the main scenario (path to contents), as files.json.
function files() {
  const big = Array.from({ length: 2500 }, (_, i) => line('200000', '', `filler line number ${i}`)).join('\n') + '\n';
  return {
    '/proc/uptime': `${UPTIME}.12 1000.00\n`,
    '/usr/share/ddns/version': '2.8.4-12\n',
    '/var/run/ddns/home.ip': '203.0.113.7\n', '/var/run/ddns/home.update': '4400\n', '/var/run/ddns/home.nextcheck': '5040\n', '/var/run/ddns/home.err': '',
    '/var/log/ddns/home.log': [
      line('203000', '', "Registered IP '203.0.113.7' detected"),
      line('203001', 'WARN', 'Transfer failed - retry 1/0 in 30 seconds'),
      line('203002', '', "Registered IP '203.0.113.7' detected"),
      line('203003', '', "Current IP '203.0.113.7' detected on network 'wan'"),
      line('203003', '', 'Detected IP: 203.0.113.7'),
      line('203004', 'info', 'Rerun IP check at 2026-11-13 20:30'),
    ].join('\n') + '\n',
    '/var/run/ddns/v6.ip': '2001:db8::4\n', '/var/run/ddns/v6.update': '4000\n', '/var/run/ddns/v6.nextcheck': '5100\n', '/var/run/ddns/v6.err': `curl: (22) The requested URL returned error: 403 for ${SECRETS.v6password}\n`,
    '/var/log/ddns/v6.log': [
      line('203000', '', "Registered IP '2001:db8::4' detected"),
      line('203001', 'ERROR', `IP update not accepted by DDNS Provider: bad credentials ${SECRETS.v6password} for ${SECRETS.short}`),
      line('203002', '', 'Waiting 60 seconds (Check Interval); Next check at 2026-11-13 20:31'),
    ].join('\n') + '\n',
    '/var/run/ddns/custom.ip': '', '/var/run/ddns/custom.update': '9999\n',
    '/var/log/ddns/custom.log': [
      line('203040', '', 'Detected IP: 198.51.100.9'),
      line('203050', 'ERROR', "No valid certificate(s) found at '/x' for HTTPS communication - TERMINATE"),
    ].join('\n') + '\n',
    '/var/log/ddns/big.log': big,
  };
}

// The providers as the command prints them: the path, a tab and the file compacted to one line. A provider of the user's own
// replaces the one of the same name, a line without a tab and one that is not JSON are ignored.
const PROVIDER_LINES = [
  ['/usr/share/ddns/default/dyn.example.json', { name: 'dyn.example', ipv4: { url: 'http://[USERNAME]:[PASSWORD]@members.example/update?hostname=[DOMAIN]&myip=[IP]', answer: 'good' }, ipv6: { url: 'http://[USERNAME]:[PASSWORD]@members.example/update?hostname=[DOMAIN]&myip=[IP]', answer: 'good' } }],
  ['/usr/share/ddns/default/duckdns.example.json', { name: 'duckdns.example', ipv4: { url: 'http://duck.example/update?domains=[DOMAIN]&token=[PASSWORD]&ip=[IP]' }, ipv6: { url: 'http://duck.example/update?domains=[DOMAIN]&token=[PASSWORD]&ipv6=[IP]' } }],
  ['/usr/share/ddns/default/old.example.json', { name: 'old.example', ipv4: { url: 'http://old.example/update?host=[DOMAIN]&user=[USERNAME]&pass=[PASSWORD]&param=[PARAMOPT]' } }],
  ['/usr/share/ddns/default/cloud.example-v4.json', { name: 'cloud.example-v4', ipv4: { url: 'update_cloud_example_v4.sh' }, ipv6: { url: 'update_cloud_example_v4.sh' } }],
  ['/usr/share/ddns/default/missing.example.json', { name: 'missing.example', ipv4: { url: 'update_missing_example.sh' } }],
  ['/usr/share/ddns/custom/dyn.example.json', { name: 'dyn.example', ipv4: { url: 'http://mine.example/update?h=[DOMAIN]' } }],
];

// What the init script prints and returns in each scenario.
const SCENARIOS = {
  main: { code: '0\n', output: 'Restarting ddns\n', config: true },
  fail: { code: '1\n', output: 'Failed to start: bad config\n', config: true },
  timeout: { code: '124\n', output: '', config: true },
  noresult: { code: '', output: '', config: true },
  empty: { code: '0\n', output: '', config: false },
};

// Writes one scenario.
function scenario(name, { code, output, config }) {
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Writes `text` as the fixture of command `cmd`.
  const put = (cmd, text) => fs.writeFileSync(path.join(dir, slug(cmd)), text);
  // Writes `value` as the fixture file `file`.
  const putJson = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  if (!config) { putJson('uci_ddns.json', { values: {} }); fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify({ '/proc/uptime': `${UPTIME}.12 1000.00\n` })); return; }
  putJson('uci_ddns.json', { values: DDNS });
  putJson('uci_network.json', { values: NETWORK });
  putJson('service_list.json', PROCD);
  putJson('network_interface_dump.json', DUMP);
  putJson('files.json', files());
  put(CMD.providers, PROVIDER_LINES.map(([p, o]) => `${p}\t${JSON.stringify(o)}`).join('\n') + '\nno tab on this line\n/usr/share/ddns/default/bad.json\t{not json\n');
  put(CMD.scripts, 'dynamic_dns_functions.sh\ndynamic_dns_updater.sh\nupdate_cloud_example_v4.sh\n');
  put(CMD.devices, 'br-lan\neth0\neth1\nlo\nbad name\n-x\nwan\n');
  put(CMD.tools, 'curl\nuclient-fetch\n');
  put(CMD.installed, '1\n');
  put(CMD.boot, 'K10ddns\nS19dnsmasq\nS95ddns\n');
  put(CMD.ca, '/etc/ssl/certs/ca-certificates.crt\n');
  put(CMD.dashDevice, '2: -r    inet 198.51.100.77/24 scope global\n');
  put(CMD.eth1v6, '3: eth1    inet6 2001:db8::5/64 scope global \\       valid_lft forever preferred_lft forever\n');
  put(OUTPUT_CMD, output);
  // A result for the command line of every call in CASES (valid or not), so a refused call that was run anyway would be
  // answered and shows up in the checks.
  for (const c of CASES) {
    // A name that makes a file name too long for a file system has no fixture; it is refused before any command anyway.
    if (typeof c.args.section === 'string' && slug(restartCmd(c.args.section)).length < 200) { put(restartCmd(c.args.section), code); put(forceCmd(c.args.section), ''); }
  }
}

fs.mkdirSync(root, { recursive: true });
for (const [name, spec] of Object.entries(SCENARIOS)) scenario(name, spec);
fs.writeFileSync(path.join(root, 'cases.json'), JSON.stringify(CASES));
