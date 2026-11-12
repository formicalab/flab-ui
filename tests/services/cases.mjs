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
// The command line that runs `action` on init script `name` and prints its exit code.
export const waitCmd = (name, action) => `timeout 45 /etc/init.d/${name} ${action} </dev/null >/tmp/flab-service.out 2>&1; echo $?`;
export const OUTPUT_CMD = 'head -c 4096 /tmp/flab-service.out 2>/dev/null; rm -f /tmp/flab-service.out';
// The fixture file name of a command.
export const slug = cmd => cmd.replace(/ 2>\/dev\/null$/, '').replace(/[^A-Za-z0-9]+/g, '_') + '.txt';

// Calls that must run the script: [name, action].
export const RUN = [['dropbear', 'restart'], ['dropbear', 'start'], ['dropbear', 'stop'], ['dnsmasq', 'restart'], ['acme', 'start'], ['firewall', 'restart'], ['rpcd', 'start'], ['uhttpd', 'start'], ['network', 'start']];
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
  ['dropbear', '', /action must be/], ['dropbear', 'RESTART', /action must be/], ['dropbear', 'enable', /action must be/],
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
