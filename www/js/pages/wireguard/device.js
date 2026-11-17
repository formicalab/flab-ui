// "Add remote device": the dialog that sets up a client (a phone, a laptop) for an interface. It makes the client's key pair in the browser,
// adds the client as a peer of the interface in the form (its public key and the next free tunnel address; nothing is saved until
// "Save and apply"), and shows the client's WireGuard configuration once, with copy and download buttons. The client's private key
// exists only in this dialog: the router never receives it.
import { h } from '../../core/dom.js';
import { copyButton } from '../../core/clipboard.js';
import { saveFile } from '../../core/download.js';
import { openDialog } from '../../core/modal.js';
import { button } from '../../core/ui.js';
import { note } from '../../core/forms.js';
import { addPeer, deviceAllowedIps, deviceConfig, deviceFileName, devicePlan, endpointText, ownAddress } from './model.js';
import { generateKeyPair, generatePresharedKey } from './keys.js';
import { isHostname } from './addr.js';
import { parseAddress } from '../../core/ip.js';

// The form of the dialog: a labeled row with a control and an optional hint.
const row = (label, control, hint) => h('div', { className: 'set-field' }, h('label', { className: 'form-label' }, label), control, hint ? h('div', { className: 'muted small set-hint' }, hint) : null);

// Opens the dialog for the interface `item` of ifaceList(). `ctx` is the page's context (data, draft, touched, redraw); `onClosed()` is
// called when the dialog closes, however it was closed.
export function openDeviceDialog(ctx, item, onClosed) {
  const plan = devicePlan(ctx.data, ctx.draft, item.id);
  const dialog = openDialog({ title: `Add a remote device to ${item.name}`, subtitle: 'A phone, a laptop or any other WireGuard client', body: h('div', {}), footer: [], size: 'lg', staticBackdrop: true, onClose: onClosed });
  // Closes the dialog.
  const close = () => dialog.close();

  if (plan.error) {
    dialog.setBody(note('warn', plan.error));
    dialog.setFooter(button('Close', 'x-lg', close));
    return;
  }

  const d = ctx.draft.interfaces[item.id];
  const name = h('input', { className: 'form-control form-control-sm', placeholder: 'My phone', spellcheck: false, autocomplete: 'off' });
  const host = h('input', { className: 'form-control form-control-sm', value: location.hostname, spellcheck: false, autocomplete: 'off' });
  const port = h('input', { className: 'form-control form-control-sm', value: plan.port, inputMode: 'numeric', autocomplete: 'off' });
  const routes = h('select', { className: 'form-select form-select-sm' },
    h('option', { value: 'tunnel' }, `Only the tunnel network (${plan.tunnels.join(', ')})`),
    h('option', { value: 'all' }, 'All its traffic (0.0.0.0/0, ::/0)'),
    h('option', { value: 'custom' }, 'These networks…'));
  const custom = h('input', { className: 'form-control form-control-sm', placeholder: '192.168.1.0/24, 10.8.0.0/24', spellcheck: false, autocomplete: 'off' });
  const customRow = row('Networks', custom);
  customRow.hidden = true;
  routes.onchange = () => { customRow.hidden = routes.value !== 'custom'; };
  const dns = h('input', { className: 'form-control form-control-sm', placeholder: ownAddress(d.values) || '10.8.0.1', spellcheck: false, autocomplete: 'off' });
  const keepalive = h('input', { className: 'form-control form-control-sm', value: '25', inputMode: 'numeric', autocomplete: 'off' });
  const usePsk = h('input', { className: 'form-check-input', type: 'checkbox', checked: true });
  const error = h('div', {});

  const form = h('div', {},
    h('p', { className: 'muted small' }, `The device gets the address ${plan.addresses.join(' and ')} in the tunnel. Its keys are made now, in your browser; only its public key goes to the router.`),
    h('div', { className: 'set-fields' },
      row('Device name', name, 'A label for the device. It becomes the description of the peer.'),
      row('Router address the device connects to', host, 'The public name or address of this router as the device sees it, not necessarily the one you use now (a dynamic DNS name is a good choice).'),
      row('Router UDP port', port, 'The listen port of the interface; the firewall must allow it from where the device connects.'),
      row('What the device sends through the tunnel', routes, 'The device decides what it routes into the tunnel: only the tunnel network, everything, or the networks you list.'),
      customRow,
      row('DNS server for the device (optional)', dns, 'An address the device asks for names while connected, for example the router\'s tunnel address when it runs a DNS server the tunnel may reach.'),
      row('Keepalive (seconds)', keepalive, 'Keeps the path open through the device\'s NAT. 25 is the usual value; empty turns it off.'),
      h('label', { className: 'form-check set-check' }, usePsk, h('span', {}, 'Use a pre-shared key', h('div', { className: 'muted small set-hint' }, 'An extra shared secret for this device (made now, stored on the router, never shown again here).')))),
    error);

  // Checks the form and returns the settings, or shows the first problem and returns null.
  const read = () => {
    // Shows `text` as the problem and gives up (null).
    const fail = text => { error.replaceChildren(note('bad', text)); return null; };
    if (!name.value.trim()) return fail('Give the device a name.');
    if (/[\r\n]/.test(name.value)) return fail('The name must be a single line.');
    const h2 = host.value.trim();
    if (!h2 || (!parseAddress(h2.replace(/^\[(.*)\]$/, '$1')) && !isHostname(h2))) return fail('Enter the router\'s host name or IP address, without a port.');
    if (!/^\d+$/.test(port.value.trim()) || +port.value < 1 || +port.value > 65535) return fail('The port must be a number from 1 to 65535.');
    const ka = keepalive.value.trim();
    if (ka && (!/^\d+$/.test(ka) || +ka > 65535)) return fail('The keepalive must be a number of seconds, or empty.');
    const allowed = deviceAllowedIps(routes.value, plan.tunnels, custom.value);
    if (allowed.error) return fail(allowed.error);
    if (dns.value.trim() && !/^[A-Za-z0-9.:,\s_-]+$/.test(dns.value)) return fail('The DNS server must be an address or a list of addresses.');
    return { name: name.value.trim(), host: h2.replace(/^\[(.*)\]$/, '$1'), port: port.value.trim(), allowed: allowed.list, dns: dns.value.trim(), keepalive: ka, psk: usePsk.checked };
  };

  // Makes the keys, adds the peer to the draft and shows the configuration for the device.
  const create = async () => {
    const s = read();
    if (!s) return;
    let pair, psk = '';
    try {
      pair = await generateKeyPair();
      if (s.psk) psk = generatePresharedKey();
    } catch (e) {
      error.replaceChildren(note('bad', e.message));
      return;
    }
    addPeer(ctx.draft, item.id, { description: s.name, public_key: pair.publicKey, preshared_key: psk, allowed_ips: [...plan.addresses] });
    ctx.touched();
    ctx.redraw();
    const text = deviceConfig({ privateKey: pair.privateKey, addresses: plan.addresses, dns: s.dns, serverKey: plan.serverKey, presharedKey: psk, endpoint: endpointText(s.host, s.port), allowedIps: s.allowed, keepalive: s.keepalive });
    const file = deviceFileName(item.name, s.name);
    dialog.setBody(h('div', {},
      note('warn', 'This is the only time the device\'s configuration is shown: its private key exists only here and is not stored on the router. Copy it, download it or enter it into the device now.'),
      note('info', `The device was added to ${item.name} in the form. It works only after you press "Save and apply".`),
      h('pre', { className: 'wg-conf mono' }, text)));
    dialog.setFooter([copyButton(text, 'Copy'), button('Download', 'download', () => saveFile(file, text)), button('Close', 'x-lg', close, 'btn-brand')]);
  };

  dialog.setBody(form);
  dialog.setFooter([button('Cancel', 'x-lg', close), button('Create the device', 'key', create, 'btn-brand')]);
  name.focus();
}
