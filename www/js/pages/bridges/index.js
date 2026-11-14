// Bridges page (route #bridges): every bridge with its spanning-tree position, settings, VLAN devices and
// members (Ethernet ports and Wi-Fi interfaces) with link, STP state and role, learned MACs and live
// throughput, and below each bridge the editor of its configuration (ports, spanning tree, VLAN filtering, multicast, MAC address, MTU)
// and the means to add a bridge. Bridges come from the flab.network status, so a new or removed bridge shows up on the next
// poll; netifd's interface dump only supplies the L3 addresses shown on each bridge. The editing cards, the draft and the saving are
// shared with the Devices and Interfaces page (interfaces/editor.js, cards.js, model.js).
import { h } from '../../core/dom.js';
import { tile, tiles, emptyState, healthBanner } from '../../core/ui.js';
import { ubus, optional } from '../../core/ubus.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { fmtNum } from '../../core/format.js';
import { bridgeCard, meshByIface } from './card.js';
import { addressesByDevice } from '../network/shared.js';
import { bridgeFindings } from '../network/util.js';
import { editContext, editNotes, editor, loadNetworkEdit, safetyNote } from '../interfaces/editor.js';
import { addDeviceBar, deviceCard } from '../interfaces/cards.js';
import { deviceList } from '../interfaces/model.js';

// Module-level so the Pause button state survives the redraw on every poll.
const state = { paused: false };

// The shell's redraw and reload functions, handed over by controls().
const shell = { rerender: () => {}, reload: () => {} };

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
  css: ['css/forms.css', 'css/bridges.css', 'css/netedit.css'],
  // No polling over unsaved edits, a focused control of the form or a save in progress.
  isPaused: () => state.paused || editor.paused('.ne-form'),

  // The wired data and the editable config, plus the mesh interfaces (optional: without the plugin, mesh ports are shown as plain Wi-Fi).
  load: async () => {
    const [data, mesh] = await Promise.all([loadNetworkEdit(), optional(ubus('flab.mesh', 'status'))]);
    return { ...data, mesh };
  },

  controls({ rerender, reload }) {
    shell.rerender = rerender;
    shell.reload = reload;
    return { nodes: [pauseControl(state), refreshControl(reload), editor.attach(reload)] };
  },

  // Summary tiles, the findings banner and one card per bridge, each followed by the editor of its configuration.
  view(data, rerender) {
    shell.rerender = rerender;
    const { net, ifs, mesh } = data;
    const addrs = addressesByDevice(ifs);
    const byIface = meshByIface(mesh);
    const ctx = editContext(data, rerender, shell);
    // The configuration card of a bridge, in the editor's container; null without an editor.
    const config = d => h('div', { className: 'ne-form' }, deviceCard(ctx, d));
    const bridges = ctx ? deviceList(ctx.base, ctx.draft).filter(d => d.type === 'bridge') : [];
    const shown = new Set();
    const cards = net.bridges.flatMap(b => {
      const own = bridges.filter(d => d.name === b.name);
      own.forEach(d => shown.add(d.id));
      return [bridgeCard(b, addrs.get(b.name) ?? [], byIface), ...own.map(config)];
    });
    // Bridges that are configured (or added in the form) but not running have no runtime card.
    const idle = bridges.filter(d => !shown.has(d.id)).map(config);
    const page = [
      summary(net),
      healthBanner(bridgeFindings(net), 'All bridges look healthy.'),
      ...editNotes(data),
      ...(net.bridges.length ? cards : [emptyState('No bridges are configured.')]),
      ...idle,
    ];
    if (ctx) {
      page.push(h('div', { className: 'ne-form' },
        addDeviceBar(ctx, ['bridge'], 'A bridge joins ports (and the Wi-Fi networks that name it) into one Layer 2 network. Give a new bridge an interface on the Devices and Interfaces page to address it.'),
        safetyNote()));
      ctx.sync();
    }
    return page;
  },
};
