// BGP tab of the Routing page: composition of the BGP sections.
//
// Data comes from one ubus call, flab.bgp status (see rpcd/ucode/flab.bgp.uc), and everything shown is
// derived from it on every poll, so peers, routes and announcements that come and go are reflected on the
// next refresh without any page-side configuration. The BIRD configuration file comes from flab.bgp config and is
// read only. Each section is a card builder in a sibling module:
//   topology.js     router -> peers -> remote AS diagram
//   system.js       health findings, protocol list, daemon and memory cards (the daemon cards and the protocol list come first)
//   peer.js         one card per peer (session, capabilities, channels, its part of the configuration, actions)
//   routes.js       learned routes table (filter, peer selector, best-only, sort); a prefix opens routedetail.js
//   announced.js    announcement matrix and export-filter results; the small table of a protocol's own routes (direct, static)
//                   that system.js draws under the protocol's row
//   config.js       the configuration file card and the peer's section of it; configmodel.js reads and reviews the file
//   actions.js      restart, enable, disable and route refresh of one peer, each after a confirmation
//   routedetail.js  the drawer that explains BIRD's choice among the routes of a prefix; routemodel.js has the reasoning
// The page (../index.js) owns the view state this tab uses: the routes filter text (q), the selected peer
// ('all' or a protocol name), best-paths-only, the routes table sort, whether every path is drawn (bgpAll), and what the
// configuration card remembers (folded, scroll, selected block, the last check, the open source folds of the peers).

import { h } from '../../../core/dom.js';
import { optional, ubus } from '../../../core/ubus.js';
import { tile, tiles, emptyState } from '../../../core/ui.js';
import { fmtNum, fmtSpan } from '../../../core/format.js';
import { isUp } from './util.js';
import { topologyCard } from './topology.js';
import { peerCard } from './peer.js';
import { routesCard } from './routes.js';
import { announcedCard } from './announced.js';
import { healthCard, protocolsCard, daemonCard, memoryCard } from './system.js';
import { configCard } from './config.js';

// Reads the BIRD state (flab.bgp status) and the configuration file (flab.bgp config, absent from an older package, in
// which case the page simply has no configuration card).
export async function loadBgp() {
  const [status, config] = await Promise.all([ubus('flab.bgp', 'status'), optional(ubus('flab.bgp', 'config'))]);
  return { ...status, config };
}

// The options of the peer selector for the peers in `data`.
export const peerOptions = data => [['all', 'All peers'], ...data.peers.map(p => [p.name, p.name])];

/**
 * Builds the row of summary tiles at the top of the tab.
 *
 * Counts are taken from the status data: `paths` holds every BGP path, `kernel_paths` is the number of
 * equal-cost next hops installed in the kernel for the path's prefix, and `in_kernel` tells whether the
 * path's own next hop is installed. "Kernel sync" is only healthy when every best path is installed.
 *
 * @param {object} data Result of flab.bgp status.
 * @returns {HTMLElement} The tile row.
 */
function summary(data) {
  const up = data.peers.filter(isUp).length;
  const prefixes = new Set(data.paths.map(p => p.prefix));
  const best = data.paths.filter(p => p.best);
  const multipath = best.filter(p => p.kernel_paths > 1).length;
  const missing = best.filter(p => !p.in_kernel).length;
  const announced = new Set(data.peers.flatMap(p => p.exported.map(e => e.prefix))).size;
  const d = data.daemon;

  return tiles(
    tile('BGP sessions', `${up} / ${data.peers.length}`, up === data.peers.length ? 'all established' : `${data.peers.length - up} not established`, up === data.peers.length ? 'text-success' : 'text-danger'),
    tile('Prefixes learned', fmtNum(prefixes.size), `${fmtNum(data.paths.length)} paths from ${data.peers.length} peers`),
    tile('Prefixes announced', fmtNum(announced), `to ${up} established peer${up === 1 ? '' : 's'}`),
    tile('Multipath (ECMP)', `${multipath} / ${best.length}`, 'best routes load-shared', multipath === best.length && best.length ? 'text-success' : ''),
    tile('Kernel sync', missing ? `${missing} missing` : 'In sync', `${fmtNum(d.routes)} routes in BIRD`, missing ? 'text-danger' : 'text-success'),
    tile('BIRD', d.version ?? '?', `up ${d.uptime ? fmtSpan(d.uptime) : '–'}`));
}

// The nodes of the tab. `state` is the page's view state; `rerender` redraws from the cached data (used by the
// routes table for sorting). When BIRD is not running the backend returns daemon.running = false and only an
// explanatory message is shown, with the configuration file below it.
export function bgpView(data, state, rerender) {
  if (!data.daemon.running) {
    // The file is shown when BIRD is down too: it is the first place to look for the reason.
    return [emptyState(`BIRD is not running or its control socket is unreachable${data.daemon.error ? ': ' + data.daemon.error : '.'}`), configCard(data, state, rerender)].filter(Boolean);
  }
  return [
    summary(data),
    h('div', { className: 'row g-3' },
      h('div', { className: 'col-12 col-xl-5' }, daemonCard(data)),
      h('div', { className: 'col-12 col-xl-7' }, memoryCard(data))),
    configCard(data, state, rerender),
    protocolsCard(data, state, rerender),
    h('div', { className: 'row g-3' },
      h('div', { className: 'col-12 col-xxl-8' }, topologyCard(data)),
      h('div', { className: 'col-12 col-xxl-4' }, healthCard(data))),
    h('div', { className: 'bgp-grid' }, data.peers.map(p => peerCard(p, data, { state }))),
    routesCard(data, state, rerender),
    announcedCard(data),
  ].filter(Boolean);
}
