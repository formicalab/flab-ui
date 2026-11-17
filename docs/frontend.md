# Frontend

## Browser requirements

The UI ships native ES modules without transpilation or a bundler. It uses BigInt for IP addresses, optional
chaining, `Array.prototype.at`, `structuredClone` and native `<dialog>`. Use a current browser; the automated browser
suites use Edge. No browser compatibility matrix is established yet. HTTPS is required operationally for credentials;
clipboard and WebCrypto capabilities also depend on the browser and secure context. WireGuard has a JavaScript X25519
fallback, but key generation still requires `crypto.getRandomValues`.

## Boot and routing (`js/core/app.js`)

- `main.js` calls `initTheme()` then `start()`.
- Routing is hash based (`#overview`, `#radios`, ...). The first entry in `pages/index.js` is the default.
- On every route change the shell rebuilds: navigation pane, command bar (page title, the page's
  persistent controls, "Updated hh:mm:ss" stamp) and a `<main>` results area.
- `page.load()` fetches data, `page.view(data, rerender)` returns nodes. A `setInterval` repeats
  `load()` every `page.interval` ms (a page that gives `interval` as a function gets a chained `setTimeout` instead,
  re-reading the period before each poll) unless `page.isPaused()` is true. A poll is also skipped while the previous
  one is still running and while the browser tab is in the background (the tab refreshes when it is shown again).
  Only the newest request counts: a late reply that was overtaken, or one for a page that was left, is dropped. A
  poll's reply is also dropped when the page became paused while it was on its way (the user clicked into a form or
  started an edit), so a slow router cannot rebuild a form under the user; an explicit reload (a save, Refresh) is
  always applied.
- Page CSS (`page.css`) is added once to `<head>` the first time the page opens.
- The registry contains navigation metadata and dynamic imports. The shell loads the selected page only after sign-in,
  caches successful imports and rejects stale navigation results; page styles remain loaded on demand.
- An `AuthError` from the shell's load path returns the user to the sign-in screen ("Session expired"); action
  handlers must explicitly trigger that path or display their own session error.

### Browser cache

uhttpd sends no `Cache-Control` header for static files, and the packaged files carry a reproducible-build
modification time (often 1970). A browser may then reuse a file it has for a very long time (months, even years) without asking the router, so after an
upgrade it keeps showing the old pages. `core/freshness.js` (called once per page load by `core/app.js`, after sign-in)
removes that problem:

- the router's `flab.system build` returns `id`, a hash of every file's path, size, modification time and status-change
  time under `/www/flab`, and `files`, the list of those files;
- the browser compares `id` with the one in `localStorage` (`flab.build`). When it differs, every file is requested
  again with `cache: 'reload'`, which replaces the cached copy, the new `id` is stored and, unless this is the first
  run in this browser, the page reloads so the new code runs. A failed download leaves the stored `id`, so the next
  start retries; a router that cannot answer leaves the page as it is.

The status-change time moves whenever a file is written, so every install, upgrade and `-Action Sync` is noticed
even when the size and modification time do not change. Code cached before this check existed cannot run it: after
upgrading from such a version, reload once with Ctrl+F5.

## Page contract

Every page is a plain object, default-exported from its module (full text in `js/pages/index.js`):

| Member | Required | Meaning |
|---|---|---|
| `id` | yes | Route name / URL hash |
| `label` | yes | Navigation text (`title` optionally overrides the command-bar heading) |
| `icon` | yes | Name from `core/icons.js` |
| `nav` | no | `'bottom'` puts the link below the spacer, next to Sign out (System settings); default is the main list |
| `interval` | yes | Auto-refresh period in ms, or a function that returns it (read again before each poll: a page whose views poll at different rates can use it) |
| `load()` | yes | Async; returns the page data, usually one ubus call |
| `view(data, rerender)` | yes | Returns an array of DOM nodes |
| `controls({ rerender, reload })` | no | Returns `{ nodes, update?(data) }`; controls persist across refreshes |
| `isPaused()` | no | Return true to suspend auto-refresh |
| `css` | no | Stylesheet (or array of stylesheets) loaded on first visit |

`aliases` (exported next to `pages`) maps a route that was a page once to the page that replaced it (`bridges` → `interfaces`); `core/app.js` replaces the hash, so a bookmark keeps working. An entry of `pages` may also have `activate(module)`, which the shell calls after the page module is imported (Toolbox uses it for `openTool`).

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
  (inline text), `GRADE_KIND` (badge kind of the A+ to D security grades). See
  [UI conventions](#ui-conventions) for `button` and the other shared looks.
- **`fold.js`**: `disclosure()`, `foldable()` with `chevron()`, and `reveal()`; see [UI conventions](#ui-conventions).
- **`controls.js`**: `searchControl`, `selectControl`, `tabsControl`, `pauseControl`, `toggleControl`, `refreshControl`
  bind to a page's `state` object.
- **`format.js`**: `fmtBytes`, `fmtBps`, `fmtLine` (bytes per second as Mbit/s), `fmtDur`, `fmtSpan`,
  `fmtNum`, `fmtRate`, `ipNum`. `ip.js` (`parseAddress()`, IPv4 and IPv6 as BigInt) is for comparing addresses.
- **`forms.js`, `fields.js`, `ops.js`, `editpage.js`**: what the editing pages share (field rows, option
  checks, the review banner, the draft/save/discard logic); see
  [Configuration changes](architecture.md#configuration-changes).
- **`modal.js`, `drawer.js`**: `openDialog()` (a native `<dialog>` in Bootstrap's modal markup) and `openDrawer()` (a
  side panel that leaves the page usable beside it, closed by Escape or a route change); each header lists the options.
  `clipboard.js` has `copyText()` and `copyButton()`; `download.js` has `saveFile()`; `qr.js` draws a QR code as inline SVG (`qrBox()`), importing the vendored encoder only when the first code is shown.
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
  An optional fourth argument supplies `timeoutMs`: native/UCI requests are capped at five seconds, plugin requests
  at 27 seconds, including response-body reads. Backend error details from nonzero ubus results are included in the
  exception with a bounded length. Mutating requests are not retried automatically.
- **`uci.js`**: the only code that calls rpcd's `uci` object, see [Configuration changes](architecture.md#configuration-changes).
  `applyChange()` runs a whole change with its safety net; pages should call that, not the single steps.
- The session id and ACLs live in `sessionStorage`; browser session restoration may restore that storage. Login timeout
  is 900 s without RPC activity, not 900 s from sign-in. Polling keeps the session alive; Sign out clears local storage
  and attempts to destroy the router-side session.

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

## UI conventions

This is the one place that says how shared UI looks and behaves; the other docs and the page docs refer to it.

- **Buttons.** Build them with `button(label, iconName, onclick, cls = 'btn-fl', props = {})` from `core/ui.js`, not by hand.
  `cls` picks the variant (`btn-fl` neutral, `btn-brand` the primary action) and may add page classes; `props` sets other
  element properties (`title`, `disabled`, `ariaLabel`). An icon-only button (empty label) needs a `title` and an `ariaLabel`.
  Labels and headers are sentence case, American English.
- **Icon vocabulary.** A concept uses the same icon on every page (names are the `PATHS` keys of `core/icons.js`):

  | Concept | Icon |
  |---|---|
  | Remove or discard an item (with a text label) | `trash` |
  | Small icon-only remove-row button (with a title) | `x-lg` |
  | Add | `plus-lg` |
  | Save, confirm | `check2` |
  | Discard edits, revert | `arrow-counterclockwise` |
  | Refresh, reload | `arrow-clockwise` |
  | Edit | `pencil` |
  | Error (`note('bad')`, `healthBanner` level `bad`) | `x-circle` |
  | Warning | `exclamation-triangle` |
  | Security risk (a weak cipher, a risky service action) | `shield-exclamation` |
  | Info, notice | `info-circle` |
  | Success | `check-circle` |
  | Settings fold | `gear` |
  | Download, upload | `download`, `upload` |

  The navigation icons are in `pages/index.js`. A new icon is pasted into `PATHS` (see [Development](development.md)).
- **Checkboxes, radios and switches** are Bootstrap's `form-check-input` and are styled once in `css/base.css`: an unchecked box has the stronger `--fl-control-border` (the theme's `--bs-border-color` is the pale card stroke, which made an enabled box look disabled), a checked one the brand color, and only a disabled one is faded. A page does not restyle them, except for layout.
- **Folds.** A native `<details>` is always built with `disclosure({ cls, summary, summaryCls, body, open, onToggle })` from
  `core/fold.js`, never with `h('details')`: it draws one arrow before the summary content (right when closed, down when
  open) and styles the summary (`.fl-disclosure` in `css/base.css`, so any page can use it). `cls: 'fl-disclosure-bar ...'` makes the summary a
  padded group header (the groups of a settings card); a plain disclosure is an inline "show more". The page keeps what is
  open in its state and passes it back as `open`, with `onToggle(open)` to record the change. A card that folds down to its
  header uses `foldable(card, folded, onChange)` with `chevron()` in the header: the header is the toggle (mouse, Enter or
  Space) and a click on a control inside it does not toggle. `reveal(el)` opens every closed group and unfolds the card around a
  control, so a control with an error is never hidden. Pages add only container layout (borders, margins, body padding), never
  their own marker, arrow or cursor rules.
- **Notes and banners.** `note(kind, text)` from `core/forms.js` (kinds `bad`, `warn`, `ok`, `info`) for a line about a form or
  an action, `healthBanner(findings, okText)` for what needs attention on a page, `emptyState(text)` when a page has nothing to
  list, and `badge` kinds `success`, `warning`, `danger` and `info` for status pills.
- **Legends** and "how to read" notes sit at the top of the card or section they explain, so the key is read before the data.

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
  Routes tab cards; `static.js` and `static-model.js` embed static-route editing and a combined configured/kernel
  inventory in the same Routes view. The Toolbox page (`toolbox/`) is separate: `index.js` is the page and exports `openTool`, which the
  lookup answer's buttons use; `diag.js` is the form, job polling and the choice of result view, `diagviews.js`
  the ping, traceroute, DNS, check, comparison and certificate views, `diagmodel.js` the pure parts (the request a form may
  build, the parsers for the classic tools' output, the check's verdict), and the newer tools have a model and a view each
  (`iperfmodel.js`/`iperfview.js`, `dnstracemodel.js`/`dnstraceview.js`, `pathmodel.js`/`pathview.js`, `capturemodel.js`/`captureview.js`) plus `charts.js` and
  `tlsdiagram.js` for the pictures.
  The BGP tab is `bgp/`: `tab.js` composes the sections; `topology.js`, `peer.js`, `routes.js`,
  `announced.js` and `system.js` each export card builders that take the backend data; `util.js` holds the
  per-peer color helpers, AS-path chips and prefix sort key.
- **Pure models**: `firewall/model.js` (zone matrix) and `firewall/edit.js`, `validate.js`, `plan.js`, `view.js`, `check.js`, `describe.js` (the editor),
  `interfaces/boardmodel.js` (the network board), `interfaces/model.js`, `interfaces/checks.js`, `interfaces/panelmodel.js` and `interfaces/wizardmodel.js` (the network editor),
  `network/vlanmodel.js` (the VLAN editor), `routing/static-model.js` (the static routes), `wifi/model.js` and `wifi/channels.js`, `wireguard/model.js`, `wireguard/addr.js` and
  `wireguard/keys.js`, `traffic/settings-model.js`, `logs/entries.js` (log filtering and formatting), `settings/model.js` and `dhcp/model.js` (validation and the
  UCI change plan) and `core/fields.js` (field checks)
  have no DOM access and are unit-tested on their own.
