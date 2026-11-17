# Testing

The suites below are driven by `run.ps1` scripts that never change the router's configuration or touch a service. The BGP, IPsec, Routing and
network suites share one mechanism (the "Common mechanism" below): the repository's plugins run **on the router**
against saved fixtures (`FLAB_FIXTURES`, with `ucode -L` so the uploaded libraries win over the deployed ones), and
an optional browser pass opens the deployed UI in Edge through `playwright-core` (installed into a temporary
folder) with the plugin calls intercepted and answered with the scenario JSON. The Settings, DHCP, VLAN editor, Static routes, Network board and Network panels suites have no
plugin: they unit-test their models and, with `-Browser`, drive the page against a mock (of rpcd's `uci` object; the Network panels suite also needs no router). The other editing suites (Wi-Fi editing, Network editors, Firewall editing, WireGuard editing, nlbwmon settings, Dynamic DNS, DNS, Services) also run their plugin on the router against fixtures.

| Suite | Command | Covers |
|---|---|---|
| BGP | `pwsh -File flab-ui\tests\bgp\run.ps1 [-Browser]` | `flab.bgp` parser and findings, the BGP tab of the Routing page |
| Routing | `pwsh -File flab-ui\tests\routing\run.ps1 [-Browser]` | The Routing model (addresses, tables, findings, filters, lookup meaning, rule origins); `flab.routing` against a captured and a synthetic router (every route and rule syntax, every lookup answer, refused input); the Routes tab, the lookup and the BGP tab against mocked replies |
| Toolbox | `pwsh -File flab-ui\tests\toolbox\run.ps1 [-Browser] [-KeepWork]` | The Toolbox model (request checks, the parsers of ping, traceroute, DNS, comparison and certificate output, the connectivity check's verdicts, MAC handling) and, from real captures, the parsers of the iperf3 events, the DNS trace and mtr and the AS data of a traceroute; `flab.diag` running real jobs on the router (streaming, offsets, stop, DNS, traceroute, mtr, a DNS trace, an iperf3 server with a loopback client, the router's own certificate, a comparison, a whole connectivity check, a packet capture on loopback (streaming, a second capture refused, Stop, the pcap and its download, advanced filters), a Wake-on-LAN packet on loopback, every allowed option, every refused tool request of `refusals.txt` and every refused wake request of `wake-refusals.txt` with an injection canary, job-id traversal, the three-job cap, CRLF source); the page against a scripted job engine |
| Traffic | `pwsh -File flab-ui\tests\traffic\run.ps1 [-Browser]` | The Traffic model (interfaces, WAN, totals, findings, endpoints, NAT, states, merging hosts by MAC, filtering and sorting, protocol rows); `flab.traffic` against a captured and several synthetic routers (every protocol, TCP state, NAT form and IPv6 spelling, a 60000-entry table, nlbwmon periods, no nlbw, no conntrack, no accounting) checked against an independent reference, and every refused argument; the Live, Connections and Usage tabs against mocked replies (the Settings tab is covered by the nlbwmon settings suite) |
| IPsec | `pwsh -File flab-ui\tests\ipsec\run.ps1 [-Browser]` | `flab.ipsec`, IPsec page, throughput history |
| Network | `pwsh -File flab-ui\tests\network\run.ps1 [-Browser]` | `flab.network`, `flab.radio`, `flab.mesh`, `flab.wireguard`, `flab.firewall`, `flab.logs`; Ethernet, Devices and Interfaces (the bridges on its board), Wi-Fi radios (with the networks and mesh points), WireGuard, Firewall and Logs pages; navigation order; unit tests of the shared helpers (including the session, `uci` and `applyChange` layer) |
| Settings | `pwsh -File flab-ui\tests\settings\run.ps1 [-Browser]` | System settings model, option table and zone table; the whole editing flow against a mock router |
| DHCP | `pwsh -File flab-ui\tests\dhcp\run.ps1 [-Browser]` | DHCP model (address helpers, reading config and leases, validation, change plan); the page against the router's own data, then the whole editing flow against a mock router |
| DNS | `pwsh -File flab-ui\tests\dns\run.ps1 [-Router ...] [-Url ...] [-Browser]` | The DNS model (tiles, findings, activity, options) and the zones (Unbound's blocks of every type and dnsmasq's entries: drafts, order, changes, validation, the UCI operations, the checks after a save); `flab.dns` against a captured and several synthetic routers (Unbound with and without extended statistics or `unbound-control`, dnsmasq, both, stopped, none, cut lists) and a call with shell metacharacters as arguments; the page against mocked replies, including adding, editing, removing and saving zones |
| Wi-Fi | `pwsh -File flab-ui\tests\wifi\run.ps1 [-Browser]` | Wi-Fi channel model (blocks of channels, errors and warnings, change plan); the radio cards and pickers of the Wi-Fi radios page against the router's own data, then the whole channel-change flow against a mock router |
| Wi-Fi editing | `pwsh -File flab-ui\tests\wifiedit\run.ps1 [-Browser]` | The editing model (reading, draft, review, validation, warnings, UCI operations, check after a save, what to wait for); `flab.radio config` and `status` against fixtures (nothing is executed) and a read-only run on the router with a check that none of its stored Wi-Fi secrets is in a reply; the radio settings and network editors against the router's own configuration, then the whole editing flow against a mock router |
| Network editors | `pwsh -File flab-ui\tests\ifedit\run.ps1 [-Browser]` | The editors of the Devices and Interfaces page (the panels in the drawer) and the settings of a port on the Ethernet ports page: the model (value checks, option tables, draft, review, validation, dangerous changes, UCI operations, check after a save); `flab.network config` (the `globals` section included) against fixtures with a secret in every kind of place and a read-only run on the router; the board against the router's own data, then the whole editing flow against a mock router |
| Network board | `pwsh -File flab-ui\tests\netboard\run.ps1 [-Browser]` | The board model (lanes, edges, protocol devices, tunnels, wireless, the draft's new and removed items, highlighting, findings, counts) and the pure parts of the drawer and of the bridge information; the board against the router's own data (read only) at 1920, 1280 and 900 px in both themes, the drawer, the Device menu, highlighting, leaving the page and the old `#bridges` route |
| Network panels | `pwsh -File flab-ui\tests\netpanels\run.ps1 [-Browser]` | The panel and wizard model (protocol cards, essential and advanced options, device chooser, what a protocol change drops, used by, suggestions, the wizard's draft effects, validation and plan); with `-Browser`, the real panels, drawer and wizard against a stateful mock of the network config, served by a local web server (no router, nothing to deploy) |
| VLAN editor | `pwsh -File flab-ui\tests\vlanedit\run.ps1 [-Browser]` | The VLAN editor's model (reading the sections, the tables of a bridge and of a swconfig switch, the draft, the review, validation and lockout warnings, the UCI operations, the check after a save); the Ethernet ports page against the router's own config (read only), then the whole editing flow of a bridge and of a swconfig switch against a mock router |
| Static routes | `pwsh -File flab-ui\tests\routeedit\run.ps1 [-Browser]` | The Static routes model (reading the `route` and `route6` sections, an older netmask, the draft, the review, validation and warnings, the default-route risks, the UCI operations, the check after a save, what the kernel holds); the tab against the router's own config (read only), then the whole editing flow against a mock router (see below) |
| WireGuard editing | `pwsh -File flab-ui\tests\wgedit\run.ps1 [-Browser]` | The WireGuard model (address math, keys, draft, review, UCI plan, validation, the tunnel you work through, check after a save, add-a-device helpers); `flab.wireguard` against fixtures and read only on the router; the page against the router's own interfaces, then the whole editing flow against a mock router |
| Firewall editing | `pwsh -File flab-ui\tests\fwedit\run.ps1 [-Browser]` | The Firewall editing model (reading, draft, zones, forwardings, rules, port forwards, defaults, validation, the lock-out check, UCI operations and section order, the check after a save); `flab.firewall` against fixtures and read only on the router; the page against the router's own firewall (read only), then the whole editing flow against a mock router |
| nlbwmon settings | `pwsh -File flab-ui\tests\nlbwedit\run.ps1 [-Browser]` | The nlbwmon settings model (reading, every option's validation, the accounting window and the periods a lower count deletes, effects, warnings, the UCI plan, the check after a save, the daemon check); `flab.traffic nlbwmon_paths` against fixtures (RAM, flash, USB, read-only, network share, a missing or blocked directory, 100+ files, no `/proc/mounts`, refused paths) and once for real; the Settings tab against the router's own config, then the whole editing flow against a mock router |
| Services | `pwsh -File flab-ui\tests\services\run.ps1 [-Browser]` | Services model; `flab.services` against fixtures (nothing is executed) and a read-only `list` on the router; the page against the router's own services, then the whole start, stop and restart flow against a mock |
| Dynamic DNS | `pwsh -File flab-ui\tests\ddns\run.ps1 [-Browser]` | Dynamic DNS model (reading, draft, validation, change plan, check after a save, verdicts, intervals, log parsing); `flab.ddns` against fixtures (nothing is executed) and a read-only `status` and `log` on the router; the page against the router's own services, then the whole editing and action flow against a mock |
| Pure/syntax aggregate | `node tests/run-pure.mjs` | All pure regression files, JavaScript syntax, ACL JSON, the lazy application-shell tests and the browser-cache refresh (`tests/shell/freshness.test.mjs`: unchanged build, changed build, first run, failed download, unusable reply) |
| Native execution | `node tests/execution/run.mjs [root@router]` | Disposable chroot/private ubus, not the installed rpcd: deferred workers, timer responsiveness, error statuses, deadlines, saturation, command and diagnostic-output limits, and that `safe_ifname()` / `one_line()` refuse a value with a line break |
| Release recovery | `pwsh -File tests/tooling/release.test.ps1` | Failure injection with disposable local Git remotes, recovery after commit/push failure and release-note validation |
| Local source isolation | `wsl -d Ubuntu-26.04 -- bash tests/tooling/source.test.sh` | Verify that a working-tree SDK source override applies only to flab-ui, not its dependencies, and that the working-tree release number replaces only `PKG_RELEASE` in the SDK's copy |
| Local SDK entry recovery | `pwsh -File tests/tooling/build.test.ps1` | Verify that working-tree build preparation leaves the feed definition intact and restores the SDK package entry after success or failure |

`-Browser` needs the UI installed (`tools/package.ps1 -Action Deploy`) and signs in with a temporary rpcd session that
`tests/TestSession.ps1` creates over ssh, grants what the ACL fragments grant, and destroys afterwards, so no
password is needed. Every suite removes its local temp folder when it finishes, and the BGP, IPsec, Routing and network
suites also remove their `/tmp/flab-*-test` folder on the router. Do not run two suites of the same name at once on one router, because they share those folders, and do not run `tools/package.ps1` while a browser suite is running.

## What these tests do not establish

- Mocked writes do not test real netifd/firewall reload timing, runtime connectivity, or a rollback after losing the
  browser connection. Do deliberate real-router checks only with alternate management access.
- Temporary sessions use grants assembled from the checkout's ACL JSON, not the installed fragments. A package that
  omitted an ACL can still pass a browser suite; separately verify package contents and a normal login on a fresh image.
- Backend fixtures and `ucode -c` do not establish compatibility with every board, ucode version or optional daemon.
  The current hardware baseline is one GL-MT6000. Browser automation uses Edge.
- A green test is not a substitute for checking the intended contract. The UCI regressions exercise session-wide
  preflight, transport deadlines, uncertain outcomes and cleanup failures; static-route tests distinguish full FIB
  identity and require installation verification for changed routes on running interfaces.
- Validation runs locally: `node tests/run-pure.mjs`, the individual hardware/browser suites and the WSL SDK build.
  There is no repository CI workflow. `-Action Release` builds and checks installation but does not run the application
  test suites, so run them first.

## Common mechanism (BGP, IPsec, Routing and network suites)

1. **Capture**: each plugin is run once on the router with `FLAB_RECORD` set, so it saves its own inputs
   (`ubus call` results, UCI, sysfs files, command output) under the fixture names. Keys and passwords
   (including WireGuard `private_key` / `preshared_key`) are blanked while recording, and the scenario builder
   plants a canary secret in every place the router keeps one so the assertions prove it is never forwarded;
   it aborts if a capture still holds a real WireGuard key.
2. **Scenarios** (`mkfx.mjs`): the captured state with targeted edits. Binary data is generated or encoded
   (the bridge forwarding table is synthesized; device-tree files are recorded hex-encoded as `hex:...`).
3. **Backend run** on the router for every scenario and plugin, then **assertions** (`assert.mjs`) on the JSON.
4. **Browser pass** (`live.mjs`): drives each page through the scenarios without a reload, checks tiles,
   cards, findings, legends above their data, simulated live rates and the absence of console errors.

## BGP scenarios
`base` (unchanged), `down` (a peer in Active with an error and a connect timer; synthetic), `dual` (IPv6
channels, IPv6 ECMP routes with link-local next hops, one best route missing from the kernel, an IPv6
announcement), `announce` (different announcements per peer, a non-static origin, a peer that receives
nothing). The plugin reads `FLAB_BGP_FIXTURES` instead of running `birdc`/`ip` when it is set (rpcd never sets
it). The browser pass adds peer removed, peer added and eight peers; it opens the BGP tab of the Routing page.

## Routing scenarios
`real` (what the router under test reports, checked for invariants only), `rich` (synthetic and deterministic: every
route and rule syntax the parser handles, an `/etc/config/network` with rules and a planted key that must never
appear in the output, a running charon) and `noip` (the tool printed nothing). The fourteen lookup cases cover a
forwarded packet, ECMP, local and broadcast addresses, a blackhole, an unreachable and a missing route, a lookup with a
source and an arrival interface for IPv4 and IPv6, an answer from a named table, mixed address families, and three
refused inputs (shell metacharacters in the destination, the source and the interface name; they have no fixture, so
a command that ran would show up as an error). Unlike the BGP plugin, `flab.routing` uses the shared fixture seam
(`FLAB_FIXTURES`, file names derived from the command line). The browser pass answers `flab.routing`, `flab.bgp` and the
interface dump from the scenario output and drives the Routes tab, the lookup (including the failover and the polling
pause, and its Ping and Traceroute buttons into the Toolbox, which are answered by a mock so nothing runs), the table and
rule cards, the BGP tab and the cases without BIRD, without `ip` and with a long route list.

## Toolbox suite
`pwsh -File flab-ui\tests\toolbox\run.ps1 [-Browser] [-KeepWork]`. `samples.mjs` holds the output busybox ping and traceroute and
the DNS tools printed on a router (a clean ping, 100% loss, a lost packet, a bad host name, traceroutes with silent hops and
with IPv6 hops answered by two routers, nslookup, kdig and drill answers and NXDOMAIN) and `samples-tools.mjs` the
output of the richer tools (a certificate check against the router's own HTTPS port, example.com, and the expired,
self-signed and hung-up cases of badssl.com, a refused port, a DNS comparison with a silent server, and a connectivity
check), shared by the unit test (`model.test.mjs`: the request a form may build, the parsers, the check's verdicts, a
certificate's findings) and the browser test. `fixtures/` holds output the tools really printed on the router (iperf3 3.22
`--json-stream` events of TCP, reverse, UDP, an aborted client and a busy port; the DNS trace script's job output for
example.com, a name behind two aliases, an in-zone alias, a name that does not exist and an IPv6 trace; `mtr --raw`; a
traceroute with its AS lookups), read by `tools.test.mjs` (the requests the form builds for mtr, the trace and the iperf3
server, the iperf3 events, the DNS trace, the mtr table and the findings about it, the AS data) and by the browser test. `flab.diag` is tested for real, not
against fixtures, because starting, reading, offsets and stopping are what it does: `run.ps1` runs the plugin with CRLF line
endings, as a Windows checkout deploys it, starts pings, a traceroute
and DNS lookups against 127.0.0.1 and localhost on the router, reads them while they run and after, reads from the end and
from an offset, stops one and checks that no process is left, starts every allowed option and compares the command line,
checks the router's own HTTPS certificate (the fingerprints, serials and dates it printed are compared with what Node
computes from the PEM text in the same output), a STARTTLS run against a closed port, a comparison of the router
against 127.0.0.1, and a complete connectivity check (whose script must carry no carriage return; a second one is stopped
half way, to see that a script job ends and leaves no ping or openssl behind), an mtr run and a traceroute with AS lookups
against loopback (no address to look up), a DNS trace of example.com from the real root servers, and an iperf3 server on
a spare port with an iperf3 client on loopback (the server reports the test, a second server is refused, Stop ends it and
no iperf3 is left),
sends the lines of `refusals.txt` (shell metacharacters, leading `-`, out-of-range and non-numeric numbers, bad
sources, servers, ports, server names, protocols and types, rounds, minutes and addresses to listen on; several would create a canary file if a command ran) and checks that all were refused, no job
appeared and the canary does not exist, tries six job ids that are not the plugin's own (paths, wrong length, empty) on
`read` and `stop`, sends a Wake-on-LAN packet out of the loopback device (where nothing hears it) and the lines of
`wake-refusals.txt` (a bad MAC, injections in the MAC and the interface, an interface that does not exist, wrong types), and starts four jobs to see the fourth refused. `live.mjs` answers `flab.diag` from a scripted job
engine (output revealed piece by piece, an endless ping, a refused start, a script that cannot run; the browser clock is held
at the day the samples were captured so the days left on a certificate do not drift) and drives the page: the navigation
entry above Logs, the form's checks, a ping
read while it runs and after, loss, no reply and a bad host, the ping chart, the options sent, stopping, traceroute (partial, not
reached, IPv6, with the networks of the hops), mtr, the DNS trace (a plain trace, two aliases, a name that does not exist, IPv6), DNS (answers, NXDOMAIN, the nslookup note), the connectivity check (a healthy router, a broken resolver, a dead
next hop, a script that fails), the lookup of several servers (the choices offered, rows arriving, DNSSEC, the fastest, the response-time chart, a silent server, one server being a plain lookup), the certificate check (a good chain, the chain and expiry pictures, an expired certificate, a server that sends only its own certificate, a gap in the chain, the
PEM copy, expired, self-signed, hung up, refused, STARTTLS, a router without openssl), Wake-on-LAN (the host list with reservations first, a typed MAC, a bad MAC, a normalized
MAC, a chosen interface, a host without an address, a refusal from the router, etherwake and socat, the Ping button, a router with
neither tool, a login without the wake permission), the iperf3 server (the form, the countdown, the connect commands, tests
arriving, Stop, the time running out, a port below 1024, an exposed zone), a router without mtr, kdig or iperf3, leaving the page and coming back, a redraw
in the middle of a job, a login that
may not run diagnostics, and the dark theme (with the new views). `-KeepWork` keeps the temporary folder so the browser test can be repeated.

## Traffic scenarios
`real` (what the router under test reports, replayed from a read-only capture of its connection table, netfilter numbers, DHCP and
hosts data and `nlbw` output, checked for invariants only: the counts add up, entries are sorted, addresses are canonical, totals are the
sums of the rows), `rich` (synthetic and deterministic: TCP in every state, UDP, ICMP and ICMPv6, GRE and an unknown protocol,
masquerade, a port forward with a changed port, an IPv6 translation, offloaded flows without a timeout, entries without counters, an
unreplied DHCPv6 request, every IPv6 compression case (a single zero group, two equal runs, the all-zero address), one heavy host
with ten unanswered connections, a garbage line, names from every source, and nlbwmon with three periods), `big` (60000 entries,
so the 20000-line cap and the speed show, and 3500 usage rows against the 3000-row cap), `noct` (no connection tracking), `noacct`
(`nf_conntrack_acct=0`, no counters), `nonlbw` and `stopped` (nlbw missing, nlbwmon not running), and `inflated` (nlbwmon counters of about
one byte per packet, as the main router's reported them). The suite pins today to 2026-11-12 (`FLAB_TRAFFIC_TODAY`), and `noct` and
`noacct` carry a `database_interval` of `2026-10-15/14` and `-2`, so the accounting window is checked under all three kinds of interval. `mkfx.mjs` writes the fixtures
(`files.json` for procfs and `/tmp`, one text file per command, one JSON file per ubus call, as `rpcd/lib/flab/util.uc` replays them) and an
independent JavaScript reference that computes what each connections call must return (the filtered, sorted and cut entries, the
counts and the top lists); `assert.mjs` compares the plugin's output with it entry by entry, and also checks the plugin source and the ACL.
The calls cover every sort, protocol and scope, name, IPv6 and port filters, translated tuples, limits and a call without arguments,
and 25 connections and 14 usage requests that must be refused (shell metacharacters, newline, subshell, wrong types, 65 characters, limits
0 and 2001, `age`, an unlisted period, a group that is not in the allow-list): each comes back as `{ ok: false }` with its reason and
no data. A call with a 50 ms time budget shows that a cut table is still the first lines only, sorted and counted. The browser pass
(`live.mjs`) answers `flab.network`, the interface dump and `flab.traffic` from the scenario outputs (the network's counters grow on
every poll), and drives the Live tab (WAN, totals, busiest interface, ordering, dimmed rows, findings, a long list, Pause, no plugin), the
Connections tab (tiles, every kind of entry, the top lists and their click-through, the filter with its debounce, the protocol, scope,
order and row selectors, invalid filters that are not sent, findings, no counters, no tracking, errors, 2000 rows, the polling cache),
the Usage tab (periods, the period note and its window under a monthly, a day-count and an end-of-month interval, tiles, merged hosts, names, filter, sort, protocols, another period, counters that cannot be right, 3000 hosts, an empty period, an error,
nlbwmon stopped and nlbw missing, which also removes the tab) and checks that the page wrote nothing and logged no error.

## DNS scenarios
`pwsh -File flab-ui\tests\dns\run.ps1 [-Router ...] [-Url ...] [-Browser]`. `real` records what the router under test reports (the capture is
read-only: `unbound-control` reads, the dnsmasq ubus metrics, UCI, procd's service list; on the main router it is Unbound, on the
GL-X3000 dnsmasq) and is checked for invariants only (shapes, uniqueness, no loopback WAN resolvers, counters that are null or
non-negative). The synthetic scenarios are hand-built, deterministic and run through the repository's plugin on the router with
`FLAB_FIXTURES`: `unbound` (extended statistics with answer codes, DNSSEC, cache sizes, ninety forward zones of which two carry
the `+i` flag, a clear-text public zone, a default zone over TLS known from the generated configuration, a WAN resolver, local
data), `unbound-basic` (extended statistics off as on the main router: the extended counters must be null, not zero),
`unbound-nocontrol` (`unbound-control` prints nothing: no statistics, a warning that says how to enable it, the version from
`unbound -V` and the forwarders from the generated configuration), `unbound-many` (520 zones and 60 sockets, to see both caps and the
`truncated` flags; two UCI zone sections, one of 89 domains that is read whole and one of 510 that is cut at 500 and so read only), `dnsmasq` (as the GL-X3000: ubus metrics, a server list with sixteen wildcard zones, a local DoH proxy and a
public server, a build without DNSSEC, the jail's pid pair, IPv6 sockets, host files and leases), `both` (dnsmasq on port 5353 behind
Unbound), `stopped` (both installed, nothing running) and `none`. A call with shell metacharacters in `host`, `zone` and `q` must give
the reply of a call without arguments, and `run.ps1` then checks that its canary file does not exist on the router. `assert.mjs` also
reads the plugin source (every `run()` call takes one fixed string, twelve different commands, nothing writes, `request.args` is never
used) and the ACL (`flab.dns: [status]` and the staged `uci` methods on the `unbound` and `dhcp` configs, nothing else). The browser pass (`live.mjs`) answers `flab.dns` from the scenario
outputs, `flab.diag` from a mock that records the request and runs nothing, and rpcd's `uci` object from a stateful mock (staged
edits, apply, confirm and rollback on the current scenario's section; any write to another config is refused and counted, and none
of it reaches the router), and drives every tile, finding and card for both
engines, both together, stopped and none; the Zones card (folded, numbered in the order of the configuration, one row per block with its
domains, filter, a focused filter that keeps the focus, read only blocks, a login that may not write); the
configuration with a default marked; the editing of the options (the review banner, the details, a save with its calls in order and
the values written, an emptied option deleted, warnings, an invalid number that opens its folded area, discarding, a resolver that
stops and is rolled back, an apply the router refuses, changes already staged, a login that may not write, dnsmasq's section); the
editing of the zones in the dialog (Unbound: edit a block, add a stub zone, a refused host name, a domain another zone takes, take one
domain out of 86, remove and keep, delete a section, the warning for the last default forwarder, a change that stops the resolver and
is rolled back, an authoritative zone and its URL; dnsmasq: edit an entry in place, add entries, remove one, the whole list written);
the WAN resolvers of the Zones card (in use, not used, partly); the
polling pause while a box has the focus; the type scale and weights; the dark theme; that nothing was written to another config and no console error
occurred. `-Router` and `-Url` default to the main router; the browser pass needs the UI deployed on the router it is given.

## IPsec scenarios
Captures `swanctl --list-conns|--list-sas|--stats|--version --raw`, `ip -s xfrm state` (key material is
redacted before it is copied; a canary key is planted), the xfrm interface addresses and their uci/netifd
data. Scenarios: `base`, `down`, `rekey` (two child SAs), `multi` (two IKE SAs under one name), `orphan` (SA
without connection, child SA without child config), `ipv6`, `daemondown`, `unconfigured` (charon stopped with an
empty swanctl config). `tests/ipsec/rates.test.mjs` unit
tests the throughput history (rates, counter resets, gaps, pauses, per-SA keys, removed connections).

## Network suite
- **Unit tests** (`tests/network/*.test.mjs`, no router): `rates` (the rate tracker), `firewall` (zone matrix and findings), `logs` (level and text filters,
  summaries, formatting) and `uci` (the session helper `can()`, `optional()`, the `uci` wrapper and `applyChange`
  against a fake transport).
- **Scenarios**: `n-linkdown`, `n-downshift`, `n-root`, `n-blocked`, `n-nostp`, `n-vlanfilter`, `n-newbridge`,
  `n-highport`, `n-nodevices`, `n-board` (a different router: other model, four LAN ports in reverse order, no
  external PHY), `n-nodsa` (no switch), `n-errors`; `n-sfp` (an optical module with an alarm, an empty cage and a
  direct-attach cable), `n-vlantable` (the kernel's `bridge vlan show`, with continuation lines and a port that is not a
  member), `n-vlanconfig` (no `bridge` tool: the `bridge-vlan` sections, one of another bridge), `n-swconfig` (an older
  board: the DSA ports removed, `swconfig list/help/show` fixtures, VLAN devices `eth0.1` and `eth0.2`, a swconfig
  `board.json`), `n-cable` (see below); radios `r-down`, `r-dfs`, `r-channel`, `r-disabled`,
  `r-newssid`; mesh `m-twopeers`, `m-weak`, `m-fwdoff`, `m-nopeer`, `m-down`, `m-nomesh`; WireGuard `w-stale`,
  `w-down`, `w-newpeer`, `w-noroutes`, `w-nozone`, `w-nowg`; firewall `f-stopped`, `f-redirect`, `f-exposed`,
  `f-disabled`, `f-anonymous`, `f-unzoned`, `f-conntrack`; logs `l-odd` (a secret, an unparsable line, an
  unknown severity, another kernel facility), `l-empty` and `l-big` (both logs over the command output cap: the system log
  is asked for again with fewer lines, the kernel log through `tail`). A capture's handshake times age while the test
  runs, so the base scenario pins the connected WireGuard peer to "30 s ago".
- **Cable test**: `cable-harness.uc` makes the calls of `n-cable` (an intact cable, open pairs, a short with its distance, a PHY
  that cannot test (asked twice, the second time answered from memory), output that is not a result, and the refusals: the
  SoC link, a bridge, an unknown name, `lan1; reboot`, a number, no argument). Every refused port also has a fixture that would
  read intact, so a refused call that ran anyway would show up as ok. The harness refuses to run without fixtures, so no
  cable is ever tested and no link ever drops during the suite; the browser test answers the call from the same results and
  fails if one would reach the real router.
- **Browser** (`live.mjs`) additions: each row's MAC and jack icon, the switch line above the table (percent of the CPU link used, a busy link
  in the line and the banner, oversubscription), the usage graph, an optical module (tag, amber icon, banner, module and optics lines, no cable
  test on a cage), EEE badges, the VLAN cards (kernel table, config table, filtering with no VLAN, none at all), an older swconfig
  board (rows, switch port numbers, CPU link, VLAN groups), and the whole cable-test flow (confirmation text for a port
  with and without link, Cancel, the four results, survival of a poll, Close, the downshift hint, a PHY that cannot test, a
  port known not to support it, and a login without write permission). The bridge and interface checks use the Devices and Interfaces board: the bridge cards and, through `bridgelive.js`, the live
  bridge information (STP root, mesh peers, a blocked port, STP off, a second bridge, no devices), and the interface cards (what each sits on, hover highlighting, zone cards, routes and prefixes under "details", an unknown
  device kept, an unattached Wi-Fi interface in the findings).

## Settings suite
Unlike the other suites it has no backend part: the page reads rpcd's `uci` object, which is not ours to fake on
the router. The unit tests (`model.test.mjs`) cover the option table (every wiki option present, every entry
well-formed), the zone table (every rule passes the rule check), reading `uci get system`, every validator, the
change plan (what is written for each kind of edit: set, delete, create a section, the two zone options, a
custom rule), staging and the read-back check; `network/uci.test.mjs` covers `applyChange`. The browser pass
(`live.mjs`) first reads the router's own `/etc/config/system` through the real page, with any uci write blocked
and failing the test, then switches to a stateful mock of `uci`, the clock and the NTP client and drives:
validation of each kind of field, the review list, a page that does not poll over edits, Discard edits, a
successful save (call order, what was written, the new hostname in the navigation header), removing an option and
a list, a change the router does not keep (rolled back), a confirmation that comes too late, leftovers from an
earlier attempt, a login without write access, the dark theme and an expired session. The mock keeps the real
router's configuration out of reach, so the suite never writes to it.

## DHCP suite
Same shape as the Settings suite, with no backend part. `model.test.mjs` covers the option tables (checked against
odhcpd's own option table: every option edited, none that odhcpd no longer reads), the address
and range helpers, reading `uci get dhcp` with the lease replies (leases mapped from device to interface),
validation, the change plan (reservations added, removed and edited, pool and daemon options, pools added and
removed, network boot entries, the server DUID in the network config) and the read-back
check; `network/uci.test.mjs` covers `applyChange`. The browser pass (`live.mjs`) first shows the router's own
leases, reservations and pools with every uci write blocked, then switches to a stateful mock of `uci` (two configs),
the `dhcp` object, the interface dump and `service list` and drives filtering, reservation edits (duplicates, the
router's own address, bad MACs, Reserve from a lease, Add, Remove and Undo), pool and daemon edits, adding and
removing pools, network boot entries, the server DUID, options without a control, a successful
save across both configs, a change the router does not keep (also in the network config), a late confirmation, a stopped odhcpd, dnsmasq serving DHCPv4 (leases read
from its lease file, an unreadable file), a login without write access,
the dark theme and an expired session.

## Wi-Fi suite
Same shape as the DHCP suite. `model.test.mjs` covers the width of an htmode, the block a channel would occupy
(fixed blocks on 5 and 6 GHz; on 2.4 GHz the second half and the covered and overlapped channels, including
netifd's rule for the side), the blocks a radio is running on, the channel part of the draft, the errors and warnings (not allowed, no
room for the width, DFS, mesh, auto), the operations and the read-back check; `network/uci.test.mjs` covers
`applyChange`. The browser pass (`live.mjs`) first shows the router's own radios with their pickers, with every uci
write and `uci get` blocked, then switches to a mock of the radio and Wi-Fi plugins (including `flab.radio config`) and a stateful mock of `uci` and drives hover
previews (fitting and not fitting, 2.4 and 5 GHz, keyboard focus), choosing, undoing, Auto, the banner and its
warnings, a page that does not poll over a pending choice, a successful save (only the channels written, the config read back through
the plugin and never with `uci get`), a change the router does not keep, a radio that does not come back (rolled back),
leftovers from an earlier attempt, a login without write access, the dark theme and an expired session.

## Services suite
Never starts, stops or restarts a service: every control call is either answered by a fixture or by a mock.
- **Unit tests** (`model.test.mjs`, no router): merging the init scripts with procd's list (states, services
  without a script, a missing plugin), the ports of a service's pids (grouping, scope), the filter, the summary, the buttons a row offers, the confirmation table
  (which services ask, the level, that `rpcd` says the session ends) and the outcome texts.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`; the calls and the expected command lines are in `cases.mjs`):
  `flab.services.uc` runs on the router with `FLAB_FIXTURES`, so it executes nothing: for each call it finds, in
  a fixture file named after the command line it builds, what that command would have printed. Scenarios `ok`
  (exit 0), `fail` (exit 1 with output), `timeout` (exit 124) and `noresult` (no exit code). The test checks the
  listing (sorted, boot state and position, junk names dropped, protected scripts), the listening sockets (parsed from a
  real `netstat -lntup` capture: repeated lines, IPv6 wildcard, loopback, a kernel socket, ephemeral UDP ports), the waited calls, the calls
  that must run in the background, and 32 refused requests (protected scripts, an unknown service, names such as
  `../../bin/sh`, `dropbear; reboot`, `-h`, a name with a line break or longer than 64 characters, wrongly typed
  or missing arguments, actions `reload`, `toggle`, `restart; reboot`, `RESTART`, `ENABLE`, `enable; reboot`; enabling or
  disabling a boot-sequence script or an unknown service): each has a fixture that would report
  success if its command were run, so a refused call that ran anyway shows up as `ok`. `enable` and `disable` are also
  checked to run in the foreground for `rpcd`, `uhttpd` and `network`. The harness refuses any
  call but `list` when no fixtures are set. `list` is also run once for real (it only reads) and compared with the
  router's `/etc/init.d` and `/etc/rc.d`.
- **Browser** (`live.mjs`): the page first lists the router's own services with any `control` call blocked and
  failing the test, then a mock of `service` and `flab.services` drives the ports of each service (chips, loopback-only
  dimming, tooltips, a socket nobody owns), the buttons, the confirmation (warning and
  danger levels, Cancel sends nothing), enabling and disabling at boot (the button that swaps, the boot column, the
  questions for the critical services, no end of the session for `rpcd`), buttons disabled while a call runs, success, a failing script with its
  output, an error from the router, stop and start without a question, a background restart, a login without
  permission, a missing plugin, the dark theme, a session that ends during a call, and `rpcd` restarted from the
  page (back to the sign-in screen).

## Dynamic DNS suite
Never changes the router's configuration and never restarts an updater: every write and every `control` call is either answered by a
fixture or by a mock, and blocked (failing the test) in the phase that talks to the real router.
- **Unit tests** (`model.test.mjs`, no router): reading the plugin's reply, the draft, which controls apply, the name and value checks,
  the errors and warnings, the UCI plan (a secret is written only when typed, an unchanged option is not written, a removed option
  is deleted only when it exists), the check after a save, the verdicts, the intervals as the updater really uses them, and log
  parsing.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`; the calls and the expected command lines are in `cases.mjs`): `flab.ddns.uc`
  runs on the router with `FLAB_FIXTURES`, so it executes nothing. Scenarios `main` (five services: secrets in several places, three
  address sources, a stopped updater, a custom provider, a log over the size limit, a device named like an option), `fail` (the init
  script exits 1 with output), `timeout` (exit 124), `noresult` (no exit code) and `empty` (no ddns-scripts). The test checks that no
  secret appears anywhere in any reply, the run-file times (uptime stamps become epoch times, a stamp from the future is ignored),
  the problem and fatal-error detection, the address of each source, the providers (a custom one overrides a default, bad lines are
  ignored), the log (masked, cut at 64 KB), and the refused requests (unknown or disabled services, names such as `home; reboot`,
  `../../etc` and a name with a line break, wrongly typed or missing arguments, other actions): each has a fixture that would
  report success if its command were run, so a refused call that ran anyway shows up as `ok`. The harness refuses `control` when no
  fixtures are set. `status` and every service's `log` are also run once for real (they only read): the reply is compared with
  the router's config, and the number of times a stored secret appears in it is counted on the router (only the count leaves it).
- **Browser** (`live.mjs`): the page first shows the router's own services, with every `uci` write and `control` call blocked and
  failing the test; then mocked replies and a stateful `uci` mock drive the tiles, the verdict of each kind of service, the actions
  (busy state, success, a failing init script), the log (filter, every line, scroll), editing (validation, the write-only password
  and its review text, the provider switch), saving, adding and removing services, a change the router does not keep, staged
  leftovers, a stopped updater, a missing ddns-scripts or plugin, a login that may not write or run actions, the dark theme and a
  session that expires. It also checks that the page never calls `uci get`.

## Wi-Fi editing suite
The radios' settings and the wireless networks (access points, client networks and mesh points) are edited on the Wi-Fi radios page, through one editor: the browser test opens the page and edits the radio sections and the networks on the same cards (go() redraws the page and keeps the draft). The model covers the radio options of the OpenWrt wireless documentation, among them the lists (channels of automatic selection, basic and supported rates, capabilities, hostapd options), and the options of a mesh point (Mesh ID, networks, SAE, password, multicast rate) with the mesh warnings (spanning tree does not see a mesh, peers lost).
Never changes the router's configuration (the only things created on the router are the fixtures and the plugin copy in
`/tmp/flab-wifiedit-test`, removed afterwards).
- **Unit tests** (`model.test.mjs`, no router): reading the plugins' replies (editable and read-only data, live state joined by
  section name), the draft (strings, booleans, lists, "none" as the open choice, secrets empty), the review list (a password is
  never shown), the operations (only changed options, emptied options deleted, one value of `network` as a plain option, a
  password written as typed and removed when it no longer applies, added networks as named `add`, removed ones as `delete`,
  hidden options neither written nor compared), adding and removing networks, every validation and warning, the check
  after a save (including an unnamed section that got a new name, an added and a removed network, a password that did not
  stick) and what to wait for.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`): the repository's `flab.radio.uc` runs on the router against fixtures
  (`FLAB_FIXTURES`): a router with three radios (one running, one switched off, one whose phy is unknown), access points and a
  client network that hold every kind of secret (including a passphrase with spaces, a hex key, an option named like a secret,
  `wifi-station` and `wifi-vlan` sections), a mesh interface, an unnamed section, a smaller hostapd, no hostapd and no radios.
  It asserts the documented fields, the names of the secrets (never their values), that options that only look like secrets (a
  `wpa_psk_file` path, an `r1_key_holder`, `ft_psk_generate_local`) are returned, the htmode lists (from `iwinfo`, derived from
  the phy, unknown), the countries, the hostapd features and the networks, and that no canary appears anywhere in `config` or
  `status`. It then runs both methods for real (they only read) and counts how often any of the router's stored Wi-Fi secrets
  appears in the replies (it must be zero; the count of secrets looked for must not be).
- **Browser** (`live.mjs`): first the router's own configuration with every uci write and every `uci get` blocked (a settings
  block per radio, an editor per network, empty password fields that say one is stored, a hint on every option), then a mock of
  `flab.radio` and a stateful mock of rpcd's `uci` object: the radio settings (mode list from the hardware, band-specific
  options, validation, disabling a radio), a mode that decides which channels fit, a successful save (only the changed options
  written, read back through the plugin), renaming a network with clients, a new password (never visible), an unnamed section,
  validation of names, passwords and network lists, the dangerous changes, the MAC filter, 802.11r and enterprise options
  appearing when they apply, adding, discarding and removing networks, a change the router does not keep, a radio and a new
  network that do not come back, a refused confirmation, leftovers from an earlier attempt, a login without write access, a plugin
  without `config`, a router without the radio plugin, the dark theme and an expired session.

## Network editors suite
The Devices and Interfaces page (the board and the panels in its drawer). Never changes the router's configuration: every write is answered by a mock, and blocked (failing the test) in the phase that talks to the real router.
- **Unit tests** (`model.test.mjs`, no router): netmasks, prefixes and subnet math; the value checks; the option tables (unique ids and options per protocol and device type, a hint on every field);
  reading the plugin's reply (a reply of another shape is "unavailable"); the router's devices; an untouched draft changes nothing; the UCI plan (a list for addresses, a deleted emptied option, flags as 1/0,
  a secret only when typed, an interface with a protocol the page does not edit never written, a protocol change deleting the old protocol's options first, defaults that follow the protocol, new and removed
  interfaces and devices, a port moved between bridges, the network-wide `globals` options); every validation rule; which interfaces are management interfaces and which changes are dangerous; the check after a save against an independently
  built "router after the plan"; interfaces that are down after a change.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`): `flab.network.uc` runs `config` on the router with `FLAB_FIXTURES` (scenarios `main`: a PPPoE password, a WireGuard private and pre-shared key, a SIM PIN, a modem
  password, `psk` and `key` options and a canary in each, anonymous and named sections in a shuffled key order, other section types, bridge VLANs, a `globals` section; `empty`; `missing`). It asserts that no canary appears in any reply,
  that the secrets are only flagged, that `keepalive` is not taken for a key, file order, list options, the counts of other sections, the `globals` reply. The harness refuses every call but `config`. `config` is also run once for real
  (only reads): the counts match `uci show network`, and the number of times a stored secret appears in the reply is counted on the router (only the count leaves it) and must be zero.
- **Browser** (`live.mjs`): the board first shows the router's own configuration with every write blocked (the panels of the PPPoE interfaces, the bridge and the network-wide settings open read only on the real data); then a stateful mock of rpcd's `uci` object and mocked flab.network and netifd replies drive
  reading (cards, values, hints, read-only protocols, the stored password never in the page), validation, a protocol change through the protocol cards, the write-only password, adding a VLAN network with the wizard (a new VLAN device and interface, applied and confirmed), adding, discarding and removing interfaces, VLAN devices and port settings, a risky change and its
  confirmation (Cancel applies nothing), the 90 second countdown on the apply call, a change the router does not keep, an interface that stays down after the change, a refused confirmation, staged leftovers, moving ports
  between bridges, the network-wide settings, a login that may not write, a login without the config call, a plugin without it, a reply of another shape, the dark theme, edits surviving leaving the page, the panel closing when its card is gone or the page is left, the board following the form (new cards, names, devices), the old `#bridges` route and an expired session. The selectors of the panels' contents are in the helper block at the top of `live.mjs`.

## Network board suite
Never changes the router's configuration: every `uci` write is blocked (and fails the test); the draft lives in the page only.
- **Unit tests** (`boardmodel.test.mjs`, no router): the lanes and their order (front-panel position first, tunnels last); the conduit and swconfig pseudo ports hidden unless used;
  bridges grouping ports and Wi-Fi, VLAN devices on a port or a bridge; PPPoE over a VLAN; a second VLAN on one port; an interface riding on another's protocol device (`wan6`);
  tunnels with and without `tunlink`; an interface directly on a port; an unknown device; zones, services and the "No zone" card; the highlighting set (what an item is built on and what
  is built on it, not its siblings); findings (down, pending, unattached wireless, no protocol) and the counts of the tiles; loops and empty routers; wireless (radio groups, bands, mesh, a
  configured interface that is not running joining its bridge, a station interface under an interface, radios without interfaces, no radio data); the draft (items keep their id while a name is typed,
  new and removed sections, a device moved in the form moves the edge, the settings of a port as a mark on the port, a VLAN or bridge of the form, a bridge with a port the router lacks, no editor).
  `drawer.test.mjs`: when a key closes the drawer, footer normalization and the mesh peers of the bridge information.
- **Browser** (`live.mjs`): the board at 1920, 1280 and 900 px in the light and dark themes against the real router: no sideways scrolling, no card whose text overflows, no overlapping cards,
  every card inside its lane, four lanes with connectors that start and end on card sides (stacked lanes, no connectors below 760 px of board width); hover highlighting; the drawer (opens with a
  title, is full height on the right edge, makes room on a wide screen, another card replaces its content, survives a refresh, Escape and the close button, a zone's read-only recap, closes when the page is left);
  the Device menu (Escape and a click elsewhere close it, adding a bridge puts a new card on the board and opens it, Discard edits removes it); the Network-wide settings button; the old `#bridges` route.

## Network panels suite
Needs no router: it never connects to one and needs no deploy. Unit tests (`panelmodel.test.mjs`, with `fixture.mjs`, a router
of the shape of a real one and a mock of what rpcd does with the UCI operations of `plan()`) cover the protocol cards, the essential/advanced split (every essential
option exists for its protocol), the device chooser, what a protocol change drops (and that the model drops exactly that), what interfaces and devices are used by,
the free /24 (overlap with live addresses, routes, tunnel addresses and addresses typed in the form, exhaustion), name suggestions, and the draft effects of every wizard
choice with its validation and plan. With `-Browser`, `live.mjs` serves `www/` and `tests/netpanels/` from this checkout, opens `harness.html` (the real
`panels.js` in the real `core/drawer.js` over the real stylesheets, against the mock) in Edge and checks: the sections and essential/advanced controls, a protocol card click and
what it drops, the device chooser, the write-only password (typed, reviewed, saved, read back as "set"), read-only protocols, removal and Undo with the dependants rule, the
bridge ports picker and live information, VLAN and port panels, the network-wide settings (edit, validation, save, a plugin without the section), a login that may not write (everything disabled, the wizard refuses), the wizard end to end
for a new bridge, a new VLAN device with PPPoE and an existing device with DHCP (saved and read back through the model's check), the wizard's validation, no horizontal
overflow of the panels and the wizard with long IPv6 addresses and names at 1920, 1280, 900 and 480 px, light and dark screenshots (`FLAB_SHOTS`), no script errors and no
request outside the local server.

## VLAN editor suite
Never changes the router's configuration: every `uci` write is blocked (and fails the test) in the phase that talks to the real
router, and the editing flow runs against a stateful mock of rpcd's `uci` object. There is no backend part: the editor adds no
plugin.
- **Unit tests** (`model.test.mjs`, no router): the port entries and tokens, the sections as `uci get` returns them
  (anonymous and named, the `name` option of a device section), the tables (columns from the device section, a port named by a VLAN
  but not in the bridge, the interfaces of the router on the bridge's VLANs and the management one, a kernel table against the
  config), the draft, the review text and the UCI operations (only what changed is set, untouched entries keep their spelling, `local`,
  an emptied row, a new or removed VLAN, filtering, `enable_vlan`, a swconfig group's tokens and `vid`), every error and warning, and
  the check after a save (a config that holds the draft, one that kept nothing, other members, a switch that stayed).
- **Browser** (`live.mjs`): the Ethernet ports page first shows the real router read only: the bridge without a table offers
  **Set up VLAN filtering**, the editor opens with the real `br-lan` and its filtering state, every `uci get` carries a section
  type (never the whole network config), **Done** closes it, and nothing is staged or written. Then a mock router (the real
  status of the router with the bridge's VLAN table and filtering following a mocked network config that also holds an interface
  with a password) drives: the read-only card, the cells, the PVID error and its two marked cells, the review text, saving (the
  order of the calls, the ports written in the notation of the file, the read-back by type), adding (an id out of range, one in
  use, Enter, the validation of the new row) and removing a VLAN, the lockout warnings, VLAN filtering off and turning it on, a
  router that applies nothing, one that refuses the confirmation, staged leftovers, a kernel table that differs, an older swconfig
  board (the groups, the CPU port, the `vid`, the untagged-once rule, a new group, `enable_vlan`; mock only, since the router has no
  swconfig switch), a login that may not write or may not read, and a session that expires while saving.

## Static routes suite
Never changes the router's configuration: every `uci` write is blocked (and fails the test) in the phase that talks to the real
router, and the editing flow runs against a stateful mock of rpcd's `uci` object, `network.interface dump` and a `flab.routing status`
whose kernel routes follow the mocked config. There is no backend part: the tab adds no plugin.
- **Unit tests** (`model.test.mjs`, no router): the sections as `uci get` returns them, an older `netmask` joined to the target,
  the address math, the draft and the review text, the UCI operations (only what changed; the prefix written to `target` and
  `netmask` removed only for an edited target; `valid` and `proto` untouched), every error and warning, the default-route
  risks, the check after a save and what the kernel holds of each route.
- **Browser** (`live.mjs`): the tab first shows the real router read only (both tables, no pending change, `uci get` only by
  section type, nothing staged or written). Then a mock router (with an interface that holds a password, which the page must never
  read) drives: the rows and their state badges, an invalid target, a valid edit and its review text, saving (the order of the calls,
  the older netmask replaced by a prefix), adding an IPv4 and an IPv6 route, removing and Undo, the confirmation before a default
  route change (Cancel leaves everything as it was, Apply the change saves), a router that applies nothing, one that refuses the
  confirmation, staged leftovers, a login that may not write or may not read, and a session that expires while saving.

## WireGuard editing suite
Never changes the router's configuration: every uci write is answered by a mock, and blocked (failing the test) in the phase that talks to the
real router.
- **Unit tests** (`model.test.mjs`, no router): the address math (parsing, netmasks, IPv6 text, overlap, the next free host, endpoint
  checks), the keys (X25519 against the RFC 7748 vectors, WebCrypto against the plain implementation, clamping, the key text check), reading the
  plugin's reply (also from a plugin without the new fields), the draft, the review list, the UCI plan (only what changed, deletes only of options
  that exist, a key only when typed, a new interface and its peers, a removed interface and its peers), every validation, the sessions that belong to
  a tunnel and each warning about cutting it, the check after a save (kept, not kept, a key stored, a new peer found by its public key, a removed one
  gone, an interface that did not come up, a peer that did not load, what is not expected to run) and the add-a-device helpers (the next address,
  refusals, the allowed IPs, the configuration text, the file name).
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`): `flab.wireguard.uc` runs on the router with `FLAB_FIXTURES`, so it executes nothing. Scenarios
  `main` (a running interface with three peers, pre-shared keys, a peer whose public key option holds a pasted secret, a disabled peer; a disabled
  interface without a running tunnel; an interface and a peer only the kernel has; a firewall zone; `/proc/net/tcp` and `tcp6` with connections on
  the default, uhttpd and dropbear ports from IPv4, IPv4-mapped, native IPv6 and loopback addresses, plus listening, closing and unrelated sockets)
  and `empty` (no WireGuard, no protocol handler). The test checks the options and their secret flags, that no key, token, password or pasted secret
  (canaries) is anywhere in a reply and no secret-named option among the options, the order of interfaces and peers, the names list, the sessions
  (addresses of both families, the ports, no duplicates). It also runs `status` once for real, which only reads: the count of the router's stored
  keys that appear in the reply is zero (only the count leaves the router), every `wireguard_*` section is reported by its section name, and the ssh
  connection the test arrived on is among the sessions.
- **Browser** (`live.mjs`): the page first shows the router's own interfaces and peers with every uci write blocked and failing the test, then a
  mock of the plugin built from a stateful mock of `uci` drives: validation of each kind of field, the key generator and the public key it shows,
  the review list (a key only as "new value (hidden)"), a save (call order, what was written, that the page never calls `uci get`), editing a peer in
  place, adding and removing peers with Undo, the dialogs that ask before cutting your own session (Cancel, confirm, the banner), the generic
  warning when no session goes through the tunnel, the add-a-device dialog (the next address, the configuration text, that the stored public key is
  the one of the shown private key, Copy, Download, Cancel), adding an interface (name, port and key offered, taken names, a taken port, a peer, the
  note and link for the firewall zone), an interface that does not come up (rolled back, nothing staged), removing an interface and its peers, a change
  the router does not keep, a confirmation that comes too late, leftovers from an earlier attempt, an interface only the kernel has, a router without
  the protocol handler or without the plugin, no interface at all, a login without write access, the dark theme and an expired session.

## Firewall editing suite
Never changes the router's configuration: every `uci` write (including `order`) is blocked, and fails the test, in the phase that talks to the real router; the editing flow runs against a stateful mock of rpcd's `uci` object. It also runs the network suite's `firewall.test.mjs` and `uci.test.mjs`.
- **Unit tests** (`model.test.mjs`, no router): reading sections in file order by name, form values (loose spellings, absent options, legacy `syn_flood`), zones (edit, add with an interface moving between zones, removal with its forwardings and Undo, duplicate names, an interface in two zones), forwardings (the matrix switch), rules (edits staged by section name, an emptied option deleted, add, move, remove, the order of every section of the file including named sections, new rules after the last rule, no needless `order`), port forwards (DNAT and SNAT checks), the defaults (including creating the section), the lock-out check (zone and address recognition, rules that keep HTTPS, port ranges, defaults, removal, interfaces leaving a zone), the check after a save (a new section matched by place, a change not kept, a stopped firewall, a zone that was not loaded), `stageOps` with an `order`, the view joined to counters, every value check and the plain words.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`): `flab.firewall.uc` runs on the router with `FLAB_FIXTURES`: `main` (the lab-like config with anonymous and named sections, a `nat` section, an include, an ipset, interfaces with addresses, counters, a canary private key in the network config), `nodefaults`, `legacy`, `stopped`, `nonet`, `partial`. It also runs once for real (read only) and compares the counts with `uci show` and the private keys it finds with the reply.
- **Browser** (`live.mjs`): the page first shows the real router read only (editing controls present, dialogs open and cancel, every write blocked); then a mock router drives the matrix, every dialog and its validation, reorder, enable and delete with Undo, the defaults card, saving (the order of the calls, the sections written, the order of rules, a new section renamed by the router afterwards), a change the router does not keep, a firewall that keeps the old ruleset or stops loading, a refused confirmation, staged leftovers, the lock-out confirmation (Cancel and Apply anyway), a login that may not write or read, a plugin reply that does not match the config, a missing plugin, the dark theme and an expiring session.

## nlbwmon settings suite
Never changes the router's configuration and never touches the daemon: every uci write is either answered by a mock or blocked
(failing the test) in the phase that talks to the real router.
- **Unit tests** (`model.test.mjs`, no router): reading the config and the replies, the defaults of an absent option, the tables,
  durations, sizes (K, M, hexadecimal) and IPv4/IPv6 subnets as nlbwmon parses them, the accounting window under a day of the month,
  from the end and every N days, the periods a lower count deletes, the daemon's command line and its comparison with the config,
  the daemon check (restart, never back, wrong command line, crash loop), the draft, the review list, the UCI plan (a size in bytes,
  deleted options, a missing section), the check after a save, the validation of every option with good and bad values, every
  warning, what the router says about paths, and the effect texts.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`): `flab.traffic.uc` runs on the router with `FLAB_FIXTURES`, so it reads a
  fake filesystem (`nlbwmon_fs.json` plus `/proc/mounts` in `files.json`) and executes nothing: a database directory in RAM behind
  the `/var` link, new and existing directories on a USB disk, under `/etc` (flash), under `/rom` and on a read-only card, on a
  network share, a path that is a file or below one, the root, a trailing slash, 120 database files, no `/proc/mounts`, the
  protocol file present, missing, a directory and unreadable, and 22 refused values tried as each argument (relative, empty, `..`,
  spaces, shell metacharacters, a newline, wrong types, 300 characters), the 126/127 character limit. It also checks the plugin
  source (no program is started in the new code, both paths are checked first) and the ACL, and runs the method once for real on
  the router's own paths, comparing the kind with `/proc/mounts` and the files with the periods `nlbw -c list` prints.
- **Browser** (`live.mjs`): the Settings tab first shows the router's own config, with every uci write blocked and failing the
  test; then a stateful `uci` mock, procd's service list (a daemon whose command line is built the way the init script builds it, and
  which restarts, stops, keeps the old command line or restarts forever when a change is applied) and a mock of the plugin drive
  the tiles, every option and its default, the effect lines, the validation of every option, the warnings, the typed-path probes
  (one question after a pause, none for a path that was asked or is already refused, errors for a read-only filesystem, a file, a
  missing protocol file), saving (only the changed options written, a size in bytes, a switch as 0), removing an option, a stopped
  daemon, a change the router does not keep, a change that stops nlbwmon, a daemon on the old settings, a daemon that keeps
  restarting, a refused confirmation, leftovers staged in the session, a daemon that differs from the file, a config without a
  section, no nlbwmon, no plugin, unsaved edits across a tab change with no polling, a login that may not write, the dark theme and a
  session that expires.
