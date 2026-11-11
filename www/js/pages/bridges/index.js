// Bridges page (route #bridges): every bridge with its spanning-tree position, settings, VLAN devices and
// members (Ethernet ports and Wi-Fi interfaces) with link, STP state and role, learned MACs and live
// throughput. Bridges come from the flab.network status, so a new or removed bridge shows up on the next
// poll; netifd's interface dump only supplies the L3 addresses shown on each bridge.
import { tile, tiles, emptyState, healthBanner } from '../../core/ui.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { fmtNum } from '../../core/format.js';
import { bridgeCard } from './card.js';
import { loadWired, addressesByDevice } from '../network/shared.js';
import { bridgeFindings } from '../network/util.js';

// Module-level so the Pause button state survives the redraw on every poll.
const state = { paused: false };

// KPI tiles. The spanning-tree tile names the first bridge that is not the root, since that is the one
// whose path to the root is worth seeing.
function summary(net) {
  const stp = net.bridges.filter(b => b.stp);
  const notRoot = stp.find(b => !b.is_root);
  const members = net.bridges.flatMap(b => b.members);
  const macs = net.bridges.reduce((n, b) => n + b.macs, 0);
  return tiles(
    tile('Bridges', net.bridges.length, net.bridges.map(b => b.name).join(', ') || 'none'),
    tile('Spanning tree', stp.length ? (notRoot ? 'Not root' : 'Root') : 'Off', notRoot ? `${notRoot.name} via ${notRoot.root_port_name ?? notRoot.root_port} (cost ${notRoot.root_path_cost})` : `${stp.length} / ${net.bridges.length} bridges`),
    tile('Member ports up', `${members.filter(m => m.carrier).length} / ${members.length}`, `${members.filter(m => m.kind === 'wifi').length} Wi-Fi · ${members.filter(m => m.kind === 'ethernet').length} Ethernet`),
    tile('Learned MACs', fmtNum(macs), 'in the bridge tables'));
}

export default {
  id: 'bridges',
  label: 'Bridges',
  title: 'Bridges',
  icon: 'diagram-2',
  interval: 3000,
  css: 'css/bridges.css',
  isPaused: () => state.paused,

  load: loadWired,

  controls({ reload }) {
    return { nodes: [pauseControl(state), refreshControl(reload)] };
  },

  // Summary tiles, the findings banner and one card per bridge.
  view({ net, ifs }) {
    const addrs = addressesByDevice(ifs);
    return [
      summary(net),
      healthBanner(bridgeFindings(net), 'All bridges look healthy.'),
      ...(net.bridges.length ? net.bridges.map(b => bridgeCard(b, addrs.get(b.name) ?? [])) : [emptyState('No bridges are configured.')]),
    ];
  },
};
