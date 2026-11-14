// What the Settings tab of the Traffic page edits: every option nlbwmon's init script (/etc/init.d/nlbwmon) reads from
// /etc/config/nlbwmon, described as data. The meaning, the units and the defaults come from nlbwmon's README and source
// (https://github.com/jow-/nlbwmon) and from the init script, which turns each option into a command line flag of the daemon
// (`arg`). model.js turns this table into the form's draft, validation, effects and UCI operations, and settings.js into the
// controls, so supporting another option is one entry here.
//
// A field is { key, group, type, label, hint, ... } (the shape core/fields.js and core/forms.js use):
//   key       the UCI option name
//   group     the card it is shown in (see GROUPS)
//   type      string | int | bool | list
//   kind      how a string or list item is validated (the checks in model.js): duration | bytes | interval | path | file | network
//   arg       the daemon flag the init script gives the value to ('-i'); a bool is passed as the bare flag when on
//   default   what the init script uses when the option is absent: shown in the empty control as "default: ...", and the
//             state of a switch. An empty option counts as absent: the init script skips it
//   min, max  bounds of an int
// Options that exist in the file but not in this table are left untouched.

// The cards, in order, each as wide as the page. `legend` is the explanation at the top of the card.
export const GROUPS = [
  {
    id: 'networks', title: 'What is counted', icon: 'diagram-3',
    legend: [
      'nlbwmon counts, per host, the traffic of the connections the kernel tracks that run between one of the local networks listed here and anything outside them. Traffic that stays inside the listed networks, or between two outside addresses, is not counted.',
    ],
  },
  {
    id: 'period', title: 'Accounting periods and history', icon: 'clock-history',
    legend: [
      'The counters start from zero at the start of each accounting period, and a finished period stays in the database as one file. The length of a period and how many are kept decide how far back the Usage tab can look.',
      'Saving reloads nlbwmon. It writes its counts to disk when it stops, and deletes the periods beyond the number to keep when it starts.',
    ],
  },
  {
    id: 'storage', title: 'Database storage', icon: 'hdd-stack',
    legend: [
      'The running counts live in RAM and are written to the database directory every commit interval, when a period ends and when nlbwmon stops. Where that directory is decides what survives a reboot: on tmpfs (RAM, such as the default /var/lib/nlbwmon on OpenWrt) nothing is lost at a restart of nlbwmon but everything is lost at a reboot; on the router\'s flash every commit wears the flash; external storage keeps the history without wearing the flash.',
    ],
  },
  {
    id: 'tuning', title: 'Polling, memory and protocols', icon: 'cpu',
    legend: [
      'How often nlbwmon reads the kernel\'s counters, how many entries the database may hold, and how traffic is told apart by protocol. The defaults suit most routers.',
    ],
  },
];

export const FIELDS = [
  // What is counted
  { key: 'local_network', group: 'networks', type: 'list', kind: 'network', label: 'Local networks', placeholder: 'lan, or 192.168.1.0/24',
    addLabel: 'Add a network',
    hint: 'Each entry is either the name of a network from /etc/config/network (lan, wan, wan6: its current IPv4 and IPv6 subnets are used, and they are read again whenever nlbwmon starts or reloads) or an address with a prefix or mask (192.168.1.0/24, fd00::/8; an address alone is one host). A name that has a dot is taken as an address. With no entry nothing is counted.' },

  // Accounting periods and history
  { key: 'database_interval', group: 'period', type: 'string', kind: 'interval', arg: '-I', label: 'Accounting period', default: '1',
    hint: 'When a period ends and the next one starts. A number is the day of the month: 1 starts a period on the first of each month (the default), 15 on the 15th; a negative number counts back from the end of the month (-1 is the last day). A start day from 29 to 31 does not exist in every month, so prefer 1 to 28 or a negative number. YYYY-MM-DD/N starts a new period every N days, counted from that date (2026-01-17/14 is every 14 days from January 17, 2026). Switching between a day of the month and every N days, or changing N, moves the boundaries of the periods already stored, so stored periods may no longer line up.' },
  { key: 'database_generations', group: 'period', type: 'int', arg: '-G', min: 0, max: 1000, label: 'Periods to keep', default: '10',
    hint: 'How many accounting periods to keep, counting the running one: 10 keeps the running period and the nine before it. Older database files are deleted when nlbwmon starts (at boot and whenever you save here). 0 keeps every period forever, so the directory grows without limit.' },

  // Database storage
  { key: 'database_directory', group: 'storage', type: 'string', kind: 'path', arg: '-o', label: 'Database directory', default: '/var/lib/nlbwmon',
    hint: 'An absolute path where one file per accounting period (YYYYMMDD.db, or .db.gz when compressed) is written; nlbwmon creates the directory if it is missing. At most 126 characters. A directory on external storage must be mounted before nlbwmon starts, or nlbwmon writes to the flash underneath the mount point. Changing it does not move anything: the periods already stored stay in the old directory, and nlbwmon starts an empty database for the running period in the new one.' },
  { key: 'commit_interval', group: 'storage', type: 'string', kind: 'duration', arg: '-i', label: 'Commit interval', default: '24h',
    hint: 'How often the counts in RAM are written to the database directory. A number with w, d, h, m or s (weeks, days, hours, minutes, seconds; a bare number is seconds), at most 24 days. A crash or power loss loses the counts since the last commit; a normal shutdown or restart writes them first. Each commit rewrites the file of the running period, so a short interval wears flash storage, and one hour or more is gentle.' },
  { key: 'database_compress', group: 'storage', type: 'bool', arg: '-Z', label: 'Compress the database files', default: true,
    hint: 'Compress the files with gzip (.db.gz). They are much smaller on flash or USB, at a small cost in time when they are read. On by default.' },

  // Polling, memory and protocols
  { key: 'refresh_interval', group: 'tuning', type: 'string', kind: 'duration', arg: '-r', label: 'Refresh interval', default: '30s',
    hint: 'How often nlbwmon reads the counters of connections that are still open (a connection that closes is counted at once). The kernel resets those counters on every read, so the traffic of a long download only shows up in the numbers at the next refresh. A very short interval costs CPU on a router with many connections. Same units as the commit interval; at least one second.' },
  { key: 'database_limit', group: 'tuning', type: 'int', arg: '-L', min: 0, max: 4294967295, label: 'Entry limit', default: '10000',
    hint: 'The most entries the database may hold; one entry is one combination of host, address family, protocol and port. When the limit is reached nlbwmon overwrites the oldest entries, so a limit that is too low loses history inside the running period. Each entry takes roughly 100 bytes of RAM (and about 70 bytes on disk before compression). 0 means no limit: the database grows with the variety of traffic.' },
  { key: 'database_prealloc', group: 'tuning', type: 'bool', arg: '-P', label: 'Reserve the memory for the whole limit', default: false,
    hint: 'Allocate the memory for the whole entry limit when nlbwmon starts instead of growing step by step. This helps a router with little RAM, which might not find a large block after a long uptime, and costs that memory from the start. It only works together with an entry limit above 0.' },
  { key: 'netlink_buffer_size', group: 'tuning', type: 'string', kind: 'bytes', arg: '-b', label: 'Netlink buffer', default: '524288',
    hint: 'The size in bytes of the receive buffer of the socket nlbwmon uses to hear about connections from the kernel. When it is too small, events are lost on a router that opens many connections at once, and that traffic is not counted. At least 32768. A K or M suffix means KiB or MiB (1M is 1048576). The default is 524288, which is 512 KiB.' },
  { key: 'protocol_database', group: 'tuning', type: 'string', kind: 'file', arg: '-p', label: 'Protocol file', default: '/usr/share/nlbwmon/protocols',
    hint: 'The file that names the protocols (one "ip-protocol port name" per line, for example "6 443 HTTPS"). nlbwmon tells traffic apart by the protocols and ports listed there and counts the rest as "other", so a shorter file means a smaller database. The file must exist and be readable, or nlbwmon does not start.' },
];
