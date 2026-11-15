// The model of the Routing page's static-route editor: the `route` (IPv4) and `route6` (IPv6) sections of /etc/config/network as an
// editable table. Pure functions with no DOM and no network, so they are unit-tested directly (tests/routeedit/model.test.mjs).
//
// What netifd reads from a route section (netifd's interface-ip.c): interface, target, netmask, gateway, metric, mtu, valid, table,
// source, onlink, type, proto and disabled. The page edits the first six, `source`, `onlink`, `type` and `disabled` ("Enabled"), and
// leaves the others (`valid`, `proto`) alone. `target` may carry a prefix length ("10.0.0.0/8"); a plain address is a host route.
// Older configs give an IPv4 route's prefix length in `netmask`, so the page shows `target` and `netmask` together as one prefix, and
// writes the prefix into `target` (and removes `netmask`) only for a route whose target was edited. `source` is a source prefix, not
// a preferred source address: the route is used only for packets coming from it.
//
// Data (readStatic): { available, routes: [{ section, family, values }], interfaces: [{ name, up, v4, v6 }], kernel, tableIds }.
// The draft (draftFrom) is { rows: [{ key, section, family, removed, values }], next }; a row's `values` are the strings of FIELDS
// (and booleans for `onlink` and `enabled`).
import { parseAddress } from '../../core/ip.js';
import { sectionsOf, uciBool } from '../../core/fields.js';
import { tableId } from './model.js';

export const CONFIG = 'network';

// The two kinds of route section.
export const FAMILIES = [
  { family: 4, type: 'route', label: 'IPv4' },
  { family: 6, type: 'route6', label: 'IPv6' },
];

// The route types the page offers: [value, label]. An empty value is the normal route (netifd's default, "unicast").
export const ROUTE_TYPES = [
  ['', 'unicast (normal)'],
  ['blackhole', 'blackhole (drop silently)'],
  ['unreachable', 'unreachable (reject)'],
  ['prohibit', 'prohibit (reject)'],
  ['throw', 'throw (use the next table)'],
  ['local', 'local'],
  ['broadcast', 'broadcast'],
  ['multicast', 'multicast'],
  ['anycast', 'anycast'],
];

// The types that do not forward to a gateway: a gateway on one of them is ignored.
const NO_GATEWAY = ['blackhole', 'unreachable', 'prohibit', 'throw', 'local', 'broadcast', 'multicast', 'anycast'];

// The editable columns of a route, in the order the table shows them: [key, label, hint]. `onlink` and `enabled` are checkboxes.
export const FIELDS = [
  { key: 'target', label: 'Target', placeholder: '10.0.0.0/8', hint: 'The destination network as address/prefix length; 0.0.0.0/0 or ::/0 is the default route, an address without a length is one host.' },
  { key: 'gateway', label: 'Gateway', placeholder: 'next hop', hint: 'The next hop. Leave it empty for a network that is directly connected on the interface. Not used by blackhole, unreachable, prohibit and throw routes.' },
  { key: 'interface', label: 'Interface', hint: 'The network interface the route belongs to; the route exists while it is up.' },
  { key: 'metric', label: 'Metric', placeholder: '0', hint: 'The lower metric wins when several routes match equally. Give a backup route a higher metric.' },
  { key: 'table', label: 'Table', placeholder: 'main', hint: 'The routing table the route goes into: a number or a name from /etc/iproute2/rt_tables. Empty is the main table.' },
  { key: 'type', label: 'Type', hint: 'What the route does with matching packets.' },
  { key: 'mtu', label: 'MTU', placeholder: 'default', hint: 'Limits the size of packets sent over this route.' },
  { key: 'source', label: 'From', placeholder: 'any source', hint: 'Use the route only for packets that come from this address or prefix (source-based routing; it needs a policy rule that selects the table).' },
  { key: 'onlink', label: 'On-link', bool: true, hint: 'Treat the gateway as directly reachable on the interface even when it is outside its subnets.' },
  { key: 'enabled', label: 'Enabled', bool: true, hint: 'A disabled route stays in the config but is not installed.' },
];

// The text columns, which are also what a blank row is judged on.
const TEXT_KEYS = ['target', 'gateway', 'interface', 'metric', 'table', 'type', 'mtu', 'source'];

//#region Addresses

// The prefix length of an IPv4 netmask in dotted form ("255.255.255.0") or as a number, or null when it is neither.
function maskLength(text) {
  const t = String(text).trim();
  if (/^\d{1,2}$/.test(t)) return +t <= 32 ? +t : null;
  const a = parseAddress(t);
  if (!a || a.family !== 4) return null;
  const bits = a.value.toString(2).padStart(32, '0');
  return /^1*0*$/.test(bits) ? bits.indexOf('0') === -1 ? 32 : bits.indexOf('0') : null;
}

// An address with an optional prefix length ("10.0.0.0/8", "2001:db8::/32", "192.0.2.1") of one family as
// { family, len, value, network, hostBits }, or null when it is not one. `network` is the address with the host bits cleared,
// `hostBits` whether it had any.
export function parseCidr(text, family) {
  const parts = String(text ?? '').trim().split('/');
  if (parts.length > 2) return null;
  const a = parseAddress(parts[0]);
  if (!a || a.family !== family) return null;
  const bits = family === 6 ? 128 : 32;
  if (parts.length === 2 && !/^\d{1,3}$/.test(parts[1])) return null;
  const len = parts.length === 2 ? +parts[1] : bits;
  if (len > bits) return null;
  const shift = BigInt(bits - len);
  const network = (a.value >> shift) << shift;
  return { family, len, value: a.value, network, hostBits: network !== a.value };
}

// A prefix as a comparable text, so "10.0.0.5/8" and "10.0.0.0/8" and a kernel route's "10.0.0.0/8" are one key.
export const cidrKey = c => `${c.family}|${c.network.toString(16)}|${c.len}`;

// Whether an address lies inside a prefix of the same family.
function inside(cidr, address) {
  const bits = cidr.family === 6 ? 128n : 32n;
  const shift = bits - BigInt(cidr.len);
  return address.family === cidr.family && (address.value >> shift) === (cidr.network >> shift);
}

//#endregion

//#region Reading

// A route section's options as the table edits them: the prefix (target and netmask joined), the strings of the other options,
// and the two checkboxes.
export function rowValues(raw, family) {
  const text = k => (raw[k] == null ? '' : String(raw[k]).trim());
  let target = text('target');
  if (family === 4 && target && !target.includes('/') && raw.netmask != null) {
    const len = maskLength(raw.netmask);
    if (len != null) target = `${target}/${len}`;
  }
  return {
    target, gateway: text('gateway'), interface: text('interface'), metric: text('metric'), table: text('table'), type: text('type'),
    mtu: text('mtu'), source: text('source'), onlink: uciBool(raw.onlink, false), enabled: !uciBool(raw.disabled, false),
  };
}

// Reads what the tab shows. `cfg4` and `cfg6` are the `route` and `route6` sections as `uci get` returns them by type (null when the
// login may not read them), `extras` the live state: `status` (flab.routing status) and `dump` (network.interface dump), both
// optional. The interfaces list the logical interfaces with their connected subnets, for the gateway check.
export function readStatic(cfg4, cfg6, { status = null, dump = null } = {}) {
  const available = cfg4 != null && cfg6 != null;
  const routes = FAMILIES.flatMap(f => sectionsOf(f.family === 4 ? cfg4 : cfg6, f.type).map(s => ({ section: s.section, family: f.family, values: s.values })));
  const interfaces = (dump?.interface ?? []).filter(i => i.interface).map(i => ({
    name: i.interface, up: Boolean(i.up), device: i.l3_device ?? i.device ?? null,
    metric: Number(i.metric ?? 0), table4: i.ip4table || 'main', table6: i.ip6table || 'main',
    v4: (i['ipv4-address'] ?? []).map(a => parseCidr(`${a.address}/${a.mask}`, 4)).filter(Boolean),
    v6: (i['ipv6-address'] ?? []).map(a => parseCidr(`${a.address}/${a.mask}`, 6)).filter(Boolean),
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { available, routes, interfaces, kernel: status?.available ? status.routes ?? [] : null, tableIds: status?.available ? status.table_ids ?? {} : null };
}

//#endregion

//#region The draft

// The form's starting values: the router's routes, in file order, IPv4 then IPv6.
export const draftFrom = data => ({
  rows: data.routes.map((r, i) => ({ key: `r${i}`, section: r.section, family: r.family, removed: false, values: rowValues(r.values, r.family) })),
  next: data.routes.length,
});

// A new, empty route row of a family, added to the draft (the page focuses it). It starts enabled.
export function newRow(draft, family) {
  const row = { key: `r${draft.next++}`, section: null, family, removed: false, values: { ...Object.fromEntries(TEXT_KEYS.map(k => [k, ''])), onlink: false, enabled: true } };
  draft.rows.push(row);
  return row;
}

// A value as it is compared and written: trimmed, an IPv6 address in lower case.
const norm = (v, family) => ({
  ...Object.fromEntries(TEXT_KEYS.map(k => [k, family === 6 && ['target', 'gateway', 'source'].includes(k) ? v[k].trim().toLowerCase() : v[k].trim()])),
  onlink: Boolean(v.onlink), enabled: Boolean(v.enabled),
});

// Whether a new row is still empty (it is ignored, like a blank list row). The interface does not count: choosing one is not yet a route.
const isBlank = row => row.section == null && TEXT_KEYS.filter(k => k !== 'interface').every(k => row.values[k].trim() === '') && !row.values.onlink;

// The rows that count: not removed and not a blank new row.
export const liveRows = draft => draft.rows.filter(r => !r.removed && !isBlank(r));

// The label of a family ("IPv4").
const familyLabel = family => (family === 6 ? 'IPv6' : 'IPv4');

// What to call a route in messages: its target, or "new route" while it has none.
const title = row => `${familyLabel(row.family)} route ${row.values.target.trim() || '(no target yet)'}`;

// A route in one line for the review list.
function routeLine(v) {
  return [
    v.type.trim() || null, v.gateway.trim() ? `via ${v.gateway.trim()}` : null, v.interface.trim() || null,
    v.metric.trim() ? `metric ${v.metric.trim()}` : null, v.table.trim() ? `table ${v.table.trim()}` : null, v.mtu.trim() ? `mtu ${v.mtu.trim()}` : null,
    v.source.trim() ? `from ${v.source.trim()}` : null, v.onlink ? 'on-link' : null, v.enabled ? null : 'disabled',
  ].filter(Boolean).join(' · ') || 'empty';
}

// A value as the review list shows it.
const shown = (key, v) => (key === 'onlink' || key === 'enabled' ? (v ? 'on' : 'off') : v === '' ? 'not set' : v);

//#endregion

//#region Changes

// The differences between the router's routes and the draft for the review list: [{ key, label, from, to }].
export function changesOf(data, draft) {
  const out = [];
  const base = new Map(data.routes.map(r => [r.section, r]));
  for (const row of draft.rows) {
    if (isBlank(row)) continue;
    if (row.section == null) {
      if (!row.removed) out.push({ key: `route:${row.key}`, label: `New ${title(row)}`, from: 'none', to: routeLine(row.values) });
      continue;
    }
    const was = base.get(row.section);
    const a = rowValues(was?.values ?? {}, row.family);
    if (row.removed) {
      out.push({ key: `route:${row.key}`, label: `Remove ${title({ ...row, values: a })}`, from: routeLine(a), to: 'removed' });
      continue;
    }
    const x = norm(a, row.family), y = norm(row.values, row.family);
    for (const f of FIELDS) {
      if (x[f.key] !== y[f.key]) out.push({ key: `route:${row.key}:${f.key}`, label: `${title({ ...row, values: a })}: ${f.label}`, from: shown(f.key, x[f.key]), to: shown(f.key, y[f.key]) });
    }
  }
  return out;
}

// Whether the draft differs from the router in any way. A new row counts even while it is empty or only partly filled in: it is not
// saved yet, and a redraw must not drop it.
export const isDirty = (data, draft) => changesOf(data, draft).length > 0 || draft.rows.some(r => r.section == null && !r.removed);

//#endregion

//#region Checks

// The routing table a route lands in, as a comparable key: its number when the name is known, else the name ("main" when empty).
const tableKey = (name, ids) => {
  const t = String(name ?? '').trim() || 'main';
  const id = tableId(t, ids ?? { main: 254, local: 255, default: 253 });
  return id == null ? t : String(id);
};

// Whether a table name or number can be used: a number, a name from rt_tables, or anything when the names are not known.
function tableKnown(text, ids) {
  if (/^\d+$/.test(text)) return +text <= 4294967295;
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) return false;
  return ids == null || ['main', 'local', 'default'].includes(text) || ids[text] != null;
}

// The error for a whole-number field that must lie between `lo` and `hi`, or null.
const rangeError = (text, lo, hi) => (!/^\d+$/.test(text) || +text < lo || +text > hi ? `must be a whole number from ${lo} to ${hi}` : null);

// The errors and warnings of the draft: { errors: [{ key, text }], warnings: [text] }. `key` names the control (route:<row>:<field>),
// so the page can mark it. Errors block Save; warnings do not.
export function problems(data, draft) {
  const errors = [], warnings = [];
  const ifaces = new Map(data.interfaces.map(i => [i.name, i]));
  const seen = new Map();
  for (const row of liveRows(draft)) {
    const v = norm(row.values, row.family);
    const name = title(row);
    const bad = (field, text) => errors.push({ key: `route:${row.key}:${field}`, text: `${name}: ${text}.` });

    const target = parseCidr(v.target, row.family);
    if (!v.target) bad('target', 'the target is required');
    else if (!target) bad('target', `"${v.target}" is not an ${familyLabel(row.family)} address with an optional prefix length such as ${row.family === 6 ? '2001:db8::/32' : '10.0.0.0/8'}`);
    else if (target.hostBits) warnings.push(`${name}: the address has host bits set; the route is for the network with those bits cleared.`);

    if (!v.interface) bad('interface', 'choose the interface the route belongs to');
    else if (data.interfaces.length && !ifaces.has(v.interface)) bad('interface', `there is no interface called "${v.interface}"`);

    const gw = v.gateway ? parseAddress(v.gateway) : null;
    if (v.gateway && (!gw || gw.family !== row.family)) bad('gateway', `"${v.gateway}" is not an ${familyLabel(row.family)} address`);
    if (v.metric && rangeError(v.metric, 0, 4294967295)) bad('metric', `the metric ${rangeError(v.metric, 0, 4294967295)}`);
    if (v.mtu && rangeError(v.mtu, row.family === 6 ? 1280 : 68, 65535)) bad('mtu', `the MTU ${rangeError(v.mtu, row.family === 6 ? 1280 : 68, 65535)}`);
    if (v.table && !tableKnown(v.table, data.tableIds)) bad('table', `"${v.table}" is not a routing table: use a number, or a name from /etc/iproute2/rt_tables`);
    if (v.type && !ROUTE_TYPES.some(([t]) => t === v.type)) bad('type', `"${v.type}" is not one of the route types`);
    if (v.source && !parseCidr(v.source, row.family)) bad('source', `"${v.source}" is not an ${familyLabel(row.family)} address or prefix`);

    if (!v.enabled) continue;
    if (v.gateway && NO_GATEWAY.includes(v.type)) warnings.push(`${name}: a ${v.type} route has no next hop, so its gateway is ignored.`);
    if (v.onlink && !v.gateway) warnings.push(`${name}: "on-link" only matters together with a gateway.`);
    const iface = ifaces.get(v.interface);
    if (iface && !iface.up) warnings.push(`${name}: the interface ${v.interface} is down, so the route is not installed until it comes up.`);
    // A gateway must be reachable on the interface's own subnets (an IPv6 link-local gateway always is), unless the route says on-link.
    if (gw && gw.family === row.family && iface && !v.onlink && !NO_GATEWAY.includes(v.type)) {
      const subnets = row.family === 4 ? iface.v4 : iface.v6;
      const linkLocal = row.family === 6 && (gw.value >> 118n) === 0x3fan;
      if (subnets.some(s => s.value === gw.value)) warnings.push(`${name}: the gateway ${v.gateway} is the router's own address on ${v.interface}.`);
      else if (subnets.length && !linkLocal && !subnets.some(s => inside(s, gw))) warnings.push(`${name}: the gateway ${v.gateway} is not inside a subnet of ${v.interface}, so the kernel refuses the route unless "on-link" is set.`);
    }
    // Two routes that are the same to the kernel (family, table, prefix, source and metric): only one of them can be installed.
    if (target) {
      const key = [row.family, tableKey(v.table, data.tableIds), cidrKey(target), v.source, v.metric || '0'].join('|');
      if (seen.has(key)) warnings.push(`${name} has the same destination, table and metric as ${seen.get(key)}: the kernel keeps only one of them. Give a backup route a higher metric.`);
      else seen.set(key, name);
    }
  }
  return { errors, warnings };
}

// Whether a row is a default route of the main table (a /0 prefix), and so decides where the router's own traffic goes.
const isDefault = (v, family, ids) => {
  const t = parseCidr(v.target, family);
  return Boolean(t) && t.len === 0 && v.enabled && tableKey(v.table, ids) === tableKey('main', ids);
};

// The warnings to confirm before saving: what a change does to the default routes, in plain words. Changing them can leave the
// router without a way to the internet or interrupt a routed management connection.
export function risksOf(data, draft) {
  const out = [];
  const base = new Map(data.routes.map(r => [r.section, r]));
  const kind = v => (NO_GATEWAY.includes(v.type.trim()) ? `${v.type.trim()} default route that drops everything not covered by a more specific route` : 'default route');
  for (const row of draft.rows) {
    if (isBlank(row)) continue;
    const label = familyLabel(row.family);
    const now = norm(row.values, row.family);
    const was = row.section == null ? null : norm(rowValues(base.get(row.section)?.values ?? {}, row.family), row.family);
    const wasDefault = was && isDefault(was, row.family, data.tableIds);
    const isNow = !row.removed && isDefault(now, row.family, data.tableIds);
    if (isNow && !wasDefault) out.push(`Adds an ${label} ${kind(now)}${now.gateway ? ` via ${now.gateway}` : ''}.`);
    else if (wasDefault && !isNow) out.push(`${row.removed ? 'Removes' : 'Disables or moves'} the ${label} default route${was.gateway ? ` via ${was.gateway}` : ''}: without another one the router has no route to the internet.`);
    else if (wasDefault && isNow && ['gateway', 'interface', 'metric', 'type', 'table'].some(k => was[k] !== now[k])) out.push(`Changes the ${label} default route${was.gateway ? ` via ${was.gateway}` : ''}, which carries the router's traffic to the internet.`);
  }
  return out;
}

//#endregion

//#region Saving

// The UCI operations that turn the router's routes into the draft, as data (see core/ops.js). Only what changed is written; a cleared
// option is deleted rather than set to ''; options the page does not know (`valid`, `proto`) are left alone. A route whose target was
// edited gets the prefix in `target` and loses an older `netmask`.
export function plan(data, draft) {
  const ops = [];
  const base = new Map(data.routes.map(r => [r.section, r]));
  // The options of a route as they are written: only those with a value; `disabled` and `onlink` are written when on.
  const written = (v, family) => {
    const n = norm(v, family);
    const out = {};
    for (const k of TEXT_KEYS) if (n[k] !== '') out[k] = n[k];
    if (n.onlink) out.onlink = '1';
    if (!n.enabled) out.disabled = '1';
    return out;
  };
  for (const row of draft.rows) {
    if (isBlank(row)) continue;
    const type = FAMILIES.find(f => f.family === row.family).type;
    if (row.section == null) {
      if (!row.removed) ops.push({ op: 'add', config: CONFIG, type, values: written(row.values, row.family) });
      continue;
    }
    if (row.removed) { ops.push({ op: 'delete', config: CONFIG, section: row.section }); continue; }
    const raw = base.get(row.section)?.values ?? {};
    const was = written(rowValues(raw, row.family), row.family), now = written(row.values, row.family);
    const set = {}, del = [];
    for (const k of [...TEXT_KEYS, 'onlink', 'disabled']) {
      if (was[k] === now[k]) continue;
      if (now[k] === undefined) { if (raw[k] !== undefined) del.push(k); } else set[k] = now[k];
    }
    // The prefix now lives in `target`, so an older `netmask` would contradict it.
    if (set.target !== undefined && raw.netmask !== undefined) del.push('netmask');
    if (Object.keys(set).length) ops.push({ op: 'set', config: CONFIG, section: row.section, values: set });
    if (del.length) ops.push({ op: 'delete', config: CONFIG, section: row.section, options: del });
  }
  return ops;
}

// A route as a comparable text, ignoring its section name.
const signature = (v, family) => {
  const n = norm(v, family);
  return [family, ...TEXT_KEYS.map(k => n[k]), n.onlink ? 'onlink' : '', n.enabled ? '' : 'disabled'].join('|');
};

// Throws unless the routes `after` (read back once the change is applied) are the ones the draft asked for. New routes get a section
// name from uci, so the routes are compared by content.
export function checkApplied(after, draft) {
  const want = liveRows(draft).map(r => signature(r.values, r.family)).sort();
  const have = after.routes.map(r => signature(rowValues(r.values, r.family), r.family)).sort();
  if (want.join('\n') === have.join('\n')) return;
  const missing = want.filter(s => !have.includes(s)).length, extra = have.filter(s => !want.includes(s)).length;
  throw new Error(`the router does not hold the routes that were saved (${missing} missing, ${extra} unexpected)`);
}

//#endregion

//#region The kernel

// netifd inherits the interface's metric/table; Linux turns an IPv6 metric of zero into 1024.
function effectiveRoute(row, data) {
  const v = norm(row.values, row.family);
  const iface = data.interfaces.find(i => i.name === (v.interface || 'loopback'));
  const explicitTable = v.table ? tableKey(v.table, data.tableIds) : null;
  const table = explicitTable && !['0', '254'].includes(explicitTable) ? explicitTable : (row.family === 6 ? iface?.table6 : iface?.table4) ?? 'main';
  const metric = Number(v.metric || iface?.metric || 0);
  return { v, iface, table: tableKey(table, data.tableIds), metric: row.family === 6 && metric === 0 ? 1024 : metric };
}

// A configured route's full identity, not just another route to the same destination.
export function matchesKernel(row, r, data) {
  const { v, iface, table, metric } = effectiveRoute(row, data);
  const raw = data.routes.find(s => s.section === row.section)?.values;
  const protocols = { unspec: '0', kernel: '2', boot: '3', static: '4', ra: '9', dhcp: '16', bird: '192' };
  const protocol = p => protocols[p] ?? String(p ?? '');
  if (protocol(r.proto) !== protocol(raw?.proto || 'static')) return false;
  const target = parseCidr(v.target, row.family);
  const prefix = parseCidr(r.prefix, row.family);
  if (!target || !prefix || r.family !== row.family || cidrKey(prefix) !== cidrKey(target)) return false;
  if (r.type !== (v.type || 'unicast') || tableKey(r.table, data.tableIds) !== table || Number(r.metric ?? (row.family === 6 ? 1024 : 0)) !== metric) return false;
  const source = parseCidr(v.source || (row.family === 6 ? '::/0' : '0.0.0.0/0'), row.family);
  const actualSource = parseCidr(r.from || (row.family === 6 ? '::/0' : '0.0.0.0/0'), row.family);
  if (!source || !actualSource || cidrKey(source) !== cidrKey(actualSource)) return false;
  if (NO_GATEWAY.includes(v.type)) return true;
  if (v.interface && !iface?.device) return false;
  const gateway = v.gateway ? parseAddress(v.gateway) : null;
  return r.nexthops.some(n => (!v.interface || n.dev === iface.device)
    && (gateway ? parseAddress(n.via)?.value === gateway.value : !n.via));
}

export function kernelState(row, data) {
  if (row.section == null || row.removed) return null;
  const { v, iface } = effectiveRoute(row, data);
  if (!v.enabled) return 'disabled';
  if (iface && !iface.up) return 'missing';
  if (!data.kernel || !parseCidr(v.target, row.family)) return null;
  const wantType = v.type || 'unicast';
  if (v.interface && !iface?.device && !NO_GATEWAY.includes(wantType)) return null;
  return data.kernel.some(r => matchesKernel(row, r, data)) ? 'active' : 'missing';
}

// Changed, enabled routes on running interfaces must actually reach the FIB before automatic confirmation.
// Routes on a down interface may be saved for later; untouched pre-existing failures do not block unrelated edits.
export function checkInstalled(base, draft, after) {
  const rows = draftFrom(after).rows;
  for (const row of liveRows(draft)) {
    if (!row.values.enabled || !changesOf(base, { rows: [row] }).length) continue;
    const iface = after.interfaces.find(i => i.name === row.values.interface);
    if (iface && !iface.up) continue;
    const saved = rows.find(r => signature(r.values, r.family) === signature(row.values, row.family));
    if (!saved || kernelState(saved, after) !== 'active') throw new Error(`${title(row)} was saved but its installation in the kernel could not be verified`);
  }
}

// Include configured-but-inactive routes without pretending they are kernel entries, or duplicating installed ones.
export function routeInventory(status, data) {
  if (!data?.available) return status;
  const routes = status.routes.map(r => ({ ...r }));
  for (const row of draftFrom(data).rows) {
    const state = kernelState(row, data);
    const installed = state === 'active' ? routes.find(r => matchesKernel(row, r, data)) : null;
    if (installed) {
      installed.configured = [...(installed.configured ?? []), row.section];
      continue;
    }
    const { v, iface, table, metric } = effectiveRoute(row, data);
    const target = parseCidr(v.target, row.family);
    if (!target) continue;
    const tableName = Object.keys(status.table_ids ?? {}).find(n => String(status.table_ids[n]) === table) ?? table;
    routes.push({
      family: row.family, prefix: v.target.includes('/') ? v.target : `${v.target}/${target.len}`, len: target.len,
      table: tableName, type: v.type || 'unicast', metric, from: v.source || null, proto: 'static',
      scope: null, src: null, pref: null, expires: null, mtu: v.mtu ? Number(v.mtu) : null, flags: [],
      nexthops: NO_GATEWAY.includes(v.type) ? [] : [{ via: v.gateway || null, dev: iface?.device ?? v.interface, flags: [] }],
      configured: [row.section], configState: state === 'disabled' ? 'disabled' : state === 'missing' ? 'not installed' : 'state unknown',
    });
  }
  return { ...status, routes };
}

// The interfaces the Interface drop-down offers: the router's logical interfaces, plus any name a route already uses that the
// router does not list (kept, so an unknown name shows as an error instead of silently changing).
export function interfaceChoices(data, draft) {
  const names = new Set(data.interfaces.map(i => i.name));
  for (const r of draft.rows) if (r.values.interface.trim()) names.add(r.values.interface.trim());
  return [...names].sort((a, b) => a.localeCompare(b));
}

// How many configured routes are installed, missing and disabled, for the summary tiles.
export function counts(draft, data) {
  const out = { total: 0, active: 0, missing: 0, disabled: 0 };
  for (const row of draft.rows) {
    if (row.section == null || row.removed) continue;
    out.total++;
    const s = kernelState(row, data);
    if (s) out[s]++;
  }
  return out;
}

//#endregion
