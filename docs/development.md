# Development

## How to add a page

Example: an `ntp` page.

1. **Backend (only if new data is needed).**
   - `rpcd/ucode/flab.ntp.uc` returning `{ 'flab.ntp': { status: { call() {...} } } }`. Reuse
     `import { run } from 'flab.util'` and, for strongSwan-style output, `flab.vici`.
   - `rpcd/acl.d/flab-ntp.json`, so that root (read and write `*`) may call it:
     ```json
     { "flab": { "description": "flab-ui NTP page",
                 "read": { "ubus": { "flab.ntp": ["status"] } }, "write": {} } }
     ```
     A page that reads or writes a config through rpcd's `uci` object needs a fragment too, listing the config
     in its `uci` read (and write) lists, like `flab-settings.json`.
   - Prefer direct data sources (see the hard rule above), and rpcd's own `uci`, `system` and
     `service` objects where they are enough: no plugin is needed for those.
2. **Frontend.** Create `www/js/pages/ntp.js` (or an `ntp/` folder with `index.js` plus helpers):
   ```js
   import { ubus } from '../core/ubus.js';
   import { card, table } from '../core/ui.js';
   export default {
     id: 'ntp', label: 'NTP', icon: 'clock', interval: 10000,
     load: () => ubus('flab.ntp', 'status'),
     view: data => [card('Servers', table(['Server', 'Offset'], data.servers.map(s => [s.name, s.offset])))],
   };
   ```
   Add `css: 'css/ntp.css'` and the file if the page needs its own styles.
3. **Register.** Import it in `www/js/pages/index.js` and add it to the `pages` array. Array order is
   navigation order.
4. **Icons.** If you need a new icon, paste its `<path>` markup from icons.getbootstrap.com into the
   `PATHS` map in `core/icons.js`.
5. **Tests.** Add the plugin to `$plugins` in `tests/network/run.ps1`, scenarios to `tests/network/mkfx.mjs`,
   assertions to `assert.mjs` and a browser section to `live.mjs` (or extend the suite that fits best).
6. **Install and test** with `tools/package.ps1`; every file in `rpcd/` and `www/` is picked up automatically.

Reuse before writing new code: if two pages need the same widget, move it to `core/ui.js`; if the same
parsing is needed by two plugins, move it to `rpcd/lib/flab/`. Comment every function and lookup table, put
legends at the top of the card they explain, and keep pure logic (models, filters) in a DOM-free module with a
unit test.

## Implementation notes

- **rpcd reads its plugins and ACL fragments only at start**: copy them and `restart` rpcd (`reload` is not enough).
- **A session without a password**: `ubus call session create` plus `session grant` (scopes `ubus` and `uci`)
  over ssh gives a session that works through `/ubus` like a real sign-in; the browser tests grant it what the
  ACL fragments list.
- **Root's `*`**: `read` and `write` `*` in an rpcd login is a list (`list read '*'`) naming every ACL group in
  `/usr/share/rpcd/acl.d`. It is not a wildcard over objects, so a call that no fragment grants is denied even
  for root (JSON-RPC `-32002`). A login that sets `*` as a plain option gets no groups at all.
- **rpcd `uci` object**: staged edits are kept per session, `set` rejects `null` values (use `delete` with
  `options`), `apply` takes no config list (it applies everything staged), and after any rollback (explicit or
  by the countdown) the rolled-back edits reappear in the staging area. `uci get <config>` returns every section
  keyed by name with `.type`, `.name` and `.anonymous`, and a list option as an array. A method the session may
  not call is refused with JSON-RPC `-32002`; a config it may not use is refused by rpcd with ubus status 6.
- **Time zone**: `/etc/config/system` holds `zonename` (IANA name) and `timezone` (POSIX rule); the system only
  uses the rule. `uci apply` on `system` triggers procd to reload `system` (rewrites `/etc/TZ`) and `sysntpd`.
- **UCI file order**: deleting and re-adding an option moves it within the section, and an explicit default
  (`enabled '1'`) stays in the file, so a change and its undo are equivalent but not byte-identical.
- **BusyBox** has no `od`; `scp` needs `-O`; shell snippets sent over ssh must be LF-only.
- **Splatting a single path** in PowerShell iterates its characters; wrap it in `@(...)`.
- **hostapd rate units**: `ubus hostapd.<if> get_clients` reports rates in units of 10 bit/s, so divide by
  100000 to get Mbit/s.
- **VICI parsing**: scalar values can contain spaces; see `flab.vici`.
- **`ip monitor`**: `timeout ip ...` runs BusyBox's reduced `ip` applet, which has no `monitor`. Call
  `/sbin/ip` (iproute2) by full path.
- **BIRD has no JSON output**: `flab.bgp` parses `birdc` text (indentation-based sections for protocols,
  header plus tab-indented attribute lines for routes). The parser skips unknown lines, so a newer BIRD only
  loses fields. Protocol names from `birdc` are validated before being used in a shell command.
- **ucode numbers and time**: `+"08"` is 8 (decimal), `timelocal({...})` works for BIRD and logread
  timestamps (month 1-12), `match(s, /re/g)` returns an array of `[full, group]` pairs, `split(s, sep, limit)`
  is supported, `replace(s, /re/gi, '$1<redacted>')` supports backreferences.
- **nft counters**: firewall4 puts a `counter` and a `!fw4: <name>` comment on each rule; chains named
  `reject_from_<zone>` / `drop_from_<zone>` (and `_to_`) hold the packets turned away per zone.
- **Log volume**: logd's buffer holds thousands of lines (every SSH login is several); the plugin asks
  `logread -l N` for the tail instead of reading everything.
- **No favicon request**: `index.html` uses an empty data-URI icon.

## Conventions

- Every function, lookup table and non-obvious block has a comment saying what it does and, where it is not
  obvious, why. Comments describe current behavior, never history; neither do these docs. Text, comments and
  these docs and the README use American English (color, center, gray, synchronize).
- PowerShell follows `Set-StrictMode -Version Latest`, `$ErrorActionPreference = 'Stop'`, comment-based help
  on functions and scripts, and `#region` blocks.
- ucode uses tabs, JavaScript and CSS use two spaces.
- Everything shown is discovered from the router at run time; nothing is hard-coded to one board.
- Legends sit at the top of the card or section they explain.
- Code in `rpcd/` and `www/` is deployed as is; there is no build step to keep in sync.
- When the router configuration is changed outside this folder, the corresponding files under
  `build/MT6000/` in this repository must be updated as well and pushed.
