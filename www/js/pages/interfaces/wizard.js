// The "New network" wizard of the Devices and Interfaces page: a dialog (core/modal.js) in three steps and a last page.
//   1  Where does it connect?    an existing device, a new VLAN device or a new bridge
//   2  How does it get its address?   the protocol cards
//   3  Details and name          the name, the address (a free private /24 is suggested), the PPPoE login, ...
// The wizard does not touch the draft while the user is choosing: each step shows what the draft WOULD be (wizardmodel.js previewChoice runs the model's
// own validation on a copy) and Finish applies the choice to the real draft once (applyChoice). Nothing is saved: the page's review banner and
// "Save and apply" do that. The last page lists what the flow does not do, with links to the pages that do.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, muted } from '../../core/ui.js';
import { note } from '../../core/forms.js';
import { openDialog } from '../../core/modal.js';
import { portOwners } from './model.js';
import { DEVICE_NAME_MAX, interfaceNameMax, suggestSubnet } from './panelmodel.js';
import {
  WHERE, applyChoice, bridgePortChoices, chooseVid, chooseVlanBase, defaultChoice, deviceNameOf, existingDevices, nameFor, notDone, previewChoice, stepErrors, summaryLines,
  vlanBases,
} from './wizardmodel.js';
import { optionList, protoCards, section } from './panelparts.js';

// How many wizards are open: the page must not replace its draft (a poll redraw) while one is, because the wizard adds to the draft it was opened on.
let openCount = 0;

// Whether a wizard dialog is open (the board keeps its polling paused meanwhile).
export const wizardOpen = () => openCount > 0;

// The names of the three steps, for the header.
const STEPS = ['Where does it connect?', 'How does it get its address?', 'Details and name'];

// Opens the wizard on the editing context `ctx` and calls `onDone({ iface, device })` with the draft ids it added when the user finishes. A context may offer
// `current()` returning the page's latest context (the page redraws on every poll and makes a new one); without it `ctx` is used as it is.
export function openWizard(ctx, onDone) {
  const cur = () => (typeof ctx.current === 'function' ? ctx.current() : ctx);
  openCount++;
  if (!ctx.canEdit) {
    const close = button('Close', 'x-lg', () => dlg.close());
    const dlg = openDialog({ title: 'New network', body: note('warn', 'This login is not allowed to change the configuration, so a network cannot be added.'), footer: [close], onClose: () => { openCount--; } });
    return;
  }

  const choice = defaultChoice(cur().base, cur().draft);
  let step = 1;
  let finished = null;
  // The inputs of the current page by name (`part:field`), so the errors can mark them; the nodes the light refresh updates; the last preview.
  let inputs = {}, problemsBox = null, summaryBox = null, nextBtn = null, preview = null;
  const dlg = openDialog({ title: 'New network', subtitle: 'Add a network to the draft; nothing is saved until you press "Save and apply".', body: h('div', {}), footer: [], size: 'lg', staticBackdrop: true,
    onClose: () => { openCount--; } });

  // Recomputes the interface's name from what was chosen, unless the user typed one.
  const autoName = () => { if (!choice.nameChosen) choice.name = nameFor(cur().base, cur().draft, choice); };

  // A labeled field: the control, its label and a hint.
  const field = (label, control, hint, wide = false) => h('div', { className: `set-field${wide ? ' wide' : ''}` }, h('label', { className: 'form-label' }, label), control, hint ? h('div', { className: 'muted small set-hint' }, hint) : null);
  // A text box bound to `read()`/`write(value)`, registered under `key` so errors can mark it.
  const textBox = (key, read, write, attrs = {}) => {
    const input = h('input', { className: 'form-control form-control-sm', value: read(), spellcheck: false, autocomplete: 'off', oninput: e => { write(e.target.value); refresh(); }, ...attrs });
    inputs[key] = input;
    return input;
  };

  //#region Pages

  // The three ways to connect, as cards.
  const whereCards = () => h('div', { className: 'np-protos', role: 'radiogroup' }, WHERE.map(w => {
    const on = choice.where === w.id;
    const b = h('button', { type: 'button', className: `np-proto${on ? ' on' : ''}`, role: 'radio', onclick: () => { choice.where = w.id; autoName(); render(); } },
      h('div', { className: 'np-proto-title' }, h('strong', {}, w.title), on ? badge('selected', 'info') : null), h('div', { className: 'muted small' }, w.blurb));
    b.dataset.where = w.id;
    b.setAttribute('aria-checked', String(on));
    return b;
  }));

  // The form of the chosen way of step 1.
  function whereForm() {
    const { base, draft } = cur();
    if (choice.where === 'device') {
      const { free, hidden } = existingDevices(base, draft);
      return [
        free.length ? optionList({ name: 'np-w-dev', items: free, value: choice.device, onPick: v => { choice.device = v; autoName(); render(); } }) : muted('Every device already carries an interface. Make a new VLAN device or a new bridge.'),
        hidden ? muted(`${hidden} more device${hidden > 1 ? 's' : ''} already carry an interface and ${hidden > 1 ? 'are' : 'is'} not listed: an interface sits on one device only.`) : null,
      ];
    }
    if (choice.where === 'vlan') {
      const bases = vlanBases(base, draft);
      const idBox = textBox('device:vid', () => choice.vid, v => { chooseVid(choice, v); autoName(); nameBox.value = choice.vlanName; }, { type: 'number', min: 1, max: 4094, step: 1, inputMode: 'numeric', placeholder: '1 to 4094' });
      const nameBox = textBox('device:name', () => choice.vlanName, v => { choice.vlanName = v; autoName(); }, { placeholder: 'eth1.200' });
      return [
        h('p', { className: 'small' }, h('strong', {}, 'Base device'), muted(': the port or bridge whose frames carry the tag.')),
        optionList({ name: 'np-w-base', items: bases, value: choice.vlanBase, onPick: v => { chooseVlanBase(base, draft, choice, v); autoName(); render(); } }),
        h('div', { className: 'set-fields np-fields' }, field('VLAN ID', idBox, 'The VLAN number, 1 to 4094. The switch or the provider on the other end must use the same.'),
          field('Device name', nameBox, `Usually base.id. At most ${DEVICE_NAME_MAX} characters.`)),
      ];
    }
    const owners = portOwners(base, draft);
    const nameBox = textBox('device:name', () => choice.bridgeName, v => { choice.bridgeName = v; autoName(); }, { placeholder: 'br-guest' });
    const ports = bridgePortChoices(base, draft, choice).map(p => {
      const mine = choice.ports.includes(p.name);
      const in_ = (owners.get(p.name) ?? []).map(b => b.name.trim()).filter(Boolean);
      const box = h('input', { className: 'form-check-input', type: 'checkbox', checked: mine, onchange: e => { choice.ports = e.target.checked ? [...choice.ports, p.name] : choice.ports.filter(x => x !== p.name); render(); } });
      return h('label', { className: `form-check ne-port${mine ? ' on' : ''}` }, box, h('span', { className: `dot ${p.up ? 'up' : 'idle'}` }), h('strong', {}, p.name), h('span', { className: 'muted small' }, p.label),
        in_.length ? badge(`in ${in_.join(', ')}`, 'info', 'Ticking it here moves it out of that bridge') : null);
    });
    const grid = h('div', { className: 'ne-port-grid' }, ports);
    inputs['device:ports'] = grid;
    return [
      h('div', { className: 'set-fields np-fields' }, field('Bridge name', nameBox, `Usually br-<something>. At most ${DEVICE_NAME_MAX} characters.`)),
      h('p', { className: 'small' }, h('strong', {}, 'Ports'), muted(': the network devices to join. A port can be in one bridge only; one that is in another bridge moves out of it. Wi-Fi networks join later, from the Wi-Fi page.')),
      grid,
    ];
  }

  // The page of step 3 holds the details of the protocol.
  function detailsForm() {
    const max = interfaceNameMax(choice.proto);
    const nameHint = choice.proto === 'pppoe'
      ? `Letters, digits and underscores. For PPPoE the session device is called pppoe-<name>, and the kernel limits a device name to ${DEVICE_NAME_MAX} characters, so use at most ${max}.`
      : `Letters, digits and underscores. This is the name the firewall and the DHCP server use for the network.`;
    const fields = [field('Network name', textBox('iface:name', () => choice.name, v => { choice.name = v; choice.nameChosen = true; }, { placeholder: 'guest' }), nameHint)];
    if (choice.proto === 'static') {
      const suggestion = suggestSubnet(cur().base, cur().draft);
      const addr = textBox('iface:ipaddr', () => choice.address, v => { choice.address = v; }, { placeholder: '192.168.10.1/24' });
      const use = button('Use the suggestion', null, () => { choice.address = suggestion?.address ?? ''; addr.value = choice.address; refresh(); });
      use.disabled = !suggestion;
      fields.push(field('Address of the router, with prefix length', addr,
        suggestion ? `${suggestion.network} overlaps none of your networks, so ${suggestion.address} is suggested. Clients get addresses from the DHCP server you set up on the DHCP page.` : 'Every private /24 range is taken; type the address yourself.'),
      field('Gateway (optional)', textBox('iface:gateway', () => choice.gateway, v => { choice.gateway = v; }, { placeholder: 'none' }),
        'Leave it empty for a network the router serves. A gateway makes this interface the one the default route goes out of.'));
      fields.push(h('div', {}, use));
    } else if (choice.proto === 'pppoe') {
      const pw = h('input', { className: 'form-control form-control-sm', type: 'password', value: choice.password, placeholder: 'not set', spellcheck: false, autocomplete: 'new-password', oninput: e => { choice.password = e.target.value; refresh(); } });
      const reveal = h('button', { type: 'button', className: 'btn btn-sm btn-fl', title: 'Show or hide what you typed', ariaLabel: 'Show or hide what you typed',
        onclick: () => { const show = pw.type === 'password'; pw.type = show ? 'text' : 'password'; reveal.replaceChildren(icon(show ? 'eye-slash' : 'eye')); } }, icon('eye'));
      fields.push(field('PAP/CHAP username', textBox('iface:username', () => choice.username, v => { choice.username = v; }), 'The user name of the PPPoE account your provider gave you.'),
        field('PAP/CHAP password', h('div', { className: 'set-row' }, pw, reveal), 'Stored in the file but never shown again: the page only ever says whether one is stored.'));
    }
    const lead = { static: 'The address you give the router on this network.', dhcp: 'Nothing else to fill in: the address, gateway and DNS come from the DHCP server.',
      dhcpv6: 'Nothing else to fill in: the provider hands out the address and the prefix.', pppoe: 'The login of your provider.', none: 'Nothing else to fill in: netifd leaves the interface alone.' }[choice.proto];
    return [muted(lead), h('div', { className: 'set-fields np-fields' }, fields)];
  }

  // The page after Finish: what was added, and what the flow did not do.
  function donePage() {
    const closeOnClick = a => { a.addEventListener('click', () => dlg.close()); return a; };
    return h('div', { className: 'np-wizard' },
      note('ok', 'The network is in the draft. Nothing is saved yet.'),
      section(null, 'Added to the draft', 'Review it in the banner at the top of the page; "Save and apply" writes it to the router with an automatic rollback if the router stops answering.',
        h('ul', { className: 'np-list' }, finished.lines.map(t => h('li', {}, t)))),
      section(null, 'What this did not do', 'The wizard only edits the network configuration. These are separate, and each has a page:',
        h('ul', { className: 'np-list' }, notDone(finished.proto).map(n => h('li', {}, n.text, ' ', closeOnClick(h('a', { href: n.href, className: 'np-link' }, n.link)))))));
  }

  //#endregion

  // Updates what changes while the user types: the problems, the summary, the Next button and the marks on the inputs.
  function refresh() {
    const { base, draft } = cur();
    preview = previewChoice(base, draft, choice);
    const errors = stepErrors(preview, step);
    for (const el of Object.values(inputs)) el?.classList.remove('is-invalid');
    for (const e of errors) inputs[`${e.part}:${e.field}`]?.classList.add('is-invalid');
    if (problemsBox) {
      problemsBox.replaceChildren(...errors.map(e => note(step === 3 ? 'bad' : 'warn', e.text)), ...(step === 1 || step === 3 ? preview.warnings.map(t => note('warn', t)) : []));
    }
    if (summaryBox) summaryBox.replaceChildren(...summaryLines(choice).map(t => h('li', {}, t)));
    if (nextBtn) nextBtn.disabled = errors.length > 0;
  }

  // Draws the page of the current step, with its buttons.
  function render() {
    inputs = {};
    problemsBox = h('div', { className: 'set-notes np-problems' });
    summaryBox = null;
    nextBtn = null;
    if (finished) {
      dlg.setBody(donePage());
      dlg.setFooter([button('Close', 'check2', () => dlg.close(), 'btn-brand')]);
      return;
    }
    const stepper = h('ol', { className: 'np-steps' }, STEPS.map((t, i) => h('li', { className: i + 1 === step ? 'on' : i + 1 < step ? 'done' : '' }, h('span', { className: 'np-num' }, String(i + 1)), h('span', {}, t))));
    let page;
    if (step === 1) {
      page = section(null, STEPS[0], 'A network is an interface (a "logical network") that sits on one device. Choose the device it will sit on: one that exists, or a new VLAN device or bridge made now.', whereCards(), ...whereForm());
    } else if (step === 2) {
      page = section(null, STEPS[1], 'The protocol is what the interface speaks on its device.',
        protoCards({ current: choice.proto, onPick: p => { choice.proto = p; autoName(); render(); } }));
    } else {
      summaryBox = h('ul', { className: 'np-list' });
      page = section(null, STEPS[2], `The network ${choice.name.trim() || 'you are adding'} will sit on ${deviceNameOf(choice) || 'the device you chose'}.`,
        ...detailsForm(), h('div', { className: 'np-summary' }, h('h4', {}, 'What Finish adds to the draft'), summaryBox));
    }
    const back = button('Back', null, () => { step--; render(); });
    back.disabled = step === 1;
    nextBtn = step === 3 ? button('Finish', 'check2', finish, 'btn-brand') : button('Next', 'arrow-right', () => { step++; render(); }, 'btn-brand');
    dlg.setBody(h('div', { className: 'np-wizard' }, stepper, page, problemsBox));
    dlg.setFooter([button('Cancel', 'x-lg', () => dlg.close()), step > 1 ? back : null, nextBtn].filter(Boolean));
    refresh();
  }

  // Adds the network to the draft the page holds now, tells the page, and shows the last page.
  function finish() {
    const c = cur();
    if (previewChoice(c.base, c.draft, choice).errors.length) { refresh(); return; }
    const ids = applyChoice(c.base, c.draft, choice);
    finished = { ids, lines: summaryLines(choice), proto: choice.proto };
    c.touched();
    c.redraw();
    render();
    onDone?.(ids);
  }

  render();
}
