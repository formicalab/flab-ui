// One card per WireGuard interface: its identity and settings, and a table of its peers with the state of the
// last handshake, endpoint, allowed IPs and traffic (live rates are derived from successive byte counters).
// Also exports the findings (what looks wrong) and the rate recorder.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, kv, muted, mono } from '../../core/ui.js';
import { createTracker, latest } from '../../core/rates.js';
import { fmtBytes, fmtLine, fmtSpan } from '../../core/format.js';

// Module-level so the rate history survives the redraw on every poll; a peer series is keyed by the
// interface and the peer's public key.
const tracker = createTracker();
const peerKey = (i, p) => `${i.name}/${p.public_key}`;
// Abbreviated public key ("abcdefgh…xyz12=") for display; the full key is in the tooltip.
const shortKey = k => `${k.slice(0, 8)}…${k.slice(-5)}`;

// An allowed IP that covers more than a single host (prefix shorter than /32 or /128): the peer is a whole
// network (a site), not one client.
const isNetwork = cidr => { const m = /\/(\d+)$/.exec(cidr); return m ? +m[1] < (cidr.includes(':') ? 128 : 32) : false; };
// What a peer is, from its allowed IPs: a full-tunnel gateway (a /0), a site (a network) or a client (hosts only).
const roleOf = p => p.allowed_ips.some(a => /\/0$/.test(a)) ? 'gateway' : p.allowed_ips.some(isNetwork) ? 'site' : 'client';
// [badge text, tooltip] for each peer role from roleOf().
const ROLE = { gateway: ['all traffic', 'The peer is allowed to carry every address: a full-tunnel gateway'], site: ['site', 'The peer is a whole network behind another router'], client: ['client', 'The peer is a single host'] };

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

// Card header: state dot, name, state, firewall zone and total traffic of the interface.
function header(i) {
  const state = !i.enabled ? ['disabled', ''] : i.up ? ['up', 'success'] : ['down', 'danger'];
  return h('div', { className: 'wg-head' },
    h('span', { className: `dot ${i.up ? 'up' : 'down'}` }), icon('key', 20),
    h('strong', { className: 'name' }, i.name),
    badge(state[0], state[1]),
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

// One peer row: identity and role, endpoint, allowed IPs (networks highlighted), handshake state, keepalive
// and traffic. Disabled peers are dimmed; peers added with `wg set` are flagged as not in the configuration.
function peerRow(i, p) {
  const [roleText, roleTitle] = ROLE[roleOf(p)];
  const rx = rateNow(i, p, 'rx'), tx = rateNow(i, p, 'tx');
  return h('tr', { className: p.enabled ? '' : 'wg-off' },
    h('td', {}, p.name ? h('strong', {}, p.name) : muted('unnamed'), ' ', badge(roleText, 'info', roleTitle),
      h('div', {}, h('span', { className: 'mono small muted', title: p.public_key }, shortKey(p.public_key))),
      p.configured ? null : h('div', { className: 'muted small' }, 'not in the configuration (added at run time)')),
    h('td', {}, p.endpoint ? mono(p.endpoint) : muted('none yet (roaming peer)')),
    h('td', {}, h('div', { className: 'wg-allowed' }, p.allowed_ips.map(a => h('span', { className: `mono wg-ip ${isNetwork(a) ? 'net' : ''}` }, a))),
      p.allowed_ips.some(isNetwork) ? h('div', { className: 'muted small' }, p.route_allowed_ips ? 'routes installed' : 'routes not installed') : null),
    h('td', {}, h('div', {}, h('span', { className: `dot ${p.state === 'connected' ? 'up' : p.state === 'stale' ? 'idle' : 'down'}` }), ' ', stateBadge(p)),
      p.handshake_age != null ? h('div', { className: 'muted small' }, `${fmtSpan(p.handshake_age)} ago`) : null),
    h('td', { className: 'num' }, p.keepalive ? `${p.keepalive}s` : muted('off')),
    h('td', { className: 'num' }, h('div', {}, icon('arrow-down', 12), fmtLine(rx)), h('div', {}, icon('arrow-up', 12), fmtLine(tx))),
    h('td', { className: 'num' }, h('div', {}, icon('arrow-down', 12), fmtBytes(p.rx_bytes ?? 0)), h('div', {}, icon('arrow-up', 12), fmtBytes(p.tx_bytes ?? 0))));
}

// Table of an interface's peers.
function peersTable(i) {
  const cols = ['Peer', 'Endpoint', 'Allowed IPs', 'Handshake', 'Keepalive', 'Traffic now', 'Total'];
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table wg-table' },
    h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
    h('tbody', {}, i.peers.length ? i.peers.map(p => peerRow(i, p)) : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'No peers are configured on this interface.')))));
}

// The card for one interface: header, then settings next to the peers table.
export function interfaceCard(i) {
  return h('div', { className: `card wg-card ${i.up ? '' : 'is-down'}` },
    header(i),
    h('div', { className: 'wg-body' }, settings(i), peersTable(i)));
}
