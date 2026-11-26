// IP address and CIDR parsing shared by the pages that compare, order or edit addresses (Routing, BGP, Interfaces, WireGuard).
// Pure functions: no DOM and no network. Addresses become BigInt values so IPv4 and IPv6 are compared the same way.

// An IPv4 address as a BigInt, or null when it is not one.
function v4Value(text) {
  const p = text.split('.');
  if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || +x > 255)) return null;
  return p.reduce((n, x) => n * 256n + BigInt(x), 0n);
}

// An IPv6 address as a BigInt (with "::" compression and an optional IPv4 tail), or null when it is not one.
function v6Value(text) {
  if (!/^[0-9a-f:.]+$/i.test(text) || (text.match(/::/g) ?? []).length > 1) return null;
  let body = text;
  // An embedded IPv4 address ("::ffff:1.2.3.4") stands for the last two groups.
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':') + 1;
    const v4 = v4Value(text.slice(cut));
    if (v4 == null) return null;
    body = `${text.slice(0, cut)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  // The colon-separated groups of one side of "::", or none when that side is empty.
  const part = x => (x ? x.split(':') : []);
  let groups;
  if (body.includes('::')) {
    const [head, rest] = body.split('::');
    const a = part(head), b = part(rest);
    if (a.length + b.length > 7) return null;
    groups = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  } else {
    groups = part(body);
  }
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

// The number of bits of an address of each family.
const BITS = { 4: 32, 6: 128 };

// The prefix length of a dotted IPv4 netmask (255.255.255.0 gives 24), or null when it is not a contiguous mask.
export function maskPrefix(text) {
  const a = parseAddress(text);
  if (a?.family !== 4) return null;
  const bits = a.value.toString(2).padStart(32, '0');
  return /^1*0*$/.test(bits) ? (bits.indexOf('0') < 0 ? 32 : bits.indexOf('0')) : null;
}

// Parses "address", "address/prefix" or (with `mask`) "address/255.255.255.0" into
// { family, value, prefix, hasPrefix, size, network, last }: `network` and `last` are the lowest and highest address of the
// prefix, `size` the bits of the family. Options: `family` (4 or 6) refuses the other family, `mask` accepts a dotted netmask
// after the slash, and `bare` says what an address without a prefix is: 'host' (a /32 or /128, the default), 'keep' (no
// prefix: `prefix` is null, `hasPrefix` false) or 'refuse' (null). Null when the text is not an address with a valid prefix.
export function parseCidr(text, { family, mask = false, bare = 'host' } = {}) {
  const t = String(text ?? '').trim();
  const slash = t.indexOf('/');
  const a = parseAddress(slash < 0 ? t : t.slice(0, slash));
  if (!a || (family && a.family !== family)) return null;
  const size = BITS[a.family];
  let prefix;
  if (slash < 0) {
    if (bare === 'refuse') return null;
    prefix = bare === 'keep' ? null : size;
  } else {
    const p = t.slice(slash + 1);
    if (/^\d{1,3}$/.test(p)) prefix = +p;
    else if (mask && a.family === 4) prefix = maskPrefix(p);
    else return null;
    if (prefix == null || prefix > size) return null;
  }
  if (prefix == null) return { family: a.family, value: a.value, prefix, hasPrefix: false, size, network: a.value, last: a.value };
  const hostBits = BigInt(size - prefix);
  const network = (a.value >> hostBits) << hostBits;
  return { family: a.family, value: a.value, prefix, hasPrefix: true, size, network, last: network | ((1n << hostBits) - 1n) };
}

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

// { family, value } of an IPv4 or IPv6 address (a BigInt value), or null.
export function parseAddress(text) {
  const t = String(text ?? '').trim();
  if (t.includes(':')) {
    const value = v6Value(t);
    return value == null ? null : { family: 6, value };
  }
  const value = v4Value(t);
  return value == null ? null : { family: 4, value };
}
