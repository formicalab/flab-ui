// The zones of the DNS page as UCI keeps them, and what changing them means. Pure functions with no DOM and no network.
//
// A zone is one block of the configuration, not one domain:
//   Unbound  a `config zone` section of /etc/config/unbound: one set of servers and settings for a list of domains, of one
//            zone_type (forward_zone, stub_zone or auth_zone; see ZONE_TYPES in schema.js and the OpenWrt Unbound README). One
//            router has a single section, `fwd_azure`, that sends 89 domains to the same two servers.
//   dnsmasq  one entry of the `server` list of its section in /etc/config/dhcp: "/a/b/address#port" sends the domains a and b
//            to the address, "/a/" answers a locally, "/a/#" uses the default servers, and a plain address is a default forwarder.
// Forward zones that only exist in Unbound's extension file (unbound_ext.conf) are not UCI sections: they are listed, read only.
//
// The draft the DNS page keeps (see edit.js) holds `forwarders`, the working copy of these blocks:
//   Unbound  [{ key: section, isNew, removed, locked, values }]   `values` is the form of the section (ZONE_FIELDS in schema.js)
//   dnsmasq  [{ key: id, isNew, removed, original, value }]       `value` is the text of the entry
// Removing a block only flags it, so it can be restored until the change is saved.
import { CHECKS, differs, errorsOf, flag, normalize, show, validServer } from '../../core/fields.js';
import { ZONE_FIELDS, ZONE_TYPES } from './schema.js';
import { flagWords, isPublicIp, serverAddress, zoneDraft } from './model.js';

const field = key => ZONE_FIELDS.find(f => f.key === key);
const ZN = field('zone_name');
const SV = field('server');

// The fields a zone of this type uses, in the order of ZONE_TYPES (none for a type this page does not know).
export const fieldsOf = type => (ZONE_TYPES[type]?.keys ?? []).map(field);

// The words for a zone type: "Forward", "Stub", "Authoritative", or the type as it is written.
export const typeLabel = type => ZONE_TYPES[type]?.label ?? (type || 'Unknown');

//#region Names and addresses

// A domain the way the router writes it: lowercase, no leading "*." or ".", no trailing dot, "." for the root (the default
// forwarder).
export function normZone(z) {
  const s = String(z ?? '').trim().toLowerCase();
  return s === '' || s === '.' ? '.' : s.replace(/^\*?\./, '').replace(/\.$/, '') || '.';
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

// An error for a non-empty domain ("." is the root), or null.
export function zoneError(raw) {
  const z = normZone(raw);
  return z === '.' || DOMAIN.test(z) ? null : 'is not a valid domain name';
}

// An error for an Unbound server, or null: an address or host name, then optionally @port and #certificate-name
// ("192.0.2.153@443#dns.example.net", the form of the Unbound documentation). A stub zone needs an address, not a name.
export function serverError(raw, type) {
  const m = /^([^@#\s]+)(?:@(\d{1,5}))?(?:#(\S+))?$/.exec(String(raw).trim());
  if (!m) return 'is not a server: write an address, address@port or address@port#name';
  if (!validServer(m[1])) return 'does not start with a valid address or host name';
  if (type === 'stub_zone' && CHECKS.ip(m[1])) return 'must be an IP address: a stub zone cannot use a host name';
  if (m[2] && (+m[2] < 1 || +m[2] > 65535)) return 'has a port outside 1 to 65535';
  if (m[3] && !DOMAIN.test(m[3].toLowerCase())) return 'has an invalid certificate name after #';
  return null;
}

// An error for a dnsmasq server (address, optionally @source and #port), or null.
export function dnsmasqServerError(raw) {
  const m = /^([^@#\s/]+)(@[^#\s/]+)?(#\d{1,5})?$/.exec(String(raw).trim());
  if (!m) return 'is not a server: write an address, or address#port';
  return validServer(m[1]) ? null : 'does not start with a valid address or host name';
}

//#endregion

//#region Words for the review list

// A few names of a list: "a, b and 87 more".
function brief(list, n = 2) {
  const shown = list.slice(0, n).map(z => (z === '.' ? 'every other name' : z));
  return list.length > n ? `${shown.join(', ')} and ${list.length - n} more` : shown.join(', ') || 'none';
}

// A zone in one line, for the review list: its kind, its domains, its servers, TLS, and whether it is switched off.
function describe(v) {
  const zones = normalize(ZN, v.zone_name).map(normZone);
  const servers = normalize(SV, v.server);
  return `${typeLabel(v.zone_type).toLowerCase()} zone for ${zones.length > 1 ? `${zones.length} domains (${brief(zones)})` : brief(zones)} → ${servers.join(', ') || (v.url_dir ? v.url_dir : 'no server')}${v.tls_upstream && v.zone_type === 'forward_zone' ? ' over TLS' : ''}${v.enabled ? '' : ' (disabled)'}`;
}

// A value of one field in words.
function words(f, v) {
  if (f.type === 'bool') return v ? 'on' : 'off';
  if (f.type === 'enum') return v === '' ? 'default' : f.labels?.[v] ?? v;
  return show(f, v);
}

// How a list changed: the counts, then what was added (+) and removed (−), a few of each.
function listChange(f, a, b) {
  const unit = f.key === 'zone_name' ? 'domains' : 'servers';
  const gone = a.filter(x => !b.includes(x));
  const added = b.filter(x => !a.includes(x));
  const bits = [...added.slice(0, 3).map(x => `+${x}`), ...(added.length > 3 ? [`+${added.length - 3} more`] : []), ...gone.slice(0, 3).map(x => `−${x}`), ...(gone.length > 3 ? [`−${gone.length - 3} more`] : [])];
  return { from: `${a.length} ${unit}`, to: `${b.length} ${unit}${bits.length ? `: ${bits.join(', ')}` : ''}` };
}

//#endregion

//#region Unbound: the zone sections

// The form value of a field in its normalized shape (domains normalized).
const normed = (f, v) => (f.key === 'zone_name' ? normalize(f, v).map(normZone) : normalize(f, v));

// The fields of a section that differ between the router's values and the draft's, for the fields its type uses:
// [{ field, from, to, a, b }].
function fieldDiffs(base, now) {
  const out = [];
  for (const f of fieldsOf(base.zone_type)) {
    const a = normed(f, base[f.key]);
    const b = normed(f, now[f.key]);
    if (!differs(f, a, b)) continue;
    const c = f.type === 'list' ? listChange(f, a, b) : { from: words(f, a), to: words(f, b) };
    out.push({ field: f, a, b, ...c });
  }
  return out;
}

// The values a new zone starts from: a forward zone, switched on, falling back to recursion as UCI does by default.
export const newZoneValues = (type = 'forward_zone') => ({ zone_type: type, enabled: true, zone_name: [], server: [], tls_upstream: false, tls_index: '', tls_port: '', port: '', fallback: true, dns_assist: '', resolv_conf: false, url_dir: '' });

// The UCI sections of the reply as drafts: [{ key, isNew, removed, locked, values }]. A section is locked (read only) when its
// lists were cut or its zone_type is one this page does not know.
function unboundDraft(data) {
  return (data.forward_uci ?? []).map(e => ({ key: e.section, isNew: false, removed: false, locked: Boolean(e.cut) || !ZONE_TYPES[e.type], values: zoneDraft(e) }));
}

// The router's values by section name.
const unboundBase = data => new Map((data.forward_uci ?? []).map(e => [e.section, zoneDraft(e)]));

// The flags (not DNSSEC-validated, …) of the running forward rules, by domain, for the flags column.
function flagsByZone(data) {
  return new Map((data.forwards ?? []).filter(r => r.source === 'uci').map(r => [r.zone, r.flags ?? []]));
}

// Zones of the same group clash when two enabled blocks list one name: forward and stub zones are one group (Unbound refuses
// two clauses for a name), authoritative zones another.
const groupOf = type => (type === 'auth_zone' ? 'auth' : 'forward');

// Where a name is already taken: domain → [section names] over the enabled zones of the type's group that stay, and, for the
// forward group, the zones that only the extension file defines (named "unbound_ext.conf"). `skip` leaves one section out.
function owners(data, draft, skip, type) {
  const map = new Map();
  const add = (zone, who) => map.set(zone, [...(map.get(zone) ?? []), who]);
  for (const d of draft.forwarders) {
    if (d.removed || d.key === skip || !d.values.enabled || groupOf(d.values.zone_type) !== groupOf(type)) continue;
    for (const z of new Set(normalize(ZN, d.values.zone_name).map(normZone))) add(z, d.key);
  }
  if (groupOf(type) === 'forward') for (const r of data.forwards ?? []) if (r.source !== 'uci') add(normZone(r.zone), 'unbound_ext.conf');
  return map;
}

// A section name for a new zone: a prefix by type and the first domain, unique among the sections that exist or are in the draft.
export function newSectionName(data, draft, type, zones) {
  const first = normZone(zones[0] ?? 'new');
  const slug = (first === '.' ? 'default' : first).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'new';
  const prefix = { forward_zone: 'fwd', stub_zone: 'stub', auth_zone: 'auth' }[type] ?? 'zone';
  const used = new Set([...(data.forward_uci ?? []).map(e => e.section), ...draft.forwarders.map(d => d.key)]);
  let name = `${prefix}_${slug}`;
  for (let i = 2; used.has(name); i++) name = `${prefix}_${slug}_${i}`;
  return name;
}

// The errors of the form of one zone, as [{ key, index?, text }] for the dialog: domains are required, so are servers (an
// authoritative zone may use a URL instead), every domain and server must be valid, and a name may be taken by one enabled zone
// only (Unbound refuses two clauses for the same name). `skip` is the section being edited.
function unboundFormProblems(data, draft, skip, v) {
  const out = [];
  const type = v.zone_type;
  if (!ZONE_TYPES[type]) return [{ key: 'zone_type', text: 'Choose the type of zone.' }];
  const zones = normalize(ZN, v.zone_name);
  const servers = normalize(SV, v.server);
  if (!zones.length) out.push({ key: 'zone_name', text: 'Add at least one domain ("." is every name that no other zone takes).' });
  if (!servers.length && !(type === 'auth_zone' && v.url_dir.trim())) out.push({ key: 'server', text: type === 'auth_zone' ? 'Add at least one server, or the URL of the zone files.' : 'Add at least one server.' });
  const seen = new Set();
  v.zone_name.forEach((raw, index) => {
    const t = raw.trim();
    if (!t) return;
    const bad = zoneError(t);
    if (bad) out.push({ key: 'zone_name', index, text: `Domain "${t}" ${bad}.` });
    else if (seen.has(normZone(t))) out.push({ key: 'zone_name', index, text: `Domain "${t}" is listed twice.` });
    seen.add(normZone(t));
  });
  const seenServers = new Set();
  v.server.forEach((raw, index) => {
    const t = raw.trim();
    if (!t) return;
    const bad = serverError(t, type);
    if (bad) out.push({ key: 'server', index, text: `Server "${t}" ${bad}.` });
    else if (seenServers.has(t.toLowerCase())) out.push({ key: 'server', index, text: `Server "${t}" is listed twice.` });
    seenServers.add(t.toLowerCase());
  });
  for (const f of fieldsOf(type).filter(x => x.type !== 'list' && x.type !== 'bool')) {
    for (const e of errorsOf(f, v[f.key])) out.push({ key: f.key, ...e });
  }
  if (v.enabled) {
    const taken = owners(data, draft, skip, type);
    const clash = new Map();
    v.zone_name.forEach((raw, index) => {
      const z = normZone(raw);
      if (!raw.trim() || !taken.has(z)) return;
      const by = taken.get(z)[0];
      if (!clash.has(by)) clash.set(by, { index, zone: z, n: 0 });
      clash.get(by).n++;
    });
    for (const [by, c] of clash) out.push({ key: 'zone_name', index: c.index, text: `${c.n === 1 ? `Domain "${c.zone}" is` : `${c.n} domains, for example "${c.zone}", are`} already taken by ${by}. Remove ${c.n === 1 ? 'it' : 'them'} there first, or switch that zone off.` });
  }
  return out;
}

// The warnings for one zone in the draft (a new or changed one that is switched on). Only forward zones talk to servers that
// can read the queries on the way.
function unboundWarnings(v, name) {
  const out = [];
  if (!v.enabled || v.zone_type !== 'forward_zone') return out;
  const servers = normalize(SV, v.server);
  const publics = servers.filter(s => isPublicIp(serverAddress(s)));
  if (publics.length && !v.tls_upstream) out.push(`${name} sends queries to a public server (${brief(publics, 2)}) in clear text: everyone on the path can read every name looked up. "Use TLS" encrypts them.`);
  if (v.tls_upstream && !v.tls_index.trim() && servers.some(s => !s.includes('#'))) out.push(`${name} uses TLS without a certificate name, so Unbound encrypts the queries but does not check who answers.`);
  if (servers.some(s => /^(127\.|::1$)/.test(serverAddress(s))) && (v.dns_assist === '' || v.dns_assist === 'none')) out.push(`${name} forwards to this router itself (127.0.0.0/8 or ::1): Unbound only allows that while "Local resolver check" names an installed and enabled program.`);
  return out;
}

// Whether an enabled forward zone of the list takes the root zone ".".
const hasDefault = list => list.some(v => v.enabled && v.zone_type === 'forward_zone' && normalize(ZN, v.zone_name).map(normZone).includes('.'));

//#endregion

//#region dnsmasq: the server entries

// The pieces of one `server` entry: { zones (as written), mode: forward | local | default, server }. "/a/b/addr" has the zones
// a and b; no slash means the default forwarder (zone "."); an empty address means "answer locally", "#" means "use the
// default servers".
export function parseEntry(value) {
  const s = String(value ?? '').trim();
  if (!s.startsWith('/')) return { zones: ['.'], mode: 'forward', server: s };
  const parts = s.split('/');
  const last = (parts.at(-1) ?? '').trim();
  const zones = parts.slice(1, -1).map(z => z.trim()).filter(Boolean);
  return { zones: zones.length ? zones : ['.'], mode: last === '' ? 'local' : last === '#' ? 'default' : 'forward', server: last === '#' ? '' : last };
}

// The text of an entry from its pieces (the opposite of parseEntry).
export function composeEntry({ zones, mode, server }) {
  const list = zones.map(z => z.trim()).filter(Boolean);
  const root = list.length === 1 && normZone(list[0]) === '.';
  if (mode === 'forward') return root ? server.trim() : `/${list.join('/')}/${server.trim()}`;
  return `/${list.join('/')}/${mode === 'default' ? '#' : ''}`;
}

// The entries of the reply as drafts: [{ key, isNew, removed, original, value }].
function dnsmasqDraft(data) {
  return (data.forward_uci ?? []).map(e => ({ key: `e${e.index}`, isNew: false, removed: false, original: e.value, value: e.value }));
}

// The initial form of a dnsmasq entry.
export const newEntryForm = () => ({ zones: [], mode: 'forward', server: '' });

// The errors of the dnsmasq form, as [{ key, index?, text }].
function dnsmasqFormProblems(f) {
  const out = [];
  const zones = f.zones.map(z => z.trim()).filter(Boolean);
  const root = zones.length === 1 && normZone(zones[0]) === '.';
  if (!zones.length) out.push({ key: 'zones', text: 'Add at least one domain ("." makes this a default forwarder).' });
  const seen = new Set();
  f.zones.forEach((raw, index) => {
    const t = raw.trim();
    if (!t) return;
    const bad = zoneError(t);
    if (bad) out.push({ key: 'zones', index, text: `Domain "${t}" ${bad}.` });
    else if (seen.has(normZone(t))) out.push({ key: 'zones', index, text: `Domain "${t}" is listed twice.` });
    seen.add(normZone(t));
  });
  if (zones.some(z => normZone(z) === '.') && !root) out.push({ key: 'zones', text: '"." stands for every name and cannot be mixed with other domains.' });
  if (f.mode === 'forward') {
    if (!f.server.trim()) out.push({ key: 'server', text: 'Write the server to forward to.' });
    else {
      const bad = dnsmasqServerError(f.server);
      if (bad) out.push({ key: 'server', text: `Server "${f.server.trim()}" ${bad}.` });
    }
  } else if (root) out.push({ key: 'zones', text: 'Answering locally or using the default servers needs a domain, not ".".' });
  return out;
}

//#endregion

//#region The draft, by engine

const isUnbound = data => data.configured === 'unbound';

// A draft that has no `forwarders` yet (one made without the zones) behaves as one with none.
const dr = draft => (draft.forwarders ? draft : { ...draft, forwarders: [] });

// The working copy of the router's zones (an empty list for a router without an engine that keeps them in UCI).
export function forwardersDraft(data) {
  if (isUnbound(data)) return unboundDraft(data);
  return data.configured === 'dnsmasq' ? dnsmasqDraft(data) : [];
}

// Whether the zones can be edited at all: an engine whose lists are complete.
export const canEditForwarders = data => Boolean(data.config_section) && (isUnbound(data) || data.configured === 'dnsmasq') && !data.truncated?.forward_uci;

// The form a dialog starts from: for a new zone the defaults, else the values of the zone `key`.
export function formFor(data, draft, key) {
  const d = key == null ? null : draft.forwarders.find(x => x.key === key);
  if (isUnbound(data)) {
    const v = d ? d.values : newZoneValues();
    return { ...v, zone_name: [...v.zone_name], server: [...v.server] };
  }
  return d ? parseEntry(d.value) : newEntryForm();
}

// The errors of a dialog's form, for the zone `key` (null: a new one).
export function formProblems(data, draft, key, form) {
  return isUnbound(data) ? unboundFormProblems(data, draft, key, form) : dnsmasqFormProblems(form);
}

// Puts a dialog's form into the draft: replaces the zone `key`, or adds a new one (key null). Returns its key.
export function saveForwarder(data, draft, key, form) {
  const d = key == null ? null : draft.forwarders.find(x => x.key === key);
  if (isUnbound(data)) {
    const values = { ...form, zone_name: normalize(ZN, form.zone_name).map(normZone), server: normalize(SV, form.server) };
    if (d) { d.values = values; return d.key; }
    const name = newSectionName(data, draft, values.zone_type, values.zone_name);
    draft.forwarders.push({ key: name, isNew: true, removed: false, locked: false, values });
    return name;
  }
  const value = composeEntry({ zones: form.zones, mode: form.mode, server: form.server });
  if (d) { d.value = value; return d.key; }
  const n = 1 + Math.max(0, ...draft.forwarders.map(x => +String(x.key).replace(/\D/g, '') || 0));
  draft.forwarders.push({ key: `n${n}`, isNew: true, removed: false, original: null, value });
  return `n${n}`;
}

// Removes a zone from the draft: a new one disappears, one the router has is flagged and can be restored.
export function removeForwarder(draft, key) {
  const i = draft.forwarders.findIndex(x => x.key === key);
  if (i < 0) return;
  if (draft.forwarders[i].isNew) draft.forwarders.splice(i, 1);
  else draft.forwarders[i].removed = true;
}

// Takes a removed zone back.
export function restoreForwarder(draft, key) {
  const d = draft.forwarders.find(x => x.key === key);
  if (d) d.removed = false;
}

//#endregion

//#region The table

// One zone as the table shows it: { key, kind (uci | file), type, name, zones, servers, url, enabled, tls, flags, mode, pending
// (new | edited | removed), locked }. `name` is the section (Unbound) or the text of the entry (dnsmasq).
function unboundItems(data, draft) {
  const base = unboundBase(data);
  const flags = flagsByZone(data);
  const items = [];
  for (const d of draft.forwarders) {
    const b = base.get(d.key);
    const v = d.removed && b ? b : d.values;
    const zones = normalize(ZN, v.zone_name).map(normZone);
    const pending = d.removed ? 'removed' : d.isNew ? 'new' : (fieldDiffs(b, d.values).length ? 'edited' : undefined);
    items.push({
      key: d.key, kind: 'uci', type: v.zone_type, name: d.key, zones, servers: normalize(SV, v.server), url: v.zone_type === 'auth_zone' ? v.url_dir : '',
      enabled: Boolean(v.enabled), tls: v.zone_type === 'forward_zone' ? Boolean(v.tls_upstream) : null,
      flags: v.zone_type === 'forward_zone' ? [...new Set(zones.flatMap(z => flags.get(z) ?? []))] : [], mode: 'forward', pending, locked: d.locked,
    });
  }
  for (const r of data.forwards ?? []) {
    if (r.source === 'uci') continue;
    items.push({ key: `file:${r.zone}`, kind: 'file', type: 'forward_zone', name: 'unbound_ext.conf', zones: [normZone(r.zone)], servers: r.servers ?? [], url: '', enabled: true, tls: r.tls ?? null, flags: r.flags ?? [], mode: 'forward', pending: undefined, locked: true });
  }
  return items;
}

function dnsmasqItems(draft) {
  return draft.forwarders.map(d => {
    const text = d.removed ? d.original : d.value;
    const p = parseEntry(text);
    return {
      key: d.key, kind: 'uci', type: '', name: text || '(empty)', zones: p.zones.map(normZone), servers: p.server ? [p.server] : [], url: '', enabled: true, tls: null,
      flags: p.mode === 'local' ? ['local-only'] : p.mode === 'default' ? ['default-servers'] : [], mode: p.mode,
      pending: d.removed ? 'removed' : d.isNew ? 'new' : (d.value !== d.original ? 'edited' : undefined), locked: false,
    };
  });
}

// Every zone for the table, in the order the router processes them: the blocks of UCI in the order of the configuration file
// (the order the generator writes the clauses of unbound.conf, and the order dnsmasq reads its server list), then the read-only
// ones from the extension file, which is appended after all of them. Each item carries its position as `order` (from 1). A
// zone added in the draft comes last. Which zone answers a query does not depend on this order: Unbound and dnsmasq pick the
// zone with the longest matching domain.
export function forwarderItems(data, draftIn) {
  const draft = dr(draftIn);
  const items = isUnbound(data) ? unboundItems(data, draft) : data.configured === 'dnsmasq' ? dnsmasqItems(draft) : [];
  items.forEach((item, i) => { item.order = i + 1; });
  return items;
}

// Whether a zone matches the filter text: every word must be in its name, type, a domain, a server or the words of a flag.
export function matchItem(item, text) {
  const ws = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!ws.length) return true;
  const hay = [item.name, typeLabel(item.type), item.url, ...item.zones, ...item.servers, ...flagWords(item.flags), item.pending ?? '', item.enabled ? '' : 'disabled'].join(' ').toLowerCase();
  return ws.every(w => hay.includes(w));
}

// How many UCI zone blocks and domains the table holds, and how many domains only the extension file defines.
export function forwarderCounts(data, draft) {
  const items = forwarderItems(data, draft);
  const uci = items.filter(i => i.kind === 'uci');
  return { forwarders: uci.length, domains: uci.reduce((n, i) => n + i.zones.length, 0), file: items.filter(i => i.kind === 'file').length };
}

//#endregion

//#region Changes, problems, plan and check (engine by engine)

// The differences between the router's zones and the draft, for the review list: [{ key, label, from, to }].
export function forwarderChanges(data, draftIn) {
  const draft = dr(draftIn);
  const out = [];
  if (isUnbound(data)) {
    const base = unboundBase(data);
    for (const d of draft.forwarders) {
      const b = base.get(d.key);
      if (d.isNew) out.push({ key: `fwd:${d.key}`, label: `New zone ${d.key}`, from: 'none', to: describe(d.values) });
      else if (d.removed) out.push({ key: `fwd:${d.key}`, label: `Remove zone ${d.key}`, from: describe(b), to: 'removed' });
      else for (const c of fieldDiffs(b, d.values)) out.push({ key: `fwd:${d.key}:${c.field.key}`, label: `${d.key}: ${c.field.label}`, from: c.from, to: c.to });
    }
    return out;
  }
  for (const d of draft.forwarders) {
    const p = parseEntry(d.removed ? d.original : d.value);
    const label = `zone ${brief(p.zones.map(normZone))}`;
    if (d.isNew) out.push({ key: `fwd:${d.key}`, label: `New ${label}`, from: 'none', to: d.value });
    else if (d.removed) out.push({ key: `fwd:${d.key}`, label: `Remove ${label}`, from: d.original || '(empty)', to: 'removed' });
    else if (d.value !== d.original) out.push({ key: `fwd:${d.key}`, label: `Zone ${brief(p.zones.map(normZone))}`, from: d.original || '(empty)', to: d.value });
  }
  return out;
}

// What stops a save (errors: [{ key, text }]) and what only deserves a warning (warnings: [text]) in the draft's zones.
export function forwarderProblems(data, draftIn) {
  const draft = dr(draftIn);
  const errors = [];
  const warnings = [];
  if (isUnbound(data)) {
    const base = unboundBase(data);
    const changed = d => !d.removed && (d.isNew || fieldDiffs(base.get(d.key), d.values).length > 0);
    const live = draft.forwarders.filter(d => !d.removed);
    for (const d of live.filter(changed)) {
      for (const e of unboundFormProblems(data, draft, d.key, d.values)) errors.push({ key: `fwd:${d.key}`, text: `${d.key}: ${e.text}` });
      warnings.push(...unboundWarnings(d.values, d.key));
    }
    if (hasDefault([...base.values()]) && !hasDefault(live.map(d => d.values)) && !(data.forwards ?? []).some(r => r.source !== 'uci' && normZone(r.zone) === '.')) {
      warnings.push('No forward zone takes every other name any more: Unbound will resolve those names itself, starting from the root servers.');
    }
  } else if (data.configured === 'dnsmasq') {
    const had = (data.forward_uci ?? []).some(e => !e.value.startsWith('/') && e.value.trim());
    const has = draft.forwarders.some(d => !d.removed && !d.value.startsWith('/') && d.value.trim());
    if (had && !has) warnings.push('No default server is left: dnsmasq asks only the resolvers learned from the WAN for names that no rule covers.');
  }
  return { errors, warnings };
}

// The UCI operations (see core/ops.js) that turn the router's zones into the draft's.
export function forwarderPlan(data, draftIn) {
  const draft = dr(draftIn);
  const section = data.config_section;
  if (!section) return [];
  const ops = [];
  if (isUnbound(data)) {
    const base = unboundBase(data);
    const gone = [];
    for (const d of draft.forwarders) {
      if (d.removed) { if (!d.isNew) gone.push({ op: 'delete', config: section.config, section: d.key }); continue; }
      if (d.isNew) {
        const v = d.values;
        const values = { zone_type: v.zone_type, enabled: flag(v.enabled), zone_name: normed(ZN, v.zone_name), server: normed(SV, v.server) };
        for (const f of fieldsOf(v.zone_type).filter(x => !['enabled', 'zone_name', 'server'].includes(x.key))) {
          const x = normed(f, v[f.key]);
          if (f.type === 'bool') { if (x !== Boolean(f.default)) values[f.key] = flag(x); } else if (x !== '') values[f.key] = x;
        }
        ops.push({ op: 'add', config: section.config, type: 'zone', name: d.key, values });
        continue;
      }
      const set = {};
      const del = [];
      for (const c of fieldDiffs(base.get(d.key), d.values)) {
        const k = c.field.key;
        if (c.field.type === 'bool') set[k] = flag(c.b);
        else if (c.field.type === 'list' ? c.b.length === 0 : c.b === '') del.push(k);
        else set[k] = c.b;
      }
      if (Object.keys(set).length) ops.push({ op: 'set', config: section.config, section: d.key, values: set });
      if (del.length) ops.push({ op: 'delete', config: section.config, section: d.key, options: del });
    }
    return [...ops, ...gone];
  }
  const list = draft.forwarders.filter(d => !d.removed).map(d => d.value.trim()).filter(Boolean);
  const before = (data.forward_uci ?? []).map(e => e.value.trim()).filter(Boolean);
  if (list.join('\n') === before.join('\n')) return [];
  return list.length
    ? [{ op: 'set', config: section.config, section: section.name, values: { server: list } }]
    : [{ op: 'delete', config: section.config, section: section.name, options: ['server'] }];
}

// What the status read after a save says is not as the draft asked, as a list of sentences (empty: all kept). `before` is the
// data the draft was made from.
export function forwarderLeftovers(before, after, draftIn) {
  const draft = dr(draftIn);
  const out = [];
  if (isUnbound(before)) {
    const now = new Map((after.forward_uci ?? []).map(e => [e.section, zoneDraft(e)]));
    const was = unboundBase(before);
    for (const d of draft.forwarders) {
      const a = now.get(d.key);
      if (d.removed) { if (!d.isNew && a) out.push(`${d.key} was not removed`); continue; }
      if (d.isNew && !a) { out.push(`${d.key} was not saved`); continue; }
      if (!d.isNew && !fieldDiffs(was.get(d.key), d.values).length) continue;
      if (a && fieldDiffs(a, d.values).length) out.push(`${d.key} was not saved as written`);
    }
    return out;
  }
  const want = draft.forwarders.filter(d => !d.removed).map(d => d.value.trim()).filter(Boolean).join('\n');
  const got = (after.forward_uci ?? []).map(e => e.value.trim()).filter(Boolean).join('\n');
  const was = (before.forward_uci ?? []).map(e => e.value.trim()).filter(Boolean).join('\n');
  if (want !== was && want !== got) out.push('the server entries were not saved as written');
  return out;
}

// The first sentence that says Unbound does not forward as the draft asked after a save (a domain a forward zone should take is
// missing, or one that was removed is still forwarded), or null. Skipped when the running forwarders cannot be listed.
export function forwardingProblem(before, after, draftIn) {
  const draft = dr(draftIn);
  if (!isUnbound(before) || after.engines?.unbound?.control === false || after.truncated?.forwards) return null;
  const running = new Set((after.forwards ?? []).map(r => normZone(r.zone)));
  const base = unboundBase(before);
  const keep = new Set();
  const forwardZone = v => v.zone_type === 'forward_zone';
  for (const d of draft.forwarders) if (!d.removed && d.values.enabled && forwardZone(d.values)) for (const z of d.values.zone_name.map(normZone)) keep.add(z);
  for (const d of draft.forwarders) {
    if (d.removed || !d.values.enabled || !forwardZone(d.values)) continue;
    if (!d.isNew && !fieldDiffs(base.get(d.key), d.values).length) continue;
    const missing = d.values.zone_name.map(normZone).filter(z => !running.has(z));
    if (missing.length) return `Unbound is not forwarding ${missing.length === 1 ? `"${missing[0]}"` : `${missing.length} of the domains of ${d.key}`} yet`;
  }
  for (const d of draft.forwarders) {
    if (!d.removed || d.isNew) continue;
    const b = base.get(d.key);
    if (!b.enabled || !forwardZone(b)) continue;
    const stale = b.zone_name.map(normZone).filter(z => running.has(z) && !keep.has(z) && !(before.forwards ?? []).some(r => r.source !== 'uci' && normZone(r.zone) === z));
    if (stale.length) return `Unbound still forwards ${stale.length === 1 ? `"${stale[0]}"` : `${stale.length} domains`} of the removed ${d.key}`;
  }
  return null;
}

//#endregion
