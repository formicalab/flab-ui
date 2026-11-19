// The options of /etc/config/network that the Devices and Interfaces page edits, as tables of fields in the format of
// core/fields.js (read that file first), with the explanations taken from the OpenWrt documentation
// (https://openwrt.org/docs/guide-user/network/network_configuration, .../ipv4/configuration, .../ipv6/configuration and
// .../wan/wan_interface_protocols) and from netifd's own device and bridge attributes.
//
// On top of the usual field keys, a field here has
//   id         the name of the draft value (default: key); fields of different protocols or device types can share a UCI option name
//              (`broadcast` is an address for a static interface and a flag for a DHCP client) and then need an id of their own
//   key        the UCI option the field reads and writes
//   group      the collapsible group of the card it belongs to (IFACE_GROUPS, DEVICE_GROUPS)
//   protos     for an interface: the protocols the field applies to (default: all editable ones)
//   types      for a device: the device types the field applies to (default: all editable ones); 'plain' is a device with no `type`
//   verify     the name of a check in checks.js for each non-empty value (a list is checked item by item)
//   secret     a write-only value: the router never sends it to the page, which only shows whether one is stored
//   dynamic    the list the page fills the options from: 'devices' (any device a logical interface may use), 'parents' (a device a VLAN
//              device may sit on)
//   defaultFor, hintFor   (interface) a default or a hint per protocol that replaces the field's own (see ifaceField)
//   show       (values) => whether the control is shown for these form values, for an interface field

//#region Protocols and device types

export const CONFIG = 'network';

// The protocols the page edits, in the order of the drop-down: id, label, a one-line description.
export const PROTOS = [
  { id: 'static', label: 'Static address', hint: 'The addresses are typed in here.' },
  { id: 'dhcp', label: 'DHCP client', hint: 'The IPv4 address, gateway and DNS come from a DHCP server (udhcpc).' },
  { id: 'dhcpv6', label: 'DHCPv6 client', hint: 'The IPv6 address and delegated prefix come from the provider (odhcp6c).' },
  { id: 'pppoe', label: 'PPPoE', hint: 'A DSL or fiber login over Ethernet (pppd); it creates the device pppoe-<name>.' },
  { id: 'none', label: 'Unmanaged (none)', hint: 'netifd does not configure the interface: the other settings are ignored.' },
];
export const EDITABLE_PROTOS = PROTOS.map(p => p.id);

// The protocols that run over PPP and so take the PPP style `ipv6` option (0, 1 or auto).
const PPP_PROTOS = ['pppoe'];

// What each protocol the page does not edit makes of an interface, for the read-only cards.
export const OTHER_PROTOS = {
  wireguard: 'WireGuard tunnel (edit it on the WireGuard page or in the file: its keys are write-only secrets)', xfrm: 'IPsec (XFRM) interface', ppp: 'PPP over a modem', pppoa: 'PPP over ATM',
  '3g': '3G modem', qmi: 'QMI modem', ncm: 'NCM modem', mbim: 'MBIM modem', wwan: 'mobile broadband', gre: 'GRE tunnel', gretap: 'GRE tap tunnel', grev6: 'GRE over IPv6',
  vti: 'VTI tunnel', vxlan: 'VXLAN', '6in4': '6in4 tunnel', '6to4': '6to4 tunnel', '6rd': '6rd tunnel', dslite: 'DS-Lite tunnel', l2tp: 'L2TP session', pptp: 'PPTP session',
  relay: 'relayd pseudo-bridge', hnet: 'HNCP home network', map: 'MAP tunnel', openvpn: 'OpenVPN', batadv: 'batman-adv', bonding: 'bonding',
};

// The device types the page edits: id ('plain' is a device section with no `type`), label and description.
export const DEVICE_TYPES = [
  { id: 'bridge', label: 'Bridge', hint: 'Joins ports into one Layer 2 network (a software switch).' },
  { id: '8021q', label: 'VLAN device (802.1Q)', hint: 'The frames carrying one VLAN tag of a port or bridge, as a device of their own.' },
  { id: '8021ad', label: 'VLAN device (802.1ad, QinQ)', hint: 'Like 802.1Q, for the outer (service) tag of stacked VLAN tags.' },
  { id: 'plain', label: 'Settings of an existing device', hint: 'MTU, MAC address, link speed and other options of a port or any device the router already has.' },
];

//#endregion

//#region Interface groups and fields

// The groups of an interface card, in order: id, title and an explanation (legend).
export const IFACE_GROUPS = [
  { id: 'general', title: 'Interface', legend: 'The protocol, the device the interface is bound to and whether it comes up at boot.' },
  { id: 'ipv4', title: 'IPv4 address', legend: 'The addresses of a static interface. An address may carry its prefix length (192.168.1.1/24); the netmask below completes the ones that do not.' },
  { id: 'ipv6', title: 'IPv6 address and prefixes', legend: 'A static IPv6 address and gateway, and how this interface takes part in prefix delegation: a downstream interface asks for a share (ip6assign) of the prefix an upstream interface received.' },
  { id: 'pppoe', title: 'PPPoE login', legend: 'The account the provider gave you. The password is never shown here; leave it empty to keep the stored one.' },
  { id: 'dhcp', title: 'DHCP client options', legend: 'What the DHCP client sends to the server and asks it for. Providers that check the client identity may need these.' },
  { id: 'dhcpv6', title: 'DHCPv6 client options', legend: 'How the DHCPv6 client asks the provider for an address and a prefix.' },
  { id: 'dns', title: 'DNS and default route', legend: 'The resolvers the router itself uses for this interface, and whether the interface installs the default route.' },
  { id: 'advanced', title: 'Advanced', legend: 'Routing tables and other options for special setups.' },
];

// A reusable hint for the `dns` list (the wording differs between a static and a client interface).
const DNS_STATIC = 'DNS servers for this interface. They are used by the router itself (through dnsmasq or Unbound) and offered to DHCP clients of the interface.';
const DNS_CLIENT = 'DNS servers to use besides the ones the provider sends, or only these when "Use the provider\'s DNS servers" is off.';

// The options of an `interface` section. A value in a form is a string, a boolean or a list (see core/fields.js).
export const IFACE_FIELDS = [
  { key: 'proto', type: 'enum', options: EDITABLE_PROTOS, group: 'general', label: 'Protocol', labels: Object.fromEntries(PROTOS.map(p => [p.id, p.label])), blank: 'not set (the interface is ignored)',
    hint: 'How the interface gets its configuration. Changing it removes the options that belong to the old protocol only (for example the addresses of a static interface).' },
  { key: 'device', type: 'enum', dynamic: 'devices', group: 'general', label: 'Device', blank: 'none (set by the protocol or by a Wi-Fi network)',
    hint: 'The device (port, bridge, VLAN device) the interface runs on. "@name" borrows the device of another interface. Leave it empty for protocols that create their own device or for an interface that only Wi-Fi networks use.' },
  { key: 'auto', type: 'bool', group: 'general', label: 'Bring up at boot', default: true,
    hint: 'Start the interface when the router boots. An interface with the protocol "none" does not start by default.' },
  { key: 'disabled', type: 'bool', group: 'general', label: 'Disabled', default: false,
    hint: 'Keep the section in the file but ignore it: the interface is not created.' },
  { key: 'ipv6', id: 'ipv6', type: 'enum', group: 'general', label: 'IPv6', options: ['1', '0'], labels: { 1: 'enabled', 0: 'disabled' }, default: '1',
    hint: 'Whether IPv6 is switched on for this interface.' },
  { key: 'mtu', type: 'int', number: true, min: 68, max: 65535, group: 'general', label: 'MTU', placeholder: 'default',
    hint: 'The largest packet the interface sends, in bytes. Leave it empty for the device\'s own MTU. A PPPoE link normally needs 1492 or lower; IPv6 needs at least 1280.' },
  { key: 'macaddr', type: 'string', verify: 'mac', group: 'general', label: 'MAC address', placeholder: 'the device\'s own',
    hint: 'Override the MAC address of the device the interface runs on, for example to clone the one a provider has registered.' },
  { key: 'force_link', type: 'bool', group: 'general', label: 'Assign addresses even without link', default: false, defaultFor: { static: true },
    hint: 'Assign the address, routes and gateway even while the port has no link. It is on for a static interface by default; for other protocols the settings are applied once the link is up.' },

  { key: 'ipaddr', type: 'list', verify: 'ip4cidr', group: 'ipv4', protos: ['static'], label: 'IPv4 addresses', addLabel: 'Add an address', placeholder: '192.168.1.1/24',
    hint: 'One or more IPv4 addresses of the interface. With a prefix length (/24) or netmask each is complete; otherwise it takes the netmask below.' },
  { key: 'netmask', type: 'string', verify: 'netmask', group: 'ipv4', protos: ['static'], label: 'IPv4 netmask', placeholder: '255.255.255.0',
    hint: 'The netmask for addresses written without a prefix length. Not needed when every address has one.' },
  { key: 'gateway', type: 'string', verify: 'ip4', group: 'ipv4', protos: ['static'], label: 'IPv4 gateway', placeholder: '192.168.1.254',
    hint: 'The default gateway (a router on the interface\'s subnet). Leave it empty on a LAN interface: a gateway makes this interface the one the default route goes out of.' },
  { key: 'broadcast', id: 'broadcast', type: 'string', verify: 'ip4', group: 'ipv4', protos: ['static'], label: 'IPv4 broadcast address', placeholder: 'from the subnet',
    hint: 'Generated from the address and netmask when empty.' },

  { key: 'ip6addr', type: 'list', verify: 'ip6cidr', group: 'ipv6', protos: ['static'], label: 'IPv6 addresses', addLabel: 'Add an address', placeholder: '2001:db8::1/64',
    hint: 'Static IPv6 addresses with their prefix length. Without a length the address is a /128 and gets no route.' },
  { key: 'ip6gw', type: 'string', verify: 'ip6', group: 'ipv6', protos: ['static'], label: 'IPv6 gateway', placeholder: 'fe80::1',
    hint: 'The IPv6 default gateway.' },
  { key: 'ip6assign', type: 'int', number: true, min: 1, max: 128, group: 'ipv6', label: 'Delegate a prefix of length', placeholder: 'none',
    hint: 'Hand this interface a subnet of this length (usually 64) from the prefixes the router has: the delegated one from the provider and the local ULA prefix. The interface then announces it to its clients.' },
  { key: 'ip6hint', type: 'string', verify: 'hint', group: 'ipv6', label: 'Subnet ID hint', placeholder: 'next free', show: v => v.ip6assign !== '',
    hint: 'The hexadecimal subnet number to use for the assigned prefix, so that it stays the same and does not depend on the order the interfaces come up in. With a /60 delegated and /64 assigned, 0 to f.' },
  { key: 'ip6class', type: 'list', verify: 'class', group: 'ipv6', label: 'Prefix classes', addLabel: 'Add a class', placeholder: 'local', show: v => v.ip6assign !== '',
    hint: 'Take prefixes of these classes only, such as the name of the upstream interface or local for the ULA prefix. Empty: every class.' },
  { key: 'ip6ifaceid', id: 'ip6ifaceid', type: 'string', verify: 'ifaceid', group: 'ipv6', protos: ['static', 'dhcp', 'pppoe', 'none'], label: 'IPv6 interface identifier', placeholder: '::1', show: v => v.ip6assign !== '',
    hint: 'The suffix of the address the router takes in the assigned prefix: eui64, random or a fixed one such as ::1:2. Useful with several routers on the LAN.' },
  { key: 'delegate', type: 'bool', group: 'ipv6', label: 'Delegate prefixes to other interfaces', default: true,
    hint: 'Whether prefixes received on this interface may be handed on to the downstream interfaces. Turn it off on an upstream interface that must not give its prefix away.' },

  { key: 'username', type: 'string', verify: 'line', group: 'pppoe', protos: ['pppoe'], label: 'PAP/CHAP username',
    hint: 'The user name of the PPPoE account.' },
  { key: 'password', type: 'string', secret: true, group: 'pppoe', protos: ['pppoe'], label: 'PAP/CHAP password',
    hint: 'Stored in the file but never shown here: leave this empty to keep the stored password, type a new one to replace it.' },
  { key: 'ac', type: 'string', verify: 'line', group: 'pppoe', protos: ['pppoe'], label: 'Access concentrator', placeholder: 'first discovered',
    hint: 'The name of the access concentrator to connect to. Empty: the first one that answers.' },
  { key: 'service', type: 'string', verify: 'line', group: 'pppoe', protos: ['pppoe'], label: 'Service name', placeholder: 'first discovered',
    hint: 'The service name to connect to. Empty: the first one that answers.' },
  { key: 'ac_mac', type: 'string', verify: 'mac', group: 'pppoe', protos: ['pppoe'], label: 'Access concentrator MAC address', placeholder: 'any',
    hint: 'Connect only to the access concentrator (BRAS) with this MAC address.' },
  { key: 'host_uniq', type: 'string', verify: 'hexpairs', group: 'pppoe', protos: ['pppoe'], label: 'Host-Uniq tag', placeholder: 'the process ID',
    hint: 'The PPPoE Host-Uniq tag to send, in hexadecimal. Some providers bind the session to it. Empty: the pppd process ID.' },
  { key: 'keepalive', type: 'string', verify: 'keepalive', group: 'pppoe', protos: ['pppoe'], label: 'LCP echo failure and interval', placeholder: '5 1',
    hint: 'Two numbers: the failed LCP echo requests after which the link is declared down, and the seconds between requests.' },
  { key: 'demand', type: 'int', number: true, min: 0, group: 'pppoe', protos: ['pppoe'], label: 'Inactivity timeout', placeholder: 'always on',
    hint: 'Connect on demand and close the connection after this many idle seconds. Empty: keep the link up.' },
  { key: 'pppd_options', type: 'string', verify: 'line', group: 'pppoe', protos: ['pppoe'], label: 'Extra pppd options', placeholder: 'debug noipv6',
    hint: 'Additional command line arguments for pppd.' },

  { key: 'broadcast', id: 'dhcp_broadcast', type: 'bool', group: 'dhcp', protos: ['dhcp'], label: 'Broadcast flag', default: false,
    hint: 'Set the broadcast flag in DHCP requests, which some providers (cable networks) need.' },
  { key: 'hostname', type: 'string', verify: 'hostname', group: 'dhcp', protos: ['dhcp'], label: 'Host name to send', placeholder: 'the system host name',
    hint: 'The host name in the request (option 12). Use * to send none.' },
  { key: 'clientid', id: 'dhcp_clientid', type: 'string', verify: 'hexpairs', group: 'dhcp', protos: ['dhcp'], label: 'Client identifier', placeholder: 'from the MAC address',
    hint: 'The client identifier (option 61) in hexadecimal. Empty: the default 01 followed by the MAC address, or the router\'s DHCP DUID when one is set.' },
  { key: 'vendorid', type: 'string', verify: 'line', group: 'dhcp', protos: ['dhcp'], label: 'Vendor class', placeholder: 'udhcp <version>',
    hint: 'The vendor class identifier (option 60) the client announces.' },
  { key: 'sendopts', id: 'dhcp_sendopts', type: 'string', verify: 'sendopts', group: 'dhcp', protos: ['dhcp'], label: 'Extra options to send', placeholder: '77:myclass',
    hint: 'Space-separated option:value words, where option is a number or a name such as hostname.' },
  { key: 'reqopts', id: 'dhcp_reqopts', type: 'string', verify: 'reqopts', group: 'dhcp', protos: ['dhcp'], label: 'Extra options to request', placeholder: '43 150',
    hint: 'Space-separated option numbers to ask the server for besides the usual ones.' },
  { key: 'classlessroute', type: 'bool', group: 'dhcp', protos: ['dhcp'], label: 'Accept classless routes', default: true,
    hint: 'Let the DHCP server send static routes (option 121).' },
  { key: 'norelease', id: 'dhcp_norelease', type: 'bool', group: 'dhcp', protos: ['dhcp'], label: 'Keep the lease when the interface stops', default: false,
    hint: 'Do not release the DHCP address when the interface is shut down.' },

  { key: 'reqaddress', type: 'enum', options: ['try', 'force', 'none'], group: 'dhcpv6', protos: ['dhcpv6'], label: 'Request an address', default: 'try',
    labels: { try: 'try (take one if offered)', force: 'force (fail without one)', none: 'none' },
    hint: 'How to ask for a non-temporary address. "force" brings the interface down when the server gives none.' },
  { key: 'reqprefix', type: 'string', verify: 'reqprefix', group: 'dhcpv6', protos: ['dhcpv6'], label: 'Request a prefix', placeholder: 'auto',
    hint: 'auto or 0 asks the provider for a prefix; a number from 1 to 64 hints the length wanted; no asks for a single address and no prefix; a prefix such as 2001:db8::/56 asks for that one.' },
  { key: 'clientid', id: 'dhcpv6_clientid', type: 'string', verify: 'hexpairs', group: 'dhcpv6', protos: ['dhcpv6'], label: 'Client identifier (DUID)', placeholder: 'from the MAC address',
    hint: 'The DHCPv6 client identifier in hexadecimal. Empty: the router\'s default DUID.' },
  { key: 'reqopts', id: 'dhcpv6_reqopts', type: 'string', verify: 'reqopts', group: 'dhcpv6', protos: ['dhcpv6'], label: 'Extra options to request', placeholder: '23 24',
    hint: 'Comma-separated option numbers to ask the server for besides the usual ones.' },
  { key: 'norelease', id: 'dhcpv6_norelease', type: 'bool', group: 'dhcpv6', protos: ['dhcpv6'], label: 'Keep the lease when the interface stops', default: true,
    hint: 'Do not send a RELEASE when the interface goes down, which makes a prefix change after a restart less likely.' },
  { key: 'forceprefix', type: 'bool', group: 'dhcpv6', protos: ['dhcpv6'], label: 'Require a prefix', default: false,
    hint: 'Treat a reply without a prefix as a failure.' },
  { key: 'noslaaconly', type: 'bool', group: 'dhcpv6', protos: ['dhcpv6'], label: 'Do not accept SLAAC-only configuration', default: false,
    hint: 'Insist on DHCPv6 (a router advertisement alone is not enough). Implied when a prefix is requested.' },
  { key: 'sourcefilter', type: 'bool', group: 'dhcpv6', protos: ['dhcpv6'], label: 'Source-based IPv6 routing', default: true,
    hint: 'Route traffic by the source prefix, so each upstream interface only carries its own prefix.' },

  { key: 'dns', type: 'list', verify: 'ip', group: 'dns', label: 'DNS servers', addLabel: 'Add a server', placeholder: '9.9.9.9', protos: ['static', 'dhcp', 'dhcpv6', 'pppoe'],
    hint: DNS_CLIENT, hintFor: { static: DNS_STATIC } },
  { key: 'peerdns', type: 'bool', group: 'dns', protos: ['dhcp', 'dhcpv6', 'pppoe'], label: 'Use the provider\'s DNS servers', default: true,
    hint: 'Use the DNS servers the DHCP server or the peer sends.' },
  { key: 'dns_search', type: 'list', verify: 'domain', group: 'dns', protos: ['static'], label: 'Search domains', addLabel: 'Add a domain', placeholder: 'lan.example.com',
    hint: 'Domains appended to short host names; relevant for lookups made by the router only.' },
  { key: 'dns_metric', type: 'int', number: true, min: 0, group: 'dns', protos: ['static'], label: 'DNS metric', placeholder: '0',
    hint: 'The priority of this interface\'s DNS servers: with several interfaces the lowest metric is asked first.' },
  { key: 'defaultroute', type: 'bool', group: 'dns', protos: ['dhcp', 'dhcpv6', 'pppoe'], label: 'Use the default route from the provider', default: true,
    hint: 'Install a default route through the gateway the provider sent.' },
  { key: 'metric', type: 'int', number: true, min: 0, max: 2147483647, group: 'dns', label: 'Route metric', placeholder: '0',
    hint: 'The metric of the routes this interface installs. With two uplinks the lower metric wins; a higher one makes this a backup.' },

  { key: 'ip4table', type: 'string', verify: 'table', group: 'advanced', label: 'IPv4 routing table', placeholder: 'main',
    hint: 'The routing table for the IPv4 routes of this interface (a number or a name from /etc/iproute2/rt_tables).' },
  { key: 'ip6table', type: 'string', verify: 'table', group: 'advanced', label: 'IPv6 routing table', placeholder: 'main',
    hint: 'The routing table for the IPv6 routes of this interface.' },
];

//#endregion

//#region Device groups and fields

// The groups of a device card, in order.
export const DEVICE_GROUPS = [
  { id: 'general', title: 'Device', legend: 'What the device is and the ports it joins.' },
  { id: 'stp', title: 'Spanning tree and aging', legend: 'Spanning tree prevents loops between bridges; the timers only matter when it is on.' },
  { id: 'multicast', title: 'Multicast', legend: 'IGMP snooping sends multicast only to the ports that asked for it. The intervals are in hundredths of a second.' },
  { id: 'link', title: 'Link', legend: 'Forced link parameters of the port. Leave them empty to let the port negotiate.' },
  { id: 'ip', title: 'Packet handling', legend: 'MTU, MAC address and kernel settings of the device.' },
];

// The options of a `device` section.
export const DEVICE_FIELDS = [
  { key: 'ifname', type: 'enum', dynamic: 'parents', group: 'general', types: ['8021q', '8021ad'], label: 'Base device', blank: 'choose a device',
    hint: 'The port or bridge whose frames carry the VLAN tag.' },
  { key: 'vid', type: 'int', number: true, min: 1, max: 4094, group: 'general', types: ['8021q', '8021ad'], label: 'VLAN ID', placeholder: '1 to 4094',
    hint: 'The VLAN number (1 to 4094). The device is called name by you, usually base.vid.' },

  { key: 'stp', type: 'bool', group: 'stp', types: ['bridge'], label: 'Spanning tree (STP)', default: false,
    hint: 'Detect loops and block the redundant ports. Leave it on when several bridges (or a mesh) can reach each other by more than one path.' },
  { key: 'priority', type: 'int', number: true, min: 0, max: 65535, group: 'stp', types: ['bridge'], label: 'Bridge priority', placeholder: '32767',
    hint: 'The bridge with the lowest priority becomes the root of the spanning tree. Most switches default to 32768.' },
  { key: 'forward_delay', type: 'int', number: true, min: 2, max: 30, group: 'stp', types: ['bridge'], label: 'Forward delay (s)', placeholder: '2',
    hint: 'Seconds a port spends in each of the listening and learning states. The default 2 is below the 802.1D minimum of 4: use at least 4 to work with other vendors\' switches.' },
  { key: 'hello_time', type: 'int', number: true, min: 1, max: 10, group: 'stp', types: ['bridge'], label: 'Hello time (s)', placeholder: '2',
    hint: 'Seconds between spanning-tree packets.' },
  { key: 'max_age', type: 'int', number: true, min: 6, max: 40, group: 'stp', types: ['bridge'], label: 'Max age (s)', placeholder: '20',
    hint: 'Seconds without news from the root bridge before this bridge tries to become the root.' },
  { key: 'ageing_time', type: 'int', number: true, min: 10, max: 1000000, group: 'stp', types: ['bridge'], label: 'MAC aging time (s)', placeholder: '300',
    hint: 'Seconds after which a learned MAC address is forgotten.' },
  { key: 'vlan_filtering', type: 'bool', group: 'general', types: ['bridge'], label: 'VLAN filtering', default: false,
    hint: 'Make the bridge VLAN aware: frames are forwarded according to the bridge VLAN table (the Ethernet ports tab edits it). Switching it on or off changes how every port forwards, so it can cut your connection.' },
  { key: 'bridge_empty', type: 'bool', group: 'general', types: ['bridge'], label: 'Keep the bridge without ports', default: false,
    hint: 'Create the bridge even when no port is in it, for example a bridge that only Wi-Fi networks join.' },
  { key: 'igmp_snooping', type: 'bool', group: 'multicast', types: ['bridge'], label: 'IGMP snooping', default: false,
    hint: 'Send multicast only to ports with a listener or a multicast router, instead of flooding it.' },
  { key: 'multicast_querier', type: 'bool', group: 'multicast', types: ['bridge'], label: 'Multicast querier', default: false,
    hint: 'Let the bridge query for listeners to keep the group table current. Only one querier is elected per subnet. Follows IGMP snooping when not set.' },
  { key: 'query_interval', type: 'int', number: true, min: 1, group: 'multicast', types: ['bridge'], label: 'Query interval (1/100 s)', placeholder: '12500',
    hint: 'Time between general queries: 12500 is 125 seconds.' },
  { key: 'query_response_interval', type: 'int', number: true, min: 1, group: 'multicast', types: ['bridge'], label: 'Query response interval (1/100 s)', placeholder: '1000',
    hint: 'The longest time listeners may take to answer a query. Must be below the query interval.' },
  { key: 'last_member_interval', type: 'int', number: true, min: 1, group: 'multicast', types: ['bridge'], label: 'Last member interval (1/100 s)', placeholder: '100',
    hint: 'How long to wait for answers after a listener leaves a group (the leave latency).' },
  { key: 'hash_max', type: 'int', number: true, min: 1, group: 'multicast', types: ['bridge'], label: 'Multicast hash size', placeholder: '512',
    hint: 'Size of the kernel\'s multicast table; raise it when collisions disable snooping.' },
  { key: 'robustness', type: 'int', number: true, min: 1, group: 'multicast', types: ['bridge'], label: 'Robustness', placeholder: '2',
    hint: 'The startup query count and last member count.' },

  { key: 'autoneg', type: 'bool', group: 'link', types: ['plain'], label: 'Auto-negotiation', default: true,
    hint: 'Negotiate speed and duplex with the link partner. Turn it off only together with a speed.' },
  { key: 'speed', type: 'enum', options: ['10', '100', '1000', '2500', '5000', '10000'], group: 'link', types: ['plain'], label: 'Speed (Mbit/s)', blank: 'negotiated',
    hint: 'Force the speed. The other end must be set the same way.' },
  { key: 'duplex', type: 'enum', options: ['1', '0'], labels: { 1: 'full duplex', 0: 'half duplex' }, group: 'link', types: ['plain'], label: 'Duplex', blank: 'negotiated',
    hint: 'Force full or half duplex.' },
  { key: 'rxpause', type: 'bool', group: 'link', types: ['plain'], label: 'Receive pause frames', default: false,
    hint: 'Honor pause frames: the port stops sending when the other end is overloaded.' },
  { key: 'txpause', type: 'bool', group: 'link', types: ['plain'], label: 'Send pause frames', default: false,
    hint: 'Send pause frames when this port is overloaded.' },
  { key: 'eee', type: 'bool', group: 'link', types: ['plain'], label: 'Energy-Efficient Ethernet', default: false,
    hint: 'Allow the port to sleep between packets (802.3az). Not every driver supports it.' },

  { key: 'macaddr', type: 'string', verify: 'mac', group: 'ip', label: 'MAC address', placeholder: 'the default one',
    hint: 'Override the device\'s MAC address, for example to clone the one a provider has registered.' },
  { key: 'mtu', type: 'int', number: true, min: 68, max: 65535, group: 'ip', label: 'MTU', placeholder: 'default',
    hint: 'The largest packet the device sends, in bytes. A VLAN device or bridge cannot exceed the MTU of the device under it.' },
  { key: 'mtu6', type: 'int', number: true, min: 1280, max: 65535, group: 'ip', label: 'IPv6 MTU', placeholder: 'the MTU',
    hint: 'The MTU for IPv6 only (at least 1280).' },
  { key: 'txqueuelen', type: 'int', number: true, min: 0, max: 1000000, group: 'ip', label: 'Transmit queue length', placeholder: 'default',
    hint: 'The length of the device\'s transmit queue, in packets.' },
  { key: 'ipv6', type: 'bool', group: 'ip', label: 'IPv6', default: true,
    hint: 'Allow IPv6 on the device. Off removes its link-local address too.' },
  { key: 'promisc', type: 'bool', group: 'ip', label: 'Promiscuous mode', default: false,
    hint: 'Receive every frame on the wire, not only those for this device.' },
  { key: 'acceptlocal', type: 'bool', group: 'ip', label: 'Accept packets from local addresses', default: false,
    hint: 'Accept IPv4 packets whose source is one of the router\'s own addresses.' },
  { key: 'sendredirects', type: 'bool', group: 'ip', label: 'Send ICMP redirects', default: true,
    hint: 'Tell hosts of a better first hop when a packet is forwarded back out of the same device.' },
  { key: 'arp', type: 'bool', group: 'ip', label: 'ARP', default: true,
    hint: 'Answer and send ARP on the device. Turn off only for point-to-point devices.' },
  { key: 'proxy_arp', type: 'bool', group: 'ip', label: 'Proxy ARP', default: false,
    hint: 'Answer ARP requests for addresses reachable through other interfaces.' },
  { key: 'igmpversion', type: 'enum', options: ['1', '2', '3'], group: 'ip', label: 'IGMP version', blank: 'kernel default',
    hint: 'The IGMP version the device speaks.' },
  { key: 'mldversion', type: 'enum', options: ['1', '2'], group: 'ip', label: 'MLD version', blank: 'kernel default',
    hint: 'The MLD (IPv6 multicast) version the device speaks.' },
  { key: 'multicast_to_unicast', type: 'bool', group: 'ip', label: 'Multicast to unicast', default: false,
    hint: 'Convert multicast frames to unicast for each listener (the bridge port setting, mainly for Wi-Fi).' },
  { key: 'isolate', type: 'bool', group: 'ip', label: 'Isolate port', default: false,
    hint: 'A bridge port that cannot send frames to other isolated ports of the same bridge.' },
  { key: 'dadtransmits', type: 'int', number: true, min: 0, max: 100, group: 'ip', label: 'DAD transmits', placeholder: '1',
    hint: 'How many IPv6 duplicate address detection probes to send.' },
];

//#endregion

//#region Network-wide settings

// The options of the `globals` section the page edits (the other options of the section are shown read only). The hints follow the OpenWrt documentation
// (network_configuration, section "globals") and netifd's own log levels.
export const GLOBALS_FIELDS = [
  { key: 'ula_prefix', type: 'string', verify: 'ula', label: 'IPv6 ULA prefix', placeholder: 'none',
    hint: 'The unique local IPv6 prefix of this router, a /48 inside fd00::/8 such as fd12:3456:789a::/48, or "auto" to generate one. Interfaces with a delegated prefix length (ip6assign) hand out parts of it, so local IPv6 traffic keeps working without the provider\'s prefix. Changing it renumbers those local addresses.' },
  { key: 'packet_steering', type: 'enum', options: ['0', '1', '2'], labels: { 0: 'disabled', 1: 'enabled', 2: 'enabled for all CPUs' }, default: '0', label: 'Packet steering',
    hint: 'Spread the handling of network packets over the CPUs of the router. Helps a fast connection on a multi-core router; 1 uses the CPUs that fit, 2 uses every CPU.' },
  { key: 'netifd_loglevel', type: 'enum', options: ['0', '1', '2', '3', '4'], labels: { 0: 'critical', 1: 'warning', 2: 'notice', 3: 'info', 4: 'debug' }, default: '2', label: 'netifd log level',
    hint: 'How much netifd, the network daemon, writes to the system log. Notice is the default; use info or debug only while looking for a problem.' },
  { key: 'tcp_l3mdev', type: 'bool', default: false, label: 'TCP sockets reachable across VRFs',
    hint: 'Sets net.ipv4.tcp_l3mdev_accept: a TCP socket outside a VRF accepts connections that arrive in a VRF. Only for setups that use VRFs.' },
  { key: 'udp_l3mdev', type: 'bool', default: false, label: 'UDP sockets reachable across VRFs',
    hint: 'Sets net.ipv4.udp_l3mdev_accept: a UDP socket outside a VRF accepts packets that arrive in a VRF. Only for setups that use VRFs.' },
];

// The options of the `globals` section the page shows but does not edit: the default DHCP DUID is generated on the first boot and identifies the router to
// its provider, so a mistake could cost the lease.
export const GLOBALS_READONLY = [
  { key: 'dhcp_default_duid', label: 'Default DHCP DUID', hint: 'The identifier of this router as a DHCP client and server, generated on the first boot. Some providers refuse a type 4 DUID; remove it in the file to fall back to one made from the MAC address.' },
];

//#endregion

//#region Field lookups

// The id of a field's draft value.
export const idOf = f => f.id ?? f.key;

// An interface field as it reads for a protocol: the default, the hint and the choices that depend on it.
export function ifaceField(f, proto) {
  let g = f;
  if (f.defaultFor && proto in f.defaultFor) g = { ...g, default: f.defaultFor[proto] };
  if (f.hintFor?.[proto]) g = { ...g, hint: f.hintFor[proto] };
  if (f.key === 'auto' && proto === 'none') g = { ...g, default: false };
  // A PPP link takes 0, 1 or auto here; every other protocol a plain on/off.
  if (f.key === 'ipv6' && PPP_PROTOS.includes(proto)) {
    g = { ...g, options: ['auto', '1', '0'], default: 'auto', labels: { auto: 'automatic (DHCPv6 on the PPP link)', 1: 'on, negotiated on the link only', 0: 'disabled' },
      hint: 'auto starts a DHCPv6 client on the PPP link; 1 only negotiates IPv6 on the link (give the wan6 interface the device @<name> for the rest); 0 disables IPv6.' };
  }
  return g;
}

// The interface fields that apply to a protocol and, for those with a `show` rule, to these form values; each as it reads for the protocol.
export function ifaceFields(proto, values = null) {
  return IFACE_FIELDS.filter(f => (!f.protos || f.protos.includes(proto)) && (!values || !f.show || f.show(values))).map(f => ifaceField(f, proto));
}

// The device fields that apply to a device type ('bridge', '8021q', '8021ad' or 'plain').
export function deviceFields(type) {
  return DEVICE_FIELDS.filter(f => !f.types || f.types.includes(type));
}

// The device type the page uses for a section's `type` option: '' (no type) is 'plain'; other types are kept as they are.
export const deviceType = raw => (raw === undefined || raw === null || raw === '' ? 'plain' : String(raw));

// Whether the page edits devices of this type.
export const editableDevice = type => DEVICE_TYPES.some(t => t.id === type);

//#endregion
