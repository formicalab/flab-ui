# DNS (route `#dns`)
The state of the router's DNS resolver and its settings. It shows what the resolver does and how it is configured, and lets
you change the resolver's **single-valued options** (a yes/no option, a choice, a number, a name) in `/etc/config/unbound` or
`/etc/config/dhcp`, and its **zones** (Unbound's `config zone` blocks, dnsmasq's `server` entries: add, edit, remove, in a dialog);
lists of options are shown read only (edit them in the file). It
understands both engines, **Unbound** (read through `unbound-control`, which needs `option unbound_control '1'` in
`/etc/config/unbound`) and **dnsmasq** (read through the ubus object `dnsmasq metrics` and UCI), and every mix: Unbound
running, dnsmasq running, both (one of them on another port, for instance dnsmasq on 5353 behind Unbound; both are
reported and the one on port 53 is the engine the page describes), none running (a finding) and installed but stopped
(the configured engine is still described from its configuration). One call, `flab.dns status`, every 10 s; the page
pauses while a text box has the focus. Top to bottom:
- **Tiles**: Resolver (engine, version, uptime, and "dnsmasq also runs (port 5353)" when both run), Queries (since the resolver
  started, and the average per minute; for dnsmasq the forwarded plus the locally answered), the share answered without
  asking upstream (Unbound: cache hits against hits and misses; dnsmasq: its own answers against those and the forwarded
  ones, labeled "Answered locally"), Resolution time (Unbound's average and median; dnsmasq reports none, so the forwarded
  count is shown instead), Upstream servers (the default forwarders and the resolvers the WAN gave, each counted once;
  "Recursive" for an Unbound with no default forwarder) and DNSSEC (Validating, Off, or Not supported by this build).
- **Banner** (`model.findings`, worst first): no resolver installed or running, or installed but stopped (critical); a running
  engine with nothing on port 53; the other engine also running (information); DNSSEC off (a warning that says which option
  turns it on) and a dnsmasq build without DNSSEC (information only); rebind protection off; dnsmasq with no upstream at all
  (critical; an Unbound without forwarders is recursive, not broken); forwarding in clear text to a public address (information:
  every public `server=` of dnsmasq, and for Unbound a forward zone that is known not to use TLS); `unbound-control` not enabled
  or no dnsmasq metrics; SERVFAIL above 5% of the answers (needs extended statistics and at least 20 answers); bogus DNSSEC
  answers; rate-limited queries; dnsmasq with more than 2% of its forwarded queries unanswered (at least 20 forwarded); a cut list.
  **Clear text for Unbound**: `unbound-control list_forwards` does not say whether a forwarder uses TLS (the `+` flags are
  `i`, not DNSSEC-validated, and possibly others), so the plugin reads the `forward-tls-upstream` setting of each `forward-zone`
  clause of Unbound's generated configuration; a zone that is not found there is "unknown" and never accused.
- **Configuration** (full width, on top): every option the page knows, in collapsible areas that look and behave like the groups of the
  DHCP and Dynamic DNS pages (the shared `disclosure()` of `core/fold.js`: an arrow before the title, right when folded, down when
  open; every area starts folded, and one the user opens stays open across the redraws). The header has a badge that says whether the engine runs, in green "Unbound running" (or "dnsmasq running", whichever
  the page describes) and in red "… not running", like the daemon card of the DHCP page, then the config file and how many
  addresses and ports it listens on.
  **General** comes first: the service and its monitoring first (enabled, remote control, statistics, log verbosity; for dnsmasq query
  logging), then *Listening on*: one chip per address and port with its protocols (from `netstat -lntup`, only the resolvers'
  sockets; Unbound's loopback control port 8953 and dnsmasq's DHCP socket are left out), where `0.0.0.0` and `[::]` are marked
  "all addresses" and the engine is named when both run; then listening and interfaces (port, LAN and WAN interfaces, IP protocols,
  EDNS size, DNS64 with its prefix in the same cell, so the prefix is not left alone on a row; for dnsmasq the port, interfaces and upstream servers). Without a resolver the card is only *Listening on*.
  **Security and privacy** is second: who may ask and the rate limit, rebind protection, query privacy and DNSSEC.
  For Unbound it also shows, read only and folded, the domains exempt from rebind protection (`private-domain:`): the ones UCI
  generates for the local names (the local domain and the router's host name) and those listed in `/etc/unbound/unbound_srv.conf` (on the main router the Azure
  private-endpoint names). There is no UCI option for that list, so it is changed in the file: the generator
  (`/usr/lib/unbound/unbound.sh`, identical in OpenWrt's packages master) only writes `private-domain:` for the `domain` option, the
  router's own host name and, with `dhcp_link 'dnsmasq'`, the domains it takes from dnsmasq, and the only lists it reads from the
  `unbound` section are `domain_insecure`, `iface_lan` and `iface_wan`; the README's table of `config unbound` has no such option
  either. The plugin reports the list as
  `private_domains` (`name`, `source` `uci` or `file`).
  The rest follow, folded: Local names and DHCP and Performance and cache (dnsmasq: Local names, Cache, DHCP). Each header gives
  the number of options and, for General and Security and privacy, a line about how they are set (port, interfaces, remote
  control, statistics; DNSSEC, rebind protection, who may ask, rate limit), so a folded area still says something. An "Other
  options" area holds options of the section the page has no description for. The options are described as data in `dns/schema.js`, in the format
  of `core/fields.js`, and drawn with the same controls as the System settings and DHCP pages (`core/forms.js`):
  a checkbox for a yes/no option, a drop-down for a fixed set of values (rebind protection,
  remote control, local domain type, DHCP server linked, IP protocols, recursion, resource profile, log verbosity, the
  router-name levels; the values and defaults are from the OpenWrt Unbound package's README and the dnsmasq manual; a choice that is a
  number in the file (rebind protection, remote control, the names added to the DNS, log verbosity) shows the number before its
  words, "1: Block private addresses (RFC 1918 and 4193)", as the README's tables do: the opt-in `numbered` of a field in
  `core/fields.js`), a number
  input with its range for a number, a text box for a name and a list for several values. An option that is not set shows its
  default (a placeholder, or "Default (…)" in a drop-down, or the default state of a checkbox).
  **Changing the options**: every described option of a single value can be edited when the login may write (`uci set`); lists
  and options the page has no description for stay disabled. An edit shows the review banner of the command bar (as on the System
  settings and DHCP pages: how many changes and which, *Details* with each one from → to, *Discard edits*, *Save and apply*),
  plus warnings for risky changes (switching off the control channel this page reads, another port, no longer local-only, no
  rebind protection, no DNSSEC, stopping Unbound, manual configuration; for dnsmasq DNSSEC in a build without it, port 0). A bad
  number is an error that blocks the save, marks the control and opens the folded area it is in. Saving stages the edits,
  applies them with the 30 second rollback countdown, reads `flab.dns status` back (changes held, and the resolver still runs;
  it gets a few seconds to restart) and confirms; otherwise the router puts the previous settings back, nothing stays staged
  and the edits stay in the form. Only what changed is written, to the `unbound` section of `/etc/config/unbound` or the dnsmasq
  section of `/etc/config/dhcp` (`flab.dns` reports it as `config_section`): a boolean as `1` or `0`, an emptied option is deleted.
  The model for all of this is `dns/edit.js` (pure and unit-tested); `core/editpage.js` takes the config name as a function
  because it depends on the engine (a page that writes sections of two configs, like the DHCP page, gives a list and a `readAfter`). A login without the `uci` write methods sees the settings read only, with a note. Changes
  already staged in the session are reported and can be discarded first.
- **Zones**: a card that is folded when the page opens (click its header; it folds like the cards of the DHCP and Dynamic DNS
  pages, `foldable()` in `core/fold.js`: the arrow points right when folded and down when open, and the choice survives the
  redraws). It shows what UCI holds, as UCI holds it: a zone is one **block**, not one domain.
  For Unbound a zone is a `config zone` section of `/etc/config/unbound`, as described in the OpenWrt Unbound README
  (`net/unbound/files/README.md`, "config zone"): a `zone_type` (`forward_zone`, `stub_zone` or `auth_zone`), a list of domains
  (`zone_name`), a list of servers and the settings of that type. One section can serve any number of domains with the same
  servers, so the main router has `fwd_azure` for 89 domains, `fwd_lab`, `fwd_flumini`, `fwd_vodafone`, the default forwarders
  `fwd_cloudflare` (and the disabled `fwd_google`) and the disabled authoritative zone `auth_icann`: 7 zones, not 93 rows.
  For dnsmasq a zone is one entry of the `server` list of its section in `/etc/config/dhcp`
  (`/a/b/address#port`, `/a/` answers locally, `/a/#` uses the default servers, a plain address is a default forwarder).
  At the top it shows *Resolvers from the WAN* (full width): the resolvers in
  `/tmp/resolv.conf.d/resolv.conf.auto` (loopback ones left out), each marked *in use* or *not used*, and a sentence that says why. dnsmasq
  asks them unless its `noresolv` is set. Unbound asks them only through a forward zone with `resolv_conf '1'`, so they count as
  used when they are among the servers of the forwarders in force (the zones are named); otherwise the sentence says that Unbound
  uses its own forwarders, or recurses from the root servers, and how to change that. The header (engine, number of zones and of
  domains, and the verdict) repeats it, and the *Upstream servers* tile counts only the WAN resolvers that are used.
  Below that is one table, in the **order of the configuration** (the order of the sections in the file, which is the order the
  generator writes the clauses of `unbound.conf`; dnsmasq's entries in the order of the list), with the extension file after
  them, as it is appended last. A first column numbers the rows. The order does not decide which zone answers a query: Unbound and
  dnsmasq take the zone with the **longest matching domain**. Each row has the section name, the type, whether it is disabled (and
  *new*, *edited* or *removed* while a change is pending), the domains (the first six as chips, a button for the rest, and
  their count), the servers (a TLS or clear-text mark; the URL of an authoritative zone), the flags and where it is defined. The
  filter box matches names, types, domains, servers, flags and states, and redraws only the table, so typing is not interrupted.
  Flags: `i` is shown as "not DNSSEC-validated": it comes from `list domain_insecure` of the `unbound` section, which makes
  Unbound mark the zone `+i` in `list_forwards`; dnsmasq's `/zone/` (answered locally) and `/zone/#` (uses the default servers) are
  marked too. "Clear text" is worked out by the page: a forward zone without TLS (dnsmasq: always) whose server is a public
  address. Every label has a tooltip that says what it means, and a "What the labels mean" block in the header of the card (always
  visible, no expander) lists them (clear text, TLS, the flags, disabled and the pending states) for the engine in use. **Add zone**
  is on the toolbar, on the same line as the filter box and right next to it. Each zone says where it is defined: *UCI* (the section is named in the tooltip) or *unbound_ext.conf* (forward zones
  that only Unbound's extension file defines: read only, with a lock; the main router has none).
  **Add zone**, and **Edit** and **Remove** on every UCI zone, work on the draft of the page; nothing is written until the review
  banner at the top is saved (the same stage, apply with the 30 second rollback, read back, confirm as the options use).
  - The **dialog** (`core/modal.js`: Bootstrap's modal markup and styles on a native `<dialog>`, so Escape and the close button leave it and the focus stays inside; a form keeps a click on the dimmed area from closing it) has
    the fields of the zone's type (`ZONE_TYPES` in `dns/schema.js`): forward zones take domains, servers, TLS (use, certificate
    name, port), port, fall back, local resolver check and "also use the WAN resolvers"; stub zones domains, servers (addresses
    only), port, fall back, check and WAN; authoritative zones domains, servers (or a URL), the URL and fall back. The type is
    chosen for a new zone and fixed afterwards. A dnsmasq entry has domains, what dnsmasq does (forward, answer locally, use the
    default servers) and the server. The form works on a copy, checks as the user types (it shows the errors after the first
    edit) and cannot be accepted while it has one: domains and servers must be valid, a name may be taken by one enabled zone only
    (Unbound refuses two clauses for a name; the other zone is named), a stub zone needs addresses, an authoritative zone a server
    or a URL. A block whose lists the plugin had to cut, or of a type the page does not know, is read only.
  - **Remove** flags the row (dimmed, with a button that keeps it) and deletes the whole section when saved. A new zone gets a
    section named from its type and first domain (`fwd_corp_example`) and is written with `uci add` and only the settings that
    differ from the defaults. A changed zone writes only the changed options (`set`, and `delete` for an emptied one). dnsmasq
    writes the whole `server` list. The review list says what changed, for instance "fwd_azure: Domains: 86 domains → 85
    domains: −x"; warnings (not errors): a public server in clear text, TLS without a certificate name, a server on this router
    itself, and the last default forwarder going away.
  - After a save the page reads the status again and checks that the blocks hold what was asked, and that Unbound lists the domains
    it should forward (it may take a few seconds to restart); a resolver that stops, or a change that was not kept, is rolled back
    and the edit stays in the banner.
- **Activity** (full width, folded when the page opens like Zones; the header says how long ago the counters started): the engine's counters with a share bar where one makes sense, and, for Unbound with extended statistics, the answer
  codes. A counter the engine does not report (Unbound's extended ones when `extended_stats` is off) is left out, never shown as
  zero, and the card says how to turn them on.

## The plugin
`flab.dns` itself is read-only (it never writes); the ACL fragment (`rpcd/acl.d/flab-dns.json`) grants its `status` method and, for
the option editing, rpcd's `uci` methods (`get`, `changes` under `read`; `set`, `add`, `delete`, `revert`, `apply`, `confirm`,
`rollback` under `write`) on the `unbound` and `dhcp` configs only: no generic `file` or exec grant, no other config. `status` takes no arguments: whatever a request carries is ignored, and every command the plugin runs
is a fixed string (a test reads the source and fails if a `run()` call takes a template or a variable). A command that fails or is
missing leaves its part null and adds a warning; it never fails the call, and the whole call is a handful of small commands.
- `ok`, `generated`; `engine` (`unbound`, `dnsmasq` or null: the running engine that listens on port 53, else any running one,
  Unbound first), `configured` (the engine described when none runs: the installed one, Unbound only when it is enabled in UCI or
  dnsmasq is absent); `engines.unbound` and `engines.dnsmasq` with `installed`, `running`, `pid` (procd's, else `pidof`), `version`,
  `uptime`, `port`, `stats` and, for Unbound, `control` (whether `unbound-control` answered).
- `version`, `uptime` (seconds: Unbound's own, or for dnsmasq the process age from `/proc/<pid>/stat` field 22 and `/proc/uptime`),
  `listeners` (`addr`, `port`, `proto`, `engine`; unique, at most 50), `stats`, `config` (the whitelisted UCI options that are set; a
  list stays a list; every option of `dns/schema.js` and no other, which a test checks), `config_section` (`config` and `name` of the UCI section that holds them, so the page can write them; null without one), `defaults` (what the engine does for an option that is not set, only where certain), `forwards` (`zone`,
  `servers`, `flags`, `tls`, `source`, `section`; the default zone first, at most 500; zones lowercase without a trailing dot;
  `source` is `uci` for a forwarder that UCI defines (an Unbound zone section, named in `section`, or a dnsmasq `server` entry) and
  `file` for one that only Unbound's extension file defines), `forward_uci` (the zones that can be changed through UCI: for
    Unbound every `config zone` section in the order of the file, of any `zone_type`, enabled or not, as `section`, `type`, `enabled`,
    `zones`, `servers` and `options` (`tls_upstream`, `tls_index`, `tls_port`, `port`, `fallback`, `dns_assist`, `resolv_conf`,
    `url_dir`), plus `cut: true` when its lists were longer than the plugin reads (500 domains, 50 servers), which makes the page treat
    it as read only; for dnsmasq the `server` entries as written, `index` and `value`), `upstream`,
  `upstream_used` (dnsmasq: not `noresolv`; null for Unbound, where the page checks whether the WAN resolvers are among the servers of the forwarders in force), `local_names` (Unbound: the distinct names of `list_local_data` without
  the reverse ones; dnsmasq: the names of the host files and named leases), `dnssec` (`supported`, `enabled`), `truncated`
  (`forwards`, `listeners`, `private_domains`, and `forward_uci` for a dnsmasq list that was cut) and `warnings`.
- `stats` for Unbound: `queries`, `cache_hits`, `cache_misses`, `prefetch`, `expired`, `ratelimited`, `timed_out`, `recursion_avg_ms`,
  `recursion_median_ms`, `rcodes`, `secure`, `bogus`, `unwanted_queries`, `unwanted_replies`, `cache_msgs`, `cache_rrsets`,
  `cache_bytes`, `since`, from the `total.*` lines of `stats_noreset`; whatever extended statistics would add is null when it is
  off. For dnsmasq: `forwarded`, `local_answered`, `auth_answered`, `stale_answered`, `unanswered`, `cache_inserted`,
  `cache_live_freed`, `cache_size` (the configured one) and `since`. `dnssec.enabled` for Unbound is whether the `validator` module is
  loaded; for dnsmasq the `dnssec` option, and `supported` is whether the build's compile options say `DNSSEC` (not `no-DNSSEC`).
