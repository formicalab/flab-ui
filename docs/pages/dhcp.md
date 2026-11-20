# DHCP (route `#dhcp`)
Shows and edits odhcpd, the router's DHCPv6 and router advertisement (RA) server and, when it is the main server,
its DHCPv4 server too; it is configured in
`/etc/config/dhcp`. It refreshes every 10 s and reads through the ubus `dhcp` object (`ipv4leases`,
`ipv6leases`, `ipv6ra`), `network.interface dump` (which device belongs to which interface and its subnet),
`service list odhcpd` and `service list dnsmasq` and rpcd's `uci` object; it needs no plugin, only the ACL fragment
`rpcd/acl.d/flab-dhcp.json`. Leases are keyed by device (`br-lan`) in the ubus replies and shown under their
logical interface (`lan`). Top to bottom the page shows the tiles, then the settings (daemon, pools), then the
advertised prefixes, the leases and last the reservations.
- **Who serves DHCPv4** is detected: odhcpd when `odhcpd.maindhcp` is on, otherwise dnsmasq when its procd service
  runs (the usual split of dnsmasq for IPv4 and an IPv6-only odhcpd). In the dnsmasq case odhcpd has no
  `ipv4leases`, so the page reads dnsmasq's lease file (the `leasefile` option of `config dnsmasq`, default
  `/tmp/dhcp.leases`, through rpcd's `file` object, which the ACL fragment limits to `/tmp/*.leases`) and parses its
  `expiry MAC address hostname client-id` lines. A lease gets its interface from the subnet it falls in, counts as
  reserved when a reservation has its MAC or address, and shows the time left (0 means it never expires; the time
  is counted with the browser's clock). The tiles and the leases card say "from dnsmasq"; a lease file that cannot
  be read is reported instead of being shown as no leases.
- **Tiles**: whether odhcpd runs (and who serves DHCPv4), DHCPv4 leases (reserved and dynamic), DHCPv6 leases,
  reservations (how many hold a lease now).
- **Daemon** (`config odhcpd`): main DHCPv4 server switch, log level, lease file, trigger script, hosts directory,
  and so on, and the **server DUID** (`dhcp_default_duid`), which odhcpd reads from the `globals` section of
  `/etc/config/network` (the only part of that config the page reads, because the rest holds secrets; the ACL
  fragment grants the `network` config for it). Like the pools it is folded to its header (main switch and log level) until opened.
- **Pools** (`config dhcp`, one card per interface, folded to its header until opened, groups collapsible: the folds are the shared ones of `core/fold.js`, the same as on the DNS and Dynamic DNS pages): Services (DHCPv4, DHCPv6, RA, NDP),
  DHCPv4 pool and options, DHCPv6, Router advertisements, Neighbor discovery proxy and Other (including the
  encrypted DNS servers `dnr`, the network device `ifname` and its alias `networkid`): every option odhcpd reads,
  taken from its option tables (`src/config.c`) and its README, and nothing it no longer reads. The header shows the subnet and the
  address range the pool resolves to (start and limit are offsets in the interface's subnet). A folded card or
  closed group that holds an error opens by itself, so an error is never hidden.
  - **Add pool** (below the pools) offers the interfaces that have none and creates a `config dhcp` section named after
    the interface (with `option interface`), as a server for DHCPv4, DHCPv6 and RA with every other option at its default; only options that differ from the default are written.
    **Remove pool** marks a pool for removal (grayed out, with Undo, and a warning that DHCP and RA stop on that
    interface); one added in the form and not yet saved is simply dropped.
  - **Other options** a section holds that no table describes (options of other programs that read the same file,
    such as `dhcp_option` or `force`, and `dhcpv6_raw`) are listed read only at the bottom of the card, so
    nothing in the file is hidden.
- **Leases**: the IPv6 prefixes advertised to clients in router advertisements (a stale one is flagged), DHCPv4 (address, MAC, hostname,
  reserved or dynamic, time left) with a *Reserve* button on every dynamic lease that adds a reservation to the
  form, and DHCPv6 (DUID, matched client MAC/hostname, IA_NA addresses, IA_PD delegated prefixes and how many
  `/64` subnets each prefix contains). Link-layer DUIDs and matching DHCPv4 DUIDs/hostnames are used to identify
  otherwise anonymous DHCPv6 clients. The command bar filters all three by text and by interface.
- **Reservations** (`config host`): one editable row each with name, IPv4 address, MAC address(es), DUID(s), IPv6
  host ID and lease time, and whether the client holds a lease now. A reservation with only a name and a MAC
  keeps the address dynamic. Rows can be added, removed (shown struck through, with Undo) and edited. New
  sections get their names from uci, so a saved reservation is recognized by its content.
- **Network boot (PXE)** (`config boot6`): one editable row each with the boot file address (`tftp://[fd11::1]/pxe.efi`)
  and the optional architecture code (7 is EFI x64; an entry without one is the default). Added, removed and
  verified like the reservations. Two entries for the same architecture warn.
- **Validation**: field checks come from `core/fields.js`; on top of them an address or MAC reserved twice
  (both rows are marked), the router's own address and a pool that starts beyond its subnet are errors. Warnings
  (they do not block Save): an address outside every served subnet, a pool longer than its subnet, DHCPv4 on an
  interface with no IPv4 address, odhcpd no longer the main DHCPv4 server, a removed pool, advertisement intervals out of
  proportion, the RA flag `none` combined with others, and `managed-config` with DHCPv6 disabled. Every
  reservation needs a MAC or a DUID and every boot entry an address. A value already invalid in the router's file is reported the same way and
  blocks Save until fixed.
- **Not offered**: the pool's `interface` (it binds the pool to its interface and is shown in the header).
- Saving uses the same flow and review banner as System settings (see
  [Configuration changes](../architecture.md#configuration-changes)); a change that includes the DUID stages both configs in one
  apply and the check after the save reads both back, so a change the router did not keep in either is rolled
  back. A pool or daemon change reloads odhcpd, which does not drop
  existing leases. A daemon that is not running is reported, and the configuration stays editable.
