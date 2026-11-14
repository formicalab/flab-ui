// Devices and Interfaces page (route #interfaces): how the network is layered, one row per netifd
// interface from the physical ports up (see layers.js and table.js), and the editor for the logical interfaces and the devices under them (the
// VLAN devices and the settings of ports; bridges are edited on the Bridges page). Everything shown is resolved from the flab.network devices,
// the plugin's network config (without secrets) and netifd's interface dump on every poll. The editing cards, the draft and the saving are
// shared with the Bridges page (editor.js, cards.js, model.js).
import { h } from '../../core/dom.js';
import { tile, tiles, healthBanner } from '../../core/ui.js';
import { ubus, optional } from '../../core/ubus.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { interfacesCard } from './table.js';
import { buildLayers } from './layers.js';
import { editContext, editNotes, editor, loadNetworkEdit, safetyNote } from './editor.js';
import { addDeviceBar, addInterfaceBar, deviceCards, editSection, interfaceCards } from './cards.js';

// Module-level so the Pause button state survives the redraw on every poll.
const state = { paused: false };

// The shell's redraw and reload functions, handed over by controls().
const shell = { rerender: () => {}, reload: () => {} };

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
  css: ['css/forms.css', 'css/interfaces.css', 'css/netedit.css'],
  // No polling over unsaved edits, a focused control of the form or a save in progress.
  isPaused: () => state.paused || editor.paused('.ne-form'),

  // The flab.radio call is optional: without it the page works with the wired layers only; so is the editable config.
  load: async () => {
    const [data, hw] = await Promise.all([loadNetworkEdit(), optional(ubus('flab.radio', 'status'))]);
    return { ...data, radios: hw?.radios ?? [] };
  },

  controls({ rerender, reload }) {
    shell.rerender = rerender;
    shell.reload = reload;
    return { nodes: [pauseControl(state), refreshControl(reload), editor.attach(reload)] };
  },

  // Summary tiles, the findings banner, the layers table and the editing cards.
  view(data, rerender) {
    shell.rerender = rerender;
    const { net, ifs, radios } = data;
    const page = [
      summary(net, ifs, radios),
      healthBanner(findings(net, ifs, radios), 'All interfaces are up.'),
      interfacesCard(ifs, net, net.tunlinks ?? {}, radios),
      ...editNotes(data),
    ];
    const ctx = editContext(data, rerender, shell);
    if (ctx) {
      page.push(h('div', { className: 'ne-form' },
        editSection('Interfaces', 'Each logical interface binds a protocol and its addresses to a device. Open a card to change it; nothing is saved until you press "Save and apply". Interfaces whose protocol this page does not edit (WireGuard, IPsec, modems, tunnels) are shown read only.',
          ...interfaceCards(ctx), addInterfaceBar(ctx)),
        editSection('Devices', 'VLAN devices, and the settings of ports and other devices (MTU, MAC address, link speed, ...). Bridges and their ports are on the Bridges page.',
          ...deviceCards(ctx, d => d.type !== 'bridge'), addDeviceBar(ctx, ['8021q', 'plain'], 'A VLAN device carries the frames of one VLAN tag of a port or bridge. Device settings configure a port or device that already exists.')),
        safetyNote()));
      ctx.sync();
    }
    return page;
  },
};
