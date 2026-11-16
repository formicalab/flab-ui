// Wi-Fi page: the wireless networks (SSIDs) of every radio, from the flab.radio plugin: a card per radio with its networks (radios.js) and the editors of
// the networks (editors.js, whose options are in schema.js and whose rules, review list and UCI operations are in model.js). The radios themselves (their
// hardware, state, channel and settings) are on the Wi-Fi radios page (radios/), the connected clients on the Connected devices tab of Devices and
// Interfaces (connected/index.js). The draft and the review banner are shared with the radios page (editor.js).
import { ubus, optional } from '../../core/ubus.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { note } from '../../core/forms.js';
import { radiosSection } from './radios.js';
import { editor } from './editor.js';
import { recordRadios } from '../radios/parts.js';
import { revealControl } from './editors.js';
import { readWifi } from './model.js';

// The paused flag lives at module level so it survives the redraw on every poll.
const state = { paused: false };

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'wifi',
  label: 'Wi-Fi',
  title: 'Wi-Fi · networks',
  icon: 'wifi',
  interval: 5000,
  css: ['css/forms.css', 'css/radios.css', 'css/wifi.css'],

  // The radio hardware and the wireless configuration are fetched together; both are optional, so the page says what is missing (flab.radio not
  // installed, or too old to report its configuration, which leaves the networks read only). Counters go to the rate tracker before rendering.
  load: async () => {
    const [hw, cfg] = await Promise.all([optional(ubus('flab.radio', 'status')), optional(ubus('flab.radio', 'config'))]);
    recordRadios(hw);
    return editor.withStaged({ hw, wifi: readWifi(hw, cfg) });
  },
  isPaused: () => state.paused || editor.paused('.rd-grid'),

  controls({ reload }) {
    return { nodes: [pauseControl(state), refreshControl(reload), editor.attach(reload)] };
  },

  // One card per radio with its networks and their editors.
  view(data, rerender) {
    if (!data.hw?.radios?.length) return [note('info', 'The Wi-Fi plugin (flab.radio) is not available on this router, or it reports no radio.')];
    // The editors of the networks edit the draft; they are read-only for a login that may not write, and absent when the plugin cannot report
    // the configuration.
    const canEdit = editor.begin(data.wifi, rerender) && data.wifi.editable;
    const edit = { canEdit, wifi: data.wifi, draft: editor.state.draft, inputs: {}, sync: () => {}, touched: () => {}, redraw: () => editor.redraw() };
    edit.sync = () => editor.markErrors(edit.inputs, canEdit, revealControl);
    edit.touched = editor.touched(edit);

    // The cards register their controls in `edit.inputs`, so they are built before the errors are marked.
    const radioCards = radiosSection(data.hw, edit);
    edit.sync();
    const unreadable = !data.wifi.editable
      ? note('info', 'The Wi-Fi plugin on this router cannot report the wireless configuration (flab.radio config), so the wireless networks cannot be edited here. Install the current flab-ui package and reload rpcd.') : null;
    return [...editor.notes(data), unreadable, ...radioCards].filter(Boolean);
  },
};
