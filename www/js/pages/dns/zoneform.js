// The dialog that adds or edits one zone: Unbound's `config zone` block (type, domains, servers and the settings that type uses,
// as in the OpenWrt Unbound README) or one dnsmasq `server` entry. The form works on a copy and validates as the user types; "Add
// to the changes" puts it into the draft, and the review banner at the top of the page saves everything at once.
import { h } from '../../core/dom.js';
import { openDialog } from '../../core/modal.js';
import { button } from '../../core/ui.js';
import { fieldRow, note } from '../../core/forms.js';
import { ZONE_TYPES } from './schema.js';
import { fieldsOf, formFor, formProblems, typeLabel } from './zones.js';

// The fields of the dnsmasq form (a server entry: domains, what to do with them, and the server).
const DNSMASQ_FIELDS = {
  zones: { key: 'zones', type: 'list', label: 'Domains', addLabel: 'Add domain', placeholder: 'e.g. example.com, or . for every name', hint: 'The domains this entry applies to; "." makes it the default forwarder.' },
  server: { key: 'server', type: 'string', label: 'Server', placeholder: 'e.g. 192.0.2.53 or 192.0.2.53#5353', hint: 'The address of the server, optionally with #port.' },
};
const MODES = { forward: 'Forward to a server', local: 'Answer locally only', default: 'Use the default servers' };

// A label, a plain drop-down (no "default" choice) and a hint.
function choice(label, hint, options, value, onChange, extra = {}) {
  const select = h('select', { className: 'form-select form-select-sm', disabled: extra.disabled ?? false, onchange: e => onChange(e.target.value) },
    Object.entries(options).map(([v, text]) => h('option', { value: v }, text)));
  select.value = value;
  return h('div', { className: `set-field${extra.full ? ' full' : ''}` }, h('label', { className: 'form-label' }, label), select, hint ? h('div', { className: 'muted small set-hint' }, hint) : null);
}

// Opens the dialog for the zone `key` of the draft (null: a new zone). `data` is what the router reports, `getDraft()` the draft
// as it is when the dialog needs it (other zones decide which domains are free), `onSave(form)` receives the form when the user
// accepts it, and `onClose()` runs when the dialog is gone.
export function openZoneDialog({ data, getDraft, key, onSave, onClose }) {
  const unbound = data.configured === 'unbound';
  const isNew = key == null;
  const form = formFor(data, getDraft(), key);
  const inputs = {};
  let touchedOnce = false;
  let dialog = null;

  const errorsBox = h('div', { className: 'set-notes' });
  const save = button(isNew ? 'Add to the changes' : 'Update the changes', 'check2', () => { onSave(form); dialog.close(); }, 'btn-brand');
  const cancel = button('Cancel', null, () => dialog.close());

  // Checks the form: the buttons follow, and the messages and the marked inputs show once the user has started typing.
  function validate() {
    const found = formProblems(data, getDraft(), key, form);
    save.disabled = found.length > 0;
    for (const el of Object.values(inputs).flat()) el?.classList.remove('is-invalid');
    errorsBox.replaceChildren(...(touchedOnce ? found.map(e => note('bad', e.text)) : []));
    if (touchedOnce) {
      for (const e of found) {
        const el = inputs[e.key];
        (Array.isArray(el) ? el[e.index] : el)?.classList.add('is-invalid');
      }
    }
  }
  // Called after every edit: from then on the problems are shown, and the form is revalidated.
  const touched = () => { touchedOnce = true; validate(); };

  // The connection of one field to the form.
  const io = f => ({
    id: `zone-${f.key}`, get: () => form[f.key], set: v => { form[f.key] = v; }, disabled: false, touched, redraw: () => render(),
    register: (el, i) => { if (i == null) inputs[f.key] = el; else (inputs[f.key] ??= [])[i] = el; },
  });
  // A field's control, wide when it is a list.
  const control = f => {
    const node = fieldRow(f, io(f));
    if (f.type === 'list') node.classList.add('full');
    return node;
  };

  // The body for the current form.
  function bodyNodes() {
    for (const k of Object.keys(inputs)) delete inputs[k];
    if (!unbound) {
      return [
        h('p', { className: 'muted small dns-area-legend' }, 'An entry of the server list of dnsmasq in /etc/config/dhcp: it sends the queries for its domains to one server, answers them locally, or leaves them to the default servers.'),
        h('div', { className: 'set-fields' },
          control(DNSMASQ_FIELDS.zones),
          choice('What dnsmasq does', 'Forward the queries to the server below, answer them from local data only (never forward), or use the default servers for them. A default forwarder (the domain ".") always forwards.', MODES, form.mode, v => { form.mode = v; touched(); render(); }),
          form.mode === 'forward' ? control(DNSMASQ_FIELDS.server) : null),
      ];
    }
    const type = form.zone_type;
    const kind = ZONE_TYPES[type];
    const fields = fieldsOf(type).filter(f => f.key !== 'zone_type');
    return [
      h('p', { className: 'muted small dns-area-legend' }, isNew ? 'A block of /etc/config/unbound that holds the servers and settings for any number of domains.' : `The block ${key} of /etc/config/unbound. ${kind?.words ?? ''}`),
      !isNew && form.zone_name.length > 1 ? note('info', `This zone applies to ${form.zone_name.length} domains: a change to its servers or settings applies to all of them.`) : null,
      h('div', { className: 'set-fields' },
        isNew
          ? choice('Type', kind?.words, Object.fromEntries(Object.entries(ZONE_TYPES).map(([k, t]) => [k, `${t.label} zone`])), type, v => { form.zone_type = v; touched(); render(); }, { full: true })
          : h('div', { className: 'set-field full' }, h('div', { className: 'form-label' }, 'Type'), h('div', {}, `${typeLabel(type)} zone`)),
        fields.map(control)),
    ];
  }

  // Draws the body again (the type or a list changed the shape of the form), then checks it.
  function render() {
    shown.setBody(h('div', {}, ...bodyNodes().filter(Boolean)));
    validate();
  }

  // The dialog belongs to this page: leaving it (the back button, another tab or page) closes the dialog.
  const leave = () => shown.close();
  addEventListener('hashchange', leave);
  const shown = openDialog({
    title: isNew ? 'Add a zone' : `Edit zone ${unbound ? key : ''}`.trim(),
    subtitle: unbound ? 'Unbound' : 'dnsmasq',
    size: 'lg',
    staticBackdrop: true,
    body: h('div', {}),
    footer: [errorsBox, cancel, save],
    onClose: () => { removeEventListener('hashchange', leave); onClose?.(); },
  });
  dialog = shown.dialog;
  // The errors take a row of their own above the buttons.
  errorsBox.style.flex = '1 0 100%';
  render();
  return shown;
}
