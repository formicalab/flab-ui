// Devices and Interfaces page (route #interfaces): how the network is layered, one row per netifd
// interface from the physical ports up (see layers.js and table.js). Everything shown is resolved from
// the flab.network devices and netifd's interface dump on every poll.
import { tile, tiles, healthBanner } from '../../core/ui.js';
import { ubus, optional } from '../../core/ubus.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { interfacesCard } from './table.js';
import { buildLayers } from './layers.js';
import { loadWired } from '../network/shared.js';

// Module-level so the Pause button state survives the redraw on every poll.
const state = { paused: false };

// The layers model for the current poll; `radios` may be empty when the wireless layer is unavailable.
const layersOf = (net, ifs, radios) => buildLayers(net, ifs, net.tunlinks ?? {}, radios);

// KPI tiles over the logical interfaces (orphan wireless rows are not interfaces and are excluded).
// "Tunnels" counts interfaces without a device of their own below them.
function summary(net, ifs, radios) {
  const rows = layersOf(net, ifs, radios).filter(r => !r.orphan);
  const up = rows.filter(r => r.up).length;
  // Number of rows matching a predicate.
  const count = fn => rows.filter(fn).length;
  const wl = radios.flatMap(r => r.interfaces ?? []);
  const mesh = wl.filter(w => w.mode === 'mesh').length;
  return tiles(
    tile('Interfaces up', `${up} / ${rows.length}`, rows.length - up ? `${rows.length - up} down or pending` : 'all configured interfaces', rows.length - up ? 'text-warning' : 'text-success'),
    tile('Bridges', net.bridges.length, 'devices grouping ports'),
    tile('VLAN devices', net.vlans.length, net.vlans.map(v => v.name).join(', ') || 'none'),
    tile('Protocol devices', count(r => r.protoDevice && !r.protoDevice.shared), 'PPPoE sessions and tunnels'),
    tile('Tunnels', count(r => !r.iface.device), 'interfaces with a device of their own'),
    tile('Radios', `${radios.filter(r => r.up).length} / ${radios.length}`, radios.map(r => r.band).filter(Boolean).join(', ') || 'none'),
    tile('Wireless interfaces', wl.length, `${wl.length - mesh} Wi-Fi, ${mesh} mesh`));
}

// Interfaces that are down or still pending deserve a line; so do wireless interfaces nothing uses.
function findings(net, ifs, radios) {
  return layersOf(net, ifs, radios).flatMap(r => {
    if (r.orphan) return r.roots[0].kind === 'radio' ? [] : [{ level: 'warn', text: `Wireless interface ${r.name} (radio ${r.roots[0].radio}) is not attached to any network interface.` }];
    return r.up ? [] : [{
      level: r.iface.pending ? 'warn' : 'bad',
      text: `Interface ${r.name} (${r.proto}) is ${r.iface.pending ? 'pending' : 'down'}.`,
    }];
  });
}

export default {
  id: 'interfaces',
  label: 'Devices and Interfaces',
  title: 'Devices and Interfaces',
  icon: 'diagram-3',
  interval: 5000,
  css: 'css/interfaces.css',
  isPaused: () => state.paused,

  // The flab.radio call is optional: without it the page works with the wired layers only.
  load: async () => {
    const [wired, hw] = await Promise.all([loadWired(), optional(ubus('flab.radio', 'status'))]);
    return { ...wired, radios: hw?.radios ?? [] };
  },

  controls({ reload }) {
    return { nodes: [pauseControl(state), refreshControl(reload)] };
  },

  // Summary tiles, the findings banner and the layers table.
  view({ net, ifs, radios }) {
    return [
      summary(net, ifs, radios),
      healthBanner(findings(net, ifs, radios), 'All interfaces are up.'),
      interfacesCard(ifs, net, net.tunlinks ?? {}, radios),
    ];
  },
};
