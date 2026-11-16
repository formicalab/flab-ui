# Traffic (route `#traffic`)
Where the bandwidth goes, in four tabs on one page (the tab strip sits in the command bar). Connections is offered when
the router has connection tracking, Usage only when it has `nlbw`, and Settings whenever `flab.traffic` answers (it says so when
nlbwmon is not installed); `flab.traffic status` reports which features exist.
Only the open tab is polled, every 3 s. The connection table, nlbwmon and the settings cost the router more than reading a counter, so
those three tabs reuse their last answer until it is 10 s (Connections, Settings) or 30 s (Usage) old, unless the request changed or
Refresh was pressed. The state (open tab, filters, sorts) lives in the page, so it survives the redraw on every poll.

## Live tab
Reads `flab.network status` and netifd's interface dump, the same calls and the same rate tracker as the Ethernet ports view
(`network/shared.js`, `network/util.js`), so a counter sampled by one page serves the other, and `flab.traffic status` for the
connection count (optional: without the plugin the tab still works and is the only one). No counter is read a second time.
- **Interfaces** (`model.deviceRows`): every device `flab.network` reports, once each: Ethernet ports, the CPU conduit of a
  switch, bridges, their members (wired, Wi-Fi with the SSID, VLAN) and VLAN devices. They come from the router on every
  poll, with the logical interface names (`wan`, `lan`) from the interface dump. A PPPoE or tunnel device that
  `flab.network` does not list (`pppoe-wan`, `wg0`, `xfrm0`) has no row of its own; a PPPoE WAN is carried by the VLAN or port it
  runs on, which is listed.
- **WAN**: the interfaces that are up and have a default route (IPv4 or IPv6); a router without one falls back to an interface
  named `wan`. The row that carries it is the L3 device when it is listed, else the device it runs on (`pppoe-wan` runs on
  `eth1.1036`); links that share a device are listed once and the row is marked WAN and sorts first.
- **Table**: link state and speed (an unplugged port is neutral gray, not red), download and upload in line units
  (Mbit/s), a sparkline of both directions (60 samples), the share of the link speed the busier direction uses, and the
  counters since boot. A bridge, a VLAN device and the CPU conduit repeat what the ports under them carry, so they are
  dimmed and left out of the totals. A long list draws its first 40 rows with a "Show all" button.
- **Tiles**: WAN throughput (and which device carries it), all interfaces (ports, Wi-Fi and other members that count; routed
  traffic is counted on both sides, and the tile says so), the busiest interface, the connection count against the limit
  (amber from 80%, red from 95%) and what the WAN device moved since boot.
- **Banner**: the connection table nearly full, and nlbwmon installed but not running.

## Connections tab
The connection tracking table (`flab.traffic connections`).
- **Tiles**: connections against the limit, TCP/UDP/ICMP counts, established, unanswered (never got a reply), translated by
  NAT, and the busiest source.
- **Banner**: the table close to its limit; an analysis that did not cover the whole table (see below); a host that holds
  100 or more connections and at least 40% of the analyzed table, or 3000 of them; unanswered connections (50 or more and a
  quarter of the table, or 20 or more from one host); packet and byte counters switched off (`nf_conntrack_acct=0`).
- **Busiest sources and destinations**: the ten hosts with the most connections and the ten with the most traffic, by original
  source and destination address, with the host name where the router knows one and the number of unanswered connections. A
  click on a host filters the table to it.
- **Table**: one row per tracked connection: family and protocol (ICMP types are named), the original endpoints with
  their ports (IPv6 in brackets and compressed) and the host names below, the **translated** tuple when NAT changed it, the
  state badges, the remaining life and the packets and bytes of both directions (↑ the original direction, ↓ the replies). SNAT is
  the masquerade of the LAN behind the WAN address (the source becomes the WAN address and port) and DNAT a port forward
  (the destination becomes the inside host and port); the badge's tooltip says so. A TCP row shows its state, a UDP flow without
  a state word shows `assured` or `replied`, a flow nobody answered has `UNREPLIED` and a tinted row, and a flow in the flow
  table shows `offloaded` with no countdown (the kernel prints no timeout for it). Without byte counters the size cell
  is a dash and nothing fails. A legend above the table explains these.
- **Controls** (command bar): filter text (host, name, address, port, protocol, state, flag; every word must match; typing waits
  for a pause before it asks again), a protocol selector filled from what the table holds, All traffic / Internet traffic /
  Internal only, the order (most traffic, most packets, longest timeout) and how many rows to fetch (300, 1000, 2000). The page
  draws the first 100 fetched rows and a "Show all" button for the rest. "Internal" means that all four addresses of the entry
  (both directions) are private, loopback, link-local, unique-local, multicast or shared (CGNAT) addresses; "Internet" is everything else.
  A filter the plugin would refuse is not sent: the page shows why.

## Usage tab
nlbwmon's counters per host (`flab.traffic usage_periods` and `usage`); the tab exists only when `nlbw` is installed.
- **Note** above the tiles, one box: first the accounting period the numbers belong to (its dates, how many days it has run and,
  for the running period, when it ends and the counters start again from zero; a stored period shows both dates and that it is
  finished), then what the numbers are: what nlbwmon has counted since the period started, download is what a host
  received and upload what it sent, nlbwmon must be running (nothing is recorded while it is stopped) and only the networks it
  lists as `local_network` are counted. The period is worked out from `database_interval` in `/etc/config/nlbwmon` (a day of the
  month, negative from the end, or `YYYY-MM-DD/NN` for every NN days) and the router's date, because nlbwmon itself does not say
  when the running period began (it is listed by `nlbw -c list` only once committed to disk).
- **Period selector**: the running period with its start date (`nlbw` without `-t`; it is not listed a second time as a stored
  one, whose copy is only as new as the last commit) and the older stored periods `nlbw -c list` prints, newest first.
- **Tiles**: the period total (with the average per day over the days the period has run), download, upload, the top host (name and
  share), the number of hosts and connections. The totals come from the plugin and cover every row, also those left out of the reply.
- **Hosts**: one row per device: the IPv4 and IPv6 rows nlbwmon keeps for one MAC (it is asked for the group `mac,ip`) are
  summed, so a device with an IPv6 privacy address is still one row. Traffic with the all-zero MAC has no device behind it, so
  each of its addresses stays one host. The row shows the name (from DHCP and hosts data, else the address), the MAC, every
  address, download, upload, total, a share bar and the connections; the columns sort and the filter in the command bar
  matches name, MAC or address. A long list draws its first 50 rows with a "Show all" button. A device whose counters cannot be right
  (in a direction with at least 100000 packets, fewer than 28 bytes per packet on average, less than the smallest IP packet) is marked
  "counters look wrong".
- **Protocols**: the same period grouped by `layer7`: nlbwmon's application name (HTTPS, QUIC, DNS, ...), else the transport and
  port ("TCP 8443"), else "Other IP"; the twelve largest and the rest summed.
- **Banner**: nlbwmon installed but not running (the tab then shows only the note and no periods), a period with nothing counted,
  an error from `nlbw`, counters that cannot be right (a warning that says how bad, that totals are inflated and names a known cause,
  flow offloading, which on the main router fed nlbwmon about one byte per packet and inflated a month to tens of terabytes), rows
  left out by the plugin's cap.

## Settings tab
The accounting settings of nlbwmon, editable through UCI (`/etc/config/nlbwmon`, the one `nlbwmon` section; the config holds no
secrets, so the page reads it with rpcd's own `uci get`). Every option of the init script has a control, the default as a
placeholder when it is not set, and a hint taken from nlbwmon's README, its source and the init script. A login without write
permission sees the same page read-only, with a note. The tab is `settings.js` (cards and saving), `settings-schema.js` (the option
table) and `settings-model.js` (pure: draft, validation, effects, the UCI plan, the check after a save).
- **Tiles**: nlbwmon (running or stopped, its process, and whether it runs with the saved settings: the command line procd reports
  is compared with what the saved options mean), the accounting period now (day N of M, its dates, when the next starts), the
  periods held against the number to keep, and the database (RAM, flash, external or read-only, where it really is and when it was
  last written).
- **What is counted**: `local_network`, a list. An entry is a network name (the init script resolves it to the network's subnets) or
  an address with a prefix or mask (IPv4 or IPv6); a name with a dot or colon is an address to nlbwmon. An invalid entry would stop
  nlbwmon from starting, so it is an error; a name the router does not have is a warning; an empty list warns that nothing is
  counted. The effect line shows the subnets the running daemon counts and the router's network names.
- **Accounting periods and history**: `database_interval` (a day of the month, negative from the end, or `YYYY-MM-DD/N` for every N
  days; the effect line shows the running period for the draft) and `database_generations` (0 to 1000, 0 keeps every period; the
  effect line and a warning name the stored periods that the next start of nlbwmon would delete, worked out the way nlbwmon does:
  every period that began this many periods back or earlier). Changing the interval warns that the stored periods keep the dates they
  were cut at (and that switching between a day of the month and N days may make them unreadable as periods); a start day of 29 to
  31 warns that the shorter months are not documented.
- **Database storage**: `database_directory`, `commit_interval`, `database_compress`. The directory is validated (absolute, at most
  126 characters because nlbwmon refuses longer, letters, digits and `. _ + @ : = , / -` only, no `..`, not `/`, `/proc`, `/sys`,
  `/rom` or `/dev`). The router then says what it is (`flab.traffic nlbwmon_paths`): the real path after links (`/var` is `/tmp`),
  the filesystem and whether it is RAM, the router's flash, external storage or read-only, whether it exists (nlbwmon creates it),
  and the database files in it. A path typed but not saved is asked about after a pause in typing, once per path. A directory that is
  a file, below a file or on a read-only filesystem is an error. Changing the directory warns that nothing is moved: the stored
  periods stay in the old directory and the running period starts from zero in the new one. The commit interval (units `w d h m s`,
  at most 24 days, because nlbwmon multiplies by 1000 into 32 bits) warns when it is under an hour and the directory is not in RAM,
  with the number of writes a day.
- **Polling, memory and protocols**: `refresh_interval` (at least 1 s; a very short or long one warns), `database_limit` (0 for no
  limit; the effect line gives the RAM it can use at roughly 100 bytes an entry and its share of the router's memory, and a very low,
  missing or huge limit warns), `database_prealloc` (warns that it does nothing without a limit), `netlink_buffer_size` (bytes, at
  least 32768, a `K` or `M` suffix is accepted and written in bytes, a buffer under 128 KiB warns) and `protocol_database` (the file
  must exist and be readable; the router is asked, and a missing, unreadable or non-regular file is an error because nlbwmon does not
  start without it).
- **Review and saving**: the shared review banner lists every change from what to what and every error and warning; Save is off
  while anything is invalid. Only what changed is written, an emptied option is deleted rather than set to an empty string, and a
  missing `nlbwmon` section is created. Saving uses `applyChange()`: stage, apply with the 30 s rollback countdown (the apply reloads
  nlbwmon, which writes its counts to disk first and deletes the periods beyond the number to keep when it starts), read the config
  back and compare it, then (when nlbwmon ran before the change) wait until procd shows nlbwmon running with a command line that
  matches the saved options and the same process in two looks 1.5 s apart (up to eight looks). A config that is not kept, a daemon
  that stopped, one that kept the old command line and one that keeps restarting each roll the change back and name the reason. When
  nlbwmon was not running before, only the config is checked.
- **States**: no nlbwmon (no config and no `nlbw`) is a note, not an error and not a form; a config that cannot be read although
  `nlbw` exists is an error note; a missing plugin removes the tab (the page falls back to Live); changes already staged in this
  session are shown with a "Discard them" button; the page does not poll over unsaved edits, a focused control or a save, and an
  unsaved edit survives a change of tab. The Settings tab also uses `service list`, `network.interface dump` and `system info`, which `flab-base.json` grants.

## The plugin
`flab.traffic` only reads the router; it writes nothing. The ACL fragment
(`rpcd/acl.d/flab-traffic.json`) grants its five methods and `uci get` and `changes` on the `nlbwmon` config under `read`, and
`set`, `add`, `delete`, `revert`, `apply`, `confirm` and `rollback` on the `nlbwmon` config under `write`; there is no generic `file`
or exec grant. Live throughput is not here: it is the counters `flab.network` already reads.
- `status`: `conntrack` (the tracker is loaded: its count file exists), `count`, `max`, `acct`, `nlbw` (`command -v nlbw`),
  `nlbwmon_running` (`pidof nlbwmon`). It never reads the table itself.
- `connections` (`q`, `limit`, `sort`, `proto`, `scope`): parses `/proc/net/nf_conntrack` (read through `sysfs_raw`, so the
  tests can replay it), at most 20000 lines, and stops earlier when the call has used 3 s (a huge table on a small router must not hold
  up rpcd). `total` is the number of lines, `parsed` the entries analyzed, `truncated` says some were not, `matched` how many pass the
  filters, `entries` the first `limit` of them sorted, `names` the names of the addresses the reply mentions and `aggregates` the
  counts per protocol and TCP state, the unanswered and translated entries and the ten busiest sources and destinations by
  connections and by bytes (and the five sources with the most unanswered connections). The aggregates cover everything analyzed, not
  only what passed the filters. Each entry has `family`, `proto`, `state`, `timeout` (null for an offloaded flow), `flags`, `src`,
  `dst`, `sport`, `dport` (the original tuple), `icmp` (the ICMP type), `nat` (the original tuple as the other side of a
  translation sees it, only when the reply is not the mirror image of the original) and `bytes` / `packets` as [original, reply]
  (absent without counters). IPv6 addresses (zero-padded in the kernel's file) are compressed the way `ip` prints them; names come
  from uci dhcp `host` sections, odhcpd's `dhcp ipv4leases` and `ipv6leases`, `/tmp/dhcp.leases`, `/tmp/hosts/*`, `/etc/ethers` and the
  ARP and IPv6 neighbor tables (a SLAAC address takes the name of its MAC), with the domain removed, never from reverse DNS.
- `usage_periods`: `present`, `running`, the periods (only plain dates `nlbw -c list` printed, newest first; none while nlbwmon
  is stopped), `current` (the start date of the running period) and `today`, both worked out from `database_interval` and the
  router's date.
- `usage` (`period`, `group`): `period` is `current` or a date that `nlbw -c list` printed, `group` one of `fam`, `mac`, `ip`,
  `mac,ip`, `layer7`, `ip,layer7`, `mac,layer7` (nlbwmon's own columns follow: `family` for `fam`, `proto`, `port` and `layer7` for
  `layer7`). The reply has `columns`, `rows` (objects, largest total first, at most 3000, with `total_rows` and `truncated`), `totals`
  over every row, `names` by MAC and by IP and `window` (`start`, `end` (the first day of the next period), `today`, `ongoing`, `days`).
  Without nlbw, with nlbwmon stopped, for an unlisted period or when `nlbw` prints no data
  the reply is `{ ok: false, error }`.
- `nlbwmon_paths` (`dir`, `protocols`, each optional): describes the paths nlbwmon's settings name. `dir`: `path`, `resolved` (links
  followed, for a directory that does not exist yet the nearest existing parent plus the rest), `exists`, `is_dir`, `blocked` (not a
  directory, or below a file), `mount`, `fstype`, `device`, `readonly` (from `/proc/mounts`, longest mount point that is a prefix),
  `kind` (`volatile`: tmpfs or ramfs; `readonly`: mounted read-only or squashfs; `flash`: overlay, jffs2, ubifs, `/overlay` or a
  `/dev/mtd`, `/dev/ubi` or `/dev/loop` device; `storage`: anything else; `unknown`: no mount found), and `files` and `total`: the
  database files in it (`<YYYYMMDD>.db` or `.db.gz`, newest first, at most 100) with their size and last write. `protocols`: `path`,
  `exists`, `file`, `size`, `readable`. Each path is checked before any filesystem function sees it (an absolute path of at most 126
  characters for `dir` and 255 for `protocols`, only letters, digits and `. _ + @ : = , / -`, no `..`, no newline); one that fails
  comes back as `{ ok: false, error }` with no data. It uses only `stat`, `lsdir`, `realpath` and `open` of ucode and `/proc/mounts`,
  never a shell, so the rule about the only `run()` calls below still holds.
- **Validation**: every argument is checked before anything is built, and a request that fails comes back as `{ ok: false, error }`
  without entries. `q`: a string of at most 64 characters from letters, digits and `. : - _ /` and space (a newline is refused too); `limit`: an
  integer from 1 to 2000 (default 300); `sort`: `bytes`, `packets` or `timeout`; `proto`: `all` or 1 to 12 lowercase letters and digits; `scope`: `all`,
  `internet` or `internal`; `period` and `group` as above. `connections` never reaches a shell. The only commands the plugin runs are
  the fixed strings `command -v nlbw`, `pidof nlbwmon`, `ls /tmp/hosts`, `ip -6 neigh show`, `nlbw -c list` and the `nlbw -c json`
  command, whose group is the allow-list's own string and whose period is the date taken from nlbw's own list, never the request's text; a test
  reads the plugin's source and fails if any other `run()` call appears or one is built from a template.
- **Speed**: ucode runs a few hundred thousand operations per second on a small router (5 to 7 s for 20000 entries on a GL-X3000
  with the time limit off, which is why the limit exists), so the loop cuts each line at its `src=` markers with string functions (regular expressions cost
  far more), reads TCP and UDP lines by position and builds the full entry only for the lines it returns.
