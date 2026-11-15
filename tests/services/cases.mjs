// Shared description of the backend test: the init scripts of the fake router, the calls made against it and the
// command lines flab.services is expected to build. Used by mkfx.mjs (fixtures) and assert.mjs (checks).

// Executable files of the fake /etc/init.d, and names that must never reach the list (not plain file names).
export const INSTALLED = ['acme', 'boot', 'cron', 'dnsmasq', 'done', 'dropbear', 'firewall', 'log', 'network', 'odhcpd', 'rpcd', 'uhttpd', 'umount', 'wpad'];
export const JUNK = ['bad name', 'x;reboot', '.hidden', 'a$(id)', '-h'];
// The fake /etc/rc.d: S<NN><name> starts at boot, K<NN><name> is the stop link.
export const RC = ['K10wpad', 'K50dropbear', 'K90umount', 'S10boot', 'S12rpcd', 'S19dnsmasq', 'S19dropbear', 'S19firewall', 'S20network', 'S35odhcpd', 'S50cron', 'S50uhttpd', 'S95done'];

// The scripts whose stop and restart run in the background.
export const DETACHED = ['rpcd', 'uhttpd', 'network'];

// The command lines the plugin builds; fixtures are named after them (see rpcd/lib/flab/util.uc).
export const LIST_CMD = 'for f in /etc/init.d/*; do [ -f "$f" ] && [ -x "$f" ] && echo "${f##*/}"; done 2>/dev/null';
export const RC_CMD = 'ls -1 /etc/rc.d 2>/dev/null';
// The listening sockets and the range of the ports the kernel hands out to outgoing connections.
export const NETSTAT_CMD = 'netstat -lntup 2>/dev/null';
export const RANGE_CMD = 'cat /proc/sys/net/ipv4/ip_local_port_range 2>/dev/null';
// What busybox netstat -lntup printed on the router (shortened): a dual-stack service listing the same port twice per family,
// loopback and specific addresses, UDP sockets in and below the ephemeral range, a kernel socket with no process ("-") and
// a line that is not a socket.
export const NETSTAT = `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 127.0.0.1:8953          0.0.0.0:*               LISTEN      21319/unbound
tcp        0      0 0.0.0.0:53              0.0.0.0:*               LISTEN      21319/unbound
tcp        0      0 0.0.0.0:53              0.0.0.0:*               LISTEN      21319/unbound
tcp        0      0 192.168.1.1:3493        0.0.0.0:*               LISTEN      3196/upsd
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      2111/dropbear
tcp        0      0 :::22                   :::*                    LISTEN      2111/dropbear
tcp        0      0 ::1:8953                :::*                    LISTEN      21319/unbound
tcp        0      0 :::53                   :::*                    LISTEN      21319/unbound
udp        0      0 0.0.0.0:500             0.0.0.0:*                           7013/charon
udp        0      0 0.0.0.0:67              0.0.0.0:*                           2571/odhcpd
udp        0      0 0.0.0.0:51820           0.0.0.0:*                           -
udp        0      0 :::547                  :::*                                2571/odhcpd
udp        0      0 :::48707                :::*                                7577/cloudflared
udp        0      0 0.0.0.0:51583           0.0.0.0:*                           4576/squid
udp        0      0 :::32767                :::*                                4576/squid
`;
// The command line that runs `action` on init script `name` and prints its exit code.
export const waitCmd = (name, action) => `/etc/init.d/${name} ${action} </dev/null`;
export const OUTPUT_CMD = 'head -c 4096 /tmp/flab-service.out 2>/dev/null; rm -f /tmp/flab-service.out';
// The fixture file name of a command.
export const slug = cmd => cmd.replace(/ 2>\/dev\/null$/, '').replace(/[^A-Za-z0-9]+/g, '_') + '.txt';

// Calls that must run the script: [name, action].
export const RUN = [['dropbear', 'restart'], ['dropbear', 'start'], ['dropbear', 'stop'], ['dnsmasq', 'restart'], ['acme', 'start'], ['firewall', 'restart'], ['rpcd', 'start'], ['uhttpd', 'start'], ['network', 'start'],
  // enable and disable only change the boot links, so they run in the foreground even for the services whose stop is detached.
  ['acme', 'enable'], ['dropbear', 'disable'], ['rpcd', 'disable'], ['uhttpd', 'enable'], ['network', 'disable']];
// Calls that must run in the background.
export const BACKGROUND = [['rpcd', 'restart'], ['rpcd', 'stop'], ['uhttpd', 'restart'], ['uhttpd', 'stop'], ['network', 'restart'], ['network', 'stop']];
// Calls that must be refused, with the start of the error each one gets. Every one has a fixture that would
// report success if its command were run, so a refused call that did run shows up as ok.
export const REFUSED = [
  ['boot', 'restart', /boot sequence/], ['done', 'stop', /boot sequence/], ['umount', 'start', /boot sequence/],
  ['nosuch', 'start', /no such service/], ['bad name', 'start', /name is not valid/], ['x;reboot', 'start', /name is not valid/],
  ['../../bin/sh', 'restart', /name is not valid/], ['dropbear; reboot', 'restart', /name is not valid/], ['dnsmasq/../boot', 'restart', /name is not valid/],
  ['a$(id)', 'stop', /name is not valid/], ['-h', 'start', /name is not valid/], ['.hidden', 'start', /name is not valid/], ['', 'start', /name is not valid/],
  ['x'.repeat(65), 'start', /name is not valid/], ['dropbear\nreboot', 'start', /name is not valid/], ['dropbear', 'reload', /action must be/], ['dropbear', 'restart; reboot', /action must be/],
  ['dropbear', '', /action must be/], ['dropbear', 'RESTART', /action must be/], ['dropbear', 'toggle', /action must be/], ['dropbear', 'ENABLE', /action must be/], ['dropbear', 'enable; reboot', /action must be/], ['dropbear', 'disable ', /action must be/],
  ['boot', 'enable', /boot sequence/], ['umount', 'disable', /boot sequence/], ['nosuch', 'enable', /no such service/], ['dropbear; reboot', 'disable', /name is not valid/],
];

// Every call, as { id, method, args } for the harness.
export const CASES = [
  { id: 'list', method: 'list', args: {} },
  ...RUN.map(([name, action]) => ({ id: `run:${name}:${action}`, method: 'control', args: { name, action } })),
  ...BACKGROUND.map(([name, action]) => ({ id: `bg:${name}:${action}`, method: 'control', args: { name, action } })),
  ...REFUSED.map(([name, action]) => ({ id: `refused:${name}:${action}`, method: 'control', args: { name, action } })),
  // Arguments of the wrong type or missing.
  { id: 'refused:no-args', method: 'control', args: {} },
  { id: 'refused:number-name', method: 'control', args: { name: 5, action: 'start' } },
  { id: 'refused:list-name', method: 'control', args: { name: ['dropbear'], action: 'start' } },
  { id: 'refused:object-action', method: 'control', args: { name: 'dropbear', action: { a: 1 } } },
  { id: 'refused:no-action', method: 'control', args: { name: 'dropbear' } },
];
