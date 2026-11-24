# Asterisk (route `#asterisk`, optional `flab-ui-mod-asterisk`)
The PBX of the router, read only apart from three reload buttons. Five tabs; only the open tab is polled (Overview and PJSIP every 5 s, Calls every 10 s, Dialplan every
30 s, Configuration not at all: Refresh reads it again). Data comes from the `flab.asterisk` plugin, which talks to
Asterisk through its CLI (`asterisk -rx '<command>'`, over the control socket). The only change the page can make is a
reload (see Reload below): there is no originate and no edit. The page is built for Asterisk 23, the version in the
OpenWrt telephony feed; the parsers skip lines they do not know, so another version loses fields instead of breaking.

## Reload
At the right end of the tab strip, on every tab: **All** (`core reload`), **Dialplan** (`dialplan reload`, extensions.conf
only) and **PJSIP** (`module reload res_pjsip.so`, endpoints and registrations). A button asks first, says what will
happen and which command runs, then shows what Asterisk answered and reads the page again. Calls in progress go on. The
buttons are greyed when Asterisk is not running and absent when the login has no write access to `flab.asterisk reload`. Asterisk's
`Last reload` moves only on **All**, so a Dialplan or PJSIP reload leaves a time marker in `/tmp` (`flab-asterisk-reload.<what>`) and
the "file changed after the last load" banner compares extensions*.conf and pjsip*.conf with it too. The
Overview banner about a configuration file changed after the last load points here.

## Overview
- Summary tiles: version and uptime, registrations (registered of all), endpoints (available of all), calls (active and
  processed since start), memory and whether the configuration was changed after the last reload. The same tiles stay pinned
  above the tabs on every tab (each tab's poll reads the status too), so the state of the daemon is always in view.
- A banner of what needs attention: a registration that is not `Registered`, an endpoint that is `Unavailable`, a
  configuration file changed after Asterisk last loaded it (the reload command is named, not run), errors in the log in the
  last 24 hours, PJSIP not loaded or nothing configured. When Asterisk is not running the page tells the cases apart:
  **disabled** (`/etc/config/asterisk` has `enabled 0`, a note), **stopped** while enabled (an error), **not answering**
  (the process lives but the control socket does not) and **not installed**.
- The daemon card: version, PJPROJECT version, uptime, last reload, process id and resident memory, call counters and
  limit, what is exposed (AMI, AMI over HTTP, realtime), whether CDR has a backend, the logger channels, the directories,
  and the loaded modules as chips (their descriptions are tooltips).
- The registrations and endpoints at a glance, and the recent warnings and errors of `/var/log/asterisk/messages.log`
  (the last 30; NOTICE lines are kept because the reason of a failed call is often one). A known harmless line is marked
  *harmless* and raises no finding: on OpenWrt (musl) Asterisk cannot read the nameservers, so it logs "There are no local
  system nameservers configured" at every start and reload and resolves through the system resolver, which works.

## PJSIP
- **Registrations**: one card per outbound registration with its state, when it renews, and its settings (client and server
  URI, intervals, retries, proxy), linked to the endpoint it belongs to.
- **Signalling**: phones on the left, Asterisk with its transports in the middle, trunks on the right; the lines move while
  a call is up.
- **Endpoints**: state, calls, context, codecs, reachable contacts and what identifies the endpoint (by user name, or by
  address). A *trunk* is an endpoint with a registration or an identify address; a *phone* registers with Asterisk.
  Filter by text or by role. A row opens a side panel with the endpoint's settings by group, its credentials (user names,
  never passwords), contacts, identify addresses and, on demand, every parameter Asterisk reports (secrets hidden).
- **Contacts** with the round-trip time and its history since the tab was opened, **transports** (what Asterisk listens on,
  what it announces, the local networks), and the **active channels** with the application each is in and its duration.
- An unavailable phone with contacts is told apart from one with none: the first registered but its contacts do not answer
  the periodic check, the second never registered.

## Calls
The recent calls, newest first, from the file `cdr_csv.so` writes (`/var/log/asterisk/cdr-csv/Master.csv`). Each row: when (the full
time is the tooltip), direction (incoming, outgoing or internal: a call that came in through a trunk endpoint is incoming, one that
went out through a trunk is outgoing; shown as “–” when PJSIP cannot be read), who called whom (the number, with the caller's name
and the endpoint that carried the call under it), the result (Answered, Missed for no answer or busy, Failed for failed or
congested), the time it rang and the time it was talked. A line over the table counts the calls shown by result and adds the
talk time. A filter by kind (all, incoming, outgoing, internal, missed) and by text (numbers, name, endpoints, result) narrows the
list. The legs of one call (a Local channel makes two CDR lines) are shown as one.

The history is what Asterisk logged, so it needs the setup in the openwrt repo: the `asterisk-cdr-csv` package (or
`utilities/install-asterisk-cdr-csv.sh`), and `unanswered=yes` and `congestion=yes` in `cdr.conf` so that missed and failed calls are
kept too. The file is in `/var/log`, which is RAM on OpenWrt: it is lost at a reboot (no writes to the flash) and a cron job trims
it to the last 5000 lines every night. The page reads the newest 300 calls. The arguments of the last application (`lastdata`) and
the user field are not sent to the browser, because they can hold dialed digits or a PIN being compared. With Asterisk stopped the
file is still read, so the last calls stay visible.

## Dialplan
The loaded dialplan (`dialplan show`), not the file: what Asterisk actually uses. Three views.

- **Browser**: the contexts on the left (a context that no endpoint enters and nothing includes or jumps to is marked
  *unused*), the selected context on the right with the endpoints that enter it, what it includes and where it jumps. Each
  extension is a fold: the pattern, what it means in words (`_0[1-9].` is “0”, then 1–9, then one or more of anything), what it
  dials (also through the subroutines it calls), and its steps: priority, label, application (colored by what it does; the tooltip says what it does), arguments with
  `${variables}` marked, where the step can go next (a click shows the destination) and the source line, which opens the
  Configuration tab at that line. A filter narrows the extensions by pattern, application or arguments. The global variables
  are listed below.
- **Routing map**: endpoints (where calls enter) → contexts → dialed endpoints, drawn from the dialplan and the live endpoints.
  `Dial(PJSIP/+39${EXTEN}@Vodafone)` links the context to the endpoint Vodafone with its live state. A global variable in the
  endpoint position is replaced by its value, so `Dial(PJSIP/${ARG1}@${OUTBOUND_TRUNK})` links to whichever trunk the global names;
  any other variable makes the target dynamic. A click on a context highlights its wiring. Under the map: an endpoint whose context the
  dialplan does not define, a `Dial` to an endpoint that does not exist, a jump to a missing context or label, and unused contexts.
- **Number tester**: pick where the call enters (an endpoint or a context) and type a number. The page follows the dialplan the
  way Asterisk searches it, and shows the extension, whether it was found through an include, what it does next (the endpoints
  it can dial, with their state, also through the subroutines it `Gosub`s or jumps to, such as `sub-trunk`) and its steps.
  Nothing is dialed. The page also asks Asterisk itself
  (`dialplan show <number>@<context>`) and says whether the two agree.

How the search works, as Asterisk does it: the extensions of a context are tried in the order `dialplan show` lists them
(the exact names, then the patterns, the most specific first); the first that matches wins; only when the context's own
extensions do not match are its includes searched, in order. In a pattern `X` is 0–9, `Z` 1–9, `N` 2–9, `[a-c5]` a set,
`.` one or more characters, `!` any rest (even none); spaces and dashes in a pattern are ignored.

PINs and passwords in the dialplan are **hidden** by the backend before anything reaches the browser (see Backend). A hidden
value shows as `<redacted>`, and the count line at the top of the Browser view says how many were hidden. This is best effort: it recognizes
`Authenticate(...)` and `DISA(...)`, `Set(NAME=value)` where the name says it is a secret (`PIN`, `PASSWORD`, `SECRET`, `TOKEN`,
…), a comparison of such a variable with a literal (`$["${PIN}" = "3003"]`), and the `[globals]` with such names. A secret under
an innocent name cannot be recognized.

## Configuration
The files of `/etc/asterisk` and `/etc/config/asterisk`, read only and with the secrets hidden (the value of `password`, `secret`,
`md5_cred` and similar, and what the Dialplan tab hides). Only text inside a line changes, so line numbers stay valid: a click on
the source of a dialplan step opens the file with that line highlighted. Files with no settings (only comments) are hidden until
asked for. A file changed after Asterisk last loaded its configuration is marked. Sections are listed in a jump menu (pjsip.conf shows
each object's type, since one name can be an endpoint, an aor, an auth and more).

## Behavior worth knowing
- Asterisk's CLI truncates some columns, such as long contact URIs; the page shows what the CLI gives.
- `pjsip show endpoint` is asked once per endpoint (up to 40; more are listed without codecs and context and the page says so).
- Call history is on the Calls tab, and exists only while a CDR backend writes it (`cdr show status` lists `csv`). Without one
  Asterisk keeps only the counters, and the tab says what to install.
- The Calls tab reads the file `/var/log/asterisk/cdr-csv/Master.csv`; the page cannot clear or change it.
- The active-channel columns follow the documented concise format of `core show channels concise`; they have been checked against
  fixtures built from that format, not against a live call.
