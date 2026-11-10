// Page registry. The order here is the order of the navigation pane; the first page is the default.
//
// To add a page:
//   1. Create js/pages/<name>.js (or a js/pages/<name>/ folder) that default-exports a page object.
//   2. Import it below and add it to the list.
//   3. If it needs server-side data, add rpcd/ucode/flab.<name>.uc plus rpcd/acl.d/flab-<name>.json;
//      deploy.ps1 installs every file in those folders automatically.
//
// Page contract (all members except the first five are optional):
//   id        route name, used as the URL hash (#id)
//   label     navigation text            title?  command-bar heading (defaults to label)
//   icon      icon name from core/icons.js
//   interval  auto-refresh period in ms
//   load()    async; returns the page data (usually one ubus call)
//   view(data, rerender)  returns an array of nodes; rerender() redraws from cached data
//   controls({ rerender, reload })  returns { nodes, update?(data) } for persistent command-bar controls
//   isPaused()  return true to suspend auto-refresh
//   css       stylesheet loaded the first time the page opens

import overview from './overview/index.js';
import wifi from './wifi.js';
import ipsec from './ipsec/index.js';
import network from './network.js';
import services from './services.js';

export const pages = [overview, wifi, ipsec, network, services];
