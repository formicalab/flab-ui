// IP address parsing shared by the pages that compare or order addresses (Routing, BGP). Pure functions: no DOM
// and no network. Addresses become BigInt values so IPv4 and IPv6 are compared the same way.

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
