// What the System settings page edits: every option the OpenWrt wiki documents for /etc/config/system
// (https://openwrt.org/docs/guide-user/base-system/system_configuration) and for its timeserver section
// (https://openwrt.org/docs/guide-user/advanced/ntp_configuration), described as data. model.js turns this
// table into the form's draft, validation and UCI operations, and index.js into the controls, so supporting
// another option is one entry here.
//
// A field is { key, section, group, type, label, hint, ... }:
//   key       the UCI option name
//   section   'system' (the system section) or 'ntp' (the timeserver section)
//   group     the card it is shown in (see GROUPS)
//   col       for a group with columns: the column it is shown in
//   type      string | text (multi-line) | bool | int | enum | list
//   check     how a string or list item is validated (see CHECKS in core/fields.js): label | host | ip | path | seed | ifname
//   default   what OpenWrt uses when the option is absent: shown in the empty control as "default: ...", and the
//             value of a switch
//   placeholder  for a field with no single default: a description ("kernel default") or an example ("e.g. lan")
//   min, max  bounds of an int
//   options   the values of an enum
// The time zone is not here: it is two linked options (zonename and timezone) and has its own control, the
// column with the id 'zone' of the time card.
// Options that exist in the file but not in this table are left untouched.

// The cards, in order, each as wide as the page. legend is the explanation at the top of the card. A card with
// `columns` shows them side by side (each with a heading); one without lays its fields out in a flowing grid.
export const GROUPS = [
  {
    id: 'general', title: 'General', icon: 'gear',
    legend: ['Basic identity and console behavior of the router. These are the system section of /etc/config/system.'],
  },
  {
    id: 'time', title: 'Time zone and NTP', icon: 'clock',
    legend: [
      'The zone decides how the clock is shown on the router and in its logs; the router keeps running on UTC underneath. Two options are stored: zonename (the IANA name) and timezone (its POSIX rule, which the system applies, including daylight saving time). Picking a zone sets both; "Custom rule" sets only the rule.',
      'NTP keeps the clock right by asking time servers, tried in the order listed; the clock matters for logs, certificates and IPsec. These are the timeserver section: with no server and no DHCP servers the NTP client does not start and the clock is never set automatically.',
    ],
    columns: [
      { id: 'zone', title: 'Time zone' },
      { id: 'client', title: 'NTP client' },
      { id: 'server', title: 'NTP server for the network' },
    ],
  },
  {
    id: 'log', title: 'System log', icon: 'journal-text',
    legend: [
      'Where logd (the logread log) keeps messages and whether it forwards them to a remote syslog server. Sizes are in KiB.',
      'Remote logging needs a server address; the remote switch alone does nothing. Messages are sent in the clear.',
    ],
  },
  {
    id: 'kernel', title: 'Kernel, cron and memory', icon: 'cpu',
    legend: ['Verbosity of the kernel console and of cron, the kernel message buffer, and the compressed-RAM swap (ZRAM, only used when its package is installed).'],
  },
];

export const FIELDS = [
  // General
  { key: 'hostname', section: 'system', group: 'general', type: 'string', check: 'label', label: 'Hostname', default: 'OpenWrt',
    hint: 'The name of this router. Avoid dots: "my.name" is shown as "my".' },
  { key: 'description', section: 'system', group: 'general', type: 'string', label: 'Description',
    hint: 'A short single line for management interfaces.' },
  { key: 'notes', section: 'system', group: 'general', type: 'text', label: 'Notes',
    hint: 'Free text: installation notes, serial number, location.' },
  { key: 'ttylogin', section: 'system', group: 'general', type: 'bool', default: false, label: 'Require a login on the console',
    hint: 'Local users must authenticate on the access methods in /etc/inittab (keyboard, serial).' },
  { key: 'urandom_seed', section: 'system', group: 'general', type: 'string', check: 'seed', label: 'Random seed file', default: '0',
    hint: 'Path of a file in which a new random seed is saved on every boot; 0 turns this off.' },

  // Time zone and NTP (the zone control is built by index.js)
  { key: 'enabled', section: 'ntp', group: 'time', col: 'client', type: 'bool', default: true, label: 'Synchronize the clock with NTP',
    hint: 'Switches the NTP client (sysntpd) on or off.' },
  { key: 'use_dhcp', section: 'ntp', group: 'time', col: 'client', type: 'bool', default: true, label: 'Also use servers offered by DHCP',
    hint: 'Adds the time servers that an upstream DHCP server announces.' },
  { key: 'server', section: 'ntp', group: 'time', col: 'client', type: 'list', check: 'host', label: 'Time servers', placeholder: 'e.g. pool.ntp.org', addLabel: 'Add server',
    hint: 'Host names or IP addresses.' },
  { key: 'dhcp_interface', section: 'ntp', group: 'time', col: 'client', type: 'list', check: 'ifname', label: 'Take DHCP servers only from', placeholder: 'e.g. wan', addLabel: 'Add interface',
    hint: 'Network interfaces whose DHCP-announced time servers are used; none means all of them.' },
  { key: 'enable_server', section: 'ntp', group: 'time', col: 'server', type: 'bool', default: false, label: 'Serve time to the network',
    hint: 'Makes this router an NTP server (UDP port 123). Add a firewall rule if clients are in another zone.' },
  { key: 'interface', section: 'ntp', group: 'time', col: 'server', type: 'string', check: 'ifname', label: 'Serve time only on interface', placeholder: 'e.g. lan',
    hint: 'Binds the NTP server to one network interface; empty means every interface.' },

  // System log
  { key: 'log_size', section: 'system', group: 'log', type: 'int', min: 1, default: 128, label: 'Log file buffer (KiB)',
    hint: 'Size of the file-based log buffer; also the default of the logread buffer below.' },
  { key: 'log_buffer_size', section: 'system', group: 'log', type: 'int', min: 1, label: 'logread buffer (KiB)', placeholder: 'same as the log file buffer',
    hint: 'Size of the in-memory log that logread shows.' },
  { key: 'log_type', section: 'system', group: 'log', type: 'enum', options: ['circular', 'file'], default: 'circular', label: 'Log storage',
    hint: 'circular is a fixed-size queue in RAM. file grows without limit and can fill the flash or RAM it lives on.' },
  { key: 'log_file', section: 'system', group: 'log', type: 'string', check: 'path', label: 'Log file', placeholder: 'e.g. /var/log/messages',
    hint: 'Where to write the log when the storage is file (and optionally besides the buffer).' },
  { key: 'log_remote', section: 'system', group: 'log', type: 'bool', default: true, label: 'Send logs to a remote server',
    hint: 'Only has an effect when a server address is set.' },
  { key: 'log_ip', section: 'system', group: 'log', type: 'string', check: 'ip', label: 'Remote syslog server', placeholder: 'e.g. 192.168.1.10',
    hint: 'IP address of a syslog server that gets the messages in addition to the local log.' },
  { key: 'log_port', section: 'system', group: 'log', type: 'int', min: 1, max: 65535, default: 514, label: 'Remote syslog port' },
  { key: 'log_proto', section: 'system', group: 'log', type: 'enum', options: ['udp', 'tcp'], default: 'udp', label: 'Remote syslog protocol' },
  { key: 'log_hostname', section: 'system', group: 'log', type: 'string', check: 'host', label: 'Hostname sent to the remote server', placeholder: 'the router hostname' },
  { key: 'log_prefix', section: 'system', group: 'log', type: 'string', label: 'Prefix for remote messages',
    hint: 'Added to every message sent over the network.' },
  { key: 'log_trailer_null', section: 'system', group: 'log', type: 'bool', default: false, label: 'Terminate TCP messages with NUL',
    hint: 'Use \\0 instead of a newline as the message trailer over TCP.' },

  // Kernel, cron and memory
  { key: 'buffersize', section: 'system', group: 'kernel', type: 'int', min: 1, label: 'Kernel message buffer (bytes)', placeholder: 'kernel default',
    hint: 'Size of the dmesg buffer.' },
  { key: 'conloglevel', section: 'system', group: 'kernel', type: 'int', min: 1, max: 8, default: 8, label: 'Console log level (1 to 8)',
    hint: 'Highest kernel message level printed on the console; higher is more verbose. The default logd ignores this option.' },
  { key: 'cronloglevel', section: 'system', group: 'kernel', type: 'int', min: 0, default: 7, label: 'Cron log level',
    hint: 'Lowest level logged by cron: 5 logs everything, 7 command executions, 9 nothing (24.10 and earlier: 4 is debug).' },
  { key: 'zram_comp_algo', section: 'system', group: 'kernel', type: 'enum', options: ['lzo', 'lzo-rle', 'lz4', 'zstd'], default: 'lzo', label: 'ZRAM compression' },
  { key: 'zram_size_mb', section: 'system', group: 'kernel', type: 'int', min: 1, label: 'ZRAM size (MB)', placeholder: 'half of the RAM',
    hint: 'Size of the compressed RAM swap.' },
];
