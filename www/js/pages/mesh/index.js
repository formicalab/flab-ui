// Mesh page (route #mesh): the 802.11s mesh interfaces and what they hear: for each interface its
// configuration, the peers (link state, signal, bit rates, expected throughput, airtime metric, retries,
// live traffic) and the mesh paths, plus where the mesh port sits in the bridge's spanning tree. Everything
// comes from the flab.mesh plugin (mac80211) and is rediscovered on every poll, so peers, paths and
// interfaces that appear or vanish are reflected without a reload.
import { tile, tiles, emptyState, healthBanner } from '../../core/ui.js';
import { ubus } from '../../core/ubus.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { fmtNum } from '../../core/format.js';
import { nodeCard, recordMesh, findings } from './node.js';

const state = { paused: false };

// A missing plugin or ACL must not break the page.
const optional = promise => promise.catch(() => null);

function summary(nodes) {
  const peers = nodes.flatMap(n => n.peers ?? []);
  const estab = peers.filter(p => p.plink === 'ESTAB');
  const signals = estab.map(p => p.signal_avg ?? p.signal).filter(s => s != null);
  const paths = nodes.flatMap(n => n.paths ?? []);
  return tiles(
    tile('Mesh interfaces', nodes.length, nodes.map(n => n.mesh_id).filter(Boolean).join(', ') || 'none'),
    tile('Peers established', `${estab.length} / ${peers.length}`, peers.length ? 'peer links in state ESTAB' : 'no peers heard', estab.length ? 'text-success' : peers.length ? 'text-warning' : ''),
    tile('Weakest link', signals.length ? `${Math.min(...signals)} dBm` : '–', signals.length ? 'average signal of the weakest peer' : ''),
    tile('Mesh paths', fmtNum(paths.length), `${paths.filter(p => p.flags.includes('resolved')).length} resolved`),
    tile('Forwarding', nodes.length ? (nodes.every(n => n.params?.mesh_fwding === '1') ? 'On' : 'Off') : '–', 'frames relayed through this node'));
}

export default {
  id: 'mesh',
  label: 'Mesh',
  title: 'Mesh · 802.11s',
  icon: 'arrow-left-right',
  interval: 5000,
  css: 'css/mesh.css',
  isPaused: () => state.paused,

  load: async () => {
    const [mesh, net] = await Promise.all([ubus('flab.mesh', 'status'), optional(ubus('flab.network', 'status'))]);
    recordMesh(mesh);
    return { mesh, net };
  },

  controls({ reload }) {
    return { nodes: [pauseControl(state), refreshControl(reload)] };
  },

  view({ mesh, net }) {
    const nodes = mesh.nodes;
    if (!nodes.length) return [emptyState('No 802.11s mesh interface is configured. Add a wireless interface in mode "mesh" and it appears here.')];
    return [
      summary(nodes),
      healthBanner(nodes.flatMap(findings), 'All mesh links look healthy.'),
      ...nodes.map(n => nodeCard(n, net)),
    ];
  },
};
