// The options of the WireGuard interfaces and peers in /etc/config/network that the WireGuard page edits, as tables of fields in
// the format of core/fields.js (read that file first), with the explanations taken from the OpenWrt documentation of the protocol
// (https://openwrt.org/docs/guide-user/network/tunneling_interface_protocols#protocol_wireguard_wireguard_vpn) and of the
// WireGuard server and client guides (https://openwrt.org/docs/guide-user/services/vpn/wireguard/server, .../client).
//
// On top of the usual field keys, a field has
//   secret   a write-only value: the router never sends it to the page, which only shows whether one is stored

// The config the page edits.
export const CONFIG = 'network';

// The type of the section of a peer of interface `name`.
export const peerType = name => `wireguard_${name}`;

// The options of an interface (a `config interface` section with `option proto 'wireguard'`). The section name is the interface's name.
export const IFACE_FIELDS = [
  { key: 'disabled', type: 'bool', label: 'Disabled', default: false,
    hint: 'A disabled interface is kept in the file but not brought up: its peers are disconnected.' },
  { key: 'private_key', type: 'string', secret: true, label: 'Private key',
    hint: 'The interface\'s secret key. It is stored in the file but never shown here: leave it empty to keep the stored key, or generate a new one (it is made in your browser and only sent to the router). Peers must be given the matching public key, so replacing a key breaks every peer until they have the new one.' },
  { key: 'listen_port', type: 'int', number: true, min: 1, max: 65535, label: 'Listen port', placeholder: '51820',
    hint: 'The UDP port the tunnel listens on. Set it on a router that peers connect to, and allow it in the firewall (Firewall page, a rule from the zone the peers come from). Without it WireGuard picks a random port each time the interface starts.' },
  { key: 'addresses', type: 'list', label: 'Addresses', addLabel: 'Add address', placeholder: '10.8.0.1/24',
    hint: 'IPv4 and IPv6 addresses of this end of the tunnel, with a prefix length (10.8.0.1/24, fd00:8::1/64). The prefix makes the tunnel network routable; without one the address is a single host and nothing else is reachable through the tunnel.' },
  { key: 'mtu', type: 'int', number: true, min: 68, max: 65535, label: 'MTU', placeholder: 'default: 1420',
    hint: 'The largest packet the tunnel carries. The default of 1420 suits tunnels over IPv6 on a 1500-byte link; lower it for a link with less room (PPPoE, mobile networks), for example 1380.' },
  { key: 'fwmark', type: 'string', label: 'Firewall mark', placeholder: '0x51820',
    hint: 'The mark put on the tunnel\'s own packets so that policy routing can keep them out of the tunnel. A number, decimal or hexadecimal (0x51820). When empty it is derived from the listen port.' },
  { key: 'nohostroute', type: 'bool', label: 'No host routes to endpoints', default: false,
    hint: 'By default a route is added for each peer endpoint so that the tunnel\'s own packets leave through the normal uplink instead of the tunnel. Turn this on only when you manage those routes yourself.' },
];

// The options of a peer (a `config wireguard_<interface>` section, usually anonymous).
export const PEER_FIELDS = [
  { key: 'description', type: 'string', label: 'Name', placeholder: 'Laptop',
    hint: 'A label for this peer, shown on this page and in the configuration. WireGuard does not use it.' },
  { key: 'disabled', type: 'bool', label: 'Disabled', default: false,
    hint: 'A disabled peer is kept in the file but not loaded: it cannot connect.' },
  { key: 'public_key', type: 'string', label: 'Public key', placeholder: '44 characters ending in =',
    hint: 'The peer\'s public key, as it shows it (wg pubkey, or the app on the device). It identifies the peer and is not secret.' },
  { key: 'preshared_key', type: 'string', secret: true, label: 'Pre-shared key',
    hint: 'An optional secret shared with the peer on top of the keys, an extra layer of symmetric encryption (it also protects against future quantum computers). Stored in the file but never shown here: leave it empty to keep the stored one. Both ends must hold the same key.' },
  { key: 'allowed_ips', type: 'list', label: 'Allowed IPs', addLabel: 'Add allowed IP', placeholder: '10.8.0.2/32',
    hint: 'The addresses this peer may use inside the tunnel, with a prefix length: what the router accepts from it and sends to it. A single device gets one /32 (and one /128 for IPv6); a network behind a peer router gets its whole prefix. 0.0.0.0/0 and ::/0 mean every address (a full-tunnel gateway). Two peers must not overlap.' },
  { key: 'route_allowed_ips', type: 'bool', label: 'Create routes for the allowed IPs', default: false,
    hint: 'Add a route in the router for every allowed IP, through this interface. Needed for a network behind the peer (and for 0.0.0.0/0 to make a default route); not needed for plain client addresses inside the tunnel\'s own network.' },
  { key: 'endpoint_host', type: 'string', label: 'Endpoint host', placeholder: 'vpn.example.com',
    hint: 'The address or name of the peer, which this router connects to. Leave it empty for a peer that connects to this router (a phone, a laptop): the router then learns its address from its first packet.' },
  { key: 'endpoint_port', type: 'int', number: true, min: 1, max: 65535, label: 'Endpoint port', placeholder: 'default: 51820',
    hint: 'The UDP port of the peer, when it has an endpoint host.' },
  { key: 'persistent_keepalive', type: 'int', number: true, min: 0, max: 65535, label: 'Keepalive (seconds)', placeholder: 'default: off',
    hint: 'Send an empty packet every this many seconds so that a NAT or stateful firewall keeps the path open. 25 is the usual value for a peer behind NAT; leave it empty (off) otherwise.' },
];
