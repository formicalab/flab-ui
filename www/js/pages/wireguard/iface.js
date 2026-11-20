// One card per WireGuard interface: its identity and settings, and a table of its peers with the state of the
// last handshake, endpoint, allowed IPs and traffic (live rates are derived from successive byte counters). The card also holds
// the editing controls: add a client or a peer, remove the interface, edit a peer in place, and the interface's settings form.
// Also exports the findings (what looks wrong) and the rate recorder.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, kv, muted, mono } from '../../core/ui.js';
import { legend, note } from '../../core/forms.js';
import { createTracker, latest } from '../../core/rates.js';
import { fmtBytes, fmtLine, fmtSpan } from '../../core/format.js';
import { adminLinks, adminSentence, addPeer, peerList, removeInterface, removePeer, restoreInterface, restorePeer, shortKey } from './model.js';
import { confirmDanger, interfaceForm, opened, peerEditor } from './edit.js';
import { openClientDialog } from './client.js';

// Module-level so the rate history survives the redraw on every poll; a peer series is keyed by the
// interface and the peer's public key.
const tracker = createTracker();
// Tracker key of one peer of an interface.
const peerKey = (i, p) => `${i.name}/${p.public_key}`;

// An allowed IP that covers more than a single host (prefix shorter than /32 or /128): the peer is a whole
// network (a site), not one client.
const isNetwork = cidr => { const m = /\/(\d+)$/.exec(cidr); return m ? +m[1] < (cidr.includes(':') ? 128 : 32) : false; };
// What a peer is, from its allowed IPs: a full-tunnel gateway (a /0), a site (a network) or a client (hosts only).
const roleOf = p => p.allowed_ips.some(a => /\/0$/.test(a)) ? 'gateway' : p.allowed_ips.some(isNetwork) ? 'site' : 'client';
// [badge text, tooltip] for each peer role from roleOf().
const ROLE = {
  gateway: ['all traffic', 'A gateway: the peer is allowed to carry every address (0.0.0.0/0 or ::/0), so it is the way out to the internet'],
  site: ['site-to-site', 'A site-to-site link: a whole network behind the peer, another router, is in its Allowed IPs'],
  client: ['client', 'A single host, such as a phone or a laptop, with one address in the tunnel'],
};

// Feeds one poll into the tracker and drops peers that disappeared.
export function recordWireguard(data) {
  const seen = new Set();
  for (const i of data.interfaces) for (const p of i.peers) {
    seen.add(peerKey(i, p));
    tracker.record(peerKey(i, p), { rx: p.rx_bytes, tx: p.tx_bytes });
  }
  tracker.keep(seen);
}

// Latest rate of a peer's counter ('rx' or 'tx', bytes/s), or null before two samples exist.
export const rateNow = (i, p, dir) => latest(tracker.rates(peerKey(i, p), dir));

// What looks wrong on one interface, as { level, text }: disabled or down (returned alone), no firewall
// zone, peers not loaded / stale / never connected, and site peers whose routes are not installed.
// Disabled peers are skipped.
export function findings(i) {
  const out = [];
  if (!i.enabled) return [{ level: 'info', text: `WireGuard interface ${i.name} is disabled in the configuration.` }];
  if (!i.up) return [{ level: 'bad', text: `WireGuard interface ${i.name} is configured but not running.` }];
  if (!i.zone) out.push({ level: 'warn', text: `${i.name} is in no firewall zone, so the default policies apply and its peers cannot reach the router or other networks.` });
  for (const p of i.peers) {
    const who = p.name ?? shortKey(p.public_key);
    if (!p.enabled) continue;
    if (p.state === 'down') out.push({ level: 'warn', text: `Peer ${who} is configured but not loaded in the kernel.` });
    else if (p.state === 'stale') out.push({ level: 'info', text: `Peer ${who}: last handshake ${fmtSpan(p.handshake_age)} ago, so it is not connected right now.` });
    else if (p.state === 'never') out.push({ level: 'info', text: `Peer ${who} has not connected since ${i.name} came up.` });
    if (roleOf(p) === 'site' && !p.route_allowed_ips) out.push({ level: 'warn', text: `Peer ${who} may carry ${p.allowed_ips.filter(isNetwork).join(', ')} but routes for them are not installed (route_allowed_ips is off).` });
  }
  return out;
}

// Badge for a peer's state. WireGuard has no connection state: "connected" means a handshake happened
// within the last 3 minutes (the backend derives `state` from the handshake age).
const stateBadge = p => ({
  connected: badge('connected', 'success', 'A handshake happened in the last 3 minutes'),
  stale: badge('no recent handshake', 'warning', 'The last handshake is older than 3 minutes'),
  never: badge('never connected', '', 'No handshake since the interface came up'),
  down: badge('not loaded', 'danger', 'Configured, but the kernel does not have this peer'),
})[p.state];

// Card header: state dot, name, state, firewall zone and total traffic of the interface. A new interface (`item.data` is null) has only its name.
function header(item) {
  const i = item.data;
  if (!i) return h('div', { className: 'wg-head' }, icon('key', 20), h('strong', { className: 'name' }, item.name.trim() || 'New interface'), badge('new', 'info', 'Not saved yet'));
  const state = !i.enabled ? ['disabled', ''] : i.up ? ['up', 'success'] : ['down', 'danger'];
  return h('div', { className: 'wg-head' },
    h('span', { className: `dot ${i.up ? 'up' : 'down'}` }), icon('key', 20),
    h('strong', { className: 'name' }, i.name),
    badge(state[0], state[1]),
    item.removed ? badge('to be removed', 'danger') : null,
    i.zone ? badge(`zone ${i.zone}`, 'info', 'Firewall zone of this interface') : badge('no firewall zone', 'warning'),
    h('span', { className: 'wg-traffic' }, i.rx_bytes != null ? `↓ ${fmtBytes(i.rx_bytes)}  ↑ ${fmtBytes(i.tx_bytes)}` : ''));
}

// Interface settings: addresses, listen port, public key (not secret; the private key never reaches the
// browser), MTU and firewall mark when set.
function settings(i) {
  return kv([
    ['Addresses', i.addresses.length ? h('div', {}, i.addresses.map(a => h('div', {}, mono(a)))) : muted('none')],
    ['Listen port', i.listen_port != null ? `UDP ${i.listen_port}` : muted('random')],
    ['Public key', i.public_key ? h('span', { className: 'mono wg-key', title: 'Share this with peers; it is not secret' }, i.public_key) : muted('not running')],
    ['MTU', i.mtu ?? '–'],
    i.fwmark && i.fwmark !== 'off' ? ['Firewall mark', mono(i.fwmark)] : null,
  ]);
}

// The peer as the table shows it: the live view when the plugin has one, else (a peer added in the form) a view made from the draft.
function viewOf(ctx, item, pe) {
  if (pe.p) return pe.p;
  const v = ctx.draft.interfaces[item.id].peers[pe.id];
  const port = v.endpoint_port.trim();
  return {
    name: v.description.trim() || undefined, public_key: v.public_key.trim(),
    endpoint: v.endpoint_host.trim() ? `${v.endpoint_host.trim()}${port ? `:${port}` : ''}` : null,
    allowed_ips: v.allowed_ips.map(a => a.trim()).filter(Boolean), route_allowed_ips: v.route_allowed_ips,
    keepalive: Number(v.persistent_keepalive) || null, handshake_age: null, state: 'new', rx_bytes: null, tx_bytes: null, configured: false, enabled: !v.disabled,
  };
}

// The cell with the buttons of a peer row: edit (opens the editor under the row), remove (asks first when this is probably the
// administrator's own tunnel) and undo. A peer that is not in the configuration has none.
function peerActions(ctx, item, pe, p) {
  if (!pe.editable) return h('td', {});
  const key = `peer:${item.id}:${pe.id}`;
  const label = p.name ?? (shortKey(p.public_key) || 'this peer');
  if (pe.removed) return h('td', { className: 'wg-actions' }, button('Undo', 'arrow-counterclockwise', () => { restorePeer(ctx.draft, item.id, pe.id); ctx.touched(); ctx.redraw(); }));
  const edit = button(opened.has(key) ? 'Close' : 'Edit', 'pencil', () => { if (opened.has(key)) opened.delete(key); else opened.add(key); ctx.redraw(); }, 'btn-outline-secondary', { disabled: !ctx.canEdit });
  const remove = button('Remove', 'trash', async () => {
    const you = pe.p ? adminSentence(adminLinks(ctx.data), item.name, pe.p) : null;
    if (you && !(await confirmDanger({ title: `Remove peer ${label}?`, paragraphs: [you, 'Removing this peer ends that connection once you save. If this page cannot reach the router afterwards, the router puts the old settings back by itself within 30 seconds.'], confirmLabel: 'Remove peer' }))) return;
    removePeer(ctx.draft, item.id, pe.id);
    opened.delete(key);
    ctx.touched();
    ctx.redraw();
  }, 'btn-outline-secondary', { disabled: !ctx.canEdit });
  return h('td', { className: 'wg-actions' }, edit, remove);
}

// One peer row: identity and role, endpoint, allowed IPs (networks highlighted), handshake state, keepalive
// and traffic, and the buttons. Disabled peers are dimmed; peers added with `wg set` are flagged as not in the configuration.
function peerRow(ctx, item, pe) {
  const i = item.data;
  const p = viewOf(ctx, item, pe);
  const [roleText, roleTitle] = ROLE[roleOf(p)];
  const rx = i && pe.p ? rateNow(i, p, 'rx') : null, tx = i && pe.p ? rateNow(i, p, 'tx') : null;
  return h('tr', { className: p.enabled && !pe.removed ? '' : 'wg-off' },
    h('td', {}, p.name ? h('strong', {}, p.name) : muted('unnamed'), ' ', badge(roleText, 'info', roleTitle),
      pe.isNew ? [' ', badge('new', 'info', 'Not saved yet')] : null, pe.removed ? [' ', badge('to be removed', 'danger')] : null,
      h('div', {}, p.public_key ? h('span', { className: 'mono small muted', title: p.public_key }, shortKey(p.public_key)) : h('span', { className: 'small muted' }, 'no valid public key')),
      pe.isNew || p.configured ? null : h('div', { className: 'muted small' }, 'not in the configuration (added at run time)')),
    h('td', {}, p.endpoint ? mono(p.endpoint) : muted('none yet (roaming peer)')),
    h('td', {}, h('div', { className: 'wg-allowed' }, p.allowed_ips.map(a => h('span', { className: `mono wg-ip ${isNetwork(a) ? 'net' : ''}` }, a))),
      p.allowed_ips.some(isNetwork) ? h('div', { className: 'muted small' }, p.route_allowed_ips ? 'routes installed' : 'routes not installed') : null),
    h('td', {}, pe.isNew ? muted('not saved yet') : [h('div', {}, h('span', { className: `dot ${p.state === 'connected' ? 'up' : p.state === 'stale' ? 'idle' : 'down'}` }), ' ', stateBadge(p)),
      p.handshake_age != null ? h('div', { className: 'muted small' }, `${fmtSpan(p.handshake_age)} ago`) : null]),
    h('td', { className: 'num' }, p.keepalive ? `${p.keepalive}s` : muted('off')),
    h('td', { className: 'num' }, pe.isNew ? null : [h('div', {}, icon('arrow-down', 12), fmtLine(rx)), h('div', {}, icon('arrow-up', 12), fmtLine(tx))]),
    h('td', { className: 'num' }, pe.isNew ? null : [h('div', {}, icon('arrow-down', 12), fmtBytes(p.rx_bytes ?? 0)), h('div', {}, icon('arrow-up', 12), fmtBytes(p.tx_bytes ?? 0))]),
    peerActions(ctx, item, pe, p));
}

// Table of an interface's peers, each configured peer followed by its editor when that is open.
function peersTable(ctx, item) {
  const cols = ['Peer', 'Endpoint', 'Allowed IPs', 'Handshake', 'Keepalive', 'Traffic now', 'Total', ''];
  const peers = peerList(item, ctx.draft);
  const rows = peers.flatMap(pe => [peerRow(ctx, item, pe), pe.editable && !pe.removed && (pe.isNew || opened.has(`peer:${item.id}:${pe.id}`)) ? peerEditor(ctx, item, pe, cols.length) : null]);
  return h('div', {},
    peers.length ? legend(['The badge after a peer\'s name says what it is. client: a single host, such as a phone or a laptop. site-to-site: a whole network behind another router (make one with Add site-to-site peer). all traffic: a gateway that carries every address.']) : null,
    h('div', { className: 'table-responsive' }, h('table', { className: 'table wg-table' },
      h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
      h('tbody', {}, peers.length ? rows : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'No peers are configured on this interface.'))))));
}

// The row of buttons under the header: add a client, add a site-to-site peer, and remove the interface (or discard it when it is new, or undo).
function toolbar(ctx, item, onDialog) {
  const key = `if:${item.id}`;
  if (item.removed) return h('div', { className: 'wg-toolbar' }, muted(`${item.name} and its peers are removed when you save.`), h('span', { className: 'wg-spacer' }),
    button('Undo', 'arrow-counterclockwise', () => { restoreInterface(ctx.draft, item.id); ctx.touched(); ctx.redraw(); }));
  const canEdit = ctx.canEdit;
  const client = button('Add client', 'plus-lg', () => { onDialog(true); openClientDialog(ctx, item, () => onDialog(false)); }, 'btn-primary',
    item.isNew ? { disabled: true, title: 'Save the interface first: the client needs the interface\'s public key.' } : { disabled: !canEdit, title: 'Set up a phone, a laptop or another client: its keys are made here and its configuration is shown once, as a QR code and as text' });
  const peer = button('Add site-to-site peer', 'plus-lg', () => { opened.add(`peer:${item.id}:${addPeer(ctx.draft, item.id, { route_allowed_ips: true })}`); ctx.touched(); ctx.redraw(); }, 'btn-outline-secondary', { disabled: !canEdit, title: 'Connect another router, so that its network and yours can reach each other (a site-to-site link): you need its public key, its endpoint and the networks behind it. Routes for those networks are created.' });
  const remove = button(item.isNew ? 'Discard interface' : 'Remove interface', 'trash', async () => {
    const you = item.data ? adminSentence(adminLinks(ctx.data), item.name) : null;
    if (you && !(await confirmDanger({ title: `Remove ${item.name}?`, paragraphs: [you, `Removing ${item.name} and its peers ends that connection once you save. If this page cannot reach the router afterwards, the router puts the old settings back by itself within 30 seconds.`], confirmLabel: 'Remove interface' }))) return;
    removeInterface(ctx.draft, item.id);
    opened.delete(key);
    ctx.touched();
    ctx.redraw();
  }, 'btn-outline-secondary', { disabled: !canEdit });
  return h('div', { className: 'wg-toolbar' }, client, peer, h('span', { className: 'wg-spacer' }), remove);
}

// The card for one interface of ifaceList(): header, the buttons, notes, the settings form (folded), then the live settings next to the peers table.
// `onDialog(open)` tells the page that a dialog is open, so it does not poll under it.
export function interfaceCard(ctx, item, onDialog) {
  const i = item.data;
  const editable = item.editable && !item.removed;
  return h('div', { className: `card wg-card ${i && !i.up ? 'is-down' : ''} ${item.removed ? 'wg-removed' : ''} ${item.isNew ? 'wg-new' : ''}` },
    header(item),
    item.editable ? toolbar(ctx, item, onDialog) : null,
    !item.editable ? h('div', { className: 'wg-notes' }, note('info', `${item.name} is not in /etc/config/network (it was created at run time, for example with wg-quick), so it cannot be edited here.`)) : null,
    editable && i && i.enabled && !i.zone ? h('div', { className: 'wg-notes' }, note('warn', `${item.name} is in no firewall zone, so the default policies apply and its peers cannot reach the router or other networks. Assign it to a zone on the Firewall page. `, h('a', { href: '#firewall' }, 'Open the Firewall page'))) : null,
    editable ? h('div', { className: 'wg-panels' }, interfaceForm(ctx, item)) : null,
    item.removed ? null : h('div', { className: 'wg-body' }, i ? settings(i) : null, peersTable(ctx, item)));
}
