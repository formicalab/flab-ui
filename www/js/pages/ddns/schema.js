// The options of /etc/config/ddns that the Dynamic DNS page edits, as tables of fields in the format of core/fields.js (read
// that file first), with the explanations taken from the OpenWrt documentation of the DDNS client
// (https://openwrt.org/docs/guide-user/base-system/ddns) and of ddns-scripts' own updater.
//
// On top of the usual field keys, a service field has
//   group      the collapsible group of the card it belongs to (SERVICE_GROUPS)
//   secret     a write-only value: the router never sends it to the page, which only shows whether one is stored
//   dynamic    the list the page fills the options from: 'providers', 'networks' or 'devices'
//   show       (values) => whether the control is shown for these (effective) values; a hidden option keeps its value in the
//              file, and is not validated
//   unit       for the number of an interval: the key of the field that holds its unit
//   needs      the provider tag (DOMAIN, USERNAME, PASSWORD) the value is required for when the provider's update address uses it

//#region Service groups

// The groups of a service card, in order: id, title and an explanation. They all start collapsed.
export const SERVICE_GROUPS = [
  { id: 'account', title: 'Provider and account', legend: 'Which dynamic DNS provider to update, the name to keep up to date and the account the update is sent with.' },
  { id: 'source', title: 'Detecting the address', legend: 'Where the updater reads the address it sends to the provider, and which network coming up starts it.' },
  { id: 'custom', title: 'Custom provider', legend: 'For a provider that is not in the list: the address the update is sent to (or a script that sends it).' },
  { id: 'connection', title: 'Connection', legend: 'How the updater talks to the provider and to DNS: HTTPS, a proxy, and which network or address family to use.' },
  { id: 'timing', title: 'Intervals', legend: 'How often the updater checks the address, when it sends an update although nothing changed, and how it retries. Each number has its own unit.' },
  { id: 'logging', title: 'Logging', legend: 'What the updater writes to the system log and to its own log file (shown under "Log" in the service card).' },
];

//#endregion

//#region Service fields

// The units an interval accepts: ddns-scripts reads days, hours and minutes, and takes anything else as seconds. Each interval
// has its own default unit (the check interval minutes, the forced update hours, the retry seconds).
const UNITS = ['seconds', 'minutes', 'hours', 'days'];

// The options of a `service` section. A value in a form is a string, a boolean or a list (see core/fields.js).
export const SERVICE_FIELDS = [
  { key: 'enabled', type: 'bool', group: 'account', label: 'Enabled', default: false,
    hint: 'The updater runs only for an enabled service. Disabled services stay in the file.' },
  { key: 'service_name', type: 'enum', dynamic: 'providers', group: 'account', label: 'Provider', blank: '-- custom --',
    hint: 'The dynamic DNS provider, from the list that ddns-scripts knows. Choose "-- custom --" for one that is not listed and enter its update address (or script) under "Custom provider".' },
  { key: 'lookup_host', type: 'string', check: 'ddnshost', group: 'account', label: 'Lookup host name', placeholder: 'host.example.com',
    hint: 'The full name the updater resolves to find out which address the provider has registered. It compares that with the address of the router, and updates only when they differ.' },
  { key: 'domain', type: 'string', check: 'ddnsdomain', group: 'account', label: 'Domain', needs: 'DOMAIN', placeholder: 'host.example.com',
    hint: 'The name sent to the provider in the update request. Usually the same as the lookup host name; some providers take another form (Cloudflare: "host@example.com").' },
  { key: 'username', type: 'string', group: 'account', label: 'Username', needs: 'USERNAME',
    hint: 'The user name or other parameter the provider asks for. It is not always your account name; check the provider\'s instructions. For Cloudflare with an API token it is "Bearer". Enter "X" when the provider does not use it.' },
  { key: 'password', type: 'string', secret: true, group: 'account', label: 'Password or token', needs: 'PASSWORD',
    hint: 'The update password or token the provider gives you, not necessarily your account password. It is stored in the file but never shown here: leave this empty to keep the stored value, type a new one to replace it. Any character may be used.' },
  { key: 'use_ipv6', type: 'bool', group: 'account', label: 'Update the IPv6 address', default: false,
    hint: 'Send the IPv6 address (an AAAA record) instead of the IPv4 address. Not every provider supports IPv6, and updating both takes two services.' },

  { key: 'interface', type: 'enum', dynamic: 'networks', group: 'source', label: 'Interface', blank: 'choose a network',
    hint: 'The network whose "interface up" event starts the updater (hotplug), normally the one that holds the public address: wan, or wan6 for IPv6.' },
  { key: 'ip_source', type: 'enum', options: ['network', 'web', 'interface', 'script'], group: 'source', label: 'Address source', default: 'network',
    labels: { network: 'a network of the router', web: 'a web page', interface: 'a network device', script: 'a script' },
    hint: 'Where the address to send is read from. A network or a device is read locally and is exact when the router has the public address; a web page tells the address the internet sees, which is what to use behind another router doing NAT.' },
  { key: 'ip_network', type: 'enum', dynamic: 'networks', group: 'source', label: 'Network', blank: 'default', show: v => v.ip_source === '' || v.ip_source === 'network',
    hint: 'The network whose address is sent, as in /etc/config/network. When none is chosen it is wan, or wan6 when the IPv6 address is updated.' },
  { key: 'ip_url', type: 'string', check: 'uri', group: 'source', label: 'Web page', placeholder: 'https://ip.example.com', show: v => v.ip_source === 'web',
    hint: 'A page that answers with the address of whoever asks. Use the one the provider suggests; otherwise any "what is my IP" service that returns plain text. When empty, checkip.dyndns.com is used (checkipv6.dyndns.com for IPv6).' },
  { key: 'ip_interface', type: 'enum', dynamic: 'devices', group: 'source', label: 'Device', blank: 'choose a device', show: v => v.ip_source === 'interface',
    hint: 'A network device of the router (for example eth1 or pppoe-wan) whose global address is sent, whatever network it belongs to. The updater uses eth1 when none is set, so choose one.' },
  { key: 'ip_script', type: 'string', check: 'path', group: 'source', label: 'Script', placeholder: '/path/to/script.sh', show: v => v.ip_source === 'script',
    hint: 'An executable script that prints the address. Its path may be followed by parameters.' },

  { key: 'update_url', type: 'string', group: 'custom', label: 'Update address', placeholder: 'http://provider.example.com/update?host=[DOMAIN]&ip=[IP]', show: v => v.service_name === '',
    hint: 'The address the update is sent to. [DOMAIN], [USERNAME], [PASSWORD], [PARAMENC], [PARAMOPT] and [IP] are replaced by the values of this service. Write http, not https: HTTPS is switched on under "Connection".' },
  { key: 'update_script', type: 'string', check: 'path', group: 'custom', label: 'Update script', placeholder: '/path/to/update_script.sh', show: v => v.service_name === '',
    hint: 'An executable script that sends the update, for a provider that needs more than an address (use one of this and the update address).' },
  { key: 'param_enc', type: 'string', group: 'custom', label: 'Encoded parameter', show: v => v.service_name === '',
    hint: 'A value that replaces [PARAMENC] in the update address, URL-encoded.' },
  { key: 'param_opt', type: 'string', group: 'custom', label: 'Optional parameter', show: v => v.service_name === '',
    hint: 'A value that replaces [PARAMOPT] in the update address, as it is.' },

  { key: 'use_https', type: 'bool', group: 'connection', label: 'Use HTTPS', default: false,
    hint: 'Send the update over HTTPS. Some providers insist on it. Needs curl, wget with SSL or uclient-fetch with SSL on the router.' },
  { key: 'cacert', type: 'string', group: 'connection', label: 'CA certificates', placeholder: '/etc/ssl/certs/ca-certificates.crt', show: v => v.use_https,
    hint: 'The certificates that vouch for the provider: a directory (/etc/ssl/certs) or one file. "IGNORE" uses HTTPS without checking the provider\'s certificate, which is insecure.' },
  { key: 'proxy', type: 'string', check: 'proxy', group: 'connection', label: 'Proxy', placeholder: 'user:password@proxy.example.com:3128',
    hint: 'A proxy for the update (the HTTPS one when HTTPS is on, else the HTTP one), as [user:password@]host:port, port included. The password in it is hidden here; to change it, type the whole value again. Do not detect the address through a web page when a proxy is set: that request would go through it too.' },
  { key: 'bind_network', type: 'enum', dynamic: 'networks', group: 'connection', label: 'Send from network', blank: 'automatic',
    hint: 'Make the updates and the address detection leave through this network. wget binds to its address, curl to its device.' },
  { key: 'force_ipversion', type: 'bool', group: 'connection', label: 'Force the IP version', default: false,
    hint: 'Talk to the provider over IPv4 (or IPv6, with "Update the IPv6 address") only. Some providers register the address the update comes from, so it must match. Needs curl or wget and the host command (bind-host).' },
  { key: 'dns_server', type: 'string', check: 'ddnshost', group: 'connection', label: 'DNS server', placeholder: 'the router\'s resolver',
    hint: 'Look up the registered address at this server instead of the default one: a name or an address, with an optional :port.' },
  { key: 'force_dnstcp', type: 'bool', group: 'connection', label: 'DNS over TCP', default: false,
    hint: 'Send the lookups over TCP. A modem that caches UDP lookups can return a stale address; TCP gets past it. Needs the host command (bind-host).' },
  { key: 'is_glue', type: 'bool', group: 'connection', label: 'The name is a glue record', default: false,
    hint: 'Compare against the glue record at the DNS server named above, for a name that is itself a name server. Needs the host command (bind-host) and a DNS server.' },
  { key: 'rec_id', type: 'string', group: 'connection', label: 'Cloudflare record ID', show: v => v.service_name.startsWith('cloudflare') || v.rec_id !== '',
    hint: 'The record to update when the name has several records at Cloudflare. Without it the updater picks one by itself.' },

  { key: 'check_interval', type: 'int', number: true, min: 1, group: 'timing', label: 'Check every', default: 10, unit: 'check_unit',
    hint: 'How often the updater reads the address and compares it with the registered one. A check shorter than 5 minutes is replaced by the shortest check interval below (5 minutes by default), because DNS takes about that long to catch up.' },
  { key: 'check_unit', type: 'enum', options: UNITS, group: 'timing', label: 'Unit of the check interval', default: 'minutes' },
  { key: 'check_interval_min', type: 'int', number: true, min: 1, group: 'timing', label: 'Shortest check interval', default: 5,
    hint: 'What a check interval below 5 minutes is replaced by, in the unit of the check interval. Set 1 (minutes) to allow checks every minute.' },
  { key: 'force_interval', type: 'int', number: true, min: 0, group: 'timing', label: 'Force an update every', default: 72, unit: 'force_unit',
    hint: 'Send the address even when it has not changed after this long, so a provider that drops idle names keeps the record. At least the check interval; 0 stops the updater after the first successful update.' },
  { key: 'force_unit', type: 'enum', options: UNITS, group: 'timing', label: 'Unit of the forced update', default: 'hours' },
  { key: 'retry_interval', type: 'int', number: true, min: 1, group: 'timing', label: 'Retry after', default: 60, unit: 'retry_unit',
    hint: 'How long to wait before trying again when detecting the address, looking it up or sending the update fails.' },
  { key: 'retry_unit', type: 'enum', options: UNITS, group: 'timing', label: 'Unit of the retry interval', default: 'seconds' },
  { key: 'retry_max_count', type: 'int', number: true, min: 0, group: 'timing', label: 'Give up after this many retries', default: 0,
    hint: '0 retries forever. When the count is reached the updater stops until it is restarted.' },

  { key: 'use_syslog', type: 'enum', options: ['0', '1', '2', '3', '4'], numbered: true, group: 'logging', label: 'System log level', default: '2',
    labels: { 0: 'nothing', 1: 'info, notices, warnings and errors', 2: 'notices, warnings and errors', 3: 'warnings and errors', 4: 'errors only' },
    hint: 'What goes to the system log (see the Logs page). Errors that stop the updater are always logged.' },
  { key: 'use_logfile', type: 'bool', group: 'logging', label: 'Keep a log file', default: true,
    hint: 'Write the updater\'s own log to a file in the log directory (the global setting below); the service card shows it. It is kept in memory and cut to the number of lines set below.' },
];

//#endregion

//#region Global fields

// The options of the `ddns` section named "global". The documentation advises casual users not to change them.
export const GLOBAL_FIELDS = [
  { key: 'upd_privateip', type: 'bool', label: 'Allow private addresses', default: false,
    hint: 'Send private and special addresses (10/8, 172.16/12, 192.168/16, 100.64/10, 127/8, 169.254/16, fc00::/7 and so on) to the provider as well. Off is right unless the provider is inside your own network.' },
  { key: 'ddns_dateformat', type: 'string', label: 'Date format', default: '%F %R', placeholder: '%F %R',
    hint: 'How dates are written in the log, with strftime codes: %F is 2026-11-13, %R is 20:35.' },
  { key: 'ddns_loglines', type: 'int', number: true, min: 1, label: 'Log lines kept', default: 250,
    hint: 'How many lines each log file keeps before the oldest are cut.' },
  { key: 'ddns_rundir', type: 'string', check: 'path', label: 'Run directory', default: '/var/run/ddns', placeholder: '/var/run/ddns',
    hint: 'Where the updater keeps its process, last-update and next-check files (one set per service). It should be in memory, not on flash. This page reads the status from it.' },
  { key: 'ddns_logdir', type: 'string', check: 'path', label: 'Log directory', default: '/var/log/ddns', placeholder: '/var/log/ddns',
    hint: 'Where the log files are kept. It should be in memory, not on flash.' },
  { key: 'use_curl', type: 'bool', label: 'Use curl', default: false,
    hint: 'When both wget and curl are installed wget is used. Turn this on to use curl instead, which binds to a network device and is needed with several WAN interfaces.' },
];

//#endregion

// Seconds in one unit of time.
export const UNIT_SECONDS = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

// The config and the global section's name.
export const CONFIG = 'ddns';
export const GLOBAL_SECTION = 'global';

// The check interval below which ddns-scripts uses the shortest check interval instead, in seconds.
export const CHECK_FLOOR_SECONDS = 300;
