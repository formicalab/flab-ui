# Frontend

## Boot and routing (`js/core/app.js`)

- `main.js` calls `initTheme()` then `start()`.
- Routing is hash based (`#overview`, `#wifi`, ...). The first entry in `pages/index.js` is the default.
- On every route change the shell rebuilds: navigation pane, command bar (page title, the page's
  persistent controls, "Updated hh:mm:ss" stamp) and a `<main>` results area.
- `page.load()` fetches data, `page.view(data, rerender)` returns nodes. A `setInterval` repeats
  `load()` every `page.interval` ms unless `page.isPaused()` is true. A poll is also skipped while the previous
  one is still running and while the browser tab is in the background (the tab refreshes when it is shown again).
  Only the newest request counts: a late reply that was overtaken, or one for a page that was left, is dropped.
- Page CSS (`page.css`) is added once to `<head>` the first time the page opens.
- An `AuthError` anywhere returns the user to the sign-in screen ("Session expired").

## Page contract

Every page is a plain object, default-exported from its module (full text in `js/pages/index.js`):

| Member | Required | Meaning |
|---|---|---|
| `id` | yes | Route name / URL hash |
| `label` | yes | Navigation text (`title` optionally overrides the command-bar heading) |
| `icon` | yes | Name from `core/icons.js` |
| `nav` | no | `'bottom'` puts the link below the spacer, next to Sign out (System settings); default is the main list |
| `interval` | yes | Auto-refresh period in ms |
| `load()` | yes | Async; returns the page data, usually one ubus call |
| `view(data, rerender)` | yes | Returns an array of DOM nodes |
| `controls({ rerender, reload })` | no | Returns `{ nodes, update?(data) }`; controls persist across refreshes |
| `isPaused()` | no | Return true to suspend auto-refresh |
| `css` | no | Stylesheet (or array of stylesheets) loaded on first visit |

`aliases` (exported next to `pages`) maps a route that was a page once to the page that replaced it (`bridges` → `interfaces`); `core/app.js` replaces the hash, so a bookmark keeps working.

**State that must survive refreshes** (filter text, sort order, selected radio, paused flag, scroll
position) lives in a module-level `state` object in the page, never in the DOM. The controls are created
once per route; only `<main>` is redrawn on refresh, so typing in a filter box is never interrupted.

## Core building blocks

- **`h(tag, props, ...children)`** builds elements from properties and text nodes only. Router data is
  therefore never parsed as HTML. Never use `innerHTML` with data (the only `innerHTML` is static markup:
  the icon path data in `icons.js` and the sign-in logo).
- **`ui.js`** components: `card`, `tile`/`tiles` (KPI row), `table`, `badge` (soft pill: `success`,
  `warning`, `danger`, `info`), `chip`, `kv` (label/value list), `section`, `lifebar`, `meter`,
  `sparkline`, `emptyState`, `button`, `healthBanner` (findings list or all-clear), `muted` and `mono`
  (inline text), `GRADE_KIND` (badge kind of the A+ to D security grades).
- **`controls.js`**: `searchControl`, `selectControl`, `pauseControl`, `toggleControl`, `refreshControl`
  bind to a page's `state` object.
- **`format.js`**: `fmtBytes`, `fmtBps`, `fmtLine` (bytes per second as Mbit/s), `fmtDur`, `fmtSpan`,
  `fmtNum`, `fmtRate`.
- **`rates.js`**: `createTracker()` turns the cumulative counters the router reports into per-second rates
  and ratios from successive polls. A series restarts after a gap (polling paused, background tab), a counter
  that goes backwards counts as zero, and `keep()` drops series whose key disappeared. Every page that shows
  live traffic uses it; `pages/ipsec/rates.js` only chooses which IPsec counters to feed it.
- **`ubus.js`**: `ubus(object, method, args)`. A JSON-RPC error `-32002` is ambiguous (expired session
  or ACL denial), so it asks `session.access` to tell them apart: an expired session raises
  `AuthError`; an ACL denial raises a normal error naming the object and method. `optional(promise)`
  resolves to `null` for data a page can do without (a missing plugin or ACL) but still raises
  `AuthError`. `can(object, method)` answers from the ACLs returned at sign-in (root's `*` allows everything),
  so a page can disable controls the login may not use.
- **`uci.js`**: the only code that calls rpcd's `uci` object, see [Configuration changes](architecture.md#configuration-changes).
  `applyChange()` runs a whole change with its safety net; pages should call that, not the single steps.
- The session id and ACLs live in `sessionStorage` (cleared when the tab closes). Login timeout is 900 s.

## Styling

- Bootstrap 5.3 supplies grid, forms, tables and utilities; `css/base.css` layers a Fluent 2 look on
  top through `--fl-*` CSS variables (surfaces, strokes, brand, soft status colors) for light and dark.
- Light/dark follows the OS (`prefers-color-scheme`) via Bootstrap's `data-bs-theme`.
- The layout fills the whole viewport: a 240 px navigation pane, a sticky acrylic command bar, then a
  fluid content area. Tables use `table-layout: fixed` with percentage column widths where several tables
  must align (`.fixed-grid`, widths must sum to 100).
- Prefer the `--fl-*` variables over hard-coded colors so both themes keep working.
- **Type scale:** use these sizes and no others: `.75rem` captions, badges and uppercase labels (letter-spacing `.05em`), `.8rem`
  secondary text, table headers and monospace, `.875rem` body, `1rem` emphasis (a value or headline inside a card), `1.2rem`
  names and the page title, `1.5rem` stat values, `1.75rem` KPI tiles. Weights are 400 and 600 only; `base.css` makes `b`,
  `strong` and the headings 600 (bootstrap's are 700 and 500) and `small` / `.small` `.8rem` (bootstrap's is relative to the
  parent, so it differed in every container). Monospace text uses `var(--fl-mono)` (also bootstrap's `pre` and `code`); never
  spell the font stack out again.
- Shared pieces (status `.dot`, health banner, table helpers) live in `base.css` because page CSS is
  loaded lazily.
- **Legends and "how to read" notes sit at the top of the card or section they explain**, so the key is read
  before the data. Keep that when adding a page.

## Page-specific frontend notes

- **IPsec**: `connection.js` renders one card per connection from the backend JSON; `names.js` maps
  strongSwan identifiers to friendly names (`AES_GCM_16`+256 to `AES-256-GCM`); `rates.js` feeds the shared
  tracker with the `xfrmN` interface counters (they survive child SA rekeys), keyed by the backend's
  `conn.key`; `daemon.js` shows daemon state and the score model.
- **Overview**: the sensors and CPU calls are optional, so a missing plugin or ACL hides that section
  instead of breaking the page. `cpu.js` keeps the sample history and builds the CPU card;
  `temperatures.js` builds the temperature cards. A sensor that gives no reading (a Qualcomm Wi-Fi radio that is
  down) is not reported by the plugin and is ignored by the page.
- **Routing**: `index.js` owns the page state, the tabs and the command bar (the tab strip, the filters of each
  tab) and loads only the open tab; `model.js` holds the pure parts (address and prefix math, the table overview,
  findings, filtering and sorting, what a lookup answer means, who added a rule); `lookup.js` and `tables.js` build the
  Routes tab cards. The Toolbox page (`toolbox/`) is separate: `index.js` is the page and exports `openTool`, which the
  lookup answer's buttons use; `diag.js` is the form, job polling and the choice of result view, `diagviews.js`
  the ping, traceroute, DNS, check, comparison and certificate views, `diagmodel.js` the pure parts (the request a form may
  build, the parsers for the classic tools' output, the check's verdict), and the newer tools have a model and a view each
  (`iperfmodel.js`/`iperfview.js`, `dnstracemodel.js`/`dnstraceview.js`, `pathmodel.js`/`pathview.js`) plus `charts.js` and
  `tlsdiagram.js` for the pictures.
  The BGP tab is `bgp/`: `tab.js` composes the sections; `topology.js`, `peer.js`, `routes.js`,
  `announced.js` and `system.js` each export card builders that take the backend data; `util.js` holds the
  per-peer color helpers, AS-path chips and prefix sort key.
- **Pure models**: `firewall/model.js` (zone matrix) and `firewall/edit.js`, `validate.js`, `plan.js`, `view.js`, `check.js`, `describe.js` (the editor),
  `interfaces/boardmodel.js` (the network board), `interfaces/model.js`, `interfaces/checks.js`, `interfaces/panelmodel.js` and `interfaces/wizardmodel.js` (the network editor),
  `network/vlanmodel.js` (the VLAN editor), `wifi/model.js` and `wifi/channels.js`, `wireguard/model.js`, `wireguard/addr.js` and
  `wireguard/keys.js`, `traffic/settings-model.js`, `logs/entries.js` (log filtering and formatting), `settings/model.js` and `dhcp/model.js` (validation and the
  UCI change plan) and `core/fields.js` (field checks)
  have no DOM access and are unit-tested on their own.
