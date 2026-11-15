# Toolbox (route `#toolbox`)
Diagnostic tools that run on the router and show their output as it arrives: a connectivity check, ping, traceroute, MTR,
DNS lookups (of one server, or of several to compare), a DNS trace, a TLS certificate check, an iperf3 server and Wake-on-LAN. The form has a tool
selector, the host, and the options of the tool:
for ping the count
(1 to 60), the packet size (0 to 1400), the address family and the interface to send from (a dropdown of the router's
interfaces, "automatic" by default; the plugin also accepts an address); for traceroute the maximum hops (1 to 30), the probes per hop (1 to 3), UDP or ICMP
probes, whether to look up host names and networks, family and source; for MTR the rounds (3 to 60) and ICMP or UDP; for
DNS the record type (A, AAAA, MX, TXT, NS, CNAME, SOA, PTR, SRV, CAA) and the servers to ask (the router's resolver by default); for the DNS trace the record type and the address family; for
the certificate check the port, a server name and a STARTTLS
protocol; for the iperf3 server the time to run, the port and the address to listen on. A tool is offered only when the router has what it needs (the certificate check needs `openssl`,
MTR needs `mtr`, the DNS trace needs `kdig`, the iperf3 server needs `iperf3`, the DNS tools
and the check need a DNS tool). The form is checked in the browser
first (a host with a space, a leading `-` or shell characters never reaches the router), and the plugin checks everything
again. The form remembers its values while the page is open; Run is disabled for a login that may not start diagnostics.
- **Connectivity check:** one click that walks down the stack and says where it breaks: the default route, the next hop
  (found the way the kernel would route to 1.1.1.1, a PPP peer address when the link has no gateway) and a ping of it, two
  public addresses (1.1.1.1 and 8.8.8.8), a DNS lookup through the router's resolver and through 1.1.1.1, the IPv6
  equivalents (skipped when there is no IPv6 default route) and a TLS handshake to the host (`example.com` unless another is
  given). The steps turn from waiting to done while it runs, and a verdict says what is wrong in the order the problems
  matter: no default route; a dead next hop; a next hop that answers while the internet does not; a router resolver that
  fails while a public one answers; no DNS at all (port 53 blocked); a certificate that is not yet valid or expired (the
  router's clock is the first suspect); an IPv6 route that leads nowhere (a note, not the verdict). A script that cannot run
  at all (the shell's own message, such as a syntax error) is shown as the result instead of an empty checklist.
- **Ping:** figures (sent, received, loss, fastest, average, slowest, jitter) that update while it runs, and a line chart of
  the round-trip time of each ping (the average as a dashed line, the range between fastest and slowest as a band, a lost
  ping as a red cross: busybox prints nothing for a lost packet, so a gap in the
  sequence numbers is the sign of it; with no reply at all there is nothing to plot and no chart), and a plain sentence for
  total loss, partial loss and a name that does not resolve.
- **Traceroute:** one row per hop as it arrives, with the routers that answered (a hop answered by two routers lists
  both), each probe's round-trip time (`*` for a lost probe), the average with a bar, silent hops marked "no reply", the
  destination highlighted, and a note when it was not reached within the hop limit. "Host names" can be switched to "look
  up names": the tool then runs without `-n` and prints `name (address)` for each router, shown as the name with the
  address beneath it; a router with no reverse record is printed as `address (address)` and shows just the address. The
  default is addresses only, because every lookup waits for the resolver and a hop without a reverse record can be slow.
  "Networks (AS)" (on by default, offered when the router has `dig` or `kdig`) turns the job into a script: the traceroute
  is the first block, then each public address that answered (up to 30; private, loopback, link-local, shared-address and multicast addresses are
  skipped) is looked up through the router's own resolver in Team Cymru's DNS service (`<reversed address>.origin.asn.cymru.com`,
  `origin6` for IPv6, and `AS<n>.asn.cymru.com` for the name). Each router then shows its AS number, the organization
  and the country beneath the address, and a line under the table lists the
  networks the path crosses in order. An address that no AS announces (an operator's own infrastructure range, which has no
  origin record) is looked up in RIPE's whois instead (a TCP query to `whois.ripe.net` port 43, for the first 8 such
  addresses of a job; `nc` is needed) and shown as "not announced · NETNAME · country", with the registered range in the
  tooltip; a range RIPE does not manage, or an answer that does not come, leaves "no AS data". The addresses leave the
  router only inside those DNS queries and the whois queries.
- **MTR:** `mtr --raw` against the host for the chosen rounds (one probe a second per hop; ICMP or UDP). The table fills as
  the events arrive: per hop the address, loss with a small bar, probes sent, last, average, best, worst, the spread and a
  sparkline of the delay over time; hops after the first repeated address are cut. Findings in words: whether any probe to
  the destination was lost, a middle hop that shows loss while the later hops do not (it only limits its own replies, so the
  path is fine; shown in green, not as a fault), a destination that never answered, and a jump in delay between two hops. A probe
  still in flight is not counted as lost while the run goes on.
- **DNS lookup:** asks the same question of one server or of up to six. The server list offers the router's own resolver
  (the default), the upstream resolvers the router was given (read from `resolv.conf.auto`, loopback left out), Cloudflare,
  Google and Quad9, and a field for one more of your choice. With **one server** the result shows how it went (the number
  of answers, NXDOMAIN, SERVFAIL, REFUSED, timeout, or no answer), the server that answered, and the tool's own output. The
  tool is the first of `dig`, `kdig`, `drill` and `nslookup` that the router has; busybox `nslookup` cannot show MX, TXT, NS,
  CNAME, SOA, SRV or CAA records in full (it prints "mail exchanger = 0" with no host), so the page says so when only
  nslookup exists and one of those types is chosen. With **two or more servers** the same question is put to each in turn
  and the result is a comparison: a bar chart (fastest first, the fastest marked) shows each server's response time, and a
  row per server shows the result, the addresses, whether the resolver validated the answer with DNSSEC (the AD flag), the
  time the tool reports and the fastest server. Differing answers are highlighted, with the note that a CDN gives each
  resolver its own, correct set; a server that does not answer shows "No reply". A lookup of one server is sent to the
  plugin as its `dns` tool and one of several as its `compare` tool.
- **DNS trace:** the way a resolver finds a name, step by step, as a script that needs `kdig`. It asks a root server
  (a, c, f or m), then the servers each answer points to, down to the zone's own server, with `+norecurse +dnssec`, one block
  per step (`step <n> <address> <name> <zone>`), and ends by asking the router's resolver the same question. A name server
  that came without an address in the referral is looked up through the router's resolver first (`lookup` block); an alias
  (CNAME) restarts the trace from the root for the new name (up to 4 times, `cname` block). Three servers in a row that
  do not answer end the trace, and it stops at 18 steps or 60 seconds. The page shows a summary (the outcome, the
  number of queries, the aliases followed, the time spent waiting), a timing bar with a segment per step, and a ladder of
  cards: the zone, the server asked and its address, the answer time and what it said (a referral with its name servers
  and which came with addresses, an alias, the authoritative answer with its records, or the denial of a name or a type).
  The DNSSEC records of each step are read: a signed delegation (the DS record's key tag, algorithm and digest), an unsigned
  one where the chain of trust ends, and the signature of the final answer (signer, key tag, expiry), summarized as a chain
  that is intact, not complete or absent. The last card compares the router's own resolver (whether it validated the answer,
  the time, the cache age) with the authoritative answer, and says that differences are normal for CDN names. NXDOMAIN
  answers that Cloudflare-style servers give as NOERROR with an NSEC `NXNAME` record are read as NXDOMAIN.
- **TLS certificate:** connects to a host and port (optionally with another server name, or after STARTTLS for SMTP, IMAP,
  POP3 and FTP) and shows the session (protocol, cipher, key exchange) and the certificates exactly as the server sent
  them, in the order sent: the router's own certificate authorities are never used to add or reorder any (`openssl
  s_client` lists the certificates received, not the chain it verified). A "Chain and expiry" picture comes first: the
  certificates as boxes from the server's certificate down to the root (a missing issuer is a dashed placeholder; a root
  the server did not send but the router's store trusts is shown as such), and a timeline with a bar for each certificate's
  validity and a mark for today. A box or bar is red once expired, amber within 14 days of the end, yellow within 60 days,
  green otherwise. Each certificate is then listed with subject, issuer, key and signature
  algorithm, validity with the days left, names, certificate authority flag, serial, SHA-256 fingerprint, and the PEM text
  with a copy button. Findings say whether the chain is trusted by the router's CA store, and judge the chain the server
  sent on its own: a server that sends only its own certificate, a gap or wrong order (a certificate that is not the
  issuer of the one before it), or a chain in order. A dashed marker shows where the issuer is missing; when the router
  trusts such a chain only because its CA store makes up for the missing certificate, the finding says so. Further findings
  say whether the certificate covers the name or address asked for (wildcards match
  one label), whether it is expired, not yet valid or ends within 14 days, a weak RSA key or a SHA-1 or MD5 signature, a
  protocol older than TLS 1.2, and why a connection failed (refused, timed out, name not found, or a server that hung up
  without sending a certificate).
- **iperf3 server:** starts `iperf3 -s` on the router for a chosen time (1, 2, 5, 15 or 30 minutes; 2 is the default) so a
  computer on the LAN can measure the path to the router. The server prints one JSON event per line (`--json-stream`,
  flushed as produced) and stops by itself when the time is up (the job's `timeout` ends it, code 124); Stop ends it
  earlier (iperf3 then exits with 0, so the page records the Stop itself). The port is 5201 unless changed (1024 to
  65535), and the server listens on every address unless one of the router's own addresses is chosen (`-B`); only one
  server runs at a time, and it holds one of the three job slots. While it runs the page shows where it listens, a
  countdown, and "Connect from a computer": the router's addresses (from `network.interface dump`) with the firewall zone of each and
  what that zone does with traffic for the router, the `iperf3 -c` commands to type (upload, `-R` for download, `-P 4`
  parallel streams, `-u -b 500M` for UDP), each with a copy button, and the addresses the firewall blocks folded away.
  A warning appears when a zone that masquerades (the internet side) accepts traffic for the router, because a server on
  every address could then be reached from outside. Each client test shows as it runs: who connected, TCP or UDP,
  upload or download, the streams, the rate now, the peak, retransmits (TCP) or jitter and loss (UDP), and a throughput
  chart; earlier tests are listed in a table with their totals as the receiver (the router) measured them, and an
  interrupted test says why. A trailing sliver of under a quarter second and the duplicate interval iperf3 prints when a client
  aborts are left out.
- **Wake-on-LAN:** sends one magic packet (six `ff` bytes, then the MAC sixteen times) with `flab.diag wake`, which is not a job:
  it answers at once. The host is chosen from a list of the hosts the router knows (static DHCP hosts, odhcpd and dnsmasq
  leases, `/etc/ethers` and the ARP table; the status marks static DHCP hosts `reserved`): the reservations come first, then
  the hosts only seen on the network, each shown as name, address and MAC. *Another MAC address…* brings up a text field, which
  is the only control when the router knows no host. The interface is the one the host was last seen on, or
  `br-lan`, unless chosen. The packet goes out as a raw Ethernet frame with `etherwake` when the router has it, otherwise as a UDP
  broadcast to port 9 through `socat`; the tool is not offered when neither exists. The result names the host, the interface and the
  method, says the router cannot know whether the host woke up, and offers a ping of the host's address. The MAC is validated as six
  hex pairs and the interface must be a safe name of an existing device before either reaches a command. The permission is its own
  (`wake` under `write`).
- **From the Routing page:** a forwarded answer of the next-hop lookup offers Ping and Traceroute buttons that open the
  Toolbox with the destination filled in and start the job.
- **Jobs:** each run is a job. `flab.diag start` returns at once with a job id and `read` returns the output so far, which
  the page asks for every half second until the job ends; `stop` ends it. Nothing blocks rpcd, so the rest of the UI keeps
  working during a 60 second traceroute. The job and the form live in the page state: leaving the page stops the reading
  (the job keeps running on the router until it ends or its time limit), and coming back resumes it. The page does not
  poll (it re-reads what the router has once a minute, and not while the form has focus); Refresh redraws it and the job
  carries on.

`flab.diag` runs the tools detached (`timeout -k 2 <limit> <tool> ... >out 2>&1 &`, with the exit code written to a file)
under `/tmp/flab-diag/<id>/`: a ping may run its count plus 10 seconds, a traceroute 60 (with the AS lookups up to 108 more),
MTR its rounds plus 15, a DNS trace 60, a DNS lookup of one server 15, a certificate check 25, a lookup of several servers
(the plugin's `compare` tool) 60, the connectivity check 75 and the iperf3 server the minutes asked for. The check, the
multi-server lookup, the certificate check,
the DNS trace and a traceroute with AS lookups are small shell scripts (`job.sh`,
written with LF line endings only, because BusyBox sh rejects a carriage return) that print their output in blocks
(`### BEGIN <step> <uptime> <detail>` … `### END <exit code> <uptime>`), which the page
splits and reads; a block without an END line is still running. Every command in a script runs under its own `timeout`, and
a TERM sent to the script (Stop) ends the command at once. `read` returns the output from a byte offset (`from`), cut at the last
complete line while more is still being written, with `size` for the next call and `truncated` when more is pending, so a long
iperf3 server's output is fetched in pieces. At most three jobs run at once,
twelve directories are kept, and a finished job is removed after ten minutes. Everything that reaches the shell is
validated: the tool, the record type and the STARTTLS protocol come from allow-lists, the host, the server name and the DNS
servers are made of letters, digits and `. : _ -` and do not start with `-` (they could be taken for an option), the port is
clamped to 1 to 65535 (1024 to 65535 for the iperf3 server), a `compare` request takes one to six servers that are each such a name (or `router`), the source is such
an address or an interface name, the iperf3 time must be one of the offered minutes and the address to listen on one of the router's own addresses,
the numbers are clamped to their ranges (a literal 0 is a number, not "absent"), the name-lookup and network-lookup switches must be real
booleans, the argument list is built from those values
only, the job id is generated from `/dev/urandom` and checked as exactly twelve hex digits whenever it comes back, and `stop`
only kills a process whose name is one of the tools (including `mtr`, `mtr-packet` and `iperf3`) or the shell running one of its own `job.sh` scripts (so a recycled pid
is never hit). The ACL fragment
`rpcd/acl.d/flab-diag.json` grants `status` and `read` (read) and `start`, `stop` and `wake` (write).
