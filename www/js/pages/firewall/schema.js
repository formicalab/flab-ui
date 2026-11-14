// The options of /etc/config/firewall (firewall4, fw4) that the Firewall page edits, as tables of fields in the format of
// core/fields.js (read that file first), with the explanations taken from the OpenWrt documentation
// (https://openwrt.org/docs/guide-user/firewall/firewall_configuration) and from fw4's own option parser.
//
// On top of the usual field keys, a field here may have
//   group     the group of the dialog it is in (the *_GROUPS tables)
//   control   a control of its own: 'networks' (the router's interfaces as check boxes), 'zones' (zone names as check boxes),
//             'choices' (check boxes for `items` plus free values), 'weekdays' (the days of a rule's schedule)
//   zone      'src' | 'dest' | 'srcOnly' | 'destOnly': a drop-down of the zones (the page fills in the options); a rule may also use "*"
//   check     the name of a check in check.js (a function of the value); the model runs it on every non-empty value
//   show      (values) => whether the control is shown for these values; a hidden option keeps its value and is not validated
//   fallback  the value the form shows when the option is absent (the value the firewall really uses)
//   always    a new section always gets this option written, even when it holds the default
//   caseless  fw4 reads the value without regard to case and by its first letters: the form shows the listed spelling
//   alias     another option name that holds the same setting (read when the main one is absent)
//   snat      for a port forward: the label, hint, placeholder and `required` this field has when its kind is SNAT
//   required  an error when empty (while the field is shown)

export const CONFIG = 'firewall';

// The three verdicts a zone policy, the defaults and a rule target can have.
export const POLICIES = ['ACCEPT', 'REJECT', 'DROP'];
const POLICY_LABELS = { ACCEPT: 'ACCEPT: let it through', REJECT: 'REJECT: refuse and tell the sender', DROP: 'DROP: discard silently' };

// The names an ICMP type may have in fw4 (either family), besides numbers such as 3 or 3/1 (type/code).
export const ICMP_TYPES = [
  'any', 'echo-request', 'echo-reply', 'ping', 'pong', 'destination-unreachable', 'network-unreachable', 'host-unreachable', 'protocol-unreachable',
  'port-unreachable', 'fragmentation-needed', 'source-route-failed', 'network-unknown', 'host-unknown', 'network-prohibited', 'host-prohibited',
  'TOS-network-unreachable', 'TOS-host-unreachable', 'communication-prohibited', 'host-precedence-violation', 'precedence-cutoff', 'source-quench',
  'redirect', 'network-redirect', 'host-redirect', 'TOS-network-redirect', 'TOS-host-redirect', 'router-advertisement', 'router-solicitation',
  'time-exceeded', 'ttl-exceeded', 'ttl-zero-during-transit', 'ttl-zero-during-reassembly', 'parameter-problem', 'ip-header-bad',
  'required-option-missing', 'timestamp-request', 'timestamp-reply', 'address-mask-request', 'address-mask-reply',
  'no-route', 'address-unreachable', 'packet-too-big', 'bad-header', 'unknown-header-type', 'unknown-option', 'multicast-listener-query',
  'multicast-listener-report', 'multicast-listener-done', 'neighbour-solicitation', 'neighbor-solicitation', 'neighbour-advertisement',
  'neighbor-advertisement', 'router-renumbering', 'node-info-query', 'node-info-response', 'inverse-neighbour-discovery-solicitation-message',
  'inverse-neighbor-discovery-solicitation-message', 'inverse-neighbour-discovery-advertisement-message',
  'inverse-neighbor-discovery-advertisement-message', 'v2-multicast-listener-report', 'home-agent-address-discovery-request-message',
  'home-agent-address-discovery-reply-message', 'mobile-prefix-solicitation', 'mobile-prefix-advertisement',
  'certification-path-solicitation-message', 'certification-path-advertisement-message', 'seamoby-protocol-message',
  'multicast-router-advertisement', 'multicast-router-solicitation', 'multicast-router-termination', 'fmipv6-message', 'rpl-control-message',
  'ilnpv6-locator-update-message', 'duplicate-address-request', 'duplicate-address-confirmation', 'mpl-control-message',
];

// The protocols offered as check boxes (any other name from /etc/protocols or a number can be added next to them). `all` means every protocol.
export const PROTOCOLS = ['tcp', 'udp', 'icmp', 'icmpv6', 'esp', 'ah', 'gre', 'sctp', 'udplite', 'all'];

// The days of a rule's schedule: the value written to the file, and the label.
export const WEEKDAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

// The targets the page offers for a traffic rule.
export const RULE_TARGETS = ['ACCEPT', 'REJECT', 'DROP', 'MARK', 'NOTRACK'];

//#region Zones

// The groups of the zone dialog, in order: id, title, an explanation and whether the group starts open.
export const ZONE_GROUPS = [
  { id: 'general', title: 'Zone', open: true, legend: 'The name and the default verdict for each direction. A zone groups interfaces; rules, forwardings and port forwards refer to it by name.' },
  { id: 'members', title: 'What belongs to the zone', open: true, legend: 'The interfaces, devices and subnets that make up the zone. An interface can be in one zone only.' },
  { id: 'nat', title: 'Address translation and MSS', open: true, legend: 'Masquerading hides the zone\'s addresses behind the router\'s when traffic leaves through it (normally the zone that faces the Internet).' },
  { id: 'logging', title: 'Logging and helpers', legend: 'Log dropped and rejected packets of the zone, and the connection tracking helpers for its protocols.' },
];

// The options of a `zone` section.
export const ZONE_FIELDS = [
  { key: 'name', type: 'string', group: 'general', label: 'Name', placeholder: 'e.g. guest', check: 'zoneName', required: true,
    hint: 'Letters, digits and . _ - / (it must start with a letter, a dot or an underscore). Rules, forwardings and port forwards refer to the zone by this name, so it cannot be changed once saved.' },
  { key: 'enabled', type: 'bool', group: 'general', label: 'Enabled', default: true,
    hint: 'A disabled zone stays in the file but the firewall ignores it (and every rule that refers to it).' },
  { key: 'input', type: 'enum', options: POLICIES, labels: POLICY_LABELS, caseless: true, group: 'general', label: 'Input policy',
    hint: 'What happens to traffic from this zone to the router itself, unless a rule says otherwise. When empty the value of the global defaults is used.' },
  { key: 'output', type: 'enum', options: POLICIES, labels: POLICY_LABELS, caseless: true, group: 'general', label: 'Output policy',
    hint: 'What happens to traffic from the router itself into this zone, unless a rule says otherwise. When empty the value of the global defaults is used.' },
  { key: 'forward', type: 'enum', options: POLICIES, labels: POLICY_LABELS, caseless: true, group: 'general', label: 'Forward policy',
    hint: 'What happens to traffic between two interfaces of this same zone. Traffic to other zones is allowed by forwardings (tick them under "Traffic to and from other zones" below). When empty the value of the global defaults is used.' },

  { key: 'network', type: 'list', control: 'networks', group: 'members', label: 'Interfaces',
    hint: 'The router\'s network interfaces (from /etc/config/network) in this zone. An interface can be in one zone only: choosing one that is in another zone moves it here. With nothing chosen here, and no device or subnet, the firewall looks for an interface with the name of the zone.' },
  { key: 'device', type: 'list', check: 'device', group: 'members', label: 'Devices', addLabel: 'Add device', placeholder: 'e.g. tun+',
    hint: 'Kernel network devices that are not interfaces of the router, for example tun+ or ppp+ for every TUN or PPP device (an OpenVPN server). Prefer Interfaces when the device is one.' },
  { key: 'subnet', type: 'list', check: 'subnet', group: 'members', label: 'Subnets', addLabel: 'Add subnet', placeholder: 'e.g. 192.0.2.0/24',
    hint: 'IP subnets that belong to this zone, whatever interface they arrive on: an address, a CIDR subnet or a range. Use ! in front to exclude.' },
  { key: 'family', type: 'enum', options: ['ipv4', 'ipv6', 'any'], labels: { ipv4: 'IPv4 only', ipv6: 'IPv6 only', any: 'IPv4 and IPv6' }, caseless: true, group: 'members', label: 'Address family', blank: 'Automatic',
    hint: 'The address family the zone\'s rules are generated for. Automatic follows the addresses in the zone\'s other options, and means both when there are none.' },

  { key: 'masq', type: 'bool', group: 'nat', label: 'Masquerade IPv4 (NAT)', default: false,
    hint: 'Rewrite the source address of outgoing IPv4 traffic to the router\'s own address on the way out. Turn it on for the zone that faces the Internet. A zone with NAT is treated as the Internet side by this page.' },
  { key: 'masq6', type: 'bool', group: 'nat', label: 'Masquerade IPv6', default: false,
    hint: 'The same for IPv6 (fw4 only). A DHCPv6 interface without a global prefix also needs sourcefilter=0 in its network settings.' },
  { key: 'masq_src', type: 'list', check: 'subnet', group: 'nat', label: 'Masquerade only these sources', addLabel: 'Add subnet', placeholder: 'e.g. 192.168.1.0/24', show: v => v.masq || v.masq6,
    hint: 'Limit masquerading to traffic from these subnets; with ! in front a subnet is excluded. Empty: every source.' },
  { key: 'masq_dest', type: 'list', check: 'subnet', group: 'nat', label: 'Masquerade only these destinations', addLabel: 'Add subnet', placeholder: 'e.g. !10.0.0.0/8', show: v => v.masq || v.masq6,
    hint: 'Limit masquerading to traffic going to these subnets; with ! in front a subnet is excluded. Empty: every destination.' },
  { key: 'masq_allow_invalid', type: 'bool', group: 'nat', label: 'Allow invalid packets through masquerading', default: false, show: v => v.masq || v.masq6,
    hint: 'Do not add the rules that drop invalid packets of masqueraded traffic. Those rules prevent NAT leakage, so leave this off unless a broken peer needs it.' },
  { key: 'mtu_fix', type: 'bool', group: 'nat', label: 'MSS clamping', default: false,
    hint: 'Adjust the TCP maximum segment size of outgoing connections to the path MTU. Turn it on for a zone that faces a link with a smaller MTU than the LAN (PPPoE, a tunnel).' },

  { key: 'log', type: 'enum', options: ['0', '1', '2', '3'], labels: { 0: 'Nothing', 1: 'Dropped and rejected traffic (filter)', 2: 'Mangle table', 3: 'Filter and mangle' }, group: 'logging', label: 'Logging', default: '0',
    hint: 'A bit field in the file: bit 0 logs what the zone\'s rules drop or reject, bit 1 logs in the mangle table. The messages go to the system log.' },
  { key: 'log_limit', type: 'string', check: 'limit', group: 'logging', label: 'Log rate limit', default: '10/minute', placeholder: '10/minute', show: v => v.log !== '0',
    hint: 'At most this many log messages per second, minute, hour or day, for example 10/minute.' },
  { key: 'auto_helper', type: 'bool', group: 'logging', label: 'Connection tracking helpers', default: true,
    hint: 'Load the connection tracking helpers (FTP, SIP, ...) for this zone so that protocols that open extra connections work through the firewall.' },
];

//#endregion

//#region Traffic rules

// The groups of the rule dialog.
export const RULE_GROUPS = [
  { id: 'what', title: 'What the rule does', open: true, legend: 'The name, the verdict and the direction. Source and destination decide the kind of traffic the rule is about: both set is traffic forwarded through the router; only a source is traffic to the router itself; only a destination is traffic from the router; neither is traffic from the router.' },
  { id: 'match', title: 'Which traffic', open: true, legend: 'Only traffic that matches every field set here is affected. An empty field matches anything.' },
  { id: 'limits', title: 'Rate limit and mark', legend: 'Limit how many packets the rule matches, or set the mark of the packets it matches.' },
  { id: 'time', title: 'Schedule', legend: 'Apply the rule only at certain times. All times are the router\'s local time unless "Use UTC" is on. The router needs a correct clock for a schedule to be meaningful.' },
];

// The fields that make a schedule, shared by rules and port forwards.
const SCHEDULE_FIELDS = group => [
  { key: 'start_time', type: 'string', check: 'time', group, label: 'From time of day', placeholder: 'hh:mm:ss', hint: 'Match traffic after this time of day (inclusive), for example 08:00.' },
  { key: 'stop_time', type: 'string', check: 'time', group, label: 'Until time of day', placeholder: 'hh:mm:ss', hint: 'Match traffic before this time of day (inclusive), for example 18:30.' },
  { key: 'weekdays', type: 'string', control: 'weekdays', check: 'weekdays', group, label: 'Days of the week', hint: 'Match traffic only on these days. "Every day except" turns the list round.' },
  { key: 'start_date', type: 'string', check: 'date', group, label: 'From date', placeholder: 'yyyy-mm-dd', hint: 'Match traffic from this date on (inclusive).' },
  { key: 'stop_date', type: 'string', check: 'date', group, label: 'Until date', placeholder: 'yyyy-mm-dd', hint: 'Match traffic up to this date (inclusive).' },
  { key: 'utc_time', type: 'bool', group, label: 'Use UTC for the times', default: false, hint: 'Read the times and dates above as UTC instead of the router\'s local time.' },
];

// The options of a `rule` section.
export const RULE_FIELDS = [
  { key: 'name', type: 'string', group: 'what', label: 'Name', placeholder: 'e.g. Allow-SSH', hint: 'A description. The firewall uses it to label the rule in the ruleset and its counters. Without a name the rule is shown as @rule[N].' },
  { key: 'enabled', type: 'bool', group: 'what', label: 'Enabled', default: true, hint: 'A disabled rule stays in the file but the firewall ignores it.' },
  { key: 'target', type: 'enum', options: RULE_TARGETS, labels: { ACCEPT: 'ACCEPT: let it through', REJECT: 'REJECT: refuse and tell the sender', DROP: 'DROP: discard silently', MARK: 'MARK: set the packet mark', NOTRACK: 'NOTRACK: skip connection tracking' }, caseless: true,
    group: 'what', label: 'Action', fallback: 'DROP', always: true, hint: 'What to do with matching traffic. DROP is the firewall\'s default when no action is set.' },
  { key: 'src', type: 'enum', zone: 'src', group: 'what', label: 'Source zone', hint: 'The zone the traffic comes from. "Any zone" matches every zone. Empty: the traffic comes from the router itself.' },
  { key: 'dest', type: 'enum', zone: 'dest', group: 'what', label: 'Destination zone', hint: 'The zone the traffic goes to. With a source zone too the rule is about forwarded traffic; without one it is about traffic from the router. Empty with a source zone: the traffic goes to the router itself.' },
  { key: 'family', type: 'enum', options: ['ipv4', 'ipv6', 'any'], labels: { ipv4: 'IPv4 only', ipv6: 'IPv6 only', any: 'IPv4 and IPv6' }, caseless: true, group: 'what', label: 'Address family', blank: 'Automatic',
    hint: 'The address family the rule is generated for. Automatic follows the addresses in the rule, and means both when it has none.' },

  { key: 'proto', type: 'list', control: 'choices', items: PROTOCOLS, check: 'protocol', group: 'match', label: 'Protocols',
    hint: 'The protocols to match. With nothing chosen the rule matches TCP and UDP. "all" matches every protocol. Any other name from /etc/protocols, or a number, can be added.' },
  { key: 'icmp_type', type: 'list', check: 'icmp', group: 'match', label: 'ICMP types', addLabel: 'Add ICMP type', placeholder: 'e.g. echo-request', suggest: ICMP_TYPES, show: v => v.proto.some(p => /^(icmp|icmpv6|ipv6-icmp|1|58)$/i.test(p)),
    hint: 'Match only these ICMP message types, by name (echo-request, destination-unreachable, ...) or as type or type/code numbers (3 or 3/1). Empty: every type.' },
  { key: 'src_ip', type: 'list', check: 'subnet', group: 'match', label: 'Source addresses', addLabel: 'Add address', placeholder: 'e.g. 192.168.1.0/24',
    hint: 'Match traffic from these addresses: an address, a CIDR subnet, a range (a-b) or the name of an interface; ! in front excludes. A rule with a source address but no destination zone is about the router itself.' },
  { key: 'src_mac', type: 'list', check: 'mac', group: 'match', label: 'Source MAC addresses', addLabel: 'Add MAC address', placeholder: '00:11:22:33:44:55', hint: 'Match traffic from these hardware addresses; ! in front excludes.' },
  { key: 'src_port', type: 'list', check: 'port', group: 'match', label: 'Source ports', addLabel: 'Add port', placeholder: 'e.g. 1024-65535',
    hint: 'Match traffic from these ports or port ranges (start-stop). Needs TCP or UDP.' },
  { key: 'dest_ip', type: 'list', check: 'subnet', group: 'match', label: 'Destination addresses', addLabel: 'Add address', placeholder: 'e.g. 192.168.1.10',
    hint: 'Match traffic to these addresses (same forms as the source). With no destination zone this is about traffic to the router itself.' },
  { key: 'dest_port', type: 'list', check: 'port', group: 'match', label: 'Destination ports', addLabel: 'Add port', placeholder: 'e.g. 22 or 6666-6670',
    hint: 'Match traffic to these ports or port ranges (start-stop). Needs TCP or UDP.' },

  { key: 'limit', type: 'string', check: 'limit', group: 'limits', label: 'Rate limit', placeholder: 'e.g. 3/minute', hint: 'The most packets per second, minute, hour or day that match, as a number with an optional /second, /minute, /hour or /day, for example 3/min.' },
  { key: 'limit_burst', type: 'int', min: 0, number: true, group: 'limits', label: 'Burst', default: 5, show: v => v.limit !== '', hint: 'How many packets may match at the start before the limit applies.' },
  { key: 'set_mark', type: 'string', check: 'mark', group: 'limits', label: 'Set mark', placeholder: 'e.g. 0x1/0xff', show: v => v.target === 'MARK', hint: 'The target MARK sets the packet mark: zero the bits of the mask and set the value (value/mask; without a mask the whole mark).' },
  { key: 'set_xmark', type: 'string', check: 'mark', group: 'limits', label: 'XOR into the mark', placeholder: 'e.g. 0x1/0xff', show: v => v.target === 'MARK', hint: 'Alternatively XOR the value into the mark, under the mask. One of the two marks is needed.' },

  ...SCHEDULE_FIELDS('time'),
];

//#endregion

//#region Port forwards

// The groups of the port forward dialog.
export const REDIRECT_GROUPS = [
  { id: 'what', title: 'What it does', open: true, legend: 'A port forward (DNAT) sends traffic that arrives on the router at an address and port to a host inside, or to another port of the router itself. A source NAT rewrites the source address of traffic that leaves.' },
  { id: 'from', title: 'Traffic it matches', open: true, legend: 'Only traffic that matches every field set here is forwarded. Without a destination port every port of the protocol matches, which exposes the target on all of them.' },
  { id: 'to', title: 'Where it goes', open: true, legend: 'The host and port the traffic is sent to.' },
  { id: 'reflection', title: 'NAT reflection', legend: 'Lets hosts inside reach the forwarded service through the router\'s public address, as the Internet does.' },
  { id: 'time', title: 'Rate limit and schedule', legend: 'Limit how many connections match, or apply the forward only at certain times.' },
];

// The options of a `redirect` section.
export const REDIRECT_FIELDS = [
  { key: 'name', type: 'string', group: 'what', label: 'Name', placeholder: 'e.g. Web server', hint: 'A description. The firewall uses it to label the rule in the ruleset and its counters.' },
  { key: 'enabled', type: 'bool', group: 'what', label: 'Enabled', default: true, hint: 'A disabled forward stays in the file but the firewall ignores it.' },
  { key: 'target', type: 'enum', options: ['DNAT', 'SNAT'], labels: { DNAT: 'DNAT: forward to an internal host', SNAT: 'SNAT: rewrite the source address' }, caseless: true, group: 'what', label: 'Kind', fallback: 'DNAT', always: true,
    hint: 'DNAT is a port forward. SNAT rewrites the source address of matching traffic to the address given under "Rewrite the source address to". The firewall treats any other value as DNAT.' },
  { key: 'family', type: 'enum', options: ['ipv4', 'ipv6', 'any'], labels: { ipv4: 'IPv4 only', ipv6: 'IPv6 only', any: 'IPv4 and IPv6' }, caseless: true, group: 'what', label: 'Address family', blank: 'Automatic',
    hint: 'The address family the forward is generated for. Automatic follows the addresses in it (IPv4 when it has none).' },
  { key: 'proto', type: 'list', control: 'choices', items: PROTOCOLS, check: 'protocol', group: 'what', label: 'Protocols',
    hint: 'The protocols to match. With nothing chosen: TCP and UDP.' },

  { key: 'src', type: 'enum', zone: 'srcOnly', group: 'from', label: 'Source zone', hint: 'The zone the traffic arrives from. A port forward needs one (usually the zone that faces the Internet) and "any zone" is not allowed.' },
  { key: 'src_dip', type: 'string', check: 'subnetOne', group: 'from', label: 'Arrives at the address', placeholder: 'e.g. 203.0.113.5',
    hint: 'Match only traffic sent to this address of the router (useful when the router has several public addresses). Empty: any address.',
    snat: { label: 'Rewrite the source address to', required: true, hint: 'The source address the traffic gets. Required for SNAT.' } },
  { key: 'src_dport', type: 'string', check: 'portOne', group: 'from', label: 'Arrives at the port', placeholder: 'e.g. 8080 or 6666-6670',
    hint: 'The port or port range on the router the traffic is sent to. One port or one range only. Without it every port matches and the target is exposed on all of them.',
    snat: { label: 'Rewrite the source port to', placeholder: 'e.g. 4000-4100', hint: 'The source port or port range the traffic gets. Empty: the port is kept. One port or one range only.' } },
  { key: 'src_ip', type: 'string', check: 'subnetOne', group: 'from', label: 'Only from address', placeholder: 'e.g. 198.51.100.0/24',
    hint: 'Match traffic from this address or subnet only (! in front excludes). Empty: anywhere.',
    snat: { label: 'Rewrite traffic from these addresses', hint: 'Match traffic from this address or subnet (! in front excludes). Empty: any source in the source zone.' } },
  { key: 'src_port', type: 'string', check: 'portOne', group: 'from', label: 'Only from port', placeholder: 'e.g. 1024-65535', hint: 'Match traffic from this source port or range only. One port or one range.' },
  { key: 'src_mac', type: 'list', check: 'mac', group: 'from', label: 'Only from MAC address', addLabel: 'Add MAC address', placeholder: '00:11:22:33:44:55', show: v => v.target !== 'SNAT', hint: 'Match traffic from these hardware addresses only; ! in front excludes.' },

  { key: 'dest', type: 'enum', zone: 'destOnly', group: 'to', label: 'Destination zone', hint: 'The zone of the internal host. Optional for a port forward: when empty, the firewall uses the zone that holds the internal address. Required for SNAT (and "any zone" is not allowed).' },
  { key: 'dest_ip', type: 'string', check: 'subnetOne', group: 'to', label: 'Internal address', placeholder: 'e.g. 192.168.1.10',
    hint: 'The host the traffic is sent to. Without it the traffic is redirected to the router itself (a local port redirect).',
    snat: { label: 'Only to address', hint: 'Match traffic sent to this address or subnet only. Empty: any destination.' } },
  { key: 'dest_port', type: 'string', check: 'portOne', group: 'to', label: 'Internal port', placeholder: 'e.g. 80',
    hint: 'The port of the target to send the traffic to. Empty: the port it arrived at. One port or one range only.',
    snat: { label: 'Only to port', hint: 'Match traffic sent to this port or range only. One port or one range only.' } },

  { key: 'reflection', type: 'bool', group: 'reflection', label: 'NAT reflection', default: true, show: v => v.target !== 'SNAT',
    hint: 'Hosts in the destination zone that connect to the router\'s public address reach the target as well (fw4 adds the rules that make it work).' },
  { key: 'reflection_src', type: 'enum', options: ['internal', 'external'], labels: { internal: 'The router\'s address on the internal interface', external: 'The router\'s public address' }, caseless: true, group: 'reflection', label: 'Source address of reflected traffic', default: 'internal', show: v => v.target !== 'SNAT' && v.reflection,
    hint: 'Which address the reflected packets are sent from. "Internal" is what most setups want.' },
  { key: 'reflection_zone', type: 'list', control: 'zones', group: 'reflection', label: 'Reflection zones', show: v => v.target !== 'SNAT' && v.reflection,
    hint: 'Zones whose hosts get reflection. Empty: the destination zone.' },

  { key: 'limit', type: 'string', check: 'limit', group: 'time', label: 'Rate limit', placeholder: 'e.g. 3/minute', hint: 'The most packets per second, minute, hour or day that match, for example 3/min.' },
  { key: 'limit_burst', type: 'int', min: 0, number: true, group: 'time', label: 'Burst', default: 5, show: v => v.limit !== '', hint: 'How many packets may match at the start before the limit applies.' },
  ...SCHEDULE_FIELDS('time'),
];

//#endregion

//#region Forwardings

// The options of a `forwarding` section. The matrix creates and removes these; the list under it shows what else a section can hold.
export const FORWARDING_FIELDS = [
  { key: 'name', type: 'string', label: 'Name', hint: 'A description (optional).' },
  { key: 'enabled', type: 'bool', label: 'Enabled', default: true, hint: 'A disabled forwarding stays in the file but the firewall ignores it.' },
  { key: 'src', type: 'string', label: 'From zone', hint: 'The zone the traffic comes from.' },
  { key: 'dest', type: 'string', label: 'To zone', hint: 'The zone the traffic goes to.' },
  { key: 'family', type: 'enum', options: ['ipv4', 'ipv6', 'any'], caseless: true, label: 'Address family', blank: 'Automatic', hint: 'The address family the forwarding is generated for.' },
];

//#endregion

//#region Global defaults

// The groups of the defaults card.
export const DEFAULT_GROUPS = [
  { id: 'policy', title: 'Default policies', open: true, legend: 'The verdict for traffic that no zone, rule or forwarding decides. A zone with an empty policy uses these. Without a value the firewall drops (OpenWrt\'s own configuration sets input and forward to REJECT and output to ACCEPT).' },
  { id: 'protection', title: 'Protection', open: true, legend: 'Basic protections of the router and the traffic through it.' },
  { id: 'offload', title: 'Flow offloading', open: true, legend: 'Lets established connections skip most of the firewall and routing code, so the router forwards faster with less CPU. It needs a kernel and a device that support it, and it bypasses some features (traffic shaping, packet marks, some per-packet rules).' },
  { id: 'advanced', title: 'Advanced', legend: 'Kernel and connection tracking switches. The defaults are right for nearly every router.' },
];

// The options of the `defaults` section.
export const DEFAULT_FIELDS = [
  { key: 'input', type: 'enum', options: POLICIES, labels: POLICY_LABELS, caseless: true, group: 'policy', label: 'Input', default: 'DROP', hint: 'Traffic to the router itself, from a zone that has no policy of its own.' },
  { key: 'output', type: 'enum', options: POLICIES, labels: POLICY_LABELS, caseless: true, group: 'policy', label: 'Output', default: 'DROP', hint: 'Traffic from the router itself, into a zone that has no policy of its own.' },
  { key: 'forward', type: 'enum', options: POLICIES, labels: POLICY_LABELS, caseless: true, group: 'policy', label: 'Forward', default: 'DROP', hint: 'Traffic between interfaces of one zone, for a zone that has no policy of its own.' },

  { key: 'drop_invalid', type: 'bool', group: 'protection', label: 'Drop invalid packets', default: false, hint: 'Drop packets that do not belong to any connection and cannot start one (for example a stray TCP segment).' },
  { key: 'synflood_protect', alias: 'syn_flood', type: 'bool', group: 'protection', label: 'SYN-flood protection', default: false, hint: 'Rate limit the TCP connection requests (SYN packets) the router accepts, so that a flood cannot exhaust it.' },
  { key: 'synflood_rate', type: 'string', check: 'limit', group: 'protection', label: 'SYN rate', default: '25/second', placeholder: '25/second', show: v => v.synflood_protect, hint: 'The rate of SYN packets above which traffic counts as a flood.' },
  { key: 'synflood_burst', type: 'int', min: 0, number: true, group: 'protection', label: 'SYN burst', default: 50, show: v => v.synflood_protect, hint: 'How many SYN packets may exceed the rate at the start before they are treated as a flood.' },
  { key: 'tcp_reject_code', type: 'enum', options: ['tcp-reset', 'port-unreachable', 'admin-prohibited', 'host-unreachable', 'no-route'], caseless: true, group: 'protection', label: 'Answer to rejected TCP', default: 'tcp-reset', hint: 'How a rejected TCP connection is refused: with a TCP reset, or with an ICMP error of this kind.' },
  { key: 'any_reject_code', type: 'enum', options: ['tcp-reset', 'port-unreachable', 'admin-prohibited', 'host-unreachable', 'no-route'], caseless: true, group: 'protection', label: 'Answer to other rejected traffic', default: 'port-unreachable', hint: 'How rejected non-TCP traffic (UDP, ICMP, ...) is refused: with an ICMP error of this kind.' },

  { key: 'flow_offloading', type: 'bool', group: 'offload', label: 'Software flow offloading', default: false, hint: 'Offload established connections to the kernel\'s software flowtable: less CPU per forwarded packet.' },
  { key: 'flow_offloading_hw', type: 'bool', group: 'offload', label: 'Hardware flow offloading', default: false, show: v => v.flow_offloading, hint: 'Also offload to the switch or network chip, when it supports it (it depends on software flow offloading and on the hardware).' },

  { key: 'tcp_syncookies', type: 'bool', group: 'advanced', label: 'TCP SYN cookies', default: true, hint: 'Answer connection requests with SYN cookies when the queue is full, so that a flood does not block new connections.' },
  { key: 'tcp_ecn', type: 'enum', options: ['0', '1', '2'], labels: { 0: 'Off', 1: 'On', 2: 'On when requested for incoming connections only' }, group: 'advanced', label: 'TCP ECN', default: '0', hint: 'Explicit Congestion Notification for the router\'s own TCP connections.' },
  { key: 'tcp_window_scaling', type: 'bool', group: 'advanced', label: 'TCP window scaling', default: true, hint: 'Allow TCP windows larger than 64 KB for the router\'s own connections.' },
  { key: 'accept_redirects', type: 'bool', group: 'advanced', label: 'Accept ICMP redirects', default: false, hint: 'Let other routers change the router\'s routes with ICMP redirects. Leave it off unless you rely on it.' },
  { key: 'accept_source_route', type: 'bool', group: 'advanced', label: 'Accept source-routed packets', default: false, hint: 'Accept packets that carry their own route. Leave it off: it is a way to get around a firewall.' },
  { key: 'auto_helper', type: 'bool', group: 'advanced', label: 'Connection tracking helpers', default: true, hint: 'Load the connection tracking helpers for the protocols that need them (FTP, SIP, ...); a zone can turn them off for itself.' },
  { key: 'auto_includes', type: 'bool', group: 'advanced', label: 'Include nftables snippets', default: true, hint: 'Read the snippets in /usr/share/nftables.d/ that packages install.' },
];

//#endregion
