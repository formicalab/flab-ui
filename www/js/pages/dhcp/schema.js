// What the DHCP page edits: every option odhcpd documents for /etc/config/dhcp
// (https://openwrt.org/docs/techref/odhcpd and https://github.com/openwrt/odhcpd/blob/master/README.md), described
// as data in the format of core/fields.js (key, type, label, hint, default, check, min, max, options, items).
// model.js builds the draft, validation and UCI operations from these tables, and the page the controls, so
// supporting another option is one entry here. Options that exist in the file but not here are left untouched.
//
// Three kinds of section are edited:
//   odhcpd  (one)        the daemon itself                                      DAEMON_FIELDS
//   dhcp    (one per interface) DHCPv4, DHCPv6, router advertisements, NDP     POOL_FIELDS, grouped by POOL_GROUPS
//   host    (many)       static leases, called reservations                    HOST_FIELDS
// Creating or deleting dhcp sections (a pool for another interface) is not offered.

export const CONFIG = 'dhcp';

// The daemon section's options.
export const DAEMON_FIELDS = [
  { key: 'maindhcp', type: 'bool', default: false, label: 'Use odhcpd as the main DHCPv4 server',
    hint: 'Without it odhcpd leaves DHCPv4 to another server such as dnsmasq. Switching it off here stops DHCPv4 unless that other server is installed.' },
  { key: 'legacy', type: 'bool', default: false, label: 'Legacy DHCPv4 mode',
    hint: 'Serve DHCPv4 on a pool that has a start option but no dhcpv4 option.' },
  { key: 'loglevel', type: 'int', min: 0, max: 7, default: 6, label: 'Log level (0 to 7)',
    hint: '0 emergency, 1 alert, 2 critical, 3 error, 4 warning, 5 notice, 6 info, 7 debug.' },
  { key: 'enable_tz', type: 'bool', default: true, label: 'Send the time zone to clients',
    hint: 'Options 41 and 42 (RFC 4833) with the zone from the system settings, to clients that ask for them.' },
  { key: 'leasefile', type: 'string', check: 'path', label: 'Lease file', default: '/tmp/odhcpd.leases',
    hint: 'Where the DHCPv4 and DHCPv6 leases are kept; persistent storage keeps leases across reboots.' },
  { key: 'leasetrigger', type: 'string', check: 'path', label: 'Lease trigger script', default: '/usr/sbin/odhcpd-update',
    hint: 'Run when a lease changes.' },
  { key: 'hostsdir', type: 'string', check: 'path', label: 'Hosts files directory', default: '/tmp/hosts',
    hint: 'One hosts file per interface (address to hostname), for example for a DNS resolver.' },
  { key: 'piodir', type: 'string', check: 'path', label: 'Prefix information directory', default: '/tmp/odhcpd-piodir',
    hint: 'Used to detect stale IPv6 prefixes (RFC 9096). Keep it on RAM: flash would wear out.' },
];

// The groups of a pool's options, in order. `open` groups are expanded by default.
export const POOL_GROUPS = [
  { id: 'service', title: 'Services', open: true,
    legend: 'Which services this interface offers to its clients: DHCPv4, DHCPv6, router advertisements (RA) and the neighbor discovery proxy (NDP).' },
  { id: 'v4', title: 'DHCPv4 pool and options', open: true,
    legend: 'The address range is counted from the start of the interface\'s subnet: start 128 and limit 120 on 192.168.1.0/24 serve .128 to .247. The options below are announced to clients; an empty list means the router\'s own address.' },
  { id: 'v6', title: 'DHCPv6', legend: 'Stateful addressing (IA_NA), prefix delegation (IA_PD) and relaying.' },
  { id: 'ra', title: 'Router advertisements', legend: 'What the IPv6 router advertisements tell clients: whether to use SLAAC or DHCPv6, lifetimes, timers and the route preference.' },
  { id: 'ndp', title: 'Neighbor discovery proxy', legend: 'Relaying neighbor discovery between routed interfaces that share a prefix.' },
  { id: 'other', title: 'Other', legend: 'Prefix filter, captive portal and IPv6-only mode.' },
];

const MODES = ['disabled', 'server', 'relay', 'hybrid'];

// The options of a dhcp (pool) section.
export const POOL_FIELDS = [
  // Services
  { key: 'dhcpv4', group: 'service', type: 'enum', options: ['disabled', 'server'], default: 'disabled', label: 'DHCPv4' },
  { key: 'dhcpv6', group: 'service', type: 'enum', options: MODES, default: 'disabled', label: 'DHCPv6' },
  { key: 'ra', group: 'service', type: 'enum', options: MODES, default: 'disabled', label: 'Router advertisements (RA)' },
  { key: 'ndp', group: 'service', type: 'enum', options: ['disabled', 'relay', 'hybrid'], default: 'disabled', label: 'Neighbor discovery proxy (NDP)' },
  { key: 'dynamicdhcp', group: 'service', type: 'bool', default: true, label: 'Create leases dynamically',
    hint: 'Off: only the reservations get an address.' },
  { key: 'ignore', group: 'service', type: 'bool', default: false, label: 'Do not serve this interface',
    hint: 'Unless a service above is set explicitly.' },
  { key: 'master', group: 'service', type: 'bool', default: false, label: 'Master interface for relaying',
    hint: 'The upstream side of a relay.' },

  // DHCPv4
  { key: 'start', group: 'v4', type: 'int', min: 0, default: 100, label: 'Pool start',
    hint: 'First address, as an offset from the start of the subnet.' },
  { key: 'limit', group: 'v4', type: 'int', min: 1, default: 150, label: 'Pool size', hint: 'Number of addresses.' },
  { key: 'leasetime', group: 'v4', type: 'string', check: 'duration', default: '12h', label: 'Lease time',
    hint: 'For example 12h, 30m, 3600 or infinite.' },
  { key: 'router', group: 'v4', type: 'list', check: 'ip4', label: 'Gateways', placeholder: 'e.g. 192.168.1.1', addLabel: 'Add gateway',
    hint: 'IPv4 routers to announce, in order of preference. Empty: this router.' },
  { key: 'dns', group: 'v4', type: 'list', check: 'ip', label: 'DNS servers', placeholder: 'e.g. 192.168.1.1', addLabel: 'Add DNS server',
    hint: 'IPv4 and IPv6 addresses. Empty: this router.' },
  { key: 'dns_service', group: 'v4', type: 'bool', default: true, label: 'Announce this router as the DNS service',
    hint: 'When the list of DNS servers is empty.' },
  { key: 'domain', group: 'v4', type: 'list', check: 'domain', label: 'Search domains', placeholder: 'e.g. lan.example.com', addLabel: 'Add domain',
    hint: 'Announced to clients. Empty: the local domain.' },
  { key: 'ntp', group: 'v4', type: 'list', check: 'ip', label: 'NTP servers', placeholder: 'e.g. 192.168.1.1', addLabel: 'Add NTP server',
    hint: 'IPv4 and IPv6 addresses. Empty: this router.' },
  { key: 'dhcpv4_forcereconf', group: 'v4', type: 'bool', default: false, label: 'Force reconfiguration',
    hint: 'Send a force-renew message even to clients that did not announce support (RFC 6704).' },

  // DHCPv6
  { key: 'dhcpv6_na', group: 'v6', type: 'bool', default: true, label: 'Hand out addresses (IA_NA)' },
  { key: 'dhcpv6_pd', group: 'v6', type: 'bool', default: true, label: 'Hand out prefixes (IA_PD)' },
  { key: 'dhcpv6_assignall', group: 'v6', type: 'bool', default: true, label: 'Assign all viable addresses',
    hint: 'Off: only the address with the longest preferred lifetime.' },
  { key: 'dhcpv6_hostidlength', group: 'v6', type: 'int', min: 12, max: 64, default: 12, label: 'Host ID length (bits)',
    hint: 'Of dynamically created leases, 12 to 64.' },
  { key: 'dhcpv6_pd_min_len', group: 'v6', type: 'int', min: 1, max: 64, default: 62, label: 'Smallest delegated prefix',
    hint: 'Minimum prefix length to delegate, adjusted if needed to be longer than the interface prefix.' },
  { key: 'dhcpv6_pd_preferred', group: 'v6', type: 'bool', default: false, label: 'Set the PD preferred flag',
    hint: 'The P flag in the advertised prefixes (RFC 9762); needs DHCPv6 and IA_PD.' },
  { key: 'dhcpv6_relay_servers', group: 'v6', type: 'list', check: 'ip6', label: 'DHCPv6 servers to relay to', placeholder: 'e.g. fd00::1', addLabel: 'Add server' },

  // Router advertisements
  { key: 'ra_slaac', group: 'ra', type: 'bool', default: true, label: 'Announce SLAAC',
    hint: 'The A flag: prefixes up to 64 bits may be used for stateless address autoconfiguration.' },
  { key: 'ra_flags', group: 'ra', type: 'list', items: ['managed-config', 'other-config', 'home-agent', 'none'], label: 'RA flags', placeholder: 'managed-config', addLabel: 'Add flag',
    hint: 'managed-config: get addresses from DHCPv6; other-config: get other settings (such as DNS) from DHCPv6; home-agent; none. Default: other-config.' },
  { key: 'ra_default', group: 'ra', type: 'enum', options: ['0', '1', '2'], default: '0', label: 'Default route override',
    hint: '0 default, 1 ignore when there is no public address, 2 ignore always.' },
  { key: 'ra_preference', group: 'ra', type: 'enum', options: ['low', 'medium', 'high'], default: 'medium', label: 'Route preference' },
  { key: 'ra_advrouter', group: 'ra', type: 'bool', default: false, label: 'Advertise the router address',
    hint: 'The R flag in the advertised prefixes (RFC 6275).' },
  { key: 'ra_offlink', group: 'ra', type: 'bool', default: false, label: 'Announce prefixes off-link' },
  { key: 'ra_dns', group: 'ra', type: 'bool', default: true, label: 'Announce DNS in the advertisements', hint: 'RFC 8106.' },
  { key: 'ra_useleasetime', group: 'ra', type: 'bool', default: false, label: 'Limit prefix lifetimes by the lease time' },
  { key: 'ra_maxinterval', group: 'ra', type: 'int', min: 4, max: 1800, default: 600, label: 'Longest interval (s)', hint: 'Between unsolicited advertisements.' },
  { key: 'ra_mininterval', group: 'ra', type: 'int', min: 3, max: 1350, default: 200, label: 'Shortest interval (s)', hint: 'Between unsolicited advertisements.' },
  { key: 'ra_lifetime', group: 'ra', type: 'int', min: 0, max: 9000, default: 2700, label: 'Router lifetime (s)', hint: 'Not recommended above 2700 (RFC 9096).' },
  { key: 'max_preferred_lifetime', group: 'ra', type: 'string', check: 'duration', default: '45m', label: 'Longest preferred prefix lifetime' },
  { key: 'max_valid_lifetime', group: 'ra', type: 'string', check: 'duration', default: '90m', label: 'Longest valid prefix lifetime' },
  { key: 'ra_reachabletime', group: 'ra', type: 'int', min: 0, default: 0, label: 'Reachable time (ms)' },
  { key: 'ra_retranstime', group: 'ra', type: 'int', min: 0, default: 0, label: 'Retransmit time (ms)' },
  { key: 'ra_hoplimit', group: 'ra', type: 'int', min: 0, max: 255, default: 0, label: 'Hop limit' },
  { key: 'ra_mtu', group: 'ra', type: 'int', min: 1280, max: 65535, label: 'MTU', placeholder: 'not announced' },
  { key: 'ra_pref64', group: 'ra', type: 'string', check: 'prefix6', label: 'NAT64 prefix (PREF64)', placeholder: 'e.g. 64:ff9b::/96', hint: 'RFC 8781.' },

  // NDP
  { key: 'ndproxy_routing', group: 'ndp', type: 'bool', default: true, label: 'Learn routes from NDP' },
  { key: 'ndproxy_slave', group: 'ndp', type: 'bool', default: false, label: 'External slave interface',
    hint: 'External interfaces only get neighbor discovery for duplicate address detection and for the router itself; add firewall rules for them.' },
  { key: 'ndp_from_link_local', group: 'ndp', type: 'bool', default: true, label: 'Use link-local source addresses',
    hint: 'RFC 4861 and macOS compatibility.' },
  { key: 'ndproxy_static', group: 'ndp', type: 'list', check: 'prefix6', label: 'Static NDP proxy prefixes', placeholder: 'e.g. 2001:db8::/64', addLabel: 'Add prefix' },

  // Other
  { key: 'prefix_filter', group: 'other', type: 'string', check: 'prefix6', default: '::/0', label: 'Prefix filter',
    hint: 'Only on-link prefixes inside this prefix are advertised.' },
  { key: 'captive_portal_uri', group: 'other', type: 'string', check: 'uri', label: 'Captive portal URI', placeholder: 'e.g. https://portal.example.com/api', hint: 'RFC 8910, via DHCPv4, DHCPv6 and RA.' },
  { key: 'ipv6_only_preferred', group: 'other', type: 'int', min: 0, default: 0, label: 'IPv6-only preferred (s)', hint: 'RFC 8925: the V6ONLY_WAIT time; 0 is off.' },
  { key: 'upstream', group: 'other', type: 'list', check: 'ifname', label: 'Upstream interfaces', placeholder: 'e.g. wan', addLabel: 'Add interface',
    hint: 'Where to take NTP and similar settings from when they are not set here.' },
];

// The options of a host (reservation) section, in the order of the table's columns. `mac` and `duid` may hold
// several values; the table edits them as one text separated by spaces.
export const HOST_FIELDS = [
  { key: 'name', type: 'string', check: 'domain', label: 'Name', placeholder: 'hostname' },
  { key: 'ip', type: 'string', check: 'ip4ignore', label: 'IPv4 address', placeholder: 'e.g. 192.168.1.20' },
  { key: 'mac', type: 'string', label: 'MAC address(es)', placeholder: 'aa:bb:cc:dd:ee:ff' },
  { key: 'duid', type: 'string', label: 'DUID(s)', placeholder: 'optional, DHCPv6' },
  { key: 'hostid', type: 'string', check: 'hostid', label: 'IPv6 host ID', placeholder: 'e.g. 10' },
  { key: 'leasetime', type: 'string', check: 'duration', label: 'Lease time', placeholder: 'pool default' },
];
