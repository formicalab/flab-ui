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

const state = { q: '', peer: 'all', best: false, sort: { key: 'prefix', dir: 1 }, paused: false };

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

export default {
  id: 'bgp',
  label: 'BGP',
  title: 'BGP · BIRD',
  icon: 'globe2',
  interval: 5000,
  css: 'css/bgp.css',
  isPaused: () => state.paused,

  load: () => ubus('flab.bgp', 'status'),

  controls({ rerender, reload }) {
    const peer = selectControl(state, 'peer', rerender, 'Peer');
    return {
      nodes: [searchControl(state, 'q', rerender, 'Filter routes…'), peer.node,
        toggleControl(state, 'best', ['Best paths only', 'All paths'], rerender), pauseControl(state), refreshControl(reload)],
      update: data => peer.setOptions([['all', 'All peers'], ...data.peers.map(p => [p.name, p.name])]),
    };
  },

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
