# Routing (route `#routing`)
The Routes view combines kernel routing state and static-route editing. BGP is a separate optional tab
(the tab strip sits in the command bar; the BGP tab shows only when `birdc` is installed, which
`flab.routing status` reports as `bird`). Only the open tab is polled (every 5 s), and each tab has its own filters in
the command bar.

## Routes tab
Reads `flab.routing status` (and `network.interface dump` for the logical interface names such as `wan` next to
`pppoe-wan`). Top to bottom:
- **Tiles:** the IPv4 and IPv6 default routes (interface as the value, next hop underneath, "+ N more" when several
  exist), routes in the main table by family, the routing tables, policy rules (and how many were added beyond the
  kernel's own) and multipath routes.
- **Banner:** a missing IPv4 default route (warning), a missing IPv6 one (note), a default route that drops
  everything, routes with a next hop that is `dead` or `linkdown`, a truncated list, or `ip` not available.
- **Next hop lookup:** a destination, an optional source address and an optional arrival interface (policy rules can
  depend on both) go in; the kernel's answer comes out: the next hop, the interface, the source address it would
  use, the matched route (`ip route get ... fibmatch`), its routing table with a "Show this table" button, and the
  rules that consult that table ("Chosen by"). The answer says what the packet meets: forwarded, a local, broadcast,
  multicast or anycast address, dropped by a blackhole, unreachable or prohibit route (the kernel only reports these
  as an error code, so the page names the covering route itself), no route, or only a source-specific route ("fill
  in From"). An ECMP route lists all its next hops and says the kernel picked one per flow. The raw `ip` output is
  one click away (a fold that stays as you left it across refreshes). The lookup is part of the poll: once a query is set every refresh asks the kernel again, so the
  answer follows route changes (a failover shows up by itself), and the matched route is highlighted in the list.
  Polling pauses while a form field has focus; the form's text lives in the page state.
- **Policy rules:** the section starts with a card, "How the kernel picks a route" (folded at first; click its header to
  open it, and it stays as you left it while the page refreshes): rules are checked from
  the lowest priority number to the highest, a priority is not a table number, every route (static ones included)
  lives in one table and is considered only when a rule sends the lookup there, within the table the longest prefix
  wins and then the lower metric (never compared across tables), a table without a matching route
  sends the lookup on to the next rule, and the cases that end it (blackhole, unreachable and prohibit routes or
  rules; `throw` and `suppress_prefixlength` continue). Below it, in a full-width card, every rule of both families in the order the
  kernel applies them (priority, family, what it
  matches, what it does) and an "Added by" column. The kernel does not record the author of a rule, so the page
  infers it and says so in the tooltip: the three kernel rules (0, 32766, 32767), a rule configured in
  `/etc/config/network` (same family and priority, a `config rule` or `rule6` section; netifd installs it),
  strongSwan's default (priority 220, table 220, every packet; the tooltip notes when charon is not running, so
  the rule may be a leftover), and netifd's IPv6 reject rule for a delegated prefix (priority 4200000000 with an
  `iif`). Anything else is flagged "unknown".
- **Routing tables:** (full width, under the rules) every table that holds a route or is named by a rule or in `rt_tables` (name, number, what it
  is for, the rules that consult it, entry counts per family including inactive static configuration). A click selects
  the table in the route list. The top kernel tiles count installed routes only.
- **Static routes:** the editable IPv4 and IPv6 sections described below, on this same view, after the rules and tables
  they depend on.
- **Routes:** the routes of the selected table (default: all tables) for the selected family, filtered by text (any
  destination, next hop, device, logical interface, protocol, ...), sortable by destination, type, next hop,
  interface, protocol, metric and table. A route shows its type (blackhole, unreachable, prohibit, throw, local,
  broadcast, ...), every next hop with its weight and interface, protocol, metric, preferred source address, table
  and details (scope, expiry, `pref`, MTU, `onlink`, `linkdown`, `dead`). Routes with a dead or link-down next hop
  are tinted. Configured static routes are annotated; disabled, missing or unverified entries also appear, explicitly
  labeled as configuration rather than active kernel routes. Installed static routes are not duplicated. A long list
  draws its first 400 rows with a "Show all" button.

Static routes are applied when Save and apply commits the network configuration. netifd installs enabled routes while
their interface is up. They have no special precedence over connected, DHCP or BGP routes, and they are not applied
before or after the policy rules: a static route is an entry in a table (the one named by its Table option, else its
interface's table, which is `main` unless the interface sets `ip4table`/`ip6table`), and it is
reached only through the rules that consult that table. Rule 32766 consults `main`, after every rule with a lower number,
so a rule with a lower number that matches the packet and finds a matching route in its own table wins over all static
routes in `main`, even more specific ones. A route in a table that no
rule consults is never used. Within a table the longest matching destination prefix wins and lower metrics choose between
equally specific alternatives.
A routing daemon chooses its own best paths before exporting them into the kernel. A default route is a `/0` fallback,
not an override for more-specific routes.

`flab.routing` parses the text of `ip` (iproute2; every router here has `ip-full` or `ip-tiny`): routes keep
their table, type, prefix (normalized to `address/length`, `default` becomes the zero prefix), source prefix,
protocol, scope, metric, preferred source, expiry, MTU, flags and next hops (the `nexthop` lines of a multipath
route, `via inet6`, `mtu lock`); rules keep their selectors in order and the action (lookup, goto or a drop type).
At most 4000 routes per family are returned (`truncated`). `lookup` accepts only an IPv4 or IPv6 address, an optional
source address and an interface name, and refuses anything else (a newline included: the regular expressions match line
by line, so they alone would pass the first line of a longer text) before a command is built, so nothing but those
three strings can reach the shell. The plugin is read-only: the static-route editor writes through rpcd's `uci` object, not
through the plugin, and the ACL fragment `rpcd/acl.d/flab-routing.json` grants `status` and `lookup` plus `uci` on `network`.

## Static-route editor
The `route` (IPv4) and `route6` (IPv6) sections of `/etc/config/network`, as one editable table per family, with what the
kernel holds of each. Files: `routing/static.js` (the view and the editor wiring), `routing/static-model.js` (pure: reading,
draft, review list, validation, risks, UCI operations, check after a save, kernel state). The editor reads the sections by
type (`uci get` with `type: route` and `route6`), never the whole network config (it holds passwords and keys), plus
`flab.routing status` and `network.interface dump` for the kernel's routes and the interfaces' subnets.
- **Tile:** one "Static routes" tile at the top with the other tiles: the number configured, and underneath how many are
  installed in the kernel, not installed and disabled (the value turns amber when some enabled route is not installed).
- **Tables:** one row per route with Target, Gateway, Interface, Metric, Table, Type, MTU, From, On-link and Enabled,
  a "Consulted by" column (the table the route lands in, after netifd's inheritance, and the policy rules of its family
  that look that table up; "no rule" when none does, because then the route is never used; it follows edits as you type)
  and a state badge (installed, not installed, disabled, new, edited, to be removed). Target is a prefix
  (`10.0.0.0/8`); an address alone is one host. An older IPv4 route with a separate `netmask` option is shown as one
  prefix and is rewritten only if its target is edited. `valid` and `proto` are kept untouched. A new row is added
  with "Add IPv4 route" / "Add IPv6 route" and starts enabled; Remove marks a saved route for removal (Undo takes it
  back).
- **Validation** (errors block Save): target, gateway and source must be addresses of the row's family, the metric
  0 to 4294967295, the MTU 68 to 65535 for IPv4 or 1280 to 65535 for IPv6, the table a number or a name from `rt_tables`, the type a known one, the interface
  one the router has. **Warnings** (Save stays possible): a gateway outside the subnets of its interface (and that is not
  the peer address of its point-to-point link, as on PPPoE) without
  on-link, and two routes that are the same to the kernel.
- **Saving** uses the same review banner and safety net as the other editing pages: stage, `uci apply` with the
  rollback countdown, read the sections back, compare and verify changed enabled routes on running interfaces against
  the kernel before confirming. netifd is given a short bounded settling period. Routes on down interfaces may be saved
  for later; untouched pre-existing missing routes do not block unrelated changes. Adding, removing, disabling or changing a **default route** (a zero prefix in the
  main table, blackhole defaults included) first shows a confirmation that says what it does to the way out.
- Polling pauses while there are unsaved edits, a control has focus or a save is running.
- Out of scope: policy rules (`rule`, `rule6`, shown on the Routes tab) and routes learned by a daemon, DHCP or the kernel.
- **Matching:** installed status compares family, effective table, destination, route type/protocol, source prefix, metric,
  gateway and outgoing device. Empty metrics/tables inherit the interface defaults; IPv6 metric zero is normalized to
  the kernel's 1024 default. Disabled state is known even if the kernel reply is unavailable.
- **Limits:** installation does not prove that the gateway answers or that internet access works. Keep alternate access when
  editing a default route; see [configuration-change limitations](../architecture.md#configuration-change-limitations).

## BGP tab
Status of BIRD 3 (`flab.bgp`), plus its configuration file, read only. Sections, top to bottom:
- **Tiles:** sessions established, prefixes learned (and paths), prefixes announced, multipath (ECMP) share,
  kernel sync, BIRD version/uptime.
- **Daemon and memory** cards (the daemon is what everything below reports on), then the **BIRD configuration**, then **BIRD protocols**.
  The protocols card opens with a **flow diagram** that follows the BIRD 3.3.3 guide (Architecture, "Protocols and channels";
  "Channel options"): every protocol is joined to a routing table (`master4`, ...) by a channel with two filters, and the diagram
  draws that join. Each protocol is a lane; the table is on the right; to the left is what lies outside BIRD (the Linux
  kernel for the Kernel protocol, the network interfaces for Device and Direct, the neighbors' AS for BGP). Two splines per
  channel: **→ import** (the protocol puts routes into the table) and **← export** (the table hands routes to the protocol),
  as thick as the number of routes, which is written above the lane (`16 routes`, `1 each`); **a click on a count lists those
  routes** in a drawer (what the table hands to the kernel, the paths a group of sessions imports, a protocol's own routes), and
  a click on a prefix in the list opens the route-choice drawer. Each spline carries a tag, placed against the table,
  with its filter: the filter's name for a named one (a click opens it in the configuration card), `accept all` or
  `reject all` otherwise, and **`default`** when the file has no `import` or `export` line for the channel, so BIRD's own
  default applies (import all, except for external BGP; export none, except for external BGP and L3VPN). What the file
  sets itself (the kernel's `import none; export all`) is not called a default. Nothing passes on a **blocked** edge: it is
  a short dashed stub next to its protocol, in the colour of its direction, that ends in a grey ✕. A protocol that the file leaves unnamed is matched by the name BIRD
  gives it (`kernel1`, `static1`: the type and a counter that skips names in use). Device (and BFD) have no channel, so they
  have no spline. The diagram says, as the guide does, that BIRD's tables are not the kernel's forwarding table: the Kernel
  protocol copies them there. BGP sessions that are alike (same channels, filters, neighbor AS and template) share one lane
  (`azure_xfrm ×4`); a click opens the group into one lane per session, a click on one of them closes it again, and a click on a
  single protocol's lane goes to its row in the table. Without a readable file the tags still show BIRD's own filters but
  nothing is called a default (it cannot be known). Below the diagram: a legend and the guide's rules in a caption; then the
  table. The protocols table lists every instance with its state, table, route counts, preference and filters. Each filter chip
  (import first, export second) explains itself in its tooltip: what an import or export filter is for that kind of protocol,
  and, for a named filter, its own comment from the configuration file; a filter defined in the file is a button that opens the
  configuration at its source. A legend above the table explains each protocol type the router runs (Kernel, Device, Direct,
  Static, BGP, and any other BIRD protocol: OSPF, RIP, Babel, BFD, RPKI, Pipe, RAdv, ...; the same text is the tooltip of the
  Type cell; the BGP entry carries, underlined, why the file writes filters for every external session: RFC 8212 requires
  both to be explicit) and what the chips and `in · out` mean, and every column heading has a tooltip.
- **BIRD configuration** (folded at first; shown below the "BIRD is not running" message too, since the file is the first
  place to look): `/etc/bird.conf` with line numbers, comments dimmed and a **Jump to** row (every protocol, template
  and filter; a click highlights its lines and scrolls to them). The badges say the size, the modification time and
  whether **BIRD has read the file since it was last changed** (the file's time against BIRD's "last reconfiguration").
  **Check** runs `birdc configure check`, which parses the file without applying it, and shows BIRD's own answer
  with the line number of an error. Secrets never reach the browser: the backend replaces what follows `password` and
  `secret` with `"<redacted>"` and says how many it hid. Nothing edits the file.
- **Topology:** this router, one node per peer, remote AS node (peers are grouped by neighbor AS). The router
  node lists what its peers actually receive ("Announces"), whichever BIRD protocol produced it. CSS grid plus
  SVG connectors (animated while a session is Established). Each peer keeps one color (`pc-0..5`) across every
  table on the page; colors are assigned on first sight and never reshuffled when other peers come and go
  (more than 6 peers reuse the least-used color). The connector math needs equal-height, touching peer cells
  (see the comment in `routing/bgp/topology.js`).
- **Health** (findings from the backend and a review of the configuration file) and **active next hops per
  peer** (how many prefixes use each peer as an installed next hop).
- **One card per peer:** session (state, neighbor/local AS, session type, interface, hold/keepalive/send-hold
  timers as remaining-time bars; a session that is down shows its last error and the next connect attempt),
  capability comparison for both directions (rows where only one side offers a capability are highlighted),
  one routing block per channel (ipv4, ipv6, ...: state, filters, route counts) and the BIRD route-change
  statistics. A **Configuration** section says where the peer is defined (lines of the file), which template it
  inherits and shows the source of its protocol block, template and filters in folds (the open folds are kept
  across polls). The header holds the **actions** (below).
- **Learned routes:** every BGP path grouped by prefix. Status is Best, ECMP (installed in the kernel as an
  equal-cost next hop) or Backup. Columns: peer, next hop, interface, AS path chips (prepending collapses to
  `65520 ×2`), origin, local pref, MED and communities (the last two only appear when some path has them),
  since. Filter, peer selector, "Best paths only", sortable columns. At most 400 paths are drawn until
  **Show all** is pressed. **A click on a prefix opens a drawer that explains BIRD's choice**: one card per route
  for that prefix (BGP paths and routes of other protocols such as a static blackhole) with the values BIRD compares
  and, for each one not chosen, the rule it lost on ("AS path length: 1 against 3"), or why it is installed next
  to the best path (it ties on every rule except the router ID, which BIRD ignores for multipath). The rules are
  the ones of the BIRD documentation in order: route preference, local preference, AS path length, origin, MED
  (only between paths of the same neighboring AS), eBGP over iBGP, router ID. The distance to the boundary router
  is not reported by BIRD, so it is not shown. The drawer is a snapshot of the poll it was opened from.
- **Announced routes:** prefix x peer matrix plus export-filter results per peer. **Announced now** is how many routes the
  peer is sent at this moment; the columns after it (considered, blocked by filter, rejected, accepted) are BIRD's counters
  of export *updates* since the session came up, so a route that is sent again (a route refresh, a changed attribute, a
  refeed of the table) counts again and each session has its own age: they differ from peer to peer and are larger than the
  number of routes. A note under the table says so, and each heading has a tooltip. The routes that BIRD did not learn through BGP (the
  `direct` routes of the tunnel interfaces, the `static` blackhole aggregate, ...) are not a card of their own: they are listed
  **under the row of the protocol that made them** in the BIRD protocols table (prefix, kind, the device it points at,
  whether the kernel has it), behind an arrow before the protocol's name. A protocol with eight routes or fewer starts open;
  folding one is remembered across polls.

**Peer actions** (a login that may call `flab.bgp action`; each asks first and says what it will do, then shows
BIRD's answer): *Refresh in* (`reload bgp in`: the peer sends its routes again, the import filter is applied
afresh), *Refresh out* (`reload bgp out`: announce again), both without touching the session and only while it is
Established; *Restart* and *Disable* (`restart`, `disable`), which drop the session and withdraw its routes; and
*Enable* for a protocol that was disabled (the only action it offers). A disabled protocol stays disabled until
enabled or until BIRD restarts.

**Configuration review** (in the Health card, from the file and the live sessions): the file is newer than BIRD's
last reconfiguration; a BGP protocol in the file that BIRD does not run; for the external sessions, `import all` or
`export all`, no route limit (`import limit` or `receive limit`) and no TCP authentication (`password` or
`authentication md5|ao`), each naming all the sessions it applies to. Settings are resolved through the template a
protocol inherits (`from`), the protocol's own value winning. Live findings added with it: a channel that is not
UP although the session is Established, an Established session that imported no route, and a hold time shorter than
three keepalive intervals.

Notes:
- **Everything is derived from live data on every poll** (5 s): peers, channels, routes, announcements
  (`show route export <peer>` per peer), findings. IPv4 and IPv6 are both handled (`master4`/`master6` tables,
  `ip -4`/`ip -6` kernel routes, prefixes sort IPv4 first, then IPv6 numerically).
- A path counts as "in kernel" when the kernel route (`ip -4/-6 route show proto bird`) has a next hop via one
  of that path's next-hop addresses (an IPv6 BGP next hop can list a global and a link-local address). With
  `merge paths on` in the kernel protocol this gives ECMP across both gateways of a region; paths with a
  longer AS path are Backup.
- BIRD prints only the **date** in `Since` for anything older than a day, so session uptime cannot be shown
  precisely.
- BIRD's **kernel protocol re-exports the whole table every `scan time`**: after each scan `krt_prune()`
  requests a full refeed, so "Export updates received" of the kernel protocol grows by the table size every
  scan while "accepted" grows by the number of exportable prefixes. This is normal: `krt_rt_notify()` drops
  updates for routes already in the kernel and no netlink message is sent. Do not report these counters as
  churn.
- Findings are computed in the backend: sessions not Established, best routes missing from the kernel,
  prefixes learned from only one peer, import-filter drops, graceful-restart mismatch, peers receiving no
  announcement.
