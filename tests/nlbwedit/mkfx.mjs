// Builds the fixtures for the backend test of flab.traffic's nlbwmon_paths method: one folder per scenario holding what the
// plugin reads instead of the real filesystem (rpcd/lib/flab/util.uc: files.json for /proc/mounts, and nlbwmon_fs.json for the
// filesystem queries the plugin makes itself), plus cases.txt (one line per call: name, scenario, method) and the cases' arguments.
// Usage: node mkfx.mjs <work dir>
import fs from 'node:fs';
import path from 'node:path';

const MOUNTS = [
  '/dev/root /rom squashfs ro,relatime,errors=continue 0 0',
  'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
  'tmpfs /tmp tmpfs rw,nosuid,nodev,noatime 0 0',
  'tmpfs /tmp/.ujail tmpfs ro,nosuid,nodev,noexec,relatime,size=4k,mode=000 0 0',
  '/dev/loop0 /overlay f2fs rw,lazytime,noatime 0 0',
  'overlayfs:/overlay / overlay rw,noatime,lowerdir=/,upperdir=/overlay/upper,workdir=/overlay/work 0 0',
  'tmpfs /dev tmpfs rw,nosuid,noexec,noatime,size=512k,mode=755 0 0',
  '/dev/sda1 /mnt/usb ext4 rw,relatime 0 0',
  '/dev/sdb1 /mnt/card vfat ro,relatime 0 0',
  '//nas/share /mnt/nas cifs rw,relatime 0 0',
].join('\n') + '\n';

const dir = { type: 'directory', size: 60, mtime: 1794582000 };
// A regular file as stat() describes it.
const file = (size, mtime) => ({ type: 'file', size, mtime });

// The filesystem of the main scenario: /var is a link to /tmp (as on OpenWrt), the database directory holds two periods and
// some stray files, a USB disk is mounted, and a protocol file is present.
const main = {
  real: { '/': '/', '/var': '/tmp', '/var/lib/nlbwmon': '/tmp/lib/nlbwmon', '/tmp': '/tmp', '/mnt': '/mnt', '/mnt/usb': '/mnt/usb', '/mnt/card': '/mnt/card', '/mnt/nas': '/mnt/nas', '/etc': '/etc', '/etc/config': '/etc/config', '/etc/config/network': '/etc/config/network', '/rom': '/rom', '/usr/share/nlbwmon/protocols': '/usr/share/nlbwmon/protocols', '/mnt/usb/nlbw': '/mnt/usb/nlbw' },
  stat: {
    '/': dir, '/var': dir, '/var/lib': dir, '/var/lib/nlbwmon': dir, '/tmp': dir, '/mnt': dir, '/mnt/usb': dir, '/mnt/card': dir, '/mnt/nas': dir, '/etc': dir, '/etc/config': dir, '/rom': dir, '/usr': dir, '/usr/share': dir, '/usr/share/nlbwmon': dir,
    '/mnt/usb/nlbw': dir,
    '/etc/config/network': file(1400, 1794000000),
    '/var/lib/nlbwmon/20261001.db.gz': file(9876, 1794000000),
    '/var/lib/nlbwmon/20261101.db.gz': file(11564, 1794582001),
    '/var/lib/nlbwmon/notes.txt': file(5, 1794000000),
    '/mnt/usb/nlbw/20260901.db': file(70000, 1790000000),
    '/usr/share/nlbwmon/protocols': file(606, 1700000000),
    '/usr/share/nlbwmon/empty-dir': dir,
    '/usr/share/nlbwmon/secret': file(10, 1700000000),
  },
  dirs: {
    '/var/lib/nlbwmon': ['notes.txt', '20261101.db.gz', '20261001.db.gz', '2026-10.db', '20261001.db.gz.tmp'],
    '/mnt/usb/nlbw': ['20260901.db'],
  },
  readable: { '/usr/share/nlbwmon/protocols': true },
};

// A directory that holds more database files than the reply may carry.
const many = JSON.parse(JSON.stringify(main));
many.dirs['/var/lib/nlbwmon'] = [];
for (let i = 0; i < 120; i++) {
  const name = `${20160101 + i * 100 + (i % 28)}.db.gz`;
  many.dirs['/var/lib/nlbwmon'].push(name);
  many.stat[`/var/lib/nlbwmon/${name}`] = file(1000 + i, 1700000000 + i);
}

// No /proc/mounts and almost nothing readable: the plugin must still answer.
const scenarios = {
  main: { 'files.json': { '/proc/mounts': MOUNTS }, 'nlbwmon_fs.json': main },
  many: { 'files.json': { '/proc/mounts': MOUNTS }, 'nlbwmon_fs.json': many },
  bare: { 'files.json': {}, 'nlbwmon_fs.json': { real: {}, stat: { '/': dir, '/data': dir }, dirs: {} } },
};

// The calls: [name, scenario, args].
export const CASES = [
  ['ram', 'main', { dir: '/var/lib/nlbwmon' }],
  ['usb-missing', 'main', { dir: '/mnt/usb/nlbw-new/deeper' }],
  ['usb-existing', 'main', { dir: '/mnt/usb/nlbw' }],
  ['flash-etc', 'main', { dir: '/etc/nlbwmon' }],
  ['readonly-rom', 'main', { dir: '/rom/nlbwmon' }],
  ['readonly-card', 'main', { dir: '/mnt/card/x' }],
  ['network-share', 'main', { dir: '/mnt/nas' }],
  ['a-file', 'main', { dir: '/etc/config/network' }],
  ['below-a-file', 'main', { dir: '/etc/config/network/sub' }],
  ['root', 'main', { dir: '/' }],
  ['trailing-slash', 'main', { dir: '/var/lib/nlbwmon/' }],
  ['protocols-ok', 'main', { protocols: '/usr/share/nlbwmon/protocols' }],
  ['protocols-missing', 'main', { protocols: '/usr/share/nlbwmon/nope' }],
  ['protocols-dir', 'main', { protocols: '/usr/share/nlbwmon/empty-dir' }],
  ['protocols-unreadable', 'main', { protocols: '/usr/share/nlbwmon/secret' }],
  ['both', 'main', { dir: '/var/lib/nlbwmon', protocols: '/usr/share/nlbwmon/protocols' }],
  ['none', 'main', {}],
  ['many-files', 'many', { dir: '/var/lib/nlbwmon' }],
  ['no-mounts', 'bare', { dir: '/data/nlbwmon' }],
];

// Arguments the plugin must refuse: the text of a path only ever reaches the filesystem functions, never a command line,
// but these would be dangerous or meaningless anyway. Each is tried as `dir` and as `protocols`.
export const REFUSED = [
  'relative/path', '', '/etc/../proc', '/a b', '/a;reboot', '/$(id)', '/`id`', '/a\nb', '/a|b', '/a"b', "/a'b", '/a\\b', '/a*', '/a?', '~/x', '/..', '/x/..', 5, true, ['/tmp'], { a: 1 },
  '/' + 'x'.repeat(300),
];
// A directory path of exactly 126 characters is the longest nlbwmon accepts.
export const LONGEST = '/' + 'd'.repeat(125);

// Writes the scenario folders and the case files into the work folder given as the first argument.
function build(work) {
  fs.mkdirSync(path.join(work, 'cases'), { recursive: true });
  for (const [name, files] of Object.entries(scenarios)) {
    fs.mkdirSync(path.join(work, name), { recursive: true });
    for (const [file, data] of Object.entries(files)) fs.writeFileSync(path.join(work, name, file), JSON.stringify(data));
  }
  const lines = [];
  // Adds one call: its arguments file and its line in cases.txt.
  const add = (name, scenario, args) => { fs.writeFileSync(path.join(work, 'cases', `${name}.json`), JSON.stringify(args)); lines.push(`${name} ${scenario} nlbwmon_paths`); };
  for (const [name, scenario, args] of CASES) add(name, scenario, args);
  REFUSED.forEach((v, i) => { add(`refused-dir-${i}`, 'main', { dir: v }); add(`refused-file-${i}`, 'main', { protocols: v }); });
  add('longest', 'main', { dir: LONGEST });
  add('too-long', 'main', { dir: LONGEST + 'd' });
  fs.writeFileSync(path.join(work, 'cases.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(work, 'scenarios.json'), JSON.stringify(Object.keys(scenarios)));
}

if (process.argv[1].endsWith('mkfx.mjs')) build(process.argv[2]);
