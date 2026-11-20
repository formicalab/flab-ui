// "Add client": the dialog that sets up a client (a phone, a laptop) for an interface. It makes the client's key pair in the browser,
// adds the client as a peer of the interface in the form (its public key and the next free tunnel address; nothing is saved until
// "Save and apply"), and shows the client's WireGuard configuration once, as a QR code (for the WireGuard app of a phone) and as text with
// copy and download buttons. The client's private key exists only in this dialog: the router never receives it. The dialog is closed
// (and its contents dropped) when the route changes.
import { h } from '../../core/dom.js';
import { copyButton } from '../../core/clipboard.js';
import { saveFile } from '../../core/download.js';
import { openDialog } from '../../core/modal.js';
import { button, muted } from '../../core/ui.js';
import { qrBox } from '../../core/qr.js';
import { note } from '../../core/forms.js';
import { addPeer, clientAllowedIps, clientConfig, clientFileName, clientPlan, endpointText, ownAddress } from './model.js';
import { generateKeyPair, generatePresharedKey } from './keys.js';
import { isHostname } from './addr.js';
import { parseAddress } from '../../core/ip.js';

// The form of the dialog: a labeled row with a control and an optional hint.
const row = (label, control, hint) => h('div', { className: 'set-field' }, h('label', { className: 'form-label' }, label), control, hint ? h('div', { className: 'muted small set-hint' }, hint) : null);

// Opens the dialog for the interface `item` of ifaceList(). `ctx` is the page's context (data, draft, touched, redraw); `onClosed()` is
// called when the dialog closes, however it was closed.
export function openClientDialog(ctx, item, onClosed) {
  const plan = clientPlan(ctx.data, ctx.draft, item.id);
  // The dialog lives in <body>, so it would outlive a route change with the private key still shown.
  const leave = () => dialog.close();
  addEventListener('hashchange', leave);
  const dialog = openDialog({ title: `Add a client to ${item.name}`, subtitle: 'A phone, a laptop or any other WireGuard client', body: h('div', {}), footer: [], size: 'xl', staticBackdrop: true,
    onClose: () => { removeEventListener('hashchange', leave); onClosed(); } });
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
    h('p', { className: 'muted small' }, `The client gets the address ${plan.addresses.join(' and ')} in the tunnel. Its keys are made now, in your browser; only its public key goes to the router.`),
    h('div', { className: 'set-fields' },
      row('Client name', name, 'A label for the client. It becomes the description of the peer.'),
      row('Router address the client connects to', host, 'The public name or address of this router as the client sees it, not necessarily the one you use now (a dynamic DNS name is a good choice).'),
      row('Router UDP port', port, 'The listen port of the interface; the firewall must allow it from where the client connects.'),
      row('What the client sends through the tunnel', routes, 'The client decides what it routes into the tunnel: only the tunnel network, everything, or the networks you list.'),
      customRow,
      row('DNS server for the client (optional)', dns, 'An address the client asks for names while connected, for example the router\'s tunnel address when it runs a DNS server the tunnel may reach.'),
      row('Keepalive (seconds)', keepalive, 'Keeps the path open through the client\'s NAT. 25 is the usual value; empty turns it off.'),
      h('label', { className: 'form-check set-check' }, usePsk, h('span', {}, 'Use a pre-shared key', h('div', { className: 'muted small set-hint' }, 'An extra shared secret for this client (made now, stored on the router, never shown again here).')))),
    error);

  // Checks the form and returns the settings, or shows the first problem and returns null.
  const read = () => {
    // Shows `text` as the problem and gives up (null).
    const fail = text => { error.replaceChildren(note('bad', text)); return null; };
    if (!name.value.trim()) return fail('Give the client a name.');
    if (/[\r\n]/.test(name.value)) return fail('The name must be a single line.');
    const h2 = host.value.trim();
    if (!h2 || (!parseAddress(h2.replace(/^\[(.*)\]$/, '$1')) && !isHostname(h2))) return fail('Enter the router\'s host name or IP address, without a port.');
    if (!/^\d+$/.test(port.value.trim()) || +port.value < 1 || +port.value > 65535) return fail('The port must be a number from 1 to 65535.');
    const ka = keepalive.value.trim();
    if (ka && (!/^\d+$/.test(ka) || +ka > 65535)) return fail('The keepalive must be a number of seconds, or empty.');
    const allowed = clientAllowedIps(routes.value, plan.tunnels, custom.value);
    if (allowed.error) return fail(allowed.error);
    if (dns.value.trim() && !/^[A-Za-z0-9.:, _-]+$/.test(dns.value)) return fail('The DNS server must be an address or a list of addresses.');
    return { name: name.value.trim(), host: h2.replace(/^\[(.*)\]$/, '$1'), port: port.value.trim(), allowed: allowed.list, dns: dns.value.trim(), keepalive: ka, psk: usePsk.checked };
  };

  // Makes the keys, adds the peer to the draft and shows the configuration for the client.
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
    const text = clientConfig({ privateKey: pair.privateKey, addresses: plan.addresses, dns: s.dns, serverKey: plan.serverKey, presharedKey: psk, endpoint: endpointText(s.host, s.port), allowedIps: s.allowed, keepalive: s.keepalive });
    const file = clientFileName(item.name, s.name);
    dialog.setBody(h('div', {},
      note('warn', 'This is the only time the client\'s configuration is shown: its private key exists only here and is not stored on the router. Scan the QR code, or copy or download the configuration, now.'),
      note('info', `The client was added to ${item.name} in the form. It works only after you press "Save and apply".`),
      h('div', { className: 'wg-result' },
        h('div', { className: 'wg-qr' },
          qrBox(text, muted('The configuration is too long for a QR code.'), { ecc: 'L', label: `QR code of the configuration of ${s.name}` }),
          h('div', { className: 'muted small' }, 'In the WireGuard app, add a tunnel and scan this QR code.')),
        h('pre', { className: 'wg-conf mono' }, text))));
    dialog.setFooter([copyButton(text, 'Copy'), button('Download', 'download', () => saveFile(file, text)), button('Close', 'x-lg', close, 'btn-primary')]);
  };

  dialog.setBody(form);
  dialog.setFooter([button('Cancel', 'x-lg', close), button('Create the client', 'key', create, 'btn-primary')]);
  name.focus();
}
