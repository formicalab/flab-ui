// The DHCP page's model: what odhcpd and its config look like, what the forms hold, whether they are valid, what
// changed, and which UCI operations write the change. Pure functions with no DOM and no network, so they are
// unit-tested directly. The options themselves come from schema.js; the handling of one option (reading,
// normalizing, validating) is in core/fields.js.
//
// Data shape (readDhcp):
//   { daemon: { section, values }, daemonRunning,
//     pools:  [{ section, iface, values, info }],       one per dhcp section; `info` is the interface (or null)
//     hosts:  [{ section, values }],                    the reservations
//     interfaces: [{ name, device, v4: { address, mask } | null }],
//     leases4: [...], leases6: [...], ra: [...],
//     server: 'odhcpd' | 'dnsmasq' | 'other' (who serves DHCPv4), leasesUnreadable (dnsmasq's lease file could not be read) }
// Draft shape (what the forms edit; values are strings, booleans and arrays as in core/fields.js):
//   { daemon: { <option>: value }, pools: { <section>: { <option>: value } },
//     hosts: [{ key, section | null, removed, values: { name, ip, mac, duid, hostid, leasetime } }], next }
//   A new reservation has section null. mac and duid are edited as one text separated by spaces.
import { MAC, asList, differs, errorsOf, flag, hasBlankRows, normalize, sectionsOf, show, uciBool, valueOf } from '../../core/fields.js';
import { CONFIG, DAEMON_FIELDS, HOST_FIELDS, POOL_FIELDS } from './schema.js';

export { CONFIG };

//#region Addresses

// An IPv4 address as a 32-bit number, or null when it is not one.
export function ipToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || +x > 255)) return null;
  return p.reduce((n, x) => n * 256 + +x, 0);
}

// A 32-bit number as an IPv4 address.
export const intToIp = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

// The first and last address a DHCPv4 pool serves, counted from the start of the subnet (`start` is an offset,
// `limit` the number of addresses), and whether the pool had to be cut at the end of the subnet.
// Returns null when the subnet or the numbers do not allow a range.
export function poolRange(address, mask, start, limit) {
  const ip = ipToInt(address);
  if (ip == null || !(mask >= 8 && mask <= 30) || !(limit >= 1) || !(start >= 0)) return null;
  const size = 2 ** (32 - mask);
  const net = Math.floor(ip / size) * size;
  const lastHost = net + size - 2;
  const first = net + start;
  const last = net + start + limit - 1;
  if (first > lastHost) return { first: intToIp(first % 2 ** 32), last: null, count: 0, outside: true, clamped: true };
  return { first: intToIp(first), last: intToIp(Math.min(last, lastHost)), count: Math.min(last, lastHost) - first + 1, outside: false, clamped: last > lastHost };
}

// Whether an IPv4 address is inside the subnet address/mask.
export function inSubnet(ip, address, mask) {
  const a = ipToInt(ip), b = ipToInt(address);
  if (a == null || b == null) return false;
  const size = 2 ** (32 - mask);
  return Math.floor(a / size) === Math.floor(b / size);
}

// A MAC address as lowercase "aa:bb:cc:dd:ee:ff", from 12 hex digits or any common spelling; other text is
// returned lowercase as it is.
export function macOf(raw) {
  const hex = String(raw).toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length === 12 && /^[0-9a-fA-F:.-]+$/.test(String(raw)) ? hex.match(/../g).join(':') : String(raw).toLowerCase();
}

//#endregion

//#region Reading

// The words of a text: values separated by spaces, commas or line breaks.
const tokens = v => String(v ?? '').split(/[\s,]+/).filter(Boolean);

// Which daemon serves DHCPv4: 'odhcpd' when it is the main DHCPv4 server, 'dnsmasq' when it is not and dnsmasq
// runs (the usual split: dnsmasq for IPv4, odhcpd for DHCPv6 and router advertisements), otherwise 'other'.
// `dnsmasqSvc` is the reply of `service list dnsmasq`.
export function dhcpv4Server(cfg, dnsmasqSvc) {
  if (uciBool(sectionsOf(cfg, 'odhcpd')[0]?.values.maindhcp, false)) return 'odhcpd';
  return Object.values(dnsmasqSvc?.dnsmasq?.instances ?? {}).some(i => i.running) ? 'dnsmasq' : 'other';
}

// The lease file dnsmasq writes (its `leasefile` option; OpenWrt's default when unset).
export const dnsmasqLeaseFile = cfg => sectionsOf(cfg, 'dnsmasq')[0]?.values.leasefile || '/tmp/dhcp.leases';

// The DHCPv4 leases in dnsmasq's lease file ("expiry MAC address hostname client-id" per line; expiry is a Unix
// time and 0 means never). DHCPv6 lines (the "duid" line and addresses with colons) are skipped. A lease is
// reserved when a reservation has its MAC or address. `now` is the Unix time the remaining time is counted from.
function dnsmasqLeases(text, now, interfaces, hosts) {
  const reservedMacs = new Set(hosts.flatMap(r => asList(r.values.mac)).map(macOf));
  const reservedIps = new Set(hosts.map(r => r.values.ip).filter(Boolean));
  return String(text ?? '').split('\n').flatMap(line => {
    const [expiry, mac, address, name] = line.trim().split(/\s+/);
    if (!/^\d+$/.test(expiry ?? '') || ipToInt(address ?? '') == null) return [];
    const net = interfaces.find(i => i.v4 && inSubnet(address, i.v4.address, i.v4.mask));
    const isStatic = reservedMacs.has(macOf(mac)) || reservedIps.has(address);
    return [{
      device: net?.device ?? '', iface: net?.name ?? '', address, mac: macOf(mac), hostname: name === '*' ? '' : name ?? '',
      flags: isStatic ? ['static'] : [], static: isStatic, valid: +expiry === 0 ? null : Math.max(0, +expiry - now),
    }];
  });
}

// The settings, leases and announcements from the replies of `uci get dhcp` (all sections), the `dhcp` object's
// ipv4leases, ipv6leases and ipv6ra, `network.interface dump` and `service list odhcpd`. The ubus replies are
// optional: without them the lists are empty and `daemonRunning` is null.
// `dns` describes dnsmasq: { svc: the reply of `service list dnsmasq`, leases: the text of its lease file (null when
// unreadable), now }. When dnsmasq serves DHCPv4 (dhcpv4Server), its leases replace the odhcpd ones, which are
// then empty because odhcpd only does DHCPv6 and router advertisements.
export function readDhcp(cfg, v4, v6, ra, dump, svc, dns = {}) {
  const interfaces = (dump?.interface ?? []).map(i => ({
    name: i.interface, device: i.l3_device ?? i.device ?? null, up: Boolean(i.up),
    v4: i['ipv4-address']?.[0] ? { address: i['ipv4-address'][0].address, mask: i['ipv4-address'][0].mask } : null,
  }));
  const byDevice = new Map(interfaces.filter(i => i.device).map(i => [i.device, i]));
  const ifaceOf = device => byDevice.get(device)?.name ?? device;

  const server = dhcpv4Server(cfg, dns.svc);
  const hosts = sectionsOf(cfg, 'host');
  const leases4 = server === 'dnsmasq' ? dnsmasqLeases(dns.leases, dns.now ?? Date.now() / 1000, interfaces, hosts)
    : Object.entries(v4?.device ?? {}).flatMap(([device, d]) => (d.leases ?? []).map(l => ({
      device, iface: ifaceOf(device), address: l.address, mac: macOf(l.mac ?? ''), hostname: l.hostname ?? '',
      flags: l.flags ?? [], static: (l.flags ?? []).includes('static'), valid: l.valid ?? null,
    })));
  const leases6 = Object.entries(v6?.device ?? {}).flatMap(([device, d]) => (d.leases ?? []).map(l => ({
    device, iface: ifaceOf(device), duid: l.duid ?? '', iaid: l.iaid ?? null, hostname: l.hostname ?? '',
    flags: l.flags ?? [], static: (l.flags ?? []).includes('static'), valid: l.valid ?? null,
    addresses: (l['ipv6-addr'] ?? []).map(a => ({ address: a.address, preferred: a['preferred-lifetime'] ?? null, valid: a['valid-lifetime'] ?? null })),
    prefixes: (l['ipv6-prefix'] ?? []).map(p => ({ address: p.address, length: p['prefix-length'] ?? null, preferred: p['preferred-lifetime'] ?? null, valid: p['valid-lifetime'] ?? null })),
  })));
  const announced = Object.entries(ra?.interfaces ?? {}).map(([device, prefixes]) => ({
    device, iface: ifaceOf(device), prefixes: prefixes.map(p => ({ prefix: p.prefix, length: p.length, stale: Boolean(p.stale) })),
  }));

  const instances = Object.values(svc?.odhcpd?.instances ?? {});
  return {
    daemon: sectionsOf(cfg, 'odhcpd')[0] ?? { section: null, values: {} },
    daemonRunning: svc ? instances.some(i => i.running) : null,
    pools: sectionsOf(cfg, 'dhcp').map(s => {
      const iface = s.values.interface ?? s.section;
      return { section: s.section, iface, values: s.values, info: interfaces.find(i => i.name === iface) ?? null };
    }),
    hosts,
    server, leasesUnreadable: server === 'dnsmasq' && dns.leases == null,
    interfaces, leases4, leases6, ra: announced,
  };
}

//#endregion

//#region The draft

// The form values of a list of fields from the raw options of a section.
const valuesOf = (fields, raw) => Object.fromEntries(fields.map(f => [f.key, valueOf(f, raw[f.key])]));

// A reservation's options as the table edits them: strings, with the lists joined by spaces.
const hostValues = raw => ({
  name: String(raw.name ?? ''), ip: String(raw.ip ?? ''), mac: asList(raw.mac).join(' '), duid: asList(raw.duid).join(' '),
  hostid: String(raw.hostid ?? ''), leasetime: String(raw.leasetime ?? ''),
});

// The form's starting values: the router's current values.
export const draftFrom = data => ({
  daemon: valuesOf(DAEMON_FIELDS, data.daemon.values),
  pools: Object.fromEntries(data.pools.map(p => [p.section, valuesOf(POOL_FIELDS, p.values)])),
  hosts: data.hosts.map((h, i) => ({ key: `h${i}`, section: h.section, removed: false, values: hostValues(h.values) })),
  next: data.hosts.length,
});

// A new, empty reservation row (added to the draft by the page).
export function newHost(draft) {
  const row = { key: `h${draft.next++}`, section: null, removed: false, values: hostValues({}) };
  draft.hosts.push(row);
  return row;
}

// A reservation's values as they are compared and written: MACs in one spelling, tokens in single spaces.
export function hostNorm(v) {
  return {
    name: v.name.trim(), ip: v.ip.trim().toLowerCase(), mac: tokens(v.mac).map(macOf).join(' '),
    duid: tokens(v.duid).map(t => t.toLowerCase()).join(' '), hostid: v.hostid.trim().toLowerCase(), leasetime: v.leasetime.trim(),
  };
}

// Whether a new reservation row is still empty (it is ignored, like a blank list row).
const isBlank = row => row.section == null && HOST_FIELDS.every(f => row.values[f.key].trim() === '');

// What to call a reservation in messages: its name, else its address, else its MAC.
const hostTitle = v => v.name.trim() || v.ip.trim() || tokens(v.mac)[0] || 'unnamed';

// A reservation in one line for the review list.
const hostLine = v => [v.name.trim(), v.ip.trim(), tokens(v.mac).join(' '), tokens(v.duid).join(' '), v.hostid.trim() && `id ${v.hostid.trim()}`, v.leasetime.trim() && `lease ${v.leasetime.trim()}`].filter(Boolean).join(' · ') || 'empty';

// The differences between the router's values and the draft for the review list: [{ key, label, from, to }].
export function changesOf(data, draft) {
  const out = [];
  const diffFields = (fields, raw, values, keyPrefix, labelPrefix) => {
    for (const f of fields) {
      const from = normalize(f, valueOf(f, raw[f.key]));
      const to = normalize(f, values[f.key]);
      if (differs(f, from, to)) out.push({ key: `${keyPrefix}:${f.key}`, label: `${labelPrefix}: ${f.label}`, from: show(f, from), to: show(f, to) });
    }
  };
  diffFields(DAEMON_FIELDS, data.daemon.values, draft.daemon, 'daemon', 'odhcpd');
  for (const p of data.pools) diffFields(POOL_FIELDS, p.values, draft.pools[p.section], `pool:${p.section}`, p.iface);

  const baseHosts = new Map(data.hosts.map(h => [h.section, h.values]));
  for (const row of draft.hosts) {
    if (isBlank(row)) continue;
    if (row.section == null) {
      if (!row.removed) out.push({ key: `host:${row.key}`, label: `New reservation ${hostTitle(row.values)}`, from: 'none', to: hostLine(hostNorm(row.values)) });
      continue;
    }
    const base = hostValues(baseHosts.get(row.section) ?? {});
    if (row.removed) {
      out.push({ key: `host:${row.key}`, label: `Remove reservation ${hostTitle(base)}`, from: hostLine(hostNorm(base)), to: 'removed' });
      continue;
    }
    const a = hostNorm(base), b = hostNorm(row.values);
    for (const f of HOST_FIELDS) {
      if (a[f.key] !== b[f.key]) out.push({ key: `host:${row.key}:${f.key}`, label: `Reservation ${hostTitle(base)}: ${f.label}`, from: a[f.key] || 'not set', to: b[f.key] || 'not set' });
    }
  }
  return out;
}

// Whether the draft differs from the router in any way, including blank list rows and empty new reservations.
export const isDirty = (data, draft) => changesOf(data, draft).length > 0
  || DAEMON_FIELDS.some(f => hasBlankRows(f, draft.daemon[f.key]))
  || Object.values(draft.pools).some(p => POOL_FIELDS.some(f => hasBlankRows(f, p[f.key])))
  || draft.hosts.some(r => r.section == null && !r.removed);

//#endregion

//#region Validation

// The value of a pool option as the router will use it: the draft value, or the documented default when empty.
export function poolValue(draft, section, key) {
  const f = POOL_FIELDS.find(x => x.key === key);
  const v = normalize(f, draft.pools[section][key]);
  return v === '' || (Array.isArray(v) && !v.length) ? f.default : v;
}

// What stops the forms from being saved (`errors`: { key, index?, text }) and what only deserves a warning.
// Keys name the control: `daemon:<option>`, `pool:<section>:<option>` and `host:<row>:<option>`; `index` is the
// row of a list.
export function problems(data, draft) {
  const errors = [];
  const warnings = [];

  for (const f of DAEMON_FIELDS) for (const e of errorsOf(f, draft.daemon[f.key], `odhcpd: ${f.label}`)) errors.push({ key: `daemon:${f.key}`, ...e });
  const maindhcpField = DAEMON_FIELDS.find(f => f.key === 'maindhcp');
  if (!draft.daemon.maindhcp && valueOf(maindhcpField, data.daemon.values.maindhcp)) warnings.push('odhcpd is no longer the main DHCPv4 server: DHCPv4 stops unless another DHCP server (such as dnsmasq) is installed and serving.');

  for (const p of data.pools) {
    const label = p.iface;
    for (const f of POOL_FIELDS) for (const e of errorsOf(f, draft.pools[p.section][f.key], `${label}: ${f.label}`)) errors.push({ key: `pool:${p.section}:${f.key}`, ...e });
    const val = key => poolValue(draft, p.section, key);

    if (val('dhcpv4') === 'server') {
      if (!p.info?.v4) warnings.push(`${label}: DHCPv4 is on but the interface has no IPv4 address to serve from.`);
      else {
        const range = poolRange(p.info.v4.address, p.info.v4.mask, +val('start'), +val('limit'));
        if (range?.outside) errors.push({ key: `pool:${p.section}:start`, text: `${label}: the pool starts beyond the end of the subnet ${p.info.v4.address}/${p.info.v4.mask}.` });
        else if (range?.clamped) warnings.push(`${label}: the pool is longer than the subnet and ends at ${range.last}.`);
      }
    }
    if (+val('ra_mininterval') > 0.75 * +val('ra_maxinterval')) warnings.push(`${label}: the shortest advertisement interval should be at most three quarters of the longest (RFC 4861).`);
    const flags = val('ra_flags');
    if (Array.isArray(flags) && flags.includes('none') && flags.length > 1) warnings.push(`${label}: the RA flag "none" is combined with other flags.`);
    if (val('ra') !== 'disabled' && Array.isArray(flags) && flags.includes('managed-config') && val('dhcpv6') === 'disabled') warnings.push(`${label}: clients are told to get addresses from DHCPv6, which is disabled on this interface.`);
  }

  // Reservations: every field, an identity, an address, and no repeats.
  const active = draft.hosts.filter(r => !r.removed && !isBlank(r));
  const ips = new Map(), macs = new Map();
  const served = data.pools.filter(p => poolValue(draft, p.section, 'dhcpv4') === 'server' && p.info?.v4);
  const routers = new Set(data.interfaces.filter(i => i.v4).map(i => i.v4.address));
  for (const row of active) {
    const v = row.values;
    const title = `Reservation ${hostTitle(v)}`;
    for (const f of HOST_FIELDS) {
      if (f.key === 'mac' || f.key === 'duid') continue;
      for (const e of errorsOf(f, v[f.key], title)) errors.push({ key: `host:${row.key}:${f.key}`, text: e.text });
    }
    for (const t of tokens(v.mac)) if (!MAC.test(t)) errors.push({ key: `host:${row.key}:mac`, text: `${title}: "${t}" is not a MAC address such as 00:11:22:33:44:55.` });
    for (const t of tokens(v.duid)) if (!/^([0-9A-Fa-f]{2})+(%[0-9A-Fa-f]+)?$/.test(t)) errors.push({ key: `host:${row.key}:duid`, text: `${title}: "${t}" is not a DUID (hexadecimal digits in pairs, optionally followed by %IAID).` });
    if (!tokens(v.mac).length && !tokens(v.duid).length) errors.push({ key: `host:${row.key}:mac`, text: `${title} needs a MAC address or a DUID.` });

    const ip = v.ip.trim().toLowerCase();
    if (ip && ip !== 'ignore' && ipToInt(ip) != null) {
      if (ips.has(ip)) errors.push({ key: `host:${row.key}:ip`, also: `host:${ips.get(ip).key}:ip`, text: `${title}: ${ip} is also reserved for ${hostTitle(ips.get(ip).values)}.` });
      else ips.set(ip, row);
      if (routers.has(ip)) errors.push({ key: `host:${row.key}:ip`, text: `${title}: ${ip} is the router's own address.` });
      else if (served.length && !served.some(p => inSubnet(ip, p.info.v4.address, p.info.v4.mask))) warnings.push(`${title}: ${ip} is outside every subnet this router serves with DHCPv4.`);
    }
    for (const m of tokens(v.mac).map(macOf)) {
      if (macs.has(m) && macs.get(m) !== row) errors.push({ key: `host:${row.key}:mac`, also: `host:${macs.get(m).key}:mac`, text: `${title}: ${m} is also used by ${hostTitle(macs.get(m).values)}.` });
      else macs.set(m, row);
    }
  }
  return { errors, warnings };
}

//#endregion

//#region Writing

// The UCI operations that turn the router's config into the draft, as data (see core/ops.js). Only what changed is
// written; an emptied option is deleted rather than set to ''; options the page does not know are left alone.
export function plan(data, draft) {
  const ops = [];

  // One section's changed options: { set, del }, from the schema fields.
  const sectionChange = (fields, raw, values) => {
    const set = {}, del = [];
    for (const f of fields) {
      const from = normalize(f, valueOf(f, raw[f.key]));
      const to = normalize(f, values[f.key]);
      if (!differs(f, from, to)) continue;
      if (f.type === 'bool') set[f.key] = flag(to);
      else if (to.length === 0) del.push(f.key);
      else set[f.key] = to;
    }
    return { set, del };
  };
  const emit = (section, { set, del }, raw) => {
    if (Object.keys(set).length) ops.push({ op: 'set', config: CONFIG, section, values: set });
    const existing = del.filter(o => raw[o] !== undefined);
    if (existing.length) ops.push({ op: 'delete', config: CONFIG, section, options: existing });
  };

  const daemon = sectionChange(DAEMON_FIELDS, data.daemon.values, draft.daemon);
  if (!data.daemon.section) {
    if (Object.keys(daemon.set).length) ops.push({ op: 'add', config: CONFIG, type: 'odhcpd', name: 'odhcpd', values: daemon.set });
  } else emit(data.daemon.section, daemon, data.daemon.values);
  for (const p of data.pools) emit(p.section, sectionChange(POOL_FIELDS, p.values, draft.pools[p.section]), p.values);

  // Reservations: a removed one is deleted, a new one added, a changed one set. mac and duid become a list when
  // there are several; MACs are written in capitals, as the router's own entries are.
  const written = v => {
    const n = hostNorm(v);
    const macs = tokens(v.mac).map(m => macOf(m).toUpperCase());
    const duids = tokens(v.duid);
    return {
      name: n.name, ip: v.ip.trim(), mac: macs.length > 1 ? macs : macs[0] ?? '', duid: duids.length > 1 ? duids : duids[0] ?? '',
      hostid: v.hostid.trim(), leasetime: n.leasetime,
    };
  };
  const baseHosts = new Map(data.hosts.map(h => [h.section, h.values]));
  for (const row of draft.hosts) {
    if (isBlank(row)) continue;
    if (row.section == null) {
      if (row.removed) continue;
      const w = written(row.values);
      ops.push({ op: 'add', config: CONFIG, type: 'host', values: Object.fromEntries(Object.entries(w).filter(([, x]) => x !== '')) });
      continue;
    }
    if (row.removed) { ops.push({ op: 'delete', config: CONFIG, section: row.section }); continue; }
    const rawBase = baseHosts.get(row.section) ?? {};
    const a = hostNorm(hostValues(rawBase)), b = hostNorm(row.values);
    const w = written(row.values);
    const set = {}, del = [];
    for (const f of HOST_FIELDS) {
      if (a[f.key] === b[f.key]) continue;
      if (w[f.key] === '') del.push(f.key);
      else set[f.key] = w[f.key];
    }
    emit(row.section, { set, del }, rawBase);
  }
  return ops;
}

// A reservation as a comparable text, ignoring its section name.
const hostSignature = v => HOST_FIELDS.map(f => hostNorm(v)[f.key]).join('|');

// Throws unless the settings `after` (read back once the change is applied) hold what the draft asked for: every
// option of the daemon and the pools, and the set of reservations (new ones get a section name from uci, so they
// are compared by content).
export function checkApplied(after, draft) {
  const left = [];
  const compare = (fields, raw, values, label) => {
    for (const f of fields) if (differs(f, normalize(f, valueOf(f, raw[f.key])), normalize(f, values[f.key]))) left.push(`${label}: ${f.label}`);
  };
  compare(DAEMON_FIELDS, after.daemon.values, draft.daemon, 'odhcpd');
  for (const p of after.pools) if (draft.pools[p.section]) compare(POOL_FIELDS, p.values, draft.pools[p.section], p.iface);

  const want = draft.hosts.filter(r => !r.removed && !isBlank(r)).map(r => hostSignature(r.values)).sort();
  const have = after.hosts.map(h => hostSignature(hostValues(h.values))).sort();
  if (want.join('\n') !== have.join('\n')) left.push('Reservations');
  if (left.length) throw new Error(`${left.slice(0, 4).join(', ')}${left.length > 4 ? ` and ${left.length - 4} more` : ''} ${left.length > 1 ? 'were' : 'was'} not saved`);
}

//#endregion
