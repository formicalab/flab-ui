// BGP page: entry point and composition of the sections.
//
// Data comes from one ubus call, flab.bgp status (see rpcd/ucode/flab.bgp.uc), and everything shown is
// derived from it on every poll, so peers, routes and announcements that come and go are reflected on the
// next refresh without any page-side configuration. Each section is a card builder in a sibling module:
//   topology.js   router -> peers -> remote AS diagram
//   system.js     health findings, protocol list, daemon and memory cards
//   peer.js       one card per peer (session, capabilities, channels)
//   routes.js     learned routes table (filter, peer selector, best-only, sort)
//   announced.js  announcement matrix, export-filter results, local routes

import { h } from '../../core/dom.js';
import { ubus } from '../../core/ubus.js';
import { tile, tiles, emptyState } from '../../core/ui.js';
import { searchControl, selectControl, pauseControl, refreshControl, toggleControl } from '../../core/controls.js';
import { fmtNum, fmtSpan } from '../../core/format.js';
import { isUp } from './util.js';
import { topologyCard } from './topology.js';
import { peerCard } from './peer.js';
import { routesCard } from './routes.js';
import { announcedCard, localCard } from './announced.js';
import { healthCard, protocolsCard, daemonCard, memoryCard } from './system.js';

// View state that must survive the auto-refresh redraws: the routes filter text (q), the selected peer
// ('all' or a protocol name), best-paths-only, the routes table sort, and the paused flag.
const state = { q: '', peer: 'all', best: false, sort: { key: 'prefix', dir: 1 }, paused: false };

/**
 * Builds the row of summary tiles at the top of the page.
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

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'bgp',
  label: 'BGP',
  title: 'BGP · BIRD',
  icon: 'globe2',
  interval: 5000,
  css: 'css/bgp.css',
  isPaused: () => state.paused,

  load: () => ubus('flab.bgp', 'status'),

  // Command-bar controls are created once per visit; `update` runs after every load so the peer dropdown
  // follows peers that appear or disappear (the selection falls back to "All peers" if its peer is gone).
  controls({ rerender, reload }) {
    const peer = selectControl(state, 'peer', rerender, 'Peer');
    return {
      nodes: [searchControl(state, 'q', rerender, 'Filter routes…'), peer.node,
        toggleControl(state, 'best', ['Best paths only', 'All paths'], rerender), pauseControl(state), refreshControl(reload)],
      update: data => peer.setOptions([['all', 'All peers'], ...data.peers.map(p => [p.name, p.name])]),
    };
  },

  // `rerender` redraws from the cached data (used by the routes table for sorting); when BIRD is not
  // running the backend returns daemon.running = false and only an explanatory message is shown.
  view(data, rerender) {
    if (!data.daemon.running) {
      return [emptyState(`BIRD is not running or its control socket is unreachable${data.daemon.error ? ': ' + data.daemon.error : '.'}`)];
    }
    return [
      summary(data),
      h('div', { className: 'row g-3' },
        h('div', { className: 'col-12 col-xxl-8' }, topologyCard(data)),
        h('div', { className: 'col-12 col-xxl-4' }, healthCard(data))),
      h('div', { className: 'bgp-grid' }, data.peers.map(p => peerCard(p, data))),
      routesCard(data, state, rerender),
      h('div', { className: 'row g-3' },
        h('div', { className: 'col-12 col-xl-7' }, announcedCard(data)),
        h('div', { className: 'col-12 col-xl-5' }, localCard(data))),
      protocolsCard(data),
      h('div', { className: 'row g-3' },
        h('div', { className: 'col-12 col-xl-5' }, daemonCard(data)),
        h('div', { className: 'col-12 col-xl-7' }, memoryCard(data))),
    ];
  },
};
