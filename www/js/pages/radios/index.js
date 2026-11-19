// The Wi-Fi radios page (route #radios): the radios as hardware, with everything that runs on them, to read and to change: one card per radio with its state,
// hardware, live figures (channel, width, TX power, noise floor, antennas), the channel utilization, the channel picker, its wireless networks (access points,
// client networks and 802.11s mesh points, each with what it is doing now and its settings: networks.js) and the radio's own settings (card.js). The objects
// edited here (the radios and their wifi-iface sections) are the ones the Devices and Interfaces board shows; the connected clients are on its Connected devices
// tab. Data comes from the flab.radio plugin: `status` for the radios, `config` for the editable wireless configuration (which leaves out every secret), and from
// flab.mesh for the peers, paths and parameters of the mesh points; counters (airtime, bytes) are turned into rates here, so the cards follow channel changes,
// DFS events and interfaces coming and going. The draft, the review banner and Save are the editor of wifi/editor.js.
import { ubus, optional } from '../../core/ubus.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { note } from '../../core/forms.js';
import { tile, tiles } from '../../core/ui.js';
import { editor } from '../wifi/editor.js';
import { reveal } from '../../core/fold.js';
import { readWifi } from '../wifi/model.js';
import { airtime, recordRadios } from './parts.js';
import { recordMesh } from './mesh.js';
import { radioCards } from './card.js';

// The paused flag lives at module level so it survives the redraw on every poll.
const state = { paused: false };

// KPI tiles, the totals no single card shows: radios up, clients on the access points, the mesh peers (when the router has a mesh point) and the busiest channel.
function summary(radios, mesh) {
  const up = radios.filter(r => r.up).length;
  const clients = radios.flatMap(r => r.interfaces).filter(i => i.mode !== 'mesh').reduce((n, i) => n + (i.clients ?? 0), 0);
  const busiest = radios.map(r => ({ r, busy: airtime(r).busyNow })).filter(x => x.busy != null).sort((a, b) => b.busy - a.busy)[0];
  const nodes = mesh?.nodes ?? [];
  const peers = nodes.flatMap(n => n.peers ?? []);
  const estab = peers.filter(p => p.plink === 'ESTAB');
  const signals = estab.map(p => p.signal_avg ?? p.signal).filter(s => s != null);
  return tiles(
    tile('Radios up', `${up} / ${radios.length}`, '', up < radios.length ? 'text-warning' : 'text-success'),
    tile('Clients', clients, 'on access points'),
    nodes.length ? tile('Mesh peers', `${estab.length} / ${peers.length}`, signals.length ? `weakest link ${Math.min(...signals)} dBm` : 'no established link', estab.length ? 'text-success' : 'text-warning') : null,
    tile('Busiest channel', busiest ? `${Math.round(busiest.busy)} %` : '–', busiest ? `${busiest.r.name} · channel ${busiest.r.live?.channel ?? '?'}` : 'measuring…', busiest?.busy >= 70 ? 'text-warning' : ''));
}

// Page object registered in pages/index.js (contract documented there).
export default {
  interval: 5000,
  css: ['css/forms.css', 'css/radios.css', 'css/wifi.css'],

  // The radio hardware, the wireless configuration and the mesh points are fetched together; all are optional, so the page says what is missing (flab.radio not
  // installed, or too old to report its configuration, which leaves the radios read only). The wired status is only asked for when a mesh point exists, for the
  // spanning-tree role of its port. Counters go to the rate trackers before rendering.
  load: async () => {
    const [hw, cfg, mesh] = await Promise.all([optional(ubus('flab.radio', 'status')), optional(ubus('flab.radio', 'config')), optional(ubus('flab.mesh', 'status'))]);
    const net = mesh?.nodes?.length ? await optional(ubus('flab.network', 'status')) : null;
    recordRadios(hw);
    if (mesh) recordMesh(mesh);
    return editor.withStaged({ hw, mesh, net, wifi: readWifi(hw, cfg, mesh) });
  },
  isPaused: () => state.paused || editor.paused('.rd-grid') || Boolean(document.querySelector('.rd-pick:hover')),

  controls({ reload }) {
    return { nodes: [pauseControl(state), refreshControl(reload), editor.attach(reload)] };
  },

  // Summary tiles, then one card per radio. The editors of the cards edit the draft; they are read-only for a login that may not write, and absent when
  // the plugin cannot report the configuration.
  view(data, rerender) {
    if (!data.hw?.radios?.length) return [note('info', 'The Wi-Fi plugin (flab.radio) is not available on this router, or it reports no radio.')];
    const canEdit = editor.begin(data.wifi, rerender) && data.wifi.editable;
    const edit = { canEdit, wifi: data.wifi, draft: editor.state.draft, inputs: {}, sync: () => {}, touched: () => {}, redraw: () => editor.redraw() };
    edit.sync = () => editor.markErrors(edit.inputs, canEdit, reveal);
    edit.touched = editor.touched(edit);

    // The cards register their controls in `edit.inputs`, so they are built before the errors are marked.
    const cards = radioCards(data.hw, edit, data.mesh, data.net);
    edit.sync();
    const unreadable = !data.wifi.editable
      ? note('info', 'The Wi-Fi plugin on this router cannot report the wireless configuration (flab.radio config), so the radios and their networks cannot be changed here. Install the current flab-ui package and reload rpcd.') : null;
    return [summary(data.hw.radios, data.mesh), ...editor.notes(data), unreadable, ...cards].filter(Boolean);
  },
};
