// The controls that edit the WireGuard configuration: the settings form of an interface (with its write-only private key and the
// key generator), the editor of a peer (with its write-only pre-shared key), and the confirmation asked before a change that may cut the
// administrator's own tunnel. The option tables are in schema.js and the rules in model.js; the controls themselves come from
// core/forms.js, so they look and behave like the other editing pages.
import { h } from '../../core/dom.js';
import { copyButton } from '../../core/clipboard.js';
import { disclosure } from '../../core/fold.js';
import { openDialog } from '../../core/modal.js';
import { button } from '../../core/ui.js';
import { fieldRow } from '../../core/forms.js';
import { generateKeyPair, generatePresharedKey, isKey, keySupport, publicKeyOf } from './keys.js';
import { IFACE_FIELDS, PEER_FIELDS } from './schema.js';

//#region State that survives a redraw

// Which interface settings panels and peer editors are open: `if:<id>` and `peer:<interface id>:<peer id>`. A new interface and a new
// peer start open.
export const opened = new Set();

//#endregion

//#region Controls

// Connects the control of one field to the draft, under the control name `id` (also used to mark errors).
function control(ctx, f, id, values) {
  return fieldRow(f, {
    id,
    get: () => values[f.key],
    set: v => { values[f.key] = v; },
    disabled: !ctx.canEdit,
    touched: ctx.touched,
    redraw: ctx.redraw,
    register: (el, index) => { if (index == null) ctx.inputs[id] = el; else (ctx.inputs[id] ??= [])[index] = el; },
  });
}

// The line under a key box that shows the public key of the private key typed or generated (it is worked out in the browser and
// never leaves it). Empty when the text is not a key.
function derivedKey(values) {
  const out = h('div', { className: 'wg-derived small' });
  const text = values.private_key.trim();
  if (isKey(text)) {
    publicKeyOf(text).then(pub => out.replaceChildren(
      h('span', { className: 'muted' }, 'The public key that goes with this private key: '), h('span', { className: 'mono wg-key' }, pub), ' ', copyButton(pub)))
      .catch(() => {});
  }
  return out;
}

// The key box with its "generate" button. `make()` returns the new value (async); `label` is the button text. The browser's ability to
// make keys is checked when the control is drawn: without it the button is disabled and the page says to paste a key.
function keyControl(ctx, f, id, values, stored, label, make) {
  const field = { ...f, placeholder: stored ? 'stored; leave empty to keep it' : 'not set' };
  const message = h('div', { className: 'wg-key-message small muted' });
  const generate = button(label, 'key', async () => {
    try {
      values[f.key] = await make();
      ctx.touched();
      ctx.redraw();
    } catch (e) {
      message.textContent = e.message;
    }
  }, 'btn-fl', { disabled: !ctx.canEdit });
  keySupport().then(support => {
    if (support) return;
    generate.disabled = true;
    message.textContent = 'This browser cannot make keys (it needs a secure connection and a secure random number generator), so paste a key made with wg genkey.';
  });
  return h('div', { className: 'set-field wg-keyfield' }, control(ctx, field, id, values), h('div', { className: 'wg-key-actions' }, generate, message),
    f.key === 'private_key' ? derivedKey(values) : null);
}

//#endregion

//#region Interface settings

// The options of a section that the option tables do not describe, read only: any option the page has no control for (ip6prefix, tunlink,
// metric...). A key is not among them; the plugin leaves it out.
function otherOptions(values, fields, skip = []) {
  const known = new Set([...fields.map(f => f.key), ...skip]);
  const rows = Object.entries(values).filter(([k]) => !known.has(k)).map(([k, v]) => [k, [].concat(v).join(' ')]);
  if (!rows.length) return null;
  return h('div', { className: 'wg-extra' },
    h('p', { className: 'muted small' }, 'Other options of this section in /etc/config/network. This page has no control for them; change them in the file or on the Devices and Interfaces page.'),
    h('dl', { className: 'kv' }, rows.flatMap(([k, v]) => [h('dt', { className: 'mono' }, k), h('dd', { className: 'mono' }, v)])));
}

// The name control of an interface that is not saved yet.
function nameControl(ctx, item) {
  const added = ctx.draft.added.find(a => a.id === item.id);
  const input = h('input', { className: 'form-control form-control-sm', value: added.name, placeholder: 'wg0', spellcheck: false, autocomplete: 'off', disabled: !ctx.canEdit,
    oninput: e => { added.name = e.target.value; ctx.touched(); } });
  ctx.inputs[`if:${item.id}:name`] = input;
  return h('div', { className: 'set-field' }, h('label', { className: 'form-label' }, 'Interface name'), input,
    h('div', { className: 'muted small set-hint' }, 'The name of the interface in /etc/config/network and of the network device. Letters, digits and underscores, at most 15; it cannot be changed once saved.'));
}

// The settings form of one interface, in a panel that opens and closes (new interfaces start open).
export function interfaceForm(ctx, item) {
  const d = ctx.draft.interfaces[item.id];
  const key = `if:${item.id}`;
  const stored = Boolean(item.data?.secrets.private_key);
  const fields = IFACE_FIELDS.filter(f => !f.secret).map(f => control(ctx, f, `${key}:${f.key}`, d.values));
  const privateKey = IFACE_FIELDS.find(f => f.secret);
  if (item.isNew) opened.add(key);
  return disclosure({
    cls: 'fl-disclosure-bar wg-panel', summary: 'Interface settings', open: opened.has(key),
    onToggle: open => { if (open) opened.add(key); else opened.delete(key); },
    body: h('div', { className: 'wg-panel-body' },
      item.isNew ? nameControl(ctx, item) : null,
      keyControl(ctx, privateKey, `${key}:private_key`, d.values, stored, stored ? 'Replace with a new key' : 'Generate a key', async () => (await generateKeyPair()).privateKey),
      h('div', { className: 'set-fields' }, fields),
      item.data ? otherOptions(item.data.values, IFACE_FIELDS, ['proto']) : null),
  });
}

//#endregion

//#region Peers

// The editor of one peer, a table row that spans the table: every option of the peer, the write-only pre-shared key with a generator.
export function peerEditor(ctx, item, pe, colSpan) {
  const v = ctx.draft.interfaces[item.id].peers[pe.id];
  const id = `peer:${item.id}:${pe.id}`;
  const psk = PEER_FIELDS.find(f => f.secret);
  const fields = PEER_FIELDS.filter(f => !f.secret).map(f => control(ctx, f, `${id}:${f.key}`, v));
  return h('tr', { className: 'wg-peer-edit' }, h('td', { colSpan },
    h('div', { className: 'wg-peer-form' },
      h('div', { className: 'set-fields' }, fields),
      keyControl(ctx, psk, `${id}:preshared_key`, v, Boolean(pe.p?.secrets.preshared_key), pe.p?.secrets.preshared_key ? 'Replace with a new key' : 'Generate a key', async () => generatePresharedKey()),
      pe.p ? otherOptions(pe.p.values, PEER_FIELDS) : null)));
}

//#endregion

//#region Confirmation

// Asks before a change that is likely to cut the administrator's own connection. `paragraphs` are the texts, `confirmLabel` the
// button that goes ahead; resolves to whether the user went ahead. Nothing is saved either way: this only decides whether the edit
// enters the form.
export function confirmDanger({ title, paragraphs, confirmLabel }) {
  return new Promise(resolve => {
    let answer = false;
    const dialog = openDialog({
      title,
      body: h('div', {}, paragraphs.map(p => h('p', {}, p))),
      footer: [
        button('Cancel', 'x-lg', () => dialog.close()),
        button(confirmLabel, 'trash', () => { answer = true; dialog.close(); }, 'btn-danger'),
      ],
      onClose: () => resolve(answer),
    });
  });
}

//#endregion
