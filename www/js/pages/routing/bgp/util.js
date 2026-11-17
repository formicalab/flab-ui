// Helpers shared by the BGP tab modules.

import { h } from '../../../core/dom.js';
import { parseAddress } from '../../../core/ip.js';

// Number of distinct peer color classes (pc-0..pc-5 in css/bgp.css).
const PALETTE_SIZE = 6;

//#region peer colors
// A peer keeps its color while it exists: slots are assigned on first sight (lowest least-used slot) and
// are not reshuffled when other peers appear or disappear. More peers than colors reuse the least-used slot.
// Module-level so colors survive the redraw on every poll: peer name -> palette slot. `synced` makes sure
// each data object is processed once even though peerClass() is called many times per render.
const slots = new Map();
const synced = new WeakSet();

// Updates `slots` for the peers in `data`: forgets vanished peers and gives new ones the least-used slot.
function syncColors(data) {
  if (synced.has(data)) return;
  synced.add(data);
  const present = new Set(data.peers.map(p => p.name));
  for (const name of [...slots.keys()]) if (!present.has(name)) slots.delete(name);
  for (const p of data.peers) {
    if (slots.has(p.name)) continue;
    const used = new Map();
    for (const s of slots.values()) used.set(s, (used.get(s) ?? 0) + 1);
    let best = 0;
    for (let s = 1; s < PALETTE_SIZE; s++) if ((used.get(s) ?? 0) < (used.get(best) ?? 0)) best = s;
    slots.set(p.name, best);
  }
}

// CSS class (pc-N) of a peer's color; stable while the peer exists (see syncColors).
export const peerClass = (data, name) => { syncColors(data); return `pc-${slots.get(name) ?? 0}`; };
// Small colored dot that matches the peer's color everywhere it is listed.
export const peerDot = (data, name) => h('span', { className: `peer-dot ${peerClass(data, name)}` });
// Display title of a peer: its description, or the protocol name when it has none.
export const peerTitle = p => p.description || p.name;

// Peer names without the prefix they all share ("azure_xfrm0".."azure_xfrm3" -> "xfrm0".."xfrm3").
export function peerLabels(peers) {
  const names = peers.map(p => p.name);
  const labels = new Map(names.map(n => [n, n]));
  if (names.length < 2) return labels;
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const cut = Math.max(prefix.lastIndexOf('_'), prefix.lastIndexOf('-'), prefix.lastIndexOf('.')) + 1;
  if (cut > 0) for (const n of names) labels.set(n, n.slice(cut) || n);
  return labels;
}
//#endregion

// Badge kind for a BGP FSM state: only Established is healthy; Idle/Down are failures, the rest
// (Connect, Active, OpenSent, ...) are transitional.
export const stateKind = s => s === 'Established' ? 'success' : /idle|down/i.test(s ?? '') ? 'danger' : 'warning';
// True when the peer's BGP session is Established.
export const isUp = p => p.state === 'Established';

// RFC 6996 private AS ranges (16-bit and 32-bit).
export const isPrivateAs = n => (n >= 64512 && n <= 65534) || (n >= 4200000000 && n <= 4294967294);

//#region prefix ordering (IPv4 before IPv6, then numerically)
// BigInt sort key for "address/len" (len optional); works for both families. Layout: bit 140 = IPv6 (so
// IPv4 sorts first), the address above the 8-bit length field (128-bit address << 8, so a shorter prefix
// sorts before a longer one at the same address).
export function prefixKey(prefix) {
  const [ip, len] = String(prefix ?? '').split('/');
  const v6 = ip.includes(':');
  const addr = parseAddress(ip)?.value ?? 0n;
  return ((v6 ? 1n : 0n) << 140n) | (addr << 8n) | BigInt(Number(len) || 0);
}

// Comparator over prefixKey for Array.sort.
export const cmpPrefix = (a, b) => {
  const x = prefixKey(a), y = prefixKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

// First address of a next-hop string (IPv6 next hops may list a global and a link-local address).
export const firstAddress = text => String(text ?? '').split(/\s+/)[0] ?? '';
//#endregion

// AS path as chips; consecutive repeats (prepending) collapse into "65520 ×2".
export function asPath(path) {
  if (!path.length) return h('span', { className: 'muted' }, 'empty');
  const runs = [];
  for (const a of path) {
    const last = runs.at(-1);
    if (last && last.as === a) last.n++; else runs.push({ as: a, n: 1 });
  }
  const nodes = [];
  runs.forEach((r, i) => {
    if (i) nodes.push(h('span', { className: 'as-sep' }, '›'));
    nodes.push(h('span', { className: 'as-chip', title: r.n > 1 ? `AS${r.as} appears ${r.n} times (path prepending)` : `AS${r.as}` }, r.n > 1 ? `${r.as} ×${r.n}` : r.as));
  });
  return h('span', { className: `as-path ${path.length > 1 ? 'transit' : 'direct'}`, title: `${path.length} AS hop${path.length === 1 ? '' : 's'}` }, nodes);
}

// "0,12076" -> "0:12076", "65515, 1, 2" -> "65515:1:2".
export const communityText = c => c.replace(/,\s*/g, ':');
