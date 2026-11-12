// Builds the fixture directories of the DNS suite.
// Usage: node mkfx.mjs <work dir, optionally containing fx-real/>
// Writes <work>/<scenario>/ with the files the flab.dns plugin reads (see FLAB_FIXTURES in rpcd/lib/flab/util.uc:
// files.json for procfs and /tmp files, <command>.txt for command output, <object>_<method>.json for ubus calls,
// uci_<config>.json for UCI), <work>/cases.txt (name, scenario and method of every plugin call to run), <work>/cases/<name>.json
// (the arguments of a call), <work>/facts.json (the numbers the assertions compare with, derived from the same constants
// as the fixtures) and <work>/scenarios.json. The synthetic scenarios are hand-built from what the engines print:
//   unbound           Unbound 1.26 with extended statistics, ninety forward zones (two with the +i flag), a WAN resolver
//   unbound-basic     Unbound as the main router runs it: extended statistics off, a few forwarders
//   unbound-nocontrol Unbound is running but unbound-control fails (no socket)
//   unbound-many      520 forward zones and 60 listening sockets: the lists are cut
//   dnsmasq           dnsmasq 2.93 as the GL-X3000 runs it: ubus metrics, a server list, no DNSSEC in the build
//   both              Unbound on port 53 with dnsmasq on port 5353 behind it
//   stopped           both engines installed, neither running
//   none              no resolver at all
//   real              what the router under test reports (captured read-only), used for invariants only
import fs from 'node:fs';
import path from 'node:path';

const work = process.argv[2];
// File name of a command's fixture, as util.uc derives it: runs of non-alphanumerics become "_".
const slug = cmd => cmd.replace(/[^A-Za-z0-9]+/g, '_') + '.txt';

//#region Text builders

// One line of `netstat -lntup`: the way busybox lays it out (UDP has no state column).
function sock(proto, addr, port, program) {
  const local = `${addr}:${port}`.padEnd(23);
  const foreign = (addr.includes(':') ? ':::*' : '0.0.0.0:*').padEnd(23);
  return `${proto.padEnd(10)} 0      0 ${local} ${foreign} ${proto === 'tcp' ? 'LISTEN      ' : '            '}${program}`;
}
const NETSTAT_HEAD = 'Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name\n';
// The sockets every router has next to the resolver (web server, ssh, DHCP, a daemon with no name).
const OTHER_SOCKS = [sock('tcp', '0.0.0.0', 443, '2703/uhttpd'), sock('tcp', '0.0.0.0', 22, '2111/dropbear'), sock('tcp', '0.0.0.0', 80, '2703/uhttpd'), sock('udp', '0.0.0.0', 51820, '-'), sock('udp', '0.0.0.0', 500, '7013/charon')];
// A netstat text from socket lines.
const netstat = (...lines) => NETSTAT_HEAD + [...lines.flat(), ...OTHER_SOCKS].join('\n') + '\n';

// The /proc/<pid>/stat line of a process: the command in parentheses, the state and the fields up to starttime (22nd).
function procStat(pid, comm, start) {
  return `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 4194560 3321 0 12 0 410 190 0 0 20 0 3 0 ${start} 41230336 2315 18446744073709551615 1 1 0 0 0 0 0 4096 1088 0 0 0 17 0 0 0 0 0 0\n`;
}

// The statistics of Unbound (`unbound-control stats_noreset`) for two threads that add up to `t`. `extended` adds the
// answer codes, DNSSEC, cache and unwanted counters that only extended-statistics prints.
function unboundStats(t, extended) {
  const split = (n, share) => Math.round(n * share);
  const thread = (i, share) => {
    const q = split(t.queries, share), hit = split(t.hits, share), miss = q - hit;
    return [`thread${i}.num.queries=${q}`, `thread${i}.num.queries_ip_ratelimited=${split(t.ratelimited, share)}`, `thread${i}.num.cachehits=${hit}`, `thread${i}.num.cachemiss=${miss}`,
      `thread${i}.num.prefetch=${split(t.prefetch, share)}`, `thread${i}.num.queries_timed_out=${split(t.timedOut, share)}`, `thread${i}.num.expired=${split(t.expired, share)}`,
      `thread${i}.num.recursivereplies=${miss}`, `thread${i}.requestlist.avg=0.993207`, `thread${i}.requestlist.max=14`, `thread${i}.recursion.time.avg=0.046309`, `thread${i}.recursion.time.median=0.0308049`, `thread${i}.tcpusage=0`];
  };
  const lines = [...thread(0, 0.55), ...thread(1, 0.45)];
  const miss = t.queries - t.hits;
  lines.push(`total.num.queries=${t.queries}`, 'total.num.queries_ip_ratelimited=' + t.ratelimited, 'total.num.queries_cookie_valid=0', `total.num.cachehits=${t.hits}`, `total.num.cachemiss=${miss}`,
    `total.num.prefetch=${t.prefetch}`, `total.num.queries_timed_out=${t.timedOut}`, 'total.query.queue_time_us.max=0', `total.num.expired=${t.expired}`, `total.num.recursivereplies=${miss}`,
    'total.requestlist.avg=0.957521', 'total.requestlist.max=14', 'total.requestlist.current.all=0', `total.recursion.time.avg=${t.avg}`, `total.recursion.time.median=${t.median}`, 'total.tcpusage=0');
  lines.push('time.now=1794475113.184176', `time.up=${t.up}`, 'time.elapsed=273600.119');
  if (extended) {
    lines.push('histogram.000000.000000.to.000000.000001=12', 'histogram.000000.000001.to.000000.000002=4',
      'num.query.type.A=30112', 'num.query.type.AAAA=16200', 'num.query.type.PTR=1898', 'num.query.class.IN=48210', 'num.query.opcode.QUERY=48210',
      'num.query.tcp=210', 'num.query.tcpout=88', 'num.query.udpout=17000', 'num.query.tls=0', 'num.query.ipv6=11000', 'num.query.flags.RD=48210',
      'num.answer.rcode.NOERROR=' + t.rcodes.NOERROR, 'num.answer.rcode.SERVFAIL=' + t.rcodes.SERVFAIL, 'num.answer.rcode.NXDOMAIN=' + t.rcodes.NXDOMAIN, 'num.answer.rcode.REFUSED=' + t.rcodes.REFUSED, 'num.answer.rcode.nodata=2100',
      'num.answer.secure=' + t.secure, 'num.answer.bogus=' + t.bogus, `unwanted.queries=${t.unwantedQueries}`, `unwanted.replies=${t.unwantedReplies}`,
      `mem.cache.rrset=${t.memRrset}`, `mem.cache.message=${t.memMessage}`, 'mem.mod.iterator=16588', 'mem.mod.validator=75316', `msg.cache.count=${t.msgs}`, `rrset.cache.count=${t.rrsets}`, 'infra.cache.count=420', 'key.cache.count=96');
  }
  return lines.join('\n') + '\n';
}

// The `unbound-control status` text.
const unboundStatus = (pid, up, validator = true) => `version: 1.26.2\nverbosity: 1\nthreads: 2\nmodules: ${validator ? '3 [ respip validator iterator ]' : '2 [ respip iterator ]'}\nuptime: ${up} seconds\noptions: reuseport control\nunbound (pid ${pid}) is running...\n`;

// The Azure private-link zones the forwarding card has to cope with: 43 services, each also under "privatelink." (86 zones).
const SERVICES = ['azmk8s.io', 'azurecr.io', 'azconfig.io', 'azurecontainerapps.io', 'api.azureml.ms', 'instances.azureml.ms', 'services.ai.azure.com', 'openai.azure.com', 'monitor.azure.com',
  'vault.azure.net', 'vaultcore.azure.net', 'blob.core.windows.net', 'file.core.windows.net', 'queue.core.windows.net', 'table.core.windows.net', 'dfs.core.windows.net', 'web.core.windows.net',
  'database.windows.net', 'servicebus.windows.net', 'search.windows.net', 'kusto.windows.net', 'azurewebsites.net', 'azuredatabricks.net', 'azure-devices.net', 'azure-api.net', 'documents.azure.com',
  'mongo.cosmos.azure.com', 'table.cosmos.azure.com', 'postgres.database.azure.com', 'mysql.database.azure.com', 'mariadb.database.azure.com', 'redis.cache.windows.net', 'eventgrid.azure.net',
  'datafactory.azure.net', 'adf.azure.com', 'batch.azure.com', 'grafana.azure.com', 'purview.azure.com', 'cognitiveservices.azure.com', 'guestconfiguration.azure.com', 'his.arc.azure.com',
  'backup.windowsazure.com', 'siterecovery.windowsazure.com'];
const AZURE_ZONES = [...SERVICES, ...SERVICES.map(s => `privatelink.${s}`)];
const AZURE_SERVERS = ['10.0.252.68', '10.1.252.68'];
const CLOUDFLARE = ['2a06:98c1:54::1c:8e39', '2606:4700:4700::1111', '1.1.1.1', '1.0.0.1'];
const VODAFONE = ['91.80.35.167', '91.80.35.134'];

// `unbound-control list_forwards` for a set of zones: the default forwarders first, then one line per zone. Flags such as
// "+i" (DNSSEC not validated) come before the servers.
function forwardsText(extra = []) {
  const lines = [`. IN forward ${CLOUDFLARE.join(' ')}`];
  for (const z of AZURE_ZONES) lines.push(`${z}. IN forward ${AZURE_SERVERS.join(' ')}`);
  lines.push('proxy.dsl.vodafone.it. IN forward ' + VODAFONE.join(' '), `lab.formicalab.casa. IN forward +i ${AZURE_SERVERS.join(' ')}`, 'flumini.formicalab.casa. IN forward +i 192.168.8.1', ...extra);
  return lines.join('\n') + '\n';
}

// The forward-zone clauses UCI generated (unbound.conf: the default zone over TLS and a clear-text one) and the user's own
// extension file (unbound_ext.conf: the zones that go to the private resolvers, without TLS).
const UNBOUND_CONF = `# /var/lib/unbound/unbound.conf generated by UCI
server:
  verbosity: 1
  tls-cert-bundle: /etc/ssl/certs/ca-certificates.crt
  interface: 0.0.0.0@53
  private-domain: lab.formicalab.casa

forward-zone:
  name: .
${CLOUDFLARE.map(a => `  forward-addr: ${a}@853#cloudflare-dns.com`).join('\n')}
  forward-first: no
  forward-tls-upstream: yes

forward-zone:
  name: proxy.dsl.vodafone.it
${VODAFONE.map(a => `  forward-addr: ${a}`).join('\n')}
  forward-first: no
  forward-tls-upstream: no

remote-control:
  control-enable: yes
  control-interface: 127.0.0.1
`;
// The user's server-clause file: the rebind-protection exceptions (two plain, ten quoted Azure names, one repeated from the generated
// configuration and one in capitals with a trailing dot, which must be listed once and normalized), and lines that are not exceptions.
const UNBOUND_SRV = ['# private-domain: commented.out', 'private-domain: formicalab.casa', 'private-domain: proxy.dsl.vodafone.it', 'private-domain: lab.formicalab.casa', 'domain-insecure: "lab.formicalab.casa"',
  'local-data: "openwrt.lab.formicalab.casa. 300 IN A 192.168.1.1"', ...AZURE_ZONES.slice(0, 10).map(z => `private-domain: "${z}"`), 'private-domain: "BLOB.Core.Windows.Net."'].join('\n') + '\n';
const UNBOUND_EXT = '# Extended user clauses\n' + [...AZURE_ZONES, 'lab.formicalab.casa'].map(z => `forward-zone:\n    name: "${z}."\n${AZURE_SERVERS.map(a => `    forward-addr: ${a}`).join('\n')}\n    forward-first: no\n`).join('\n')
  + '\nforward-zone:\n    name: "flumini.formicalab.casa."\n    forward-addr: 192.168.8.1\n    forward-first: no\n';

// `unbound-control list_local_data`: records separated by blank lines, tab separated; the reverse (arpa) names are not
// counted by the plugin. Six names: localhost and five hosts (one has an A and an AAAA record).
const LOCAL_NAMES = ['localhost', 'nas.lab.formicalab.casa', 'printer.lab.formicalab.casa', 'router.lab.formicalab.casa', 'pve.lab.formicalab.casa', 'laptop.lab.formicalab.casa'];
const LOCAL_DATA = [
  'localhost.\t10800\tIN\tA\t127.0.0.1', 'localhost.\t10800\tIN\tAAAA\t::1', 'nas.lab.formicalab.casa.\t300\tIN\tA\t192.168.1.50', 'nas.lab.formicalab.casa.\t300\tIN\tAAAA\t2001:db8:1::50',
  'printer.lab.formicalab.casa.\t300\tIN\tA\t192.168.1.20', 'router.lab.formicalab.casa.\t300\tIN\tA\t192.168.1.1', 'pve.lab.formicalab.casa.\t300\tIN\tA\t192.168.1.60', 'laptop.lab.formicalab.casa.\t300\tIN\tA\t192.168.1.10',
  '1.0.0.127.in-addr.arpa.\t10800\tIN\tPTR\tlocalhost.', '50.1.168.192.in-addr.arpa.\t300\tIN\tPTR\tnas.lab.formicalab.casa.', '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa.\t10800\tIN\tPTR\tlocalhost.',
  '0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa.\t10800\tIN\tSOA\tlocalhost. nobody.invalid. 1 3600 1200 604800 10800'].join('\n\n') + '\n';

// A UCI section as `uci export` JSON: the type, the name and the options.
const section = (name, type, options) => ({ '.type': type, '.name': name, ...options });
// The main router's `unbound` section.
const UB_MAIN = section('ub_main', 'unbound', {
  add_extra_dns: '1', dhcp_link: 'odhcpd', dns64: '0', domain: 'lab.formicalab.casa', domain_type: 'transparent', edns_size: '1232', extended_stats: '0', hide_binddata: '1', interface_auto: '1',
  listen_port: '53', localservice: '1', manual_conf: '0', num_threads: '4', protocol: 'default', rate_limit: '300', rebind_localhost: '1', rebind_protection: '1', recursion: 'default',
  resource: 'default', root_age: '9', ttl_min: '0', ttl_neg_max: '60', unbound_control: '1', validator: '1', verbosity: '1', iface_wan: ['wan'], enabled: '1', iface_lan: ['lan', 'lan100', 'wg0'], iface_trig: ['lan', 'wan'],
});
// The UCI zone sections next to it: the plugin reports the forward zones among them, enabled or not (the auth zone is not one).
const UB_ZONES = {
  auth_icann: section('auth_icann', 'zone', { enabled: '0', fallback: '1', zone_type: 'auth_zone', server: ['lax.xfr.dns.icann.org', 'iad.xfr.dns.icann.org'], zone_name: ['.', 'arpa.'] }),
  fwd_cloudflare: section('fwd_cloudflare', 'zone', { enabled: '1', fallback: '0', tls_index: 'cloudflare-dns.com', tls_upstream: '1', zone_type: 'forward_zone', server: CLOUDFLARE, zone_name: ['.'] }),
  fwd_google: section('fwd_google', 'zone', { enabled: '0', fallback: '1', tls_index: 'dns.google', tls_upstream: '1', zone_type: 'forward_zone', server: ['8.8.4.4', '8.8.8.8'], zone_name: ['.'] }),
  fwd_vodafone: section('fwd_vodafone', 'zone', { fallback: '0', enabled: '1', zone_type: 'forward_zone', zone_name: ['proxy.dsl.vodafone.it'], server: VODAFONE, dns_assist: 'none' }),
};

// The service list of procd for the given running instances: { name: pid }.
function services(running) {
  const out = {};
  for (const [name, spec] of Object.entries(running)) {
    out[name] = { instances: { [spec.instance ?? name]: { running: true, pid: spec.pid, incarnation: 12, command: [`/usr/sbin/${name}`], term_timeout: 5 } } };
  }
  return out;
}

//#endregion

//#region The dnsmasq router

// The dhcp config of the GL-X3000: one dnsmasq section with the server list (sixteen zones to the Azure resolver, one to the
// lab router, a local DoH proxy on 5053 and Cloudflare) and the rebind exceptions.
const DM_ZONES = ['blob.core.windows.net', 'database.windows.net', 'documents.azure.com', 'vault.azure.net', 'vaultcore.azure.net', 'azurewebsites.net', 'azuredatabricks.net', 'file.core.windows.net',
  'postgres.database.azure.com', 'privatelink.prod.migration.windowsazure.com', 'privatelink.siterecovery.windowsazure.com', 'guestconfiguration.azure.com', 'his.arc.azure.com', 'queue.core.windows.net',
  'monitor.azure.com', 'azure-api.net'];
const dmSection = (port = '53') => section('cfg01411c', 'dnsmasq', {
  domainneeded: '1', localise_queries: '1', rebind_protection: '1', domain: 'flumini.formicalab.casa', expandhosts: '1', cachesize: '1000', authoritative: '1', readethers: '1', leasefile: '/tmp/dhcp.leases',
  resolvfile: '/tmp/resolv.conf.d/resolv.conf.auto', localservice: '1', ednspacket_max: '1232', strictorder: '1', rapidcommit: '1', rebind_domain: ['lab.formicalab.casa', ...DM_ZONES], interface: ['lan', 'wg0'], port,
  server: [...DM_ZONES.map(z => `/*.${z}/10.0.2.4`), '/*.lab.formicalab.casa/192.168.1.1', '127.0.0.1#5053', '1.1.1.1'], sequential_ip: '1',
});
const DM_METRICS = { dns_cache_inserted: 418, dns_cache_live_freed: 0, dns_queries_forwarded: 568, dns_auth_answered: 0, dns_local_answered: 814, dns_stale_answered: 0, dns_unanswered: 7,
  dnssec_max_crypto_use: 0, dnssec_max_sig_fail: 0, dnssec_max_work: 0, bootp: 0, pxe: 0, dhcp_ack: 52, dhcp_decline: 0, dhcp_discover: 2, dhcp_inform: 0, dhcp_nak: 0, dhcp_offer: 2, dhcp_release: 0, dhcp_request: 52,
  noanswer: 0, leases_allocated_4: 4, leases_pruned_4: 0, leases_allocated_6: 0, leases_pruned_6: 0, tcp_connections: 0, dhcp_leasequery: 0, dhcp_lease_unassigned: 0, dhcp_lease_actve: 0, dhcp_lease_unknown: 0 };
const DM_VERSION = `Dnsmasq version 2.93  Copyright (c) 2000-2026 Simon Kelley
Compile time options: IPv6 GNU-getopt no-DBus UBus no-i18n no-IDN DHCP no-DHCPv6 no-Lua TFTP no-conntrack no-ipset no-nftset no-auth no-DNSSEC no-ID loop-detect inotify dumpfile

This software comes with ABSOLUTELY NO WARRANTY.
Dnsmasq is free software, and you are welcome to redistribute it
under the terms of the GNU General Public License, version 2 or 3.
`;
// The sockets dnsmasq holds on the X3000: DNS on three IPv4 and three IPv6 addresses (TCP and UDP), DHCP on UDP 67.
const dmSocks = (pid, port = 53) => ['192.168.9.1', '192.168.8.1', '127.0.0.1', 'fe80::9683:c4ff:fea3:9530', '::1', 'fd0c:f0e0:4283::1'].flatMap(a => [sock('tcp', a, port, `${pid}/dnsmasq`), sock('udp', a, port, `${pid}/dnsmasq`)]).concat(sock('udp', '0.0.0.0', 67, `${pid}/dnsmasq`));
// What dnsmasq serves by name: the host files in /tmp/hosts and the leases (seven distinct names, see facts.json).
const HOSTS_FILES = {
  'dhcp.cfg01411c': '192.168.8.100\tnet_ac_FF9C\n192.168.8.101\tnet_ac_96A2\n# the router\n192.168.8.1\topenwrt-flumini flumini\n',
  'odhcpd.hosts.lan': 'fd0c:f0e0:4283::100\tnet_ac_ff9c\n192.168.8.50\tprinter.flumini.formicalab.casa printer\n',
};
const LEASES = '1794478626 e8:b2:fe:18:ed:85 192.168.8.102 * *\n1794477793 d8:34:1c:ed:96:a2 192.168.8.101 net_ac_96A2 *\n1794477660 d8:34:1c:ec:ff:9c 192.168.8.100 net_ac_FF9C *\n1794470000 aa:bb:cc:00:11:22 192.168.8.77 phone 01:aa:bb:cc:00:11:22\n';
const DM_NAMES = ['net_ac_ff9c', 'net_ac_96a2', 'openwrt-flumini', 'flumini', 'printer.flumini.formicalab.casa', 'printer', 'phone'];

//#endregion

//#region Scenarios

// The scenarios: name -> { commands, uci, ubus, files }.
const scenarios = {};
// The time the router has been up, and the start of the processes in clock ticks: the dnsmasq process has run 55000 s.
const UPTIME_FILE = '100000.57 392000.11\n';
const DM_START = 4500050;
const DM_AGE = Math.floor(100000.57 - DM_START / 100);
const REAL_UB_COMMON = { 'command -v unbound': '/usr/sbin/unbound\n', 'command -v dnsmasq': '' };

// Unbound with extended statistics, ninety forwarders and a WAN resolver.
const UB_T = { queries: 48210, hits: 31190, ratelimited: 12, prefetch: 1210, timedOut: 48, expired: 35, avg: '0.051234', median: '0.032100', up: '273600.120000',
  rcodes: { NOERROR: 44100, SERVFAIL: 910, NXDOMAIN: 3200, REFUSED: 12 }, secure: 30120, bogus: 3, unwantedQueries: 0, unwantedReplies: 17, memRrset: 2097152, memMessage: 1048576, msgs: 4120, rrsets: 6800 };
scenarios.unbound = {
  commands: {
    ...REAL_UB_COMMON,
    'unbound-control status': unboundStatus(2201, 273600), 'unbound-control stats_noreset': unboundStats(UB_T, true),
    'unbound-control list_forwards': forwardsText(), 'unbound-control list_local_data': LOCAL_DATA,
    'netstat -lntup': netstat(['0.0.0.0', '::'].flatMap(a => [sock('tcp', a, 53, '2201/unbound'), sock('tcp', a, 53, '2201/unbound'), sock('udp', a, 53, '2201/unbound'), sock('udp', a, 53, '2201/unbound')]), sock('tcp', '127.0.0.1', 8953, '2201/unbound'), sock('tcp', '::1', 8953, '2201/unbound')),
  },
  uci: { unbound: { ub_main: UB_MAIN, ...UB_ZONES } },
  ubus: { service_list: services({ unbound: { pid: 2201 } }) },
  files: { '/proc/uptime': UPTIME_FILE, '/var/lib/unbound/unbound.conf': UNBOUND_CONF, '/var/lib/unbound/unbound_ext.conf': UNBOUND_EXT, '/var/lib/unbound/unbound_srv.conf': UNBOUND_SRV, '/tmp/resolv.conf.d/resolv.conf.auto': '# Interface wan\nsearch isp.example\nnameserver 192.0.2.53\nnameserver 2001:db8:53::1\nnameserver 127.0.0.1\n# Interface wan6\nnameserver 192.0.2.53\n' },
};

// Unbound as the main router runs it: extended statistics off, so only the totals exist; a short forwarder list.
const BASIC_T = { queries: 2011, hits: 575, ratelimited: 0, prefetch: 0, timedOut: 0, expired: 0, avg: '0.045918', median: '0.0307683', up: '618.114594' };
scenarios['unbound-basic'] = {
  commands: {
    ...REAL_UB_COMMON,
    'unbound-control status': unboundStatus(25447, 618), 'unbound-control stats_noreset': unboundStats(BASIC_T, false),
    'unbound-control list_forwards': `. IN forward ${CLOUDFLARE.join(' ')}\nazmk8s.io. IN forward ${AZURE_SERVERS.join(' ')}\nlab.formicalab.casa. IN forward +i ${AZURE_SERVERS.join(' ')}\n`,
    'unbound-control list_local_data': LOCAL_DATA,
    'netstat -lntup': netstat(['0.0.0.0', '::'].flatMap(a => [sock('tcp', a, 53, '25447/unbound'), sock('udp', a, 53, '25447/unbound')])),
  },
  uci: { unbound: { ub_main: { ...UB_MAIN, rebind_protection: '0' } } },
  ubus: { service_list: services({ unbound: { pid: 25447 } }) },
  files: { '/proc/uptime': UPTIME_FILE, '/var/lib/unbound/unbound.conf': UNBOUND_CONF, '/var/lib/unbound/unbound_ext.conf': '', '/tmp/resolv.conf.d/resolv.conf.auto': '' },
};

// Unbound runs, but unbound-control fails: every control command prints nothing (the error goes to stderr).
scenarios['unbound-nocontrol'] = {
  commands: {
    ...REAL_UB_COMMON, 'unbound -V': 'Version 1.26.2\n\nConfigure line: --prefix=/usr --sysconfdir=/etc\nLinked libs: OpenSSL 3.0.15\n',
    'netstat -lntup': netstat(['0.0.0.0', '::'].flatMap(a => [sock('tcp', a, 53, '2201/unbound'), sock('udp', a, 53, '2201/unbound')])),
  },
  uci: { unbound: { ub_main: { ...UB_MAIN, unbound_control: '0', validator: '0' } } },
  ubus: { service_list: services({ unbound: { pid: 2201 } }) },
  files: { '/proc/uptime': UPTIME_FILE, '/var/lib/unbound/unbound.conf': UNBOUND_CONF, '/var/lib/unbound/unbound_ext.conf': UNBOUND_EXT, '/tmp/resolv.conf.d/resolv.conf.auto': 'nameserver 192.0.2.53\n' },
};

// A router with 520 forward zones and 60 listening sockets (30 addresses, TCP and UDP): both lists are cut.
const MANY = Array.from({ length: 520 }, (_, i) => `zone${String(i).padStart(3, '0')}.example.net`);
const MANY_ADDRS = Array.from({ length: 30 }, (_, i) => `10.20.${i}.1`);
scenarios['unbound-many'] = {
  commands: {
    ...REAL_UB_COMMON,
    'unbound-control status': unboundStatus(2201, 3600), 'unbound-control stats_noreset': unboundStats({ ...BASIC_T, up: '3600.5' }, false),
    'unbound-control list_forwards': `. IN forward 9.9.9.9\n${MANY.map(z => `${z}. IN forward 10.9.9.9`).join('\n')}\n`, 'unbound-control list_local_data': '',
    'netstat -lntup': netstat(MANY_ADDRS.flatMap(a => [sock('tcp', a, 53, '2201/unbound'), sock('udp', a, 53, '2201/unbound')])),
  },
  uci: { unbound: { ub_main: UB_MAIN, fwd_many: section('fwd_many', 'zone', { enabled: '1', zone_type: 'forward_zone', fallback: '0', server: ['10.9.9.9'], zone_name: MANY.slice(0, 89) }) } },
  ubus: { service_list: services({ unbound: { pid: 2201 } }) },
  files: { '/proc/uptime': UPTIME_FILE, '/var/lib/unbound/unbound.conf': '', '/var/lib/unbound/unbound_ext.conf': '', '/tmp/resolv.conf.d/resolv.conf.auto': '' },
};

// dnsmasq as the GL-X3000 runs it.
const dnsmasqFiles = () => ({
  '/proc/uptime': UPTIME_FILE, '/proc/5752/stat': procStat(5752, 'dnsmasq', DM_START), '/tmp/resolv.conf.d/resolv.conf.auto': '# Interface mm0\nnameserver 10.133.106.38\nnameserver 10.128.28.16\n',
  ...Object.fromEntries(Object.entries(HOSTS_FILES).map(([f, t]) => [`/tmp/hosts/${f}`, t])), '/tmp/dhcp.leases': LEASES,
});
scenarios.dnsmasq = {
  commands: {
    'command -v dnsmasq': '/usr/sbin/dnsmasq\n', 'command -v unbound': '', 'dnsmasq --version': DM_VERSION, 'pidof dnsmasq': '5778 5752\n', 'ls /tmp/hosts': Object.keys(HOSTS_FILES).join('\n') + '\n',
    'netstat -lntup': netstat(dmSocks(5778)),
  },
  uci: { dhcp: { cfg01411c: dmSection() } },
  ubus: { service_list: services({ dnsmasq: { pid: 5752, instance: 'cfg01411c' } }), dnsmasq_metrics: DM_METRICS },
  files: dnsmasqFiles(),
};

// Unbound answers on port 53 and dnsmasq (port 5353) sits behind it as the forwarder of the default zone.
scenarios.both = {
  commands: {
    'command -v unbound': '/usr/sbin/unbound\n', 'command -v dnsmasq': '/usr/sbin/dnsmasq\n', 'dnsmasq --version': DM_VERSION, 'ls /tmp/hosts': Object.keys(HOSTS_FILES).join('\n') + '\n',
    'unbound-control status': unboundStatus(2201, 7200), 'unbound-control stats_noreset': unboundStats({ ...BASIC_T, up: '7200.4' }, false),
    'unbound-control list_forwards': '. IN forward 127.0.0.1\n', 'unbound-control list_local_data': LOCAL_DATA,
    'netstat -lntup': netstat(['0.0.0.0', '::'].flatMap(a => [sock('tcp', a, 53, '2201/unbound'), sock('udp', a, 53, '2201/unbound')]), sock('tcp', '127.0.0.1', 8953, '2201/unbound'),
      ['127.0.0.1', '::1'].flatMap(a => [sock('tcp', a, 5353, '3302/dnsmasq'), sock('udp', a, 5353, '3302/dnsmasq')]), sock('udp', '0.0.0.0', 67, '3302/dnsmasq')),
  },
  uci: { unbound: { ub_main: UB_MAIN }, dhcp: { cfg01411c: dmSection('5353') } },
  ubus: { service_list: services({ unbound: { pid: 2201 }, dnsmasq: { pid: 3302, instance: 'cfg01411c' } }), dnsmasq_metrics: DM_METRICS },
  files: { ...dnsmasqFiles(), '/proc/3302/stat': procStat(3302, 'dnsmasq', DM_START), '/var/lib/unbound/unbound.conf': UNBOUND_CONF, '/var/lib/unbound/unbound_ext.conf': '' },
};

// Both installed, neither running: the service list is empty and no socket serves DNS.
scenarios.stopped = {
  commands: {
    'command -v unbound': '/usr/sbin/unbound\n', 'command -v dnsmasq': '/usr/sbin/dnsmasq\n', 'unbound -V': 'Version 1.26.2\n\nConfigure line: --prefix=/usr\n', 'dnsmasq --version': DM_VERSION,
    'netstat -lntup': netstat(),
  },
  uci: { unbound: { ub_main: UB_MAIN }, dhcp: { cfg01411c: dmSection() } },
  ubus: { service_list: {} },
  files: { '/proc/uptime': UPTIME_FILE, '/var/lib/unbound/unbound.conf': UNBOUND_CONF, '/var/lib/unbound/unbound_ext.conf': UNBOUND_EXT, '/tmp/resolv.conf.d/resolv.conf.auto': 'nameserver 192.0.2.53\n' },
};

// No resolver installed at all.
scenarios.none = {
  commands: { 'netstat -lntup': netstat() },
  uci: {},
  ubus: { service_list: {} },
  files: { '/proc/uptime': UPTIME_FILE, '/tmp/resolv.conf.d/resolv.conf.auto': 'nameserver 192.0.2.53\n' },
};

//#endregion

// Writes one scenario's fixture directory.
function writeScenario(name, spec) {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [cmd, text] of Object.entries(spec.commands)) fs.writeFileSync(path.join(dir, slug(cmd)), text);
  for (const [config, sections] of Object.entries(spec.uci)) fs.writeFileSync(path.join(dir, `uci_${config}.json`), JSON.stringify({ values: sections }));
  for (const [call, reply] of Object.entries(spec.ubus)) fs.writeFileSync(path.join(dir, `${call}.json`), JSON.stringify(reply));
  fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify(spec.files));
}

for (const [name, spec] of Object.entries(scenarios)) writeScenario(name, spec);
// What the router under test reports: the files the capture saved, copied unchanged.
const names = Object.keys(scenarios);
if (fs.existsSync(path.join(work, 'fx-real'))) {
  names.push('real');
  fs.mkdirSync(path.join(work, 'real'), { recursive: true });
  for (const f of fs.readdirSync(path.join(work, 'fx-real'))) fs.writeFileSync(path.join(work, 'real', f), fs.readFileSync(path.join(work, 'fx-real', f), 'utf8').replace(/\r/g, ''));
}

// The cases: one plugin call per scenario, and one with arguments that must be ignored (the canary file must not appear).
const cases = names.map(n => ({ name: n, scenario: n, method: 'status' }));
cases.push({ name: 'unbound-args', scenario: 'unbound', method: 'status', args: { host: '$(touch /tmp/flab-dns-canary)', zone: '.; touch /tmp/flab-dns-canary', q: '`touch /tmp/flab-dns-canary`' } });
fs.mkdirSync(path.join(work, 'cases'), { recursive: true });
fs.writeFileSync(path.join(work, 'cases.txt'), cases.map(c => `${c.name} ${c.scenario} ${c.method}`).join('\n') + '\n');
for (const c of cases) if (c.args !== undefined) fs.writeFileSync(path.join(work, 'cases', `${c.name}.json`), JSON.stringify(c.args));
fs.writeFileSync(path.join(work, 'scenarios.json'), JSON.stringify(names));
fs.writeFileSync(path.join(work, 'cases.json'), JSON.stringify(cases));
// The numbers the assertions compare with.
fs.writeFileSync(path.join(work, 'facts.json'), JSON.stringify({
  azureZones: AZURE_ZONES, azureServers: AZURE_SERVERS, cloudflare: CLOUDFLARE, vodafone: VODAFONE, forwardRows: AZURE_ZONES.length + 4, ubT: UB_T, basicT: BASIC_T,
  localNames: LOCAL_NAMES.length, dmNames: DM_NAMES.length, dmAge: DM_AGE, dmMetrics: DM_METRICS, dmZones: DM_ZONES, many: MANY.length, manyAddrs: MANY_ADDRS.length,
}));
console.log(`built ${names.join(', ')} and ${cases.length} cases`);
