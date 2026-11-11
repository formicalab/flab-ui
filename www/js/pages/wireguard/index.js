// WireGuard page (route #wireguard): every WireGuard interface and its peers, from the flab.wireguard plugin
// (UCI network + `wg show`). Interfaces and peers are rediscovered on every poll, so a new one appears
// without a reload. Private and pre-shared keys never leave the router.
import { tile, tiles, emptyState, healthBanner } from '../../core/ui.js';
import { ubus } from '../../core/ubus.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { fmtLine, fmtSpan } from '../../core/format.js';
import { interfaceCard, findings, recordWireguard, rateNow } from './iface.js';

// Only the paused flag; the page has no filters, so nothing else needs to survive the redraw on every poll.
const state = { paused: false };

// Summary tiles over the enabled peers of all interfaces; traffic is the sum of the live rx and tx rates.
function summary(list) {
  const peers = list.flatMap(i => i.peers.filter(p => p.enabled).map(p => ({ i, p })));
  const connected = peers.filter(({ p }) => p.state === 'connected');
  const ages = peers.map(({ p }) => p.handshake_age).filter(a => a != null);
  const sum = dir => peers.reduce((t, { i, p }) => t + (rateNow(i, p, dir) ?? 0), 0);
  return tiles(
    tile('Interfaces up', `${list.filter(i => i.up).length} / ${list.length}`, list.map(i => i.name).join(', ') || 'none', list.every(i => i.up || !i.enabled) ? 'text-success' : 'text-warning'),
    tile('Peers connected', `${connected.length} / ${peers.length}`, 'handshake within 3 minutes', connected.length ? 'text-success' : peers.length ? 'text-warning' : ''),
    tile('Latest handshake', ages.length ? `${fmtSpan(Math.min(...ages))} ago` : '–', ages.length ? 'most recent peer contact' : 'no peer has connected'),
    tile('Traffic now', fmtLine(sum('rx') + sum('tx')), `↓ ${fmtLine(sum('rx'))}  ↑ ${fmtLine(sum('tx'))}`));
}

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'wireguard',
  label: 'WireGuard',
  title: 'WireGuard · VPN',
  icon: 'key',
  interval: 5000,
  css: 'css/wireguard.css',
  isPaused: () => state.paused,

  // Peer counters are fed to the rate tracker before rendering.
  load: async () => {
    const data = await ubus('flab.wireguard', 'status');
    recordWireguard(data);
    return data;
  },

  controls({ reload }) {
    return { nodes: [pauseControl(state), refreshControl(reload)] };
  },

  view(data) {
    const list = data.interfaces;
    if (!list.length) return [emptyState('No WireGuard interface is configured. Add a network interface with protocol "wireguard" and it appears here.')];
    return [
      summary(list),
      healthBanner(list.flatMap(findings), 'All WireGuard interfaces and peers look healthy.'),
      ...list.map(interfaceCard),
    ];
  },
};
