// The Routing page's model for the kernel routing state: what the routes, tables and rules say, which tables
// exist, what looks wrong, how the route list is filtered and sorted, and what the answer of the next-hop
// lookup means. Pure functions with no DOM and no network, so they are unit-tested directly.
//
// Data shape (flab.routing status):
//   { available, truncated, bird, table_ids: { name: number },
//     routes: [{ family, table, type, prefix, len, from, proto, scope, metric, src, pref, expires, mtu, flags,
//                nexthops: [{ via, dev, weight, flags }] }],
//     rules:  [{ family, priority, selectors: [[name, value]], action, table, goto, suppress_prefixlength }] }
// The lookup reply (flab.routing lookup) is described in rpcd/ucode/flab.routing.uc.
import { prefixKey } from './bgp/util.js';

//#region Addresses

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

// Whether the text is an IPv4 or IPv6 address.
export const isAddress = text => parseAddress(text) != null;

// Whether the address lies inside the prefix "address/length" (the address and the prefix must be of one family).
export function covers(prefix, address) {
  const [net, len] = String(prefix).split('/');
  const n = parseAddress(net), a = parseAddress(address);
  if (!n || !a || n.family !== a.family) return false;
  const bits = n.family === 6 ? 128n : 32n;
  const shift = bits - BigInt(len === undefined ? bits : len);
  return shift >= 0n && (n.value >> shift) === (a.value >> shift);
}

//#endregion

//#region Routes and tables

// Route types that drop the packet instead of forwarding it.
export const DROPS = ['blackhole', 'unreachable', 'prohibit', 'throw'];

// What each dropping type means, for the lookup answer and the table.
export const DROP_TEXT = {
  blackhole: 'silently discarded (blackhole route)',
  unreachable: 'rejected with "host unreachable" (unreachable route)',
  prohibit: 'rejected with "administratively prohibited" (prohibit route)',
  throw: 'skipped: the lookup continues in the next routing table (throw route)',
};

// The identity of a route as the kernel keeps it: family, table, prefix, source prefix and metric.
export const routeKey = r => `${r.family}|${r.table}|${r.prefix}|${r.from ?? ''}|${r.metric ?? 0}`;

// "default" for a zero-length prefix, otherwise the prefix.
export const destination = r => (r.len === 0 ? 'default' : r.prefix);

// The first (or only) next hop of a route that has one, else null.
export const firstHop = r => r.nexthops[0] ?? null;

// A route as one line of `ip route` text (without the table), for the lookup answer.
export function routeText(r) {
  const parts = [r.type !== 'unicast' ? r.type : null, destination(r), r.from ? `from ${r.from}` : null];
  const hops = r.nexthops.map(n => [n.via ? `via ${n.via}` : null, n.dev ? `dev ${n.dev}` : null, n.weight != null && r.nexthops.length > 1 ? `weight ${n.weight}` : null, ...n.flags].filter(Boolean).join(' '));
  if (hops.length === 1) parts.push(hops[0]);
  parts.push(r.proto ? `proto ${r.proto}` : null, r.scope ? `scope ${r.scope}` : null, r.src ? `src ${r.src}` : null, r.metric != null ? `metric ${r.metric}` : null);
  const line = parts.filter(Boolean).join(' ');
  return hops.length > 1 ? `${line}\n${hops.map(x => `  nexthop ${x}`).join('\n')}` : line;
}

// The number of a table: the kernel's `table_ids` entry for a name, or the number itself for "220".
export function tableId(name, ids) {
  if (ids?.[name] != null) return ids[name];
  return /^\d+$/.test(String(name)) ? +name : null;
}

// "main (254)", "220", "local (255)": the name with its number when they differ.
export function tableLabel(name, ids) {
  const id = tableId(name, ids);
  return id == null || String(id) === String(name) ? String(name) : `${name} (${id})`;
}

// What a table is for, in a few words, for the well-known ones.
const TABLE_ROLE = {
  main: 'ordinary routes',
  local: 'addresses of this router and broadcasts',
  default: 'rarely used',
  prelocal: 'consulted before the local table',
};

// Every routing table that holds a route or is named by a rule or in rt_tables, as
// [{ name, id, role, v4, v6, rules: [priority...] }] with the well-known tables first.
export function tablesOf(data) {
  const names = new Map();
  const add = name => { if (!names.has(name)) names.set(name, { name, id: tableId(name, data.table_ids), role: TABLE_ROLE[name] ?? '', v4: 0, v6: 0, rules: [] }); return names.get(name); };
  add('main');
  for (const r of data.routes) add(r.table)[r.family === 6 ? 'v6' : 'v4']++;
  for (const rule of data.rules) if (rule.action === 'lookup' && rule.table != null) add(rule.table).rules.push(rule.priority);
  const order = n => (n === 'main' ? 0 : n === 'local' ? 1 : 2);
  return [...names.values()].map(t => ({ ...t, rules: [...new Set(t.rules)].sort((a, b) => a - b) }))
    .sort((a, b) => order(a.name) - order(b.name) || (a.id ?? 1e9) - (b.id ?? 1e9) || a.name.localeCompare(b.name));
}

// The default routes of one family in the main table, best (lowest metric) first. A source-specific default
// route (IPv6 "default from <prefix>") counts too, and so does one that drops everything (a blackhole default).
export function defaultRoutes(data, family) {
  return data.routes.filter(r => r.family === family && r.table === 'main' && r.len === 0 && (r.type === 'unicast' || DROPS.includes(r.type)))
    .sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0));
}

// The policy rules the kernel installs itself; any other rule was added by someone.
export const isKernelRule = rule => rule.action === 'lookup' && rule.selectors.length === 1 && rule.selectors[0][0] === 'from' && rule.selectors[0][1] === 'all'
  && ((rule.priority === 0 && rule.table === 'local') || (rule.priority === 32766 && rule.table === 'main') || (rule.priority === 32767 && rule.table === 'default'));

// The rules that send lookups to a table.
export const rulesFor = (data, table) => data.rules.filter(r => r.action === 'lookup' && r.table === table);

// Who most likely added a rule, as { kind, label, title }. The kernel does not record the author of a rule, so this is
// inferred from evidence: the kernel's own three rules; a rule configured in /etc/config/network (same family and
// priority), which netifd installs; strongSwan's default (priority 220, table 220, every packet), which charon adds
// when it starts; netifd's reject rule for a delegated IPv6 prefix (priority 4200000000). Anything else is unknown.
export function ruleOrigin(rule, data) {
  if (isKernelRule(rule)) return { kind: 'kernel', label: 'kernel', title: 'One of the three rules the kernel creates at boot' };
  const configured = (data.uci_rules ?? []).find(u => u.family === rule.family && u.priority === rule.priority);
  if (configured) {
    const name = configured.anonymous ? `a "config ${configured.family === 6 ? 'rule6' : 'rule'}" section` : `"config ${configured.family === 6 ? 'rule6' : 'rule'} ${configured.section}"`;
    return { kind: 'netifd', label: 'netifd', title: `Configured in /etc/config/network (${name}, priority ${rule.priority}); netifd installs it` };
  }
  const everyPacket = rule.selectors.every(([k, v]) => k === 'from' && v === 'all');
  if (rule.priority === 220 && rule.action === 'lookup' && rule.table === '220' && everyPacket) {
    return { kind: 'strongswan', label: 'strongSwan', title: `Priority 220 and table 220 are strongSwan's defaults (charon.routing_table_prio and charon.routing_table); charon adds this rule when it starts${data.charon ? '' : '. strongSwan is not running now, so the rule may be a leftover'}` };
  }
  if (rule.family === 6 && rule.priority === 4200000000 && rule.action === 'unreachable' && rule.selectors.some(([k]) => k === 'iif')) {
    return { kind: 'netifd', label: 'netifd', title: 'Rejects traffic from a delegated IPv6 prefix that arrives on the wrong interface (source-based routing); this is the pattern netifd uses, inferred from the priority and the rule' };
  }
  return { kind: 'unknown', label: 'unknown', title: 'The kernel does not say who added a rule. It is not one of the kernel\'s own, and matches neither strongSwan\'s defaults nor a rule configured in /etc/config/network; a script, a hotplug event or another service added it' };
}

// The logical interface (netifd name) of each device, from `network.interface dump`: Map device -> name.
export function interfaceNames(dump) {
  const map = new Map();
  for (const i of dump?.interface ?? []) {
    for (const dev of [i.l3_device, i.device]) if (dev && !map.has(dev)) map.set(dev, i.interface);
  }
  return map;
}

// What deserves attention in the routing state, as [{ level: 'bad' | 'warn' | 'info', text }].
export function findings(data) {
  const out = [];
  if (!data.available) return [{ level: 'bad', text: 'The router did not report any route: the ip tool could not be run.' }];
  const v4 = defaultRoutes(data, 4), v6 = defaultRoutes(data, 6);
  if (!v4.length) out.push({ level: 'warn', text: 'There is no IPv4 default route, so this router cannot reach addresses outside its directly connected networks.' });
  if (!v6.length) out.push({ level: 'info', text: 'There is no IPv6 default route.' });
  for (const r of [...defaultRoutes(data, 4), ...defaultRoutes(data, 6)].filter(x => DROPS.includes(x.type))) out.push({ level: 'bad', text: `The IPv${r.family} default route is a ${r.type} route: everything that matches no other route is dropped.` });
  const down = data.routes.filter(r => r.nexthops.some(n => n.flags.includes('dead') || n.flags.includes('linkdown')));
  if (down.length) out.push({ level: 'bad', text: `${down.length} route${down.length === 1 ? ' uses' : 's use'} a next hop that is down (${down.slice(0, 3).map(r => `${destination(r)} via ${r.nexthops.find(n => n.flags.includes('dead') || n.flags.includes('linkdown')).dev ?? '?'}`).join(', ')}${down.length > 3 ? ', ...' : ''}).` });
  if (data.truncated) out.push({ level: 'info', text: 'The router has more routes than are listed here; only the first part of each family is shown.' });
  return out;
}

//#endregion

//#region Filtering and sorting

// The routes that pass the family selector ('all', '4', '6'), the table selector ('all' or a table name) and the
// filter text (every word must appear in the destination, type, next hops, devices, interface names, protocol,
// source or table).
export function filterRoutes(routes, { q = '', family = 'all', table = 'all' }, names = new Map()) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return routes.filter(r => {
    if (family !== 'all' && String(r.family) !== String(family)) return false;
    if (table !== 'all' && r.table !== table) return false;
    if (!words.length) return true;
    const hay = [r.prefix, destination(r), r.type, r.from, r.proto, r.scope, r.src, r.table, r.pref,
      ...r.nexthops.flatMap(n => [n.via, n.dev, names.get(n.dev)])].filter(Boolean).join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

// Sort keys of the route list columns; each returns a comparable value.
export const SORT_KEYS = {
  prefix: r => prefixKey(r.prefix),
  type: r => r.type,
  next_hop: r => (r.nexthops[0]?.via ? prefixKey(`${r.nexthops[0].via}/0`) : -1n),
  dev: r => r.nexthops[0]?.dev ?? '',
  proto: r => r.proto ?? '',
  metric: r => r.metric ?? 0,
  table: r => r.table,
};

// A copy of the routes ordered by the column in `sort` ({ key, dir: 1 | -1 }); ties keep the main table first and
// then the destination order, so a table's routes stay readable.
export function sortRoutes(routes, sort) {
  const key = SORT_KEYS[sort.key] ?? SORT_KEYS.prefix;
  const rank = t => (t === 'main' ? 0 : t === 'local' ? 2 : 1);
  return [...routes].sort((a, b) => {
    const x = key(a), y = key(b);
    const primary = (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    const px = prefixKey(a.prefix), py = prefixKey(b.prefix);
    return primary || rank(a.table) - rank(b.table) || (px < py ? -1 : px > py ? 1 : 0) || (a.metric ?? 0) - (b.metric ?? 0);
  });
}

//#endregion

//#region The next-hop lookup

// The routes (any table) whose prefix covers the address, most specific first, then lowest metric.
export function coveringRoutes(routes, address) {
  const a = parseAddress(address);
  if (!a) return [];
  return routes.filter(r => r.family === a.family && covers(r.prefix, address))
    .sort((x, y) => y.len - x.len || (x.metric ?? 0) - (y.metric ?? 0));
}

// What the kernel's answer to a lookup means: { verdict, text, route, ... }.
//   verdict 'invalid'  the input was refused (text says why)
//   verdict 'forward'  the packet is sent on: nextHop (null = the destination is on the link), dev, src, table
//   verdict 'local'    the address belongs to this router (also 'broadcast', 'multicast', 'anycast')
//   verdict 'drop'     a blackhole, unreachable or prohibit route catches it (route says which)
//   verdict 'none'     no route covers the address
//   verdict 'error'    the kernel refused for another reason (text has its message)
// `routes` are the routes of the status data, used to name the route behind a refusal, which the kernel only
// reports as an error code.
export function interpret(res, routes) {
  if (!res) return null;
  if (!res.ok) return { verdict: 'invalid', text: res.error };
  const g = res.get;
  const route = res.match ?? null;
  if (g.ok) {
    if (['local', 'broadcast', 'multicast', 'anycast'].includes(g.type)) {
      return { verdict: g.type, text: { local: 'This address belongs to this router.', broadcast: 'This is a broadcast address of a directly connected network.', multicast: 'This is a multicast address.', anycast: 'This is an anycast address of this router.' }[g.type], route, table: g.table, dev: route?.nexthops[0]?.dev ?? g.dev, src: g.src };
    }
    return {
      verdict: 'forward', route, table: route?.table ?? g.table, nextHop: g.via, dev: g.dev, src: g.src,
      paths: route?.nexthops.length ?? 1,
      text: g.via ? `Sent on to ${g.via} through ${g.dev}.` : `The destination is directly reachable through ${g.dev}.`,
    };
  }
  const covering = coveringRoutes(routes, res.dst).filter(r => r.table !== 'local');
  const special = covering.find(r => DROPS.includes(r.type));
  if (special) return { verdict: 'drop', route: special, table: special.table, text: `The packet is ${DROP_TEXT[special.type]}.` };
  if (covering.length && covering.every(r => r.from)) {
    // A source-specific route (IPv6 "default from <prefix>") only matches packets from that prefix, so a lookup without a
    // fitting source fails even though a default route exists.
    return { verdict: 'none', text: `Only routes restricted to certain source addresses cover this address (${covering[0].from}). Fill in "From" with an address inside such a prefix.` };
  }
  if (/unreachable/i.test(g.error ?? '') && !covering.length) return { verdict: 'none', text: 'No route covers this address, so the packet cannot be sent.' };
  return { verdict: 'error', text: g.error };
}

//#endregion
