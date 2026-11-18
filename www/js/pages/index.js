// Page registry. The order here is the order of the navigation pane; the first page is the default.
//
// To add a page:
//   1. Create js/pages/<name>.js (or a js/pages/<name>/ folder) that default-exports a page object.
//   2. Add its navigation metadata and dynamic import below.
//   3. If it needs server-side data that rpcd's own objects (uci, system, service, ...) do not give, add
//      rpcd/ucode/flab.<name>.uc; the package installs every file in that folder automatically.
//
// Page contract (id, label, icon, interval, load and view are required; the rest is optional):
//   id        route name, used as the URL hash (#id)
//   label     navigation and command-bar text
//   title?    command-bar heading override
//   icon      icon name from core/icons.js
//   nav       'bottom' places the link below the spacer, next to Sign out; 'hidden' keeps a compatibility route without a link
//   interval  auto-refresh period in ms, or a function that returns it (read again before each poll, for a page whose views poll at different rates)
//   load()    async; returns the page data (usually one ubus call)
//   view(data, rerender)  returns an array of nodes; rerender() redraws from cached data
//   controls({ rerender, reload })  returns { nodes, update?(data) } for persistent command-bar controls
//   isPaused()  return true to suspend auto-refresh
//   css       stylesheet (or array of stylesheets) loaded the first time the page opens
//   activate?(module)  (an entry of `pages`, not of the page object) called by the shell once the page module is imported and the route is still current

let pendingTool = null;

// Lightweight deep-link bridge: importing this from another page must not fetch Toolbox's implementation.
export function openTool(tool, host) {
  pendingTool = { tool, host };
  location.hash = '#toolbox';
}

// Called by the shell only after the Toolbox import completes and this navigation is still current.
function activateToolbox(module) {
  if (!pendingTool) return;
  const { tool, host } = pendingTool;
  pendingTool = null;
  module.openTool(tool, host);
}

// Keep this module free of page imports, including Toolbox's openTool helper: the login screen only needs
// navigation metadata. Native ES modules cache successful imports and preserve each page's state on return.
export const basePages = [
  { id: 'overview', label: 'Overview', icon: 'speedometer2', resolve: () => import('./overview/index.js') },
  { id: 'settings', label: 'System settings', icon: 'gear', nav: 'bottom', resolve: () => import('./settings/index.js') },
];

// Builds the registry from validated installed-module manifests. A module controls its own feature directories and
// backend ACL/plugin, while the base package always keeps Overview and System settings available.
export function installedPages(manifests = []) {
  const ids = new Set(basePages.map(p => p.id));
  const installed = [];
  for (const manifest of manifests) {
    if (!manifest || !Array.isArray(manifest.entries)) continue;
    for (const entry of manifest.entries) {
      if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9-]+$/.test(entry.id)
        || typeof entry.label !== 'string' || typeof entry.icon !== 'string'
        || typeof entry.module !== 'string' || !entry.module.startsWith('./')
        || ids.has(entry.id) || !Number.isFinite(entry.order)) continue;
      ids.add(entry.id);
      installed.push({
        ...entry,
        resolve: () => import(entry.module),
        activate: entry.activation === 'toolbox' ? activateToolbox
          : entry.tab ? module => module.openTab?.(entry.tab)
          : undefined,
      });
    }
  }
  return [
    ...basePages.filter(p => p.nav !== 'bottom'),
    ...installed.sort((a, b) => a.order - b.order),
    ...basePages.filter(p => p.nav === 'bottom'),
  ];
}

// Compatibility export for code that imports the uninstalled registry before sign-in.
export const pages = basePages;

// Routes that were pages once and now open another page: #bridges is part of the Devices and Interfaces board, #wifi and #mesh are part of the Wi-Fi radios page.
export const aliases = { bridges: 'interfaces', wifi: 'radios', mesh: 'radios' };
