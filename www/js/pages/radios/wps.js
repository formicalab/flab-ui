// The WPS push button of an access point on the Wi-Fi radios page. An access point that has `wps_pushbutton` set (WPA2-Personal only) gets a WPS button in the
// summary line of its block: it asks hostapd (the flab.radio `wps` method) to accept the WPS button of a device for two minutes, during which a device in range
// joins without the password, so it starts only after a confirmation that says so. While it is open the line says for how long and the button cancels it.
import { h } from '../../core/dom.js';
import { AuthError, can, ubus } from '../../core/ubus.js';
import { openDialog } from '../../core/modal.js';
import { badge, button } from '../../core/ui.js';

// How long hostapd keeps the push button open after it was started.
const WINDOW_MS = 120000;

// The button state of each access point by interface name: { until } while it is open, { error } after a refusal. Module-level so it survives the redraw on every poll.
const open = new Map();

// Whether the access point `i` (an interface of the flab.radio status) has a push button to offer: a running access point with the option set, to a login that may use it.
export const hasWps = i => i?.mode === 'ap' && i.up && i.ifname && i.features?.wps && can('flab.radio', 'wps');

// Asks the plugin to start or cancel the button of `i`, and keeps what came back for the block. `redraw` repaints the page.
async function send(i, action, redraw) {
  try {
    const r = await ubus('flab.radio', 'wps', { ifname: i.ifname, action });
    if (r?.ok) { if (action === 'start') open.set(i.ifname, { until: Date.now() + WINDOW_MS }); else open.delete(i.ifname); }
    else open.set(i.ifname, { error: r?.error ?? 'The router refused.' });
  } catch (e) {
    if (e instanceof AuthError) { location.reload(); return; }
    open.set(i.ifname, { error: e.message });
  }
  redraw();
}

// The confirmation before the button is opened: what it lets in.
function confirm(i, redraw) {
  const dialog = openDialog({
    title: `WPS push button on ${i.ssid ?? i.ifname}`,
    body: h('div', {},
      h('p', {}, `The access point accepts the WPS button of a device for two minutes. Press the WPS button of the device within that time and it joins ${i.ssid ?? 'the network'} without the password.`),
      h('p', { className: 'muted small' }, 'Any device in range that presses its WPS button during these two minutes joins, so open it only when you are ready to connect the device.')),
    footer: [
      button('Cancel', 'x-lg', () => dialog.close()),
      button('Open the WPS button', 'key', () => { dialog.close(); send(i, 'start', redraw); }, 'btn-fl btn-brand'),
    ],
  });
}

// The remaining time of an open button as "1:52", or null when it is closed (or ran out).
function remaining(ifname) {
  const s = open.get(ifname);
  if (!s?.until) return null;
  const left = Math.round((s.until - Date.now()) / 1000);
  if (left <= 0) { open.delete(ifname); return null; }
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

// The nodes for the summary line of the access point `i`: the button (it starts the WPS button, or cancels it while it is open), the time left and a refusal. They
// take their clicks themselves, so they do not fold the block. Empty when `i` has no push button.
export function wpsControls(i, redraw) {
  if (!hasWps(i)) return [];
  const left = remaining(i.ifname);
  const error = open.get(i.ifname)?.error;
  const b = button(left ? 'Cancel WPS' : 'WPS', 'key', () => (left ? send(i, 'cancel', redraw) : confirm(i, redraw)), 'btn-fl wps-btn');
  b.title = left ? 'Close the WPS push button' : 'Open the WPS push button for two minutes so a device can join by pressing its WPS button';
  b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
  return [b, left ? badge(`WPS open ${left}`, 'info', 'A device that presses its WPS button now joins without the password') : null, error ? badge('WPS refused', 'danger', error) : null].filter(Boolean);
}
