# Backend (rpcd plugins)

rpcd loads every `*.uc` file in `/usr/share/rpcd/ucode/`; each plugin returns an object
mapping ubus object names to methods:

```ucode
return {
  'flab.example': {
    status: { call: function(request) { return { ... }; } },
  },
};
```

| Plugin | ubus object | Method | Sources |
|---|---|---|---|
| `flab.wifi.uc` | `flab.wifi` | `clients` | uci wireless/network/dhcp, ubus `network.wireless`, `dhcp`, `hostapd.<if>`; `hostapd_cli all_sta`, `iw station dump`, `/proc/net/arp`, `ip -6 neigh` |
| `flab.radio.uc` | `flab.radio` | `status`; `config`; `wps` (on request) | `status`: uci wireless and network, ubus `network.wireless`, `hostapd.<if>`; `iw dev/phy info`, `iw survey dump`, the phy device in sysfs (driver, bus, device-tree compatible string, PCI or USB id), `iw reg get`, `iwinfo <if> info`; sysfs counters. `config` (the editable wireless config): every option of the `wifi-device` and `wifi-iface` sections except secrets, which are only reported as set; `iwinfo <if> htmodelist/countrylist`, `hostapd -v<feature>` (what the installed hostapd can do; see [Wi-Fi radios](pages/radios.md)) |
| `flab.mesh.uc` | `flab.mesh` | `status` | uci wireless (`wifi-iface mode=mesh`), ubus `network.wireless`; `iw dev/station dump`, `iw mpath dump`, `iw mpp dump`, `iw get mesh_param`; sysfs counters |
| `flab.wireguard.uc` | `flab.wireguard` | `status` | uci network (`proto wireguard` interfaces and `wireguard_<if>` peer sections: every option except the secret ones, which are only reported as set; the names of the named sections), uci firewall (zone), uci uhttpd and dropbear (the administration ports); `wg show <if> public-key/listen-port/peers/endpoints/allowed-ips/latest-handshakes/transfer/persistent-keepalive` (the single-field forms never print the private or pre-shared key); sysfs MTU and counters; `/lib/netifd/proto/wireguard.uc`, or `wireguard.sh` on older releases (whether netifd has the protocol handler); `/proc/net/tcp` and `/proc/net/tcp6` (established connections to the router's web and SSH ports; the word byte order is taken from the ELF header of the running process, so big-endian boards read correctly; see [WireGuard](pages/wireguard.md#wireguard-route-wireguard)) |
| `flab.firewall.uc` | `flab.firewall` | `status` | uci firewall (defaults, zones, forwardings, `rule`, `redirect`, `nat`, `include`, `ipset`; every rule and port forward carries its section name), uci network (the interfaces and whether each is disabled), ubus `network.interface dump` (the router's addresses on each interface); `nft -j list ruleset` (per-rule hit counters matched through the `!fw4: <name>` comment, reject/drop chain counters per zone, the devices behind each zone, the zones that have an `input_<zone>` chain (`loaded_zones`), flowtable devices, base chain policies); procfs conntrack count and limit. A zone without a policy of its own reports the one of the defaults |
| `flab.network.uc` | `flab.network` | `status`; `clients`; `config`; `cable_test` (`port`) | `config` (the editable part of the network config): uci network (the `interface` and `device` sections with every option except secrets, the first `globals` section as `globals` (`null` without one), the number of sections of each other type, and the `bridge-vlan` sections' device and VLAN). An option whose name says it is a secret (`password`, `passwd`, `pin`, `pincode`, anything containing `passw`, `secret`, `psk`, `key`, `token` or `credential`: a PPPoE or modem password, a SIM PIN, a WireGuard private or pre-shared key) is never returned, only whether it is set (`secrets`). `status`: ubus `network.device status` (netifd); sysfs `/sys/class/net/<if>/{carrier,bridge,brport}`; the bridge forwarding table `brforward`; `ethtool -i/-S`, `ethtool --show-eee` (EEE), `ethtool -m` (optical modules, only for ports that are optical cages), `/sys/class/mdio_bus`, `/proc/device-tree` (hardware and switch wiring), `/etc/board.json` (LAN/WAN roles, port order, swconfig switches); `swconfig list` / `dev <switch> help` / `dev <switch> show` (switches that are not DSA); `bridge vlan show` (when iproute2's `bridge` is installed) and uci network `bridge-vlan` sections (the VLAN tables); uci network (`tunlink`), uci firewall (zones, forwardings), uci dhcp (DHCP/RA service per interface); `logread` (error log lines). `clients`: Ethernet members' learned bridge FDB MACs, enriched with DHCP, ARP/NDP and static reservations; clients are reported as seen through a port because the port can lead to an attached switch. `cable_test` runs `timeout 30 ethtool --cable-test <port>` (the executor's 20 s cap ends it first) on one physical port after strict validation, only when asked (its ACL grant is under `write`; see [Ethernet ports](pages/network.md#ethernet-ports-a-view-of-devices-and-interfaces-route-network)) |
| `flab.diag.uc` | `flab.diag` | `status`, `start` (`tool`, `host`, options), `read` (`id`, `from`), `download` (`id`, `from`: a capture file as base64), `stop` (`id`), `wake` (`mac`, `iface`) | busybox `ping` and `traceroute`, `mtr --raw`, `tcpdump` for the packet capture, `iperf3 -s`, `kdig` for the DNS trace, the first of `dig`, `kdig`, `drill`, `nslookup`, and `openssl s_client` / `x509`, run detached under `timeout` with their output in `/tmp/flab-diag/<id>/out`; `ip route get` and `ip route show default` for the connectivity check; `etherwake` or `socat` for Wake-on-LAN, with the host list from uci dhcp hosts, `dhcp ipv4leases`, `/tmp/dhcp.leases`, `/etc/ethers` and `/proc/net/arp`; ubus `network.interface dump` and uci firewall for the iperf3 server's addresses and zones; `command -v` for the tools, `/sys/class/net` for the interface names, `/tmp/resolv.conf.d/resolv.conf.auto` for the upstream resolvers; every argument validated before a command line is built |
| `flab.ipsec.uc` | `flab.ipsec` | `status` | `swanctl --raw` (via `flab.vici`), `swanctl --version`, `ip -s xfrm state`, `ip -o addr show dev <xfrmN>`, `network.device`, uci network |
| `flab.asterisk.uc` | `flab.asterisk` | `status`; `pjsip`; `endpoint` (`name`); `dialplan`; `resolve` (`context`, `exten`); `config` (optional `file`); `reload` (`what` = `core`, `dialplan` or `pjsip`: runs `core reload`, `dialplan reload` or `module reload res_pjsip.so`, the only write method, serialized by the worker's MUTATING list); the others are read only | `asterisk -rx` (`core show uptime seconds`, `core show version`, `core show settings`, `core show calls`, `core show channels concise`, `module show`, `logger show channels`, `cdr show status`, `pjsip show version`, `pjsip list endpoints|registrations`, `pjsip show endpoints|registrations|transports`, `pjsip show endpoint|registration|transport <name>`, `dialplan show`, `dialplan show globals`, `dialplan show <exten>@<context>`), uci asterisk (`enabled`), `/var/run/asterisk/asterisk.pid` and `/proc/<pid>/status`, the tail of `/var/log/asterisk/messages.log` (128 KiB) and `/etc/asterisk/*.conf` plus `/etc/config/asterisk` (at most 256 KiB each). `endpoint` and `resolve` validate their arguments (a plain identifier, no quote, no leading `-`; the endpoint must be in `pjsip list endpoints`) before any command is built; `config` accepts only a name from its own file list. Secrets never leave the router: configuration values named `password`, `secret`, `md5_cred`, `pin`, `token`, … and a dialplan's `Authenticate(…)`, `DISA(…)`, `Set(<secret name>=…)`, and a literal compared with a secret-named variable are replaced by `<redacted>` (best effort: a secret under an innocent name cannot be recognized), the `[globals]` and PJSIP parameters with such names too; only text inside a line changes, so line numbers stay valid. One `pjsip show endpoint` per endpoint (up to 40), one `show registration` per registration and one `show transport` per transport (up to 8) |
| `flab.bgp.uc` | `flab.bgp` | `status`; `config`; `check`; `action` | `birdc` (`show status`, `show protocols all`, `show route all`, `show route export <peer>`, `show route export <protocol>` for the other protocols (the routes the table hands to each, up to 2000, returned as `protocols[].exported`; `null` for BGP and above the limit), `show memory`), `ip -4 route show proto bird` and `ip -6 route show proto bird`; `config` reads `/etc/bird.conf` (at most 256 KiB, the text after `password` and `secret` replaced by `"<redacted>"`, with its size and modification time); `check` runs `birdc configure check` (parses the file, applies nothing); `action` (the only method that changes anything, serialized by `flab.worker`) runs one fixed birdc command, `restart`, `enable`, `disable`, `reload bgp in` or `reload bgp out`, on a protocol that BIRD lists as BGP right now (the name must also be a plain name; anything else is refused before birdc runs) |
| `flab.routing.uc` | `flab.routing` | `status`, `lookup` (`dst`, `src`, `iif`) | `ip -4/-6 route show table all`, `ip -4/-6 rule show`, `/etc/iproute2/rt_tables`, `command -v birdc`, `pidof charon`, uci network (only the `rule` and `rule6` sections, and only their section name, family, priority and lookup table); `lookup` runs `ip route get` and `ip route get ... fibmatch` for a validated address, optional source address and interface name |
| `flab.traffic.uc` | `flab.traffic` | `status`; `connections` (`q`, `limit`, `sort`, `proto`, `scope`); `usage_periods`; `usage` (`period`, `group`); `nlbwmon_paths` (`dir`, `protocols`) | procfs `/proc/net/nf_conntrack` and `/proc/sys/net/netfilter/nf_conntrack_{count,max,acct}`; `command -v nlbw`, `pidof nlbwmon`, `nlbw -c list`, `nlbw -c json -g <group> [-t <period>]`; names from uci dhcp (`host` sections), `dhcp ipv4leases`/`ipv6leases` (ubus, odhcpd), `/tmp/dhcp.leases`, `/tmp/hosts/*`, `/etc/ethers`, `/proc/net/arp`, `ip -6 neigh show` (see [Traffic](pages/traffic.md#traffic-route-traffic)); for `nlbwmon_paths` the ucode functions `stat`, `lsdir`, `realpath` and `open` on the database directory and the protocol file, and `/proc/mounts` (never a shell) |
| `flab.dns.uc` | `flab.dns` | `status` (no arguments) | procd `service list` (ubus), `pidof unbound`/`pidof dnsmasq`, `command -v unbound`/`dnsmasq`, `netstat -lntup`, `unbound-control status`/`stats_noreset`/`list_forwards`/`list_local_data`, `unbound -V`, the generated `/var/lib/unbound/unbound.conf` and `unbound_ext.conf` (forward-zone clauses), `dnsmasq --version`, ubus `dnsmasq metrics`, uci unbound and uci dhcp (the `unbound` and `dnsmasq` sections), `/tmp/resolv.conf.d/resolv.conf.auto`, `/tmp/hosts/*`, `/tmp/dhcp.leases`, `/proc/<pid>/stat` and `/proc/uptime` (see [DNS](pages/dns.md#dns-route-dns)) |
| `flab.sensors.uc` | `flab.sensors` | `status` | sysfs `/sys/class/thermal`, `/sys/class/hwmon` |
| `flab.system.uc` | `flab.system` | `cpu`; `build`; `modules`; `storage`; `ntp_sync`; configuration `backup_create`, `backup_download`, `backup_begin`, `backup_upload`, `backup_inspect`, `backup_restore`, `backup_cancel` | procfs `/proc/stat`, `/proc/loadavg`, `/proc/uptime`; for `storage` the block, eMMC and NAND (UBI, `dmesg`) data of the Overview Storage card; for `build` and `modules` the ucode functions `lsdir` and `stat` over `/www/flab` (see [Browser cache](frontend.md#browser-cache)); `ntp_sync` restarts `sysntpd`; backups are created with `sysupgrade -b`, transferred through bounded base64 chunks, checked with `gzip -t` and `tar -tzf`, restored with `sysupgrade -r` and followed by a reboot. Temporary files live below `/tmp/flab-backup` in directories that only root can read (mode 0700); at most four are kept and each expires after 900 s |
| `flab.ddns.uc` | `flab.ddns` | `status` (no arguments); `log` (`section`); `control` (`section`, `action` = `check` or `force`) | uci `ddns` and `network`, procd `service list` (the updater instances), ubus `network.interface dump`, the run files in `ddns_rundir` (`<service>.ip`, `.update`, `.nextcheck`, `.err`) and the logs in `ddns_logdir`, `/proc/uptime`, `/usr/share/ddns/{default,custom}/*.json` (the providers), `/usr/lib/ddns` (provider scripts), `/sys/class/net`, `ip addr`, `/etc/rc.d`; `control` runs `/etc/init.d/ddns stop` and `start` for one enabled service after strict validation (see [Dynamic DNS](pages/ddns.md#dynamic-dns-route-ddns)); passwords and tokens are never returned |
| `flab.logs.uc` | `flab.logs` | `read` (`lines`, `source`) | `logread -l N` (logd ring buffer), `dmesg -r`, `/proc/uptime`; entries are parsed and secret-looking values redacted. Output over the 256 KiB command cap is not an error: the system log is asked for again with about 60% of the lines that fit (the `limit` of the reply says how many), and a larger kernel buffer is read again through `tail -n N` |
| `flab.services.uc` | `flab.services` | `list`; `control` (`name`, `action`) | `/etc/init.d` (executable files) and `/etc/rc.d` (`S<NN><name>` = starts at boot), `netstat -lntup` and `/proc/sys/net/ipv4/ip_local_port_range` (the listening sockets) for `list`; `control` runs `/etc/init.d/<name> start\|stop\|restart\|enable\|disable` after strict validation (see [Services](pages/services.md#services-route-services)); its ACL fragment grants `list` under `read` and `control` under `write` |

The DHCP page needs no plugin of its own. System settings uses `flab.system` for backup and restore in addition to
rpcd's `uci` object. Pages that edit a configuration through rpcd's own `uci` object need an ACL fragment that grants the `uci` methods on
the configs they touch (in `rpcd/acl.d/`; the page and plugin sections name them):

| Fragment | `uci` read (`get`, `changes`) and write (`set`, `add`, `delete`, `revert`, `apply`, `confirm`, `rollback`; `order` where noted) on |
|---|---|
| `flab-settings.json` | `system`; also all `flab.system` backup methods under write |
| `flab-dhcp.json` | `dhcp` and `network` (the page reads and writes only the `globals` section of the latter, for the server DUID); also ubus `dhcp` methods and reading `/tmp/*.leases` through rpcd's `file` object for dnsmasq's lease file |
| `flab-dns.json` | `unbound` and `dhcp` |
| `flab-firewall.json` | `firewall` (with `order`) |
| `flab-traffic.json` | `nlbwmon` |
| `flab-vlan.json` | `network` (with `order`; the VLAN editor of the Ethernet ports page) |
| `flab-routing.json` | `network` (the static-route editor on the Routes view; also ubus `flab.routing` `status` and `lookup`) |
| `flab-network.json` | `network`: `changes` and the write methods only, no `get` (Devices and Interfaces, which reads the config through `flab.network config`) |
| `flab-radio.json` | `wireless`: `changes` and the write methods only, no `get` (the Wi-Fi radios page reads it through `flab.radio config`); `flab.radio wps` under write |
| `flab-wireguard.json` | `network`: `changes` and the write methods only, no `get` (WireGuard reads it through `flab.wireguard status`) |
| `flab-ddns.json` | `ddns`: `changes` and the write methods only, no `get` (Dynamic DNS reads it through `flab.ddns status`) |

**Secrets.** A config that holds secrets is never read by the browser with `uci get` where the page can avoid it: `wireless` (Wi-Fi keys),
`network` (PPPoE passwords, WireGuard keys) and `ddns` (passwords and tokens) are read through the plugin of the page, which omits
recognized secret options and reports only whether they are set; the read-back after a save goes through the same plugin. Their password and key fields are
write-only: empty keeps the stored value, a typed value replaces it, and the review list shows "new value (hidden)" or nothing. The
standard options edited through raw `uci get` (`system`, `dhcp`, `unbound`, `firewall`, `nlbwmon`) are not intended
to hold credentials, but custom options in those configs are not filtered. Secret-name filtering and log redaction are
heuristics, not a guarantee for arbitrary option names or free text. The VLAN and static-route editors read the network config
with `uci get` filtered by section type (`bridge-vlan`, `device`, `switch`, `switch_vlan`, `switch_port`; `route`, `route6`), never the whole config, and a test checks
that. rpcd cannot restrict `uci get` to section types, and root holds every fragment, so a root login can still call `uci get network` (through
`flab-dhcp.json`, `flab-vlan.json` or `flab-routing.json`); the pages never do.

Shared modules (`rpcd/lib/flab/`, imported as `flab.util`, `flab.vici`, `flab.exec`, `flab.jobs` and `flab.worker`):

- **`flab.util`**: `run(cmd)`, `command_result(cmd, options)`, `ubus_call(conn, object, method, args)`, `uci_all(config)`,
  `sysfs(path)` / `sysfs_raw(path)`, `fixture(name)`, `fixture_time()`, `record_file()`, `one_line()` and `safe_ifname()` (validators; see
  Shell safety below), `normalize_mac()`, `num()`, `as_list()` (a UCI option as a list),
  `iw_channel_info()` (channel, width and TX power from `iw dev <if> info`) and `security_label()`
  (human label of a wireless `encryption` value). They are also the test seam: with `FLAB_FIXTURES=<dir>`
  set (rpcd never does) `run()` returns `<dir>/<command>.txt` instead of executing the command (file name =
  the command with every run of non-alphanumerics turned into `_` and a trailing `2>/dev/null` dropped),
  `ubus_call()` reads `<object>_<method>.json`, `uci_all()` reads `uci_<config>.json` and `sysfs()` looks
  the path up in `files.json`. A plugin written with these helpers is testable without any plugin-specific
  hook. With `FLAB_RECORD=<dir>` set the same helpers save what they read under those names (keys,
  passwords and WireGuard keys blanked), so a fixture set is captured by running the plugin once;
  `tests/network/run.ps1` does exactly that.
- **`flab.exec`**: `command_result()` (what `flab.util` wraps) runs one command through `sh -c` under `timeout`, with a time
  limit (20 s at most), an output cap (256 KiB) and the per-request budget the worker starts with `begin_budget()`. It
  returns `{ ok, code, output, truncated, timed_out }`.
- **`flab.jobs`**: `launch_job()` builds the shell script that runs a long command (a capture, an iperf3 server) in the
  background with bounded output, for the Toolbox.
- **`flab.worker`**: `deferred()` wraps every method of a plugin so it runs in a worker task (see Backend rules).
- **`flab.vici`**: parses `swanctl --list-sas|--list-conns|--stats --raw` output into nested objects.
  The raw format is `name {key=value list=[a b] section {...}}`; values may contain spaces
  (`class=pre-shared key`), so a value ends where the next `key=` or `key {` begins. `events()` returns
  every event (several IKE SAs can share a connection name); `query()` merges them by name and is only
  safe where names are unique (`list-conns`); `reply()` is for request/reply commands such as `stats`.

## Backend rules

- **Whitelist fields.** Build the response explicitly; never pass a raw dump through. `flab.ipsec`
  parses `ip xfrm state` but only copies algorithm names, sizes, counters and encapsulation; the key hex
  is dropped. `flab.wifi` never copies Wi-Fi keys from `network.wireless status`; `flab.wireguard` only uses
    `wg show` forms that never print keys. The plugins that return an editable config (`flab.radio config`,
    `flab.network config`, `flab.wireguard status`, `flab.ddns status`) return every option except those whose name says
    it holds a secret, and report only that such an option is set.
- **Redact free text.** `flab.logs` replaces values after `password`, `psk`, `secret`, `token`, `key` and
  similar names with `<redacted>` (the whole quoted value of `password="a b"` or `"psk":"x y"`; an unterminated quote
  leaves the rest of the line visible), because daemons sometimes log them and the page shows them to anyone who
  can sign in (and they end up in downloaded files).
- **Never call a ubus object served by rpcd itself** from a plugin (any `flab.*`, `session`, `file`, ...).
  rpcd runs plugins in-process, so the call blocks its own event loop. Calling `netifd`, `hostapd.*`,
  `dhcp`, `network.*` objects is fine.
- **Shell safety.** Anything interpolated into a command line, a path or a UCI name must be validated first, and an
  unvalidated value must never be quoted into a shell string instead. `safe_ifname()` validates interface names (no line break, no leading `-`, not `.` or `..`).
  A `^...$` pattern in ucode matches the first line of a string that contains a line break, so `1.1.1.1\nid` passes
  `/^[0-9.]+$/` and the second line would run in the shell: test `one_line(value)` (a string without `\n` or `\r`,
  `flab.util`) before the pattern, as `safe_ifname()` does.
- **Speed.** Collect once per call and cache in local variables. The UI polls every 3 to 10 s; the logs
  plugin returns at most 2000 lines per source (500 by default) so a poll stays small.
- **Blocking and errors.** All production plugin handlers run in deferred `uloop.task` workers, leaving rpcd free to
  serve requests and rollback timers. Workers have a 24-second deadline; commands have a 20-second maximum, a 256 KiB
  per-command output cap and a 1 MiB request output budget. At most four workers run per plugin module, with no queue
  (this is not a global four-worker limit). Mutation calls are serialized per object. `command_result()` preserves
  exit status, timeout and truncation; routing/firewall queries and controls use it where success matters. `run()` is
  a compatibility reader for optional probes, not a way to prove a command succeeded.
- **Worker state.** A worker is a fork snapshot, not a persistent service. Module-local provider, hardware/EEE
  and cable-support caches are request-scoped in production and are not merged back into rpcd. This trades more
  repeated discovery work for isolation and responsiveness; test memory and polling cost on smaller devices.
  Each plugin module still has a four-worker cap, and `flab.worker` also keeps a process-wide eight-worker budget
  across all plugin modules so concurrent pages cannot multiply the fork count without bound.
- **Diagnostic helpers.** `flab.diag-validation` owns the request validators and safe command-line quoting, while
  `flab.diag-jobs` owns job IDs, state, bounded reads/downloads, retention and stop checks. `flab.diag` keeps the
  tool-specific command builders and output parsers.
- **Diagnostic storage.** Output-file and retained browser text are each capped at 256 KiB, independently of the
  64 KiB read chunks. Reaching the job limit terminates the producer and reports the cap explicitly. Cleanup of old
  finished jobs runs on another start request, not from a periodic timer.
- **ucode specifics.** Arrays have no methods (`push(arr, x)`, `slice(arr, 1)`, not `arr.push`). Function
  declarations are not hoisted: define a helper before its caller. Redeclaring a `let` makes rpcd silently
  skip the plugin. Regular expressions are POSIX ERE (no `(?:` non-capturing groups, no lazy quantifiers); the
  code uses `[[:space:]]` instead of `\s` in classes. Use `100000.0` to force float division. Optional
  chaining (`a?.b`) and `??` work. `ucode -c <plugin>.uc` checks syntax (library modules with `export`
  cannot be compiled that way). Exported function declarations end with a semicolon for parser compatibility.
  `0 == ''` is true, so `util.num()` (which tests for `''`) turns the integer 0 of
  a ubus reply into null: use it for strings only, and test a number with `type(v) == 'int'`.
