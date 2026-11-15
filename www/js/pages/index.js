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
//   label     navigation text            title?  command-bar heading (defaults to label)
//   icon      icon name from core/icons.js
//   nav       'bottom' places the link below the spacer, next to Sign out (default: the main list)
//   interval  auto-refresh period in ms
//   load()    async; returns the page data (usually one ubus call)
//   view(data, rerender)  returns an array of nodes; rerender() redraws from cached data
//   controls({ rerender, reload })  returns { nodes, update?(data) } for persistent command-bar controls
//   isPaused()  return true to suspend auto-refresh
//   css       stylesheet (or array of stylesheets) loaded the first time the page opens

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

// Network pages go from the physical layer up (ports, radios, tunnels, firewall); DHCP and router
// advertisements, a service on top of those, come next, then DNS, the resolver those clients use, and Dynamic DNS, which keeps
// a name pointing at the router; Devices and Interfaces (the network board: ports, bridges, VLANs, interfaces and zones, and where bridges are
// edited) ties them together, followed by routing (kernel routes, static-route editing and BGP), traffic (where the bandwidth goes), the services, the toolbox
// (diagnostic tools) and the logs.
// System settings sits at the bottom of the navigation, by Sign out.
// Keep this module free of page imports, including Toolbox's openTool helper: the login screen only needs
// navigation metadata. Native ES modules cache successful imports and preserve each page's state on return.
export const pages = [
  { id: 'overview', label: 'Overview', icon: 'speedometer2', resolve: () => import('./overview/index.js') },
  { id: 'network', label: 'Wired network', icon: 'ethernet', resolve: () => import('./network/index.js') },
  { id: 'wifi', label: 'Wi-Fi', icon: 'wifi', resolve: () => import('./wifi/index.js') },
  { id: 'mesh', label: 'Mesh', icon: 'arrow-left-right', resolve: () => import('./mesh/index.js') },
  { id: 'ipsec', label: 'IPsec VPN', icon: 'shield-lock', resolve: () => import('./ipsec/index.js') },
  { id: 'wireguard', label: 'WireGuard', icon: 'key', resolve: () => import('./wireguard/index.js') },
  { id: 'firewall', label: 'Firewall', icon: 'shield-check', resolve: () => import('./firewall/index.js') },
  { id: 'dhcp', label: 'DHCP', icon: 'signpost-split', resolve: () => import('./dhcp/index.js') },
  { id: 'dns', label: 'DNS', icon: 'hdd-network', resolve: () => import('./dns/index.js') },
  { id: 'ddns', label: 'Dynamic DNS', icon: 'cloud', resolve: () => import('./ddns/index.js') },
  { id: 'interfaces', label: 'Devices and Interfaces', icon: 'diagram-3', resolve: () => import('./interfaces/index.js') },
  { id: 'routing', label: 'Routing', icon: 'globe2', resolve: () => import('./routing/index.js') },
  { id: 'traffic', label: 'Traffic', icon: 'activity', resolve: () => import('./traffic/index.js') },
  { id: 'services', label: 'Services', icon: 'hdd-stack', resolve: () => import('./services.js') },
  { id: 'toolbox', label: 'Toolbox', icon: 'tools', resolve: () => import('./toolbox/index.js'), activate: activateToolbox },
  { id: 'logs', label: 'Logs', icon: 'journal-text', resolve: () => import('./logs/index.js') },
  { id: 'settings', label: 'System settings', icon: 'gear', nav: 'bottom', resolve: () => import('./settings/index.js') },
];

// Routes that were pages once and now open another page: #bridges is part of the Devices and Interfaces board.
export const aliases = { bridges: 'interfaces' };
