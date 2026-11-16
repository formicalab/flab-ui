// The radio cards of the Wi-Fi radios page: one card per radio with its state, key figures (channel, width, TX power, noise floor, antennas, clients),
// findings, the configuration next to what is actually running, the channel utilization and the allowed channels (a picker to change the channel, see
// wifi/picker.js), and the radio's settings (wifi/editors.js radioSettings). The wireless networks (SSIDs) of the radio are on the Wi-Fi page. Data comes
// from the flab.radio plugin; the display parts are in parts.js.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { channelPicker } from '../wifi/picker.js';
import { editable } from '../wifi/channels.js';
import { radioSettings } from '../wifi/editors.js';
import { findings, header, hero, airtimeBlock, configBlock, channelStrip } from './parts.js';

// One card per radio: header, live figures, findings, configuration and airtime/channels, then (when the configuration can be edited) the radio's
// settings. With `edit` (see wifi/picker.js) the channels are a picker the draft is edited through; without it, a plain strip.
function radioCard(r, reg, edit) {
  const list = findings(r, reg);
  const channels = edit?.canEdit && editable(r) ? channelPicker(r, edit) : channelStrip(r);
  const editing = Boolean(edit?.wifi?.editable);
  return h('div', { className: `card rd-card ${r.up ? 'is-up' : 'is-down'}` },
    header(r),
    hero(r),
    list.length ? h('ul', { className: 'rd-find' }, list.map(f => h('li', { className: f.level }, icon(f.level === 'bad' ? 'shield-exclamation' : f.level === 'warn' ? 'exclamation-triangle' : 'info-circle'), f.text))) : null,
    h('div', { className: 'rd-cols' }, h('div', {}, h('h3', {}, 'Configuration'), configBlock(r, reg)), h('div', {}, airtimeBlock(r), channels)),
    editing ? radioSettings(r.name, edit) : null);
}

// The cards of every radio of the flab.radio status `hw`; an empty list when the plugin is not available. Mesh interfaces are shown as a link to the
// Mesh page, and the interfaces count in the key figures is the access points'. `edit` is passed on to every card.
export function radioCards(hw, edit) {
  if (!hw?.radios?.length) return [];
  const radios = hw.radios.map(r => ({ ...r, interfaces: r.interfaces.filter(i => i.mode !== 'mesh'), mesh: r.interfaces.filter(i => i.mode === 'mesh') }));
  return [h('div', { className: 'rd-grid' }, radios.map(r => radioCard(r, hw.regdomain, edit)))];
}
