// The editors of the Wi-Fi radios page: the settings of a radio and its wireless networks (access points, client networks and mesh points), built from the
// option tables in schema.js through core/forms.js and edited in place in the page's draft (see model.js). Nothing is saved here: every edit
// goes through `edit.touched()`, which refreshes the review banner, and saving is the page's.
//
// `edit` connects the editors to the page:
//   wifi       the model's data (readWifi)         draft     the form's draft
//   canEdit    whether the controls may be used     inputs    receives each control under its error key (see problems())
//   touched()  called after every edit              redraw()  redraws the page (after a change that adds or removes controls)
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, muted } from '../../core/ui.js';
import { fieldRow } from '../../core/forms.js';
import { disclosure } from '../../core/fold.js';
import { ENCRYPTIONS, IFACE_FIELDS, IFACE_GROUPS, RADIO_FIELDS, RADIO_GROUPS, encryptionLabel } from './schema.js';
import { addIface, encryptionOffered, ifaceCtx, ifaceList, ifaceTitle, isShown, radioCtx, removeIface, restoreIface } from './model.js';

//#region State and helpers

// Which blocks and groups are open, kept across redraws: id to open or closed. A group the page was not told about starts as its
// table says.
const opened = new Map();

// The options whose value changes which other controls are shown or what a control offers, so changing one redraws the page.
const RADIO_REDRAWS = new Set(['htmode', 'disabled']);
const IFACE_REDRAWS = new Set(['encryption', 'ieee80211r', 'macfilter', 'eap_type', 'time_advertisement']);

//#endregion

//#region Fields

// The generation each htmode prefix stands for, for the words of the drop-down.
const GENERATION = { HT: '802.11n', VHT: '802.11ac', HE: '802.11ax', EHT: '802.11be' };

// An htmode in words: "HE80 · 802.11ax, 80 MHz".
function htmodeWords(mode) {
  const m = /^(HT|VHT|HE|EHT)(\d+)([+-]?)$/.exec(mode);
  if (m) return `${mode} · ${GENERATION[m[1]]}, ${m[2]} MHz${m[3] === '+' ? ', second channel above' : m[3] === '-' ? ', second channel below' : ''}`;
  return mode === 'NOHT' ? 'NOHT · no 802.11n or later' : mode;
}

// The field `f` of a radio with its drop-down options filled in from what the radio and the router reported: the modes the hardware
// lists (and, on 2.4 GHz, the explicit HT40+ and HT40-), the countries the driver knows. When the hardware reported nothing the
// field is a text box that the model checks.
function radioField(w, r, f) {
  if (f.dynamic === 'htmodes') {
    const modes = r.htmodes.modes;
    if (!modes.length) return { ...f, type: 'string', placeholder: 'for example HE80' };
    const options = [...modes, ...(r.band === '2g' && modes.includes('HT40') ? ['HT40+', 'HT40-'] : []), 'NOHT'];
    return { ...f, options, labels: Object.fromEntries(options.map(m => [m, htmodeWords(m)])) };
  }
  if (f.dynamic === 'countries') {
    if (!w.countries.length) return { ...f, type: 'string', placeholder: 'for example DE' };
    return { ...f, options: w.countries.map(c => c.code), labels: Object.fromEntries(w.countries.map(c => [c.code, `${c.code} · ${c.name}`])) };
  }
  return f;
}

// The field `f` of a wireless network with the encryption choices this router's hostapd can do, and the placeholder of a secret
// saying whether one is stored. A mesh point is encrypted with SAE or not at all, and its hints say what is special about a mesh.
function ifaceField(w, i, v, f) {
  if (f.dynamic === 'encryptions') {
    if (i.mode === 'mesh') {
      const offered = ENCRYPTIONS.filter(e => e.value === 'sae' || (e.value === v.encryption && e.value !== 'none'));
      return { ...f, options: offered.map(e => e.value), labels: Object.fromEntries(offered.map(e => [e.value, e.label])),
        hint: 'WPA3-Personal (SAE) encrypts the mesh and keeps out any node that does not know the password; it needs a wpad with mesh support (wpad-mesh-* or the full wpad). An open mesh lets any device that uses the same Mesh ID and channel join it.' };
    }
    const offered = ENCRYPTIONS.filter(e => e.value !== 'none' && (encryptionOffered(w, e.value) || e.value === v.encryption));
    return { ...f, options: offered.map(e => e.value), labels: Object.fromEntries(offered.map(e => [e.value, e.label])) };
  }
  if (i.mode === 'mesh' && f.key === 'network') return { ...f, hint: 'The network interfaces (usually a bridge) the mesh point is bridged into, so the mesh carries their traffic. Spanning tree does not see a mesh: a second path between the same nodes, such as a cable, loops.' };
  if (f.secret) return { ...f, placeholder: i.secrets[f.key] ? 'stored; leave empty to keep it' : 'not set' };
  return f;
}

// Connects the control of one field to the draft values, under the error key `id`.
function control(edit, f, id, values, off, redraws) {
  return fieldRow(f, {
    id,
    get: () => values[f.key],
    set: v => { values[f.key] = v; if (redraws.has(f.key)) queueMicrotask(() => edit.redraw()); },
    disabled: !edit.canEdit || off,
    touched: edit.touched,
    redraw: edit.redraw,
    register: (el, index) => { if (index == null) edit.inputs[id] = el; else (edit.inputs[id] ??= [])[index] = el; },
  });
}

// The check boxes that choose which network interfaces a wireless network is attached to (a list field the generic controls do not
// cover). A network the config names that does not exist stays listed, marked, so it is not dropped by accident.
function networkControl(edit, f, id, values, off) {
  const list = values.network;
  const known = edit.wifi.networks;
  const names = [...known, ...list.filter(n => !known.includes(n))];
  const boxes = names.map(n => {
    const box = h('input', { className: 'form-check-input', type: 'checkbox', checked: list.includes(n), disabled: !edit.canEdit || off,
      onchange: e => {
        const at = list.indexOf(n);
        if (e.target.checked && at < 0) list.push(n);
        else if (!e.target.checked && at >= 0) list.splice(at, 1);
        edit.touched();
      } });
    return h('label', { className: 'form-check wf-net' }, box, h('span', {}, n, known.includes(n) ? null : badge('not in the network config', 'warning')));
  });
  const row = h('div', { className: 'wf-nets' }, boxes.length ? boxes : muted('The router has no network interfaces.'));
  edit.inputs[id] = row;
  return h('div', { className: 'set-field wide' }, h('label', { className: 'form-label' }, f.label), row, f.hint ? h('div', { className: 'muted small set-hint' }, f.hint) : null);
}

// One group of controls in a collapsible block, remembered open or closed under `id`; `extra` is a node shown full width under the controls.
function group(g, id, controls, extra) {
  return disclosure({ cls: 'fl-disclosure-bar wf-group', summary: g.title, open: opened.get(id) ?? Boolean(g.open), onToggle: open => opened.set(id, open),
    body: h('div', { className: 'wf-group-body' }, h('p', { className: 'muted small' }, g.legend), h('div', { className: 'set-fields' }, controls), extra) });
}

//#endregion

//#region Radio settings

// The "Radio settings" block of the radio card of `name`: the Radio group (whether the radio is on, its mode and width, country and power, and under them the
// channel: `channels` is the node the card built, the picker the draft is edited through or a plain strip when the login may not write; the mode decides which
// channels fit), and the rates and advanced options, in collapsible groups. The summary line shows the configured mode, country and power, the only place the card shows
// them besides the live figures.
export function radioSettings(name, edit, channels) {
  const w = edit.wifi;
  const r = w.radios.find(x => x.name === name);
  const d = edit.draft.radios[name];
  const ctx = radioCtx(r);
  const groups = RADIO_GROUPS.map(g => {
    const fields = RADIO_FIELDS.filter(f => f.group === g.id && isShown(f, d, ctx));
    return fields.length ? group(g, `radio:${name}:${g.id}`, fields.map(f => control(edit, radioField(w, r, f), `${name}:${f.key}`, d, false, RADIO_REDRAWS)), g.id === 'general' ? channels : null) : null;
  });
  const id = `radio:${name}`;
  return disclosure({ cls: 'wf-block', open: opened.get(id) ?? false, onToggle: open => opened.set(id, open),
    summary: [icon('gear'), h('strong', {}, 'Radio settings'), d.disabled ? badge('disabled', 'warning') : null,
      muted(`${d.htmode || 'default mode'} · ${d.country || 'default country'}${d.txpower ? ` · ${d.txpower} dBm` : ''}`)],
    body: h('div', { className: 'wf-block-body' }, identity(r), groups) });
}

// The read-only identification of a radio, as the file holds it (the driver type, the phy, the MAC address, the device path and the band, which are detected
// by themselves and should not be changed), or nothing when the file holds none of them.
function identity(r) {
  const rows = ['type', 'phy', 'radio', 'macaddr', 'path', 'band'].filter(k => r.values?.[k] != null && r.values[k] !== '').map(k => `${k} ${r.values[k]}`);
  return rows.length ? h('p', { className: 'muted small mono' }, `Identified by: ${rows.join(' · ')}. These are detected by themselves and are not edited here.`) : null;
}

//#endregion

//#region Wireless networks

// The words of the mode badge of a network.
export const MODE_BADGE = { ap: 'access point', sta: 'client', mesh: 'mesh' };

// The editor of one wireless network (`i`, an entry of ifaceList): a collapsible block with its settings in groups, a button to
// remove it (or to take the removal back), and its state in the summary. `live` is what the page knows about the running interface,
// { badges, body }: badges for the summary line (clients, peers) and a node shown above the settings (what the interface is doing now).
function ifaceEditor(i, edit, live) {
  const w = edit.wifi;
  const v = edit.draft.ifaces[i.id];
  const ctx = ifaceCtx(w, i, v);
  const off = i.removed;
  const title = ifaceTitle(i, v);
  const groups = IFACE_GROUPS.map(g => {
    const fields = IFACE_FIELDS.filter(f => f.group === g.id && isShown(f, v, ctx));
    if (!fields.length) return null;
    const controls = fields.map(f => (f.key === 'network'
      ? networkControl(edit, ifaceField(w, i, v, f), `if:${i.id}:network`, v, off)
      : control(edit, ifaceField(w, i, v, f), `if:${i.id}:${f.key}`, v, off, IFACE_REDRAWS)));
    return g.id === 'basic' ? h('div', { className: 'set-fields wf-basic' }, controls) : group(g, `if:${i.id}:${g.id}`, controls);
  });
  const state = i.isNew ? badge('new', 'info', 'not saved yet') : i.removed ? badge('to be removed', 'danger')
    : v.disabled ? badge('disabled') : i.live ? (i.live.up ? badge('running', 'success') : badge('not running', 'danger')) : null;
  const what = i.mode === 'mesh' ? 'mesh point' : 'network';
  const actions = off
    ? h('div', { className: 'wf-actions' }, muted(`"${title}" is removed when you save.`), button('Undo', 'arrow-counterclockwise', () => { restoreIface(edit.draft, i.id); edit.touched(); edit.redraw(); }))
    : h('div', { className: 'wf-actions' },
      muted(i.isNew ? `Not saved yet. It is added as the section "${i.name}".` : `The wifi-iface section "${i.section}"${i.anonymous ? ' (unnamed)' : ''}.`),
      button(i.isNew ? `Discard ${what}` : `Remove ${what}`, 'trash', () => { removeIface(edit.draft, i.id); edit.touched(); edit.redraw(); }, 'btn-fl',
        { disabled: !edit.canEdit, title: `Remove the ${what} ${title}` }));
  const id = `if:${i.id}`;
  return disclosure({ cls: `wf-iface${i.isNew ? ' wf-new' : ''}`, open: opened.get(id) ?? i.isNew, onToggle: open => opened.set(id, open),
    summary: [icon(i.mode === 'mesh' ? 'diagram-2' : 'wifi'), h('strong', {}, title), badge(MODE_BADGE[i.mode] ?? i.mode),
      badge(encryptionLabel(v.encryption || 'none'), /^$|^none$/.test(v.encryption) ? 'danger' : ''), state, ...(live?.badges ?? [])],
    body: h('div', { className: `wf-iface-body${off ? ' wf-dim' : ''}` }, off ? null : live?.body, groups, actions) });
}

// The editors of the wireless networks of radio `name`, one block per network (`liveOf(i)` gives the live part of each, see ifaceEditor), and the
// buttons that add an access point, a client network or a mesh point to it. A network of another mode (ad hoc, monitor) is left alone.
export function networksEditor(name, edit, liveOf = () => null) {
  const w = edit.wifi;
  const mine = ifaceList(w, edit.draft).filter(i => i.device === name);
  const others = w.ifaces.filter(i => i.device === name && !i.editable);
  const add = (label, mode) => {
    return button(label, 'plus-lg', () => { opened.set(`if:${addIface(w, edit.draft, name, mode)}`, true); edit.touched(); edit.redraw(); }, 'btn-fl', { disabled: !edit.canEdit });
  };
  return h('div', { className: 'wf-nets-editor' },
    mine.length ? mine.map(i => ifaceEditor(i, edit, liveOf(i))) : muted('No access point, client network or mesh point is configured on this radio.'),
    others.length ? h('p', { className: 'muted small' }, `Not editable here: ${others.map(i => `${i.section} (${i.mode})`).join(', ')}.`) : null,
    h('div', { className: 'wf-addbar' }, add('Add access point', 'ap'), add('Add client network', 'sta'), add('Add mesh point', 'mesh'),
      h('span', { className: 'muted small' }, 'A client network makes this router join another network, as a repeater or an uplink does; a mesh point joins the 802.11s mesh of the other nodes.')));
}

//#endregion
