// Per-peer actions of the BGP tab: ask the peer for its routes again, announce ours again, restart the session, disable or enable the
// protocol. Each goes through flab.bgp action, which runs one fixed birdc command on one BGP protocol; every one asks first, and says
// what it will do to the session.

import { h } from '../../../core/dom.js';
import { icon } from '../../../core/icons.js';
import { AuthError, can, ubus } from '../../../core/ubus.js';
import { button, mono, spinner } from '../../../core/ui.js';
import { openDialog } from '../../../core/modal.js';

// What the actions are called, their icon, whether they interrupt the session (they get a red button), what they do in words and what
// the peer's session needs for them to work.
const ACTIONS = {
  refresh_in: {
    label: 'Refresh in', icon: 'arrow-down', title: 'Ask the peer to send its routes again', danger: false, needs: 'established',
    text: ['BIRD asks the peer to send all its routes again (BGP route refresh) and applies the import filter to them afresh.', 'The session stays up and traffic is not interrupted.'],
  },
  refresh_out: {
    label: 'Refresh out', icon: 'arrow-up', title: 'Announce the routes to the peer again', danger: false, needs: 'established',
    text: ['BIRD announces to the peer again every route that its export filter allows.', 'The session stays up and traffic is not interrupted.'],
  },
  restart: {
    label: 'Restart', icon: 'arrow-clockwise', title: 'Close and reopen the session', danger: true, needs: 'enabled',
    text: ['BIRD closes the BGP session and opens it again. The routes learned from this peer are withdrawn until the session is Established again, and traffic that used them moves to the other paths (graceful restart may keep forwarding for a while).'],
  },
  disable: {
    label: 'Disable', icon: 'toggle-off', title: 'Shut the session down until it is enabled again', danger: true, needs: 'enabled',
    text: ['BIRD shuts the session down and keeps it down. Its routes are withdrawn and nothing is announced to the peer.', 'It stays disabled until you enable it again or BIRD restarts.'],
  },
  enable: {
    label: 'Enable', icon: 'toggle-on', title: 'Start the session again', danger: false, needs: 'disabled',
    text: ['BIRD starts the session again; it becomes Established when the peer answers.'],
  },
};

// Whether the protocol was disabled with `disable`: BIRD lists it as down and its session has no state.
export const isDisabled = p => p.protocol_state === 'down';

// Runs the action after the user confirmed in a dialog, shows BIRD's answer in the same dialog, and refreshes the page behind it.
// `state` is the page state (its `reload` polls again).
export function openActionDialog(p, action, state) {
  const a = ACTIONS[action];
  const body = h('div', {}, a.text.map(t => h('p', {}, t)),
    h('p', { className: 'muted small' }, 'Peer ', mono(p.name), p.neighbor ? [' · ', mono(p.neighbor)] : null, p.neighbor_as != null ? ` · AS ${p.neighbor_as}` : ''));
  const cancel = button('Cancel', 'x-lg', () => dialog.close(), 'btn-outline-secondary', { id: 'bgp-act-cancel' });
  const go = button(a.label, a.icon, () => perform(), a.danger ? 'btn-danger' : 'btn-primary', { id: 'bgp-act-go' });
  const dialog = openDialog({ title: `${a.label} ${p.name}?`, subtitle: p.description, body, footer: [cancel, go], staticBackdrop: true });

  // Sends the action and replaces the dialog's content with the outcome.
  async function perform() {
    go.disabled = true;
    cancel.disabled = true;
    dialog.setBody(h('p', {}, spinner('Working'), ` ${a.label} ${p.name}…`));
    let reply = null, error = null;
    try {
      reply = await ubus('flab.bgp', 'action', { name: p.name, action });
    } catch (e) {
      // A session that ended meanwhile goes back to the sign-in screen through the refresh.
      if (e instanceof AuthError) { dialog.close(); return state.reload(); }
      error = e.message;
    }
    const ok = reply?.ok === true;
    dialog.setBody(h('div', { className: `cfg-check ${ok ? 'ok' : 'bad'}`, role: 'status', id: 'bgp-act-outcome' },
      icon(ok ? 'check-circle' : 'x-circle', 17),
      h('div', {}, h('strong', {}, ok ? `${a.label}: done.` : `${a.label} failed.`),
        reply?.output ? h('pre', { className: 'cfg-output' }, reply.output) : null,
        !ok ? h('div', { className: 'text-danger' }, error ?? reply?.error ?? 'No answer from the router.') : null)));
    dialog.setFooter(button('Close', 'x-lg', () => dialog.close(), 'btn-outline-secondary', { id: 'bgp-act-close' }));
    state.reload();
    // A session needs a moment to close or open; poll again once more when it has.
    if (ok && (action === 'restart' || action === 'enable' || action === 'disable')) setTimeout(() => state.reload(), 2000);
  }
}

// The button group in a peer card's header, or null when the login may not run actions. A refresh needs an Established session; a
// disabled protocol offers only Enable.
export function peerActions(p, state) {
  if (!can('flab.bgp', 'action')) return null;
  const disabled = isDisabled(p);
  const established = p.state === 'Established';
  const offered = Object.entries(ACTIONS).filter(([, a]) => a.needs === 'disabled' ? disabled : !disabled);
  return h('div', { className: 'btn-group btn-group-sm bgp-actions', role: 'group', ariaLabel: `Actions for ${p.name}` },
    offered.map(([key, a]) => h('button', {
      type: 'button', className: 'btn btn-outline-secondary', id: `bgp-${p.name}-${key}`,
      title: a.needs === 'established' && !established ? `${a.title} (the session is not Established)` : a.title,
      disabled: a.needs === 'established' && !established,
      onclick: () => openActionDialog(p, key, state),
    }, icon(a.icon, 14), ' ', a.label)));
}
