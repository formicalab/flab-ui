// Helpers shared by the BGP page modules.

import { h } from '../../core/dom.js';
import { ipNum } from '../../core/format.js';

const PALETTE_SIZE = 6;

// Each peer keeps one color across the topology, the route table and the announcement matrix.
export const peerClass = (data, name) => `pc-${Math.max(0, data.peers.findIndex(p => p.name === name)) % PALETTE_SIZE}`;
export const peerDot = (data, name) => h('span', { className: `peer-dot ${peerClass(data, name)}` });
export const peerTitle = p => p.description || p.name;

export const stateKind = s => s === 'Established' ? 'success' : /idle|down/i.test(s ?? '') ? 'danger' : 'warning';
export const isUp = p => p.state === 'Established';

// RFC 6996 private AS ranges (16-bit and 32-bit).
export const isPrivateAs = n => (n >= 64512 && n <= 65534) || (n >= 4200000000 && n <= 4294967294);

// Numeric sort key for "a.b.c.d/len" prefixes.
export const prefixKey = prefix => {
  const [ip, len] = prefix.split('/');
  return ipNum(ip) * 64 + Number(len ?? 0);
};

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
