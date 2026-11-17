# WireGuard (route `#wireguard`)
Refreshed every 5 s, from `flab.wireguard`. Interfaces come from UCI network (`proto wireguard`) plus whatever
`wg show interfaces` reports, peers from the `wireguard_<interface>` sections plus whatever the kernel has
(matched by public key), so a new interface or a peer added at run time with `wg set` shows up on the next
poll (flagged as not in the configuration). The page also edits the configuration behind them.
- **Tiles**: interfaces up, peers connected, latest handshake, live traffic (rates derived in the browser from
  the byte counters).
- **Interface card**: state, firewall zone, addresses, listen port, public key (not secret), MTU, firewall
  mark, totals; the buttons *Add client*, *Add peer manually* and *Remove interface*; a note with a link to the Firewall page when the interface is in no
  zone; the foldable *Interface settings* form (above the live values and the peers); the peers table. An interface that only the kernel has (made with `wg-quick` or `ip link`) is
  shown read only with a note.
- **Peers table**: name (UCI `description`) and a role badge from the allowed IPs (*client*: host routes only, a phone or a laptop;
  *remote network*: a whole network behind another router, a site-to-site link; *all traffic*: a `/0`, a gateway), with a legend above the table that says so, shortened public key (full key on hover),
  endpoint (empty for roaming peers), allowed IPs, handshake state, keepalive, live and total traffic, and the buttons *Edit* (opens the peer's
  editor under its row), *Remove* and *Undo*.
- **Handshake state**: *connected* when the last handshake is under 180 s old (WireGuard rekeys every 120 s
  and rejects a session after 180 s), *no recent handshake* when older, *never connected* when the kernel has
  no handshake, *not loaded* when the peer is configured but the interface is not running.
- **Findings**: interface down, interface in no firewall zone, a configured peer not loaded, stale or never
  connected peers (informational: roaming phones are often offline), a site peer whose `route_allowed_ips` is
  off.
- **Interface options** (hints from the OpenWrt documentation on each): disabled, listen port, addresses (a list), MTU, firewall mark, no host
  routes to endpoints, and the private key. Options the page has no control for (`tunlink`, `ip6prefix`, ...) are listed read only.
  An interface is added with *Add WireGuard interface* (name: letters, digits and underscores, at most 15, not the name of any section of the
  network config; the first free `wgN`, the first free UDP port from 51820 and a private key made in the browser are offered) and removed with
  its peers (until saved, with *Undo*).
- **Peer options**: name, disabled, public key, pre-shared key, allowed IPs (a list), create routes for the allowed IPs, endpoint host and port,
  keepalive. Peers are added (an anonymous `wireguard_<interface>` section), edited in place and removed.
- **Keys never reach the browser, and a new one is made there.** The plugin never reads `private_key` or `preshared_key` (or any option named like a
  secret) into its output and reports only whether each is set; only the single-field `wg show` forms are used because they never print them. The test recorder
  scrubs both keys, and the test generator aborts if a capture still contains one. The key boxes are write-only: empty keeps the stored key, the review banner shows *new value
  (hidden)*, never the text. *Generate a key* makes an X25519 key pair in the browser with WebCrypto (feature-detected; where the browser has no
  X25519 a small BigInt implementation of RFC 7748 derives the public key from random bytes of the browser's own generator; where there is no
  secure random generator at all, the button is disabled and the page says to paste a key made with `wg genkey`). The public key of a typed or
  generated private key is shown next to the box (with *Copy*). A pre-shared key is 32 random bytes from the same generator.
- **Add client**: a dialog (the wide one, so that the hints do not wrap much) for a phone or laptop of an interface that is running; *Add peer manually* is for
  a peer you enter by hand, such as the router of another network (a site-to-site link) or a gateway, whose public key you have. It takes a name, the router's public address (offered: the
  host name the page was opened with), the UDP port, what the client sends through the tunnel (the tunnel networks, everything, or a list),
  an optional DNS server, a keepalive and whether to use a pre-shared key. It makes the client's key pair in the browser, adds the client as a peer
  of the form (its public key and the next free address of each family from the interface's tunnel network, skipping what other peers allow) and shows
  the client's WireGuard configuration once ([Interface] with its private key and address, [Peer] with the router's public key as wg show
  reports it, the endpoint and the allowed IPs) as a **QR code** that the WireGuard app of a phone scans (*add a tunnel*, then scan) and as text with *Copy* and *Download*
  (<interface>-<client>.conf). The code is drawn in the browser (core/qr.js with the vendored www/vendor/qrcode.js, loaded only when it is first needed, error correction level L)
  and holds the same text, so it is as secret as the private key: it exists only in the dialog, and the peer reaches the router only when you press *Save and apply*.
  A configuration too long for the largest QR code (about 2.9 KB) shows a note instead of the code.
- **Validation** (errors block Save; warnings do not): the interface name, a listen port that is a number and that no other enabled interface (or
  an interface only the kernel has) uses, addresses as CIDR (a dotted netmask is accepted), the MTU range and the firewall mark, a typed key that is
  44 base64 characters with the right padding bits, a peer's public key (required, not the interface's own, not repeated on the interface),
  allowed IPs as CIDR with a prefix length, an endpoint host that is a name or an address (an IPv6 address without brackets), port and keepalive
  ranges, a new interface without a private key. Warnings: no address, an address without a prefix, overlapping tunnel networks of two interfaces,
  an MTU above 1420 or below 1280 with IPv6, no listen port on a router that peers connect to, overlapping allowed IPs between peers (the same
  prefix: the later one wins; a broader one: the more specific wins), a `/0` on a peer (the default route when routes are created, else that no
  route is created), a network on a peer without routes, no allowed IPs, an endpoint that does not look reachable (loopback, unspecified,
  link-local, multicast, a name without a dot or in `.local`/`.lan`, an address inside the router's own tunnel network), an endpoint port without a
  host, a new interface (it is in no firewall zone), a removed interface that a firewall zone still names.
- **Changes that may cut the tunnel you are working through.** The plugin reports the established TCP connections to the router's web and SSH
  ports (the ports in uci uhttpd and dropbear, plus 22, 80 and 443). A connection whose remote address is inside an enabled peer's allowed IPs of
  a running interface (the most specific one; a `/0` does not count) is probably your own, so removing, disabling or re-keying that interface
  or peer, or any change that restarts it, is called out in the banner, and removing the interface or the peer asks first in a dialog that names
  the address and the peer. Without such a connection a connected peer or interface gets a generic warning. The page does not know which
  connection is its own, so another administrator's session through the tunnel gives the same warning.
- **Saving** goes through `applyChange()` like the other editing pages (stage, apply with the rollback countdown, read the config back through
  the plugin, confirm). The check requires every option, every typed key (as set) and every new or removed interface and peer to be as drafted,
  and then that the tunnel really runs: an interface that was running, is new or is being enabled must be `up`, and a new, re-keyed or enabled
  peer must be loaded in the kernel. netifd takes a moment, so the read-back is repeated for about 7 s while something is not running yet; a
  configuration that makes the interface fail (no key, a bad key, a missing `wireguard-tools`) is rolled back and the edit stays in the form. Changes
  already staged in the session are shown with a "Discard them" button. The page does not poll over unsaved edits, a focused control or an open dialog.
- **The firewall zone is another page's job**: a new interface is in no zone until you put it in one on the Firewall page (the card links there); the
  listen port also needs a firewall rule from the zone the peers come from.
- **Plugin missing**: a router without `flab.wireguard` gets a note instead of the page; a router without netifd's wireguard protocol handler
  (`wireguard-tools`; the handler file is `wireguard.uc` on current releases, `wireguard.sh` on older ones) gets a note that interfaces cannot start. A login that may not write sees the page read only.
- **ACL**: `rpcd/acl.d/flab-wireguard.json` grants `flab.wireguard` `status` (read), `uci` `changes` (read) and `set`, `add`, `delete`, `revert`, `apply`,
  `confirm`, `rollback` (write), and `uci` read and write on the `network` config. It has to list that config under read because `uci changes` needs it, although the config holds the
  private and pre-shared keys: it does not grant `uci get`, the page never calls it (a test fails if it does) and reads the config only through the plugin, which leaves the keys out.
