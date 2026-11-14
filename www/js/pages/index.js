// Page registry. The order here is the order of the navigation pane; the first page is the default.
//
// To add a page:
//   1. Create js/pages/<name>.js (or a js/pages/<name>/ folder) that default-exports a page object.
//   2. Import it below and add it to the list.
//   3. If it needs server-side data that rpcd's own objects (uci, system, service, ...) do not give, add
//      rpcd/ucode/flab.<name>.uc; deploy.ps1 installs every file in that folder automatically.
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

import overview from './overview/index.js';
import network from './network/index.js';
import wifi from './wifi/index.js';
import mesh from './mesh/index.js';
import ipsec from './ipsec/index.js';
import wireguard from './wireguard/index.js';
import firewall from './firewall/index.js';
import dhcp from './dhcp/index.js';
import dns from './dns/index.js';
import ddns from './ddns/index.js';
import interfaces from './interfaces/index.js';
import routing from './routing/index.js';
import traffic from './traffic/index.js';
import services from './services.js';
import toolbox from './toolbox/index.js';
import logs from './logs/index.js';
import settings from './settings/index.js';

// Network pages go from the physical layer up (ports, radios, tunnels, firewall); DHCP and router
// advertisements, a service on top of those, come next, then DNS, the resolver those clients use, and Dynamic DNS, which keeps
// a name pointing at the router; Devices and Interfaces (the network board: ports, bridges, VLANs, interfaces and zones, and where bridges are
// edited) ties them together, followed by routing (the kernel's routes and BGP), traffic (where the bandwidth goes), the services, the toolbox
// (diagnostic tools) and the logs.
// System settings is the only other page that changes the router; it sits at the bottom of the navigation, by Sign out.
export const pages = [overview, network, wifi, mesh, ipsec, wireguard, firewall, dhcp, dns, ddns, interfaces, routing, traffic, services, toolbox, logs, settings];

// Routes that were pages once and now open another page: #bridges is part of the Devices and Interfaces board.
export const aliases = { bridges: 'interfaces' };
