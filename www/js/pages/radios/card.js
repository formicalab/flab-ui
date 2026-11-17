// The radio card, top to bottom: header, live figures (with the configured channel, width and power), findings (the radio's and those of its mesh points),
// the channel utilization, the radio's own settings (wifi/editors.js radioSettings), which start with the channel (a picker the draft is edited through, see
// wifi/picker.js, or a plain strip for a login that may not write) and hold every other configured value of the radio, and last the wireless networks on the radio
// (access points, client networks and mesh points: networks.js). A router whose plugin cannot report the configuration gets the plain channel strip in the card.
// Data comes from the flab.radio plugin (and flab.mesh for the mesh points); the display parts are in parts.js.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { channelPicker } from '../wifi/picker.js';
import { editable } from '../wifi/channels.js';
import { radioSettings } from '../wifi/editors.js';
import { findings, header, hero, airtimeBlock, channelStrip, regulatoryNote } from './parts.js';
import { findings as meshFindings } from './mesh.js';
import { networksSection } from './networks.js';

// One card per radio. `edit` is the editor of the page: with the configuration available the channels (a picker, or a plain strip for a login that may not
// write) are the first group of the radio settings, like any other editable option; without it they are a plain strip in the card. `ctx` is
// { mesh: Map(section -> flab.mesh node), net }.
function radioCard(r, reg, edit, ctx) {
  const list = [...findings(r, reg), ...r.mesh.flatMap(m => (ctx.mesh.has(m.section) ? meshFindings(ctx.mesh.get(m.section)) : []))];
  const editing = Boolean(edit?.wifi?.editable);
  const channels = h('div', {}, edit?.canEdit && editable(r) ? channelPicker(r, edit) : channelStrip(r), regulatoryNote(reg));
  return h('div', { className: `card rd-card ${r.up ? 'is-up' : 'is-down'}` },
    header(r),
    hero(r),
    list.length ? h('ul', { className: 'rd-find' }, list.map(f => h('li', { className: f.level }, icon(f.level === 'bad' ? 'x-circle' : f.level === 'warn' ? 'exclamation-triangle' : 'info-circle'), f.text))) : null,
    h('div', { className: `rd-cols${editing ? ' rd-cols-1' : ''}` }, h('div', {}, airtimeBlock(r)), editing ? null : channels),
    editing ? radioSettings(r.name, edit, channels) : null,
    networksSection(r, edit, ctx));
}

// The radios of the flab.radio status `hw` with their interfaces split into the access points and client networks (`interfaces`, which the key figures
// count) and the mesh points (`mesh`).
const withMesh = hw => (hw?.radios ?? []).map(r => ({ ...r, interfaces: r.interfaces.filter(i => i.mode !== 'mesh'), mesh: r.interfaces.filter(i => i.mode === 'mesh') }));

// The cards of every radio of the flab.radio status `hw`; an empty list when the plugin is not available. `mesh` is the flab.mesh status (or null) and `net`
// the flab.network status (or null), for the live part of the mesh points. `edit` is passed on to every card.
export function radioCards(hw, edit, mesh, net) {
  if (!hw?.radios?.length) return [];
  const ctx = { mesh: new Map((mesh?.nodes ?? []).map(n => [n.section, n])), net };
  return [h('div', { className: 'rd-grid' }, withMesh(hw).map(r => radioCard(r, hw.regdomain, edit, ctx)))];
}
