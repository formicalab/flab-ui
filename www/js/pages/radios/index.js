// The Wi-Fi radios page (route #radios): the radios as hardware, to read and to change: one card per radio with its state, hardware, live figures (channel,
// width, TX power, noise floor, antennas), the channel utilization, the configuration next to what is running, the channel picker and the radio's settings
// (card.js). The wireless networks (SSIDs) of the radios are on the Wi-Fi page; the connected clients on the Connected devices tab of Devices and
// Interfaces. Data comes from the flab.radio plugin: `status` for the radios, `config` for the editable wireless configuration (which leaves out every
// secret); counters (airtime, bytes) are turned into rates here, so the cards follow channel changes, DFS events and interfaces coming and going. The draft,
// the review banner and Save are the editor shared with the Wi-Fi page (wifi/editor.js), so edits survive a visit to the other page.
import { h } from '../../core/dom.js';
import { ubus, optional } from '../../core/ubus.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { note } from '../../core/forms.js';
import { tile, tiles } from '../../core/ui.js';
import { editor } from '../wifi/editor.js';
import { revealControl } from '../wifi/editors.js';
import { readWifi } from '../wifi/model.js';
import { airtime, bandOf, recordRadios } from './parts.js';
import { radioCards } from './card.js';

// The paused flag lives at module level so it survives the redraw on every poll.
const state = { paused: false };

// KPI tiles: radios up, wireless interfaces, clients on the access points and the busiest channel.
function summary(radios) {
  const up = radios.filter(r => r.up).length;
  const ifs = radios.flatMap(r => r.interfaces);
  const clients = ifs.filter(i => i.mode !== 'mesh').reduce((n, i) => n + (i.clients ?? 0), 0);
  const busiest = radios.map(r => ({ r, busy: airtime(r).busyNow })).filter(x => x.busy != null).sort((a, b) => b.busy - a.busy)[0];
  return tiles(
    tile('Radios up', `${up} / ${radios.length}`, radios.map(bandOf).join(', '), up < radios.length ? 'text-warning' : 'text-success'),
    tile('Wireless interfaces', ifs.length, `${ifs.filter(i => i.mode === 'mesh').length} mesh`),
    tile('Clients', clients, 'on access points'),
    tile('Busiest channel', busiest ? `${Math.round(busiest.busy)} %` : '–', busiest ? `${busiest.r.name} · channel ${busiest.r.live?.channel ?? '?'}` : 'measuring…', busiest?.busy >= 70 ? 'text-warning' : ''));
}

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'radios',
  label: 'Wi-Fi radios',
  title: 'Wi-Fi radios',
  icon: 'broadcast',
  interval: 5000,
  css: ['css/forms.css', 'css/radios.css', 'css/wifi.css'],

  // The radio hardware and the wireless configuration are fetched together; both are optional, so the page says what is missing (flab.radio not
  // installed, or too old to report its configuration, which leaves the radios read only). Counters go to the rate tracker before rendering.
  load: async () => {
    const [hw, cfg] = await Promise.all([optional(ubus('flab.radio', 'status')), optional(ubus('flab.radio', 'config'))]);
    recordRadios(hw);
    return editor.withStaged({ hw, wifi: readWifi(hw, cfg) });
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
    edit.sync = () => editor.markErrors(edit.inputs, canEdit, revealControl);
    edit.touched = editor.touched(edit);

    // The cards register their controls in `edit.inputs`, so they are built before the errors are marked.
    const cards = radioCards(data.hw, edit);
    edit.sync();
    const unreadable = !data.wifi.editable
      ? note('info', 'The Wi-Fi plugin on this router cannot report the wireless configuration (flab.radio config), so the radios cannot be changed here. Install the current flab-ui package and reload rpcd.') : null;
    return [summary(data.hw.radios), ...editor.notes(data), unreadable, ...cards,
      h('p', { className: 'muted small' }, 'The wireless networks (SSIDs) of the radios are on the ', h('a', { href: '#wifi' }, 'Wi-Fi page'), '.')].filter(Boolean);
  },
};
