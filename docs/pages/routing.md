# Routing (route `#routing`)
The kernel's routing state and, when the router has BIRD, BGP, in up to two tabs on one page
(the tab strip sits in the command bar; the BGP tab shows only when `birdc` is installed, which `flab.routing status`
reports as `bird`). Only the open tab is polled (every 5 s), and each tab has its own filters in the command bar.

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
  one click away. The lookup is part of the poll: once a query is set every refresh asks the kernel again, so the
  answer follows route changes (a failover shows up by itself), and the matched route is highlighted in the list.
  Polling pauses while a form field has focus; the form's text lives in the page state.
- **Policy rules:** the section starts with a short header, "How the kernel picks a route": rules are checked from
  the lowest priority number to the highest, a priority is not a table number, a table without a matching route
  sends the lookup on to the next rule, and the cases that end it (blackhole, unreachable and prohibit routes or
  rules; `throw` and `suppress_prefixlength` continue). Below it, every rule of both families in the order the
  kernel applies them (priority, family, what it
  matches, what it does) and an "Added by" column. The kernel does not record the author of a rule, so the page
  infers it and says so in the tooltip: the three kernel rules (0, 32766, 32767), a rule configured in
  `/etc/config/network` (same family and priority, a `config rule` or `rule6` section; netifd installs it),
  strongSwan's default (priority 220, table 220, every packet; the tooltip notes when charon is not running, so
  the rule may be a leftover), and netifd's IPv6 reject rule for a delegated prefix (priority 4200000000 with an
  `iif`). Anything else is flagged "unknown".
- **Routing tables:** every table that holds a route or is named by a rule or in `rt_tables` (name, number, what it
  is for, the rules that consult it, route counts per family). A click selects the table in the route list.
- **Routes:** the routes of the selected table (default: main) for the selected family, filtered by text (any
  destination, next hop, device, logical interface, protocol, ...), sortable by destination, type, next hop,
  interface, protocol, metric and table. A route shows its type (blackhole, unreachable, prohibit, throw, local,
  broadcast, ...), every next hop with its weight and interface, protocol, metric, preferred source address, table
  and details (scope, expiry, `pref`, MTU, `onlink`, `linkdown`, `dead`). Routes with a dead or link-down next hop
  are tinted. A long list draws its first 400 rows with a "Show all" button.

`flab.routing` parses the text of `ip` (iproute2; every router here has `ip-full` or `ip-tiny`): routes keep
their table, type, prefix (normalized to `address/length`, `default` becomes the zero prefix), source prefix,
protocol, scope, metric, preferred source, expiry, MTU, flags and next hops (the `nexthop` lines of a multipath
route, `via inet6`, `mtu lock`); rules keep their selectors in order and the action (lookup, goto or a drop type).
At most 4000 routes per family are returned (`truncated`). `lookup` accepts only an IPv4 or IPv6 address, an optional
source address and an interface name, and refuses anything else before a command is built, so nothing but those
three strings can reach the shell. The plugin is read-only, and the ACL fragment `rpcd/acl.d/flab-routing.json`
grants only `status` and `lookup`.

## BGP tab
Status of BIRD 3 (`flab.bgp`). Sections, top to bottom:
- **Tiles:** sessions established, prefixes learned (and paths), prefixes announced, multipath (ECMP) share,
  kernel sync, BIRD version/uptime.
- **Topology:** this router, one node per peer, remote AS node (peers are grouped by neighbor AS). The router
  node lists what its peers actually receive ("Announces"), whichever BIRD protocol produced it. CSS grid plus
  SVG connectors (animated while a session is Established). Each peer keeps one color (`pc-0..5`) across every
  table on the page; colors are assigned on first sight and never reshuffled when other peers come and go
  (more than 6 peers reuse the least-used color). The connector math needs equal-height, touching peer cells
  (see the comment in `routing/bgp/topology.js`).
- **Health** (findings from the backend) and **active next hops per peer** (how many prefixes use each peer as
  an installed next hop).
- **One card per peer:** session (state, neighbor/local AS, session type, interface, hold/keepalive/send-hold
  timers as remaining-time bars; a session that is down shows its last error and the next connect attempt),
  capability comparison for both directions (rows where only one side offers a capability are highlighted),
  one routing block per channel (ipv4, ipv6, ...: state, filters, route counts) and the BIRD route-change
  statistics.
- **Learned routes:** every BGP path grouped by prefix. Status is Best, ECMP (installed in the kernel as an
  equal-cost next hop) or Backup. Columns: peer, next hop, interface, AS path chips (prepending collapses to
  `65520 x2`), origin, local pref, MED and communities (the last two only appear when some path has them),
  since. Filter, peer selector, "Best paths only", sortable columns.
- **Announced routes:** prefix x peer matrix plus export-filter results per peer (considered, blocked by
  filter, rejected, announced). **Local & connected routes**, **BIRD protocols**, **daemon** and **memory**
  cards close the page.

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
