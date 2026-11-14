// Address math of the WireGuard page: CIDR parsing and comparison (allowed IPs, interface addresses), the next free address of a
// tunnel network, and what an endpoint address looks like. Pure functions, no DOM and no network; addresses are BigInt values
// (core/ip.js), so IPv4 and IPv6 are handled the same way.
import { parseAddress } from '../../core/ip.js';

// The number of bits of an address of each family.
const BITS = { 4: 32, 6: 128 };

// The netmask words netifd accepts after the slash of an IPv4 address ("192.168.1.1/255.255.255.0") as a prefix length, or null.
function maskPrefix(text) {
  const a = parseAddress(text);
  if (!a || a.family !== 4) return null;
  const inverted = (~a.value) & 0xffffffffn;
  // A netmask is a run of ones then zeros, so its inverse plus one is a power of two.
  if ((inverted & (inverted + 1n)) !== 0n) return null;
  return inverted === 0n ? 32 : 32 - inverted.toString(2).length;
}

// Parses "address/prefix" into { family, value, prefix, bits, first, last, text } (`first` and `last` are the network's lowest and highest
// address), or null when it is not one. Options: `bare` accepts an address without a prefix (a host: /32 or /128) and
// `mask` accepts a dotted netmask after the slash, as the interface `addresses` option does.
export function parseCidr(text, { bare = false, mask = false } = {}) {
  const t = String(text ?? '').trim();
  const slash = t.indexOf('/');
  const addr = parseAddress(slash < 0 ? t : t.slice(0, slash));
  if (!addr) return null;
  const bits = BITS[addr.family];
  let prefix;
  if (slash < 0) {
    if (!bare) return null;
    prefix = bits;
  } else {
    const p = t.slice(slash + 1);
    if (/^\d{1,3}$/.test(p)) prefix = +p;
    else if (mask && addr.family === 4) prefix = maskPrefix(p);
    else return null;
    if (prefix == null || prefix > bits) return null;
  }
  const hostBits = BigInt(bits - prefix);
  const first = (addr.value >> hostBits) << hostBits;
  const last = first | ((1n << hostBits) - 1n);
  return { family: addr.family, value: addr.value, prefix, bits, first, last, text: t };
}

// Whether the network `a` contains the whole of network `b` (the same family).
export const covers = (a, b) => a.family === b.family && a.first <= b.first && b.last <= a.last;
// Whether two networks share any address.
export const overlaps = (a, b) => a.family === b.family && a.first <= b.last && b.first <= a.last;
// Whether the address of `cidr` lies inside the network `net`.
export const holds = (net, cidr) => net.family === cidr.family && net.first <= cidr.value && cidr.value <= net.last;

// An address as text: dotted for IPv4, RFC 5952 for IPv6 (the longest run of zero groups, at least two, becomes "::").
export function formatAddress(family, value) {
  if (family === 4) return [24n, 16n, 8n, 0n].map(s => String((value >> s) & 0xffn)).join('.');
  const groups = Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(112 - 16 * i)) & 0xffffn));
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  const hex = groups.map(g => g.toString(16));
  if (best.len < 2) return hex.join(':');
  return `${hex.slice(0, best.at).join(':')}::${hex.slice(best.at + best.len).join(':')}`;
}

// The address of a parsed CIDR as text, without the prefix.
export const addressText = c => formatAddress(c.family, c.value);

// The text of a network: its first address and the prefix ("192.168.2.0/24").
export const networkText = c => `${formatAddress(c.family, c.first)}/${c.prefix}`;

// The host addresses a client of the tunnel network `net` (the interface's own address and prefix) may take, as CIDR texts of one
// address each ("10.8.0.2/32", "fd00::2/128"): the first address after the interface's own that no peer's allowed IPs cover. The
// network address and an IPv4 broadcast address are skipped. `taken` is the list of parsed CIDRs already in use (the allowed IPs
// of the interface's peers). Returns null when the network has no room (a /31 or smaller, or all of the first 65534 addresses used).
export function nextFreeHost(net, taken) {
  const hostBits = BigInt(net.bits - net.prefix);
  if (hostBits < 2n) return null;
  // The first address worth trying: the one after the interface's own, or the first host of the network when the own address
  // is outside the network's host range.
  const lowest = net.first + 1n;
  const highest = net.family === 4 ? net.last - 1n : net.last;
  let candidate = net.value >= lowest && net.value < highest ? net.value + 1n : lowest;
  for (let tries = 0; tries < 65534 && candidate <= highest; tries++, candidate++) {
    if (candidate === net.value) continue;
    const host = { family: net.family, value: candidate, first: candidate, last: candidate };
    if (!taken.some(t => overlaps(t, host))) return `${formatAddress(net.family, candidate)}/${net.bits}`;
  }
  return null;
}

//#region Endpoints

// Whether `text` can be a host name (letters, digits, hyphens in labels separated by dots; at most 253 characters).
export const isHostname = text => /^(?=.{1,253}$)[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*$/.test(text);

// What is wrong with an endpoint host that makes it unlikely to be reachable, as a list of short phrases (empty when it looks fine).
// An IPv6 address may be written in square brackets. `tunnels` is the list of parsed networks of the router's own tunnel addresses.
export function endpointProblems(host, tunnels = []) {
  const text = String(host ?? '').trim().replace(/^\[(.*)\]$/, '$1');
  if (!text) return [];
  const a = parseAddress(text);
  const out = [];
  if (!a) {
    const lower = text.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.localhost')) out.push('is this router itself');
    else if (!lower.includes('.')) out.push('is a name without a dot, which the router may not be able to resolve');
    else if (/\.(local|lan|home|internal|localdomain)$/.test(lower)) out.push('ends in a domain that public DNS does not know');
    return out;
  }
  // Whether the address is inside the network `cidr` (a CIDR text).
  const inside = (cidr) => holds(parseCidr(cidr), { family: a.family, value: a.value });
  if (a.family === 4) {
    if (inside('0.0.0.0/8')) out.push('is not a usable address (0.0.0.0/8)');
    else if (inside('127.0.0.0/8')) out.push('is this router itself (loopback)');
    else if (inside('169.254.0.0/16')) out.push('is a link-local address, valid only on one link');
    else if (inside('224.0.0.0/4') || a.value === 0xffffffffn) out.push('is a multicast or broadcast address');
  } else {
    if (a.value === 0n) out.push('is the unspecified address (::)');
    else if (a.value === 1n) out.push('is this router itself (loopback)');
    else if (inside('fe80::/10')) out.push('is a link-local address, valid only on one link');
    else if (inside('ff00::/8')) out.push('is a multicast address');
  }
  if (tunnels.some(t => holds(t, { family: a.family, value: a.value }))) out.push('is inside one of this router\'s own tunnel networks, so its packets would be sent into the tunnel they are meant to set up');
  return out;
}

//#endregion
