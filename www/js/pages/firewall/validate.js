// Validation of the Firewall page's draft: the errors that block Save, the warnings that do not, and the check that a change cannot lock the
// administrator out. Pure: no DOM and no network.
//
// Rules the checks follow:
//  - An error is a value firewall4 would refuse or skip (a bad address, a port above 65535, a rule that names a zone that does not exist),
//    so the page never writes a configuration that fw4 cannot use. A problem that is already in the router's file and sits in a section
//    the form has not touched is only a warning, so that unrelated edits can still be saved; a problem that the edit introduces (a rule
//    left pointing at a zone that was just removed) is always an error.
//  - A warning is something that works but is probably not what was meant (ports on a protocol that has none, a forward that opens every port).
import { CHECKS, subnetFamily, unnegate } from './check.js';
import { DEFAULT_FIELDS, REDIRECT_FIELDS, RULE_FIELDS, ZONE_FIELDS } from './schema.js';
import { KINDS, changedFields, draftFrom, fieldFor, formValues, isShown, itemChanged, live, networkNames, policyOf, zoneName } from './edit.js';

//#region One field

// The error text of one non-empty value of a field, or null. `ctx.networks` are the router's interface names.
function valueError(f, v, ctx) {
  if (f.type === 'int') {
    if (!/^\d+$/.test(v)) return 'must be a whole number';
    return f.min != null && +v < f.min ? `must be at least ${f.min}` : null;
  }
  if (f.type === 'enum') return f.zone || f.options.includes(v) ? null : `must be one of ${f.options.join(', ')}`;
  if (f.type === 'string' && /[\r\n]/.test(v)) return 'must be a single line';
  return f.check ? CHECKS[f.check](v, ctx) : null;
}

// The errors of one field's draft value as [{ index?, text }], where `label` introduces each message. A list reports the row of each
// invalid or repeated value (blank rows are ignored); a required field that is empty reports once.
export function fieldErrors(f, value, label, ctx) {
  if (f.type === 'bool') return [];
  const out = [];
  if (f.type === 'list') {
    const seen = new Set();
    value.forEach((raw, index) => {
      const v = raw.trim();
      if (!v) return;
      const bad = valueError(f, v, ctx);
      if (bad) out.push({ index, text: `${label}: "${v}" ${bad}.` });
      else if (seen.has(v.toLowerCase())) out.push({ index, text: `${label}: "${v}" is listed twice.` });
      seen.add(v.toLowerCase());
    });
    return out;
  }
  const v = String(value).trim();
  if (!v) return f.required ? [{ text: `${label} is required.` }] : [];
  const bad = valueError(f, v, ctx);
  return bad ? [{ text: `${label} "${v}" ${bad}.` }] : [];
}

// The problems of every field of a table that is shown for these values, as [{ key, index?, text, level: 'error' }].
function tableProblems(fields, values, ctx) {
  const out = [];
  for (const base of fields) {
    if (!isShown(base, values)) continue;
    const f = fieldFor(base, values);
    for (const e of fieldErrors(f, values[f.key], f.label, ctx)) out.push({ ...e, key: f.key, level: 'error' });
  }
  return out;
}

//#endregion

//#region References to zones

// The names of the zones of the draft (the ones not marked for removal), with whether each is enabled.
export function zoneMap(draft) {
  return new Map(live(draft.zones).filter(z => zoneName(z)).map(z => [zoneName(z), z]));
}

// The problems of a reference to a zone in the option `key` (`role` says whose zone it is: "source", "destination"): the empty value and
// (where `any` is allowed) "*" are fine; a zone that does not exist is an error (`introduced` when it existed before this edit); a zone that
// is disabled is a warning, because the firewall skips what refers to it.
function zoneRef(draft, data, key, value, role, any = true) {
  if (!value || (any && value === '*')) return [];
  const zones = zoneMap(draft);
  if (!zones.has(value)) {
    const existed = data.zones.some(z => (z.values.name ?? '') === value);
    return [{ key, level: 'error', introduced: existed, text: `The ${role} zone "${value}" ${existed ? 'is being removed' : 'does not exist'}. Choose another zone${existed ? ' or keep the zone' : ''}.` }];
  }
  return zones.get(value).values.enabled ? [] : [{ key, level: 'warn', text: `The ${role} zone "${value}" is disabled, so the firewall skips this.` }];
}

//#endregion

//#region Kinds

// Whether a protocol list matches TCP or UDP (an empty list means both).
const hasPorts = protos => protos.length === 0 || protos.some(p => ['tcp', 'udp', 'tcpudp', '6', '17'].includes(p.toLowerCase()));

// The warning when ports are set but no listed protocol has ports, or null.
function portsIgnored(protos, ...lists) {
  return !hasPorts(protos) && lists.some(l => [].concat(l).some(p => String(p).trim())) ? 'Ports only apply to TCP and UDP, so with these protocols they are ignored.' : null;
}

// The warning when an address of one family is combined with a family restriction to the other, or null.
function familyMismatch(family, ...lists) {
  const fams = new Set(lists.flatMap(l => [].concat(l)).map(a => (String(a).trim() ? subnetFamily(String(a)) : null)).filter(Boolean));
  if (family === 'ipv6' && fams.size && !fams.has(6)) return 'The addresses are IPv4 but the address family is IPv6 only, so this matches nothing.';
  if (family === 'ipv4' && fams.size && !fams.has(4)) return 'The addresses are IPv6 but the address family is IPv4 only, so this matches nothing.';
  return null;
}

// The problems of a zone item.
function zoneProblems(item, draft, data, ctx) {
  const v = item.values, out = tableProblems(ZONE_FIELDS, v, ctx);
  const name = zoneName(item);
  const same = live(draft.zones).filter(z => zoneName(z) === name);
  if (name && same.length > 1) {
    const before = data.zones.filter(z => (z.values.name ?? '') === name).length > 1;
    out.push({ key: 'name', level: 'error', introduced: !before, text: `Another zone is called "${name}". Zone names must be unique.` });
  }
  if (item.isNew && name && data.zones.some(z => z.values.name === name && !live(draft.zones).some(x => x.id === z.section))) {
    out.push({ key: 'name', level: 'warn', text: `A zone called "${name}" was removed in this form; saving removes it and creates this one.` });
  }
  const known = new Set(networkNames(data));
  v.network.filter(n => n.trim()).forEach((n, index) => {
    if (!known.has(n)) out.push({ key: 'network', index, level: 'warn', text: `"${n}" is not an interface of the router (/etc/config/network).` });
    for (const other of live(draft.zones)) {
      if (other.id !== item.id && other.values.network.includes(n)) {
        const before = data.zones.filter(z => (z.values.network ?? []).includes(n)).length > 1;
        out.push({ key: 'network', index, level: 'error', introduced: !before, moved: true, text: `Interface "${n}" is also in zone "${zoneName(other)}". An interface can be in one zone only.` });
      }
    }
  });
  if (!v.network.length && !v.device.length && !v.subnet.length && name) {
    out.push({ key: 'network', level: 'warn', text: `The zone has no interface, device or subnet, so the firewall looks for an interface called "${name}"${known.has(name) ? '' : ', which does not exist: the zone stays empty'}.` });
  }
  return out;
}

// The problems of a forwarding item.
function forwardingProblems(item, draft, data) {
  const v = item.values, out = [...zoneRef(draft, data, 'src', v.src, 'source'), ...zoneRef(draft, data, 'dest', v.dest, 'destination')];
  if (!v.src) out.push({ key: 'src', level: 'error', text: 'The source zone is required.' });
  if (!v.dest) out.push({ key: 'dest', level: 'error', text: 'The destination zone is required.' });
  if (v.src && v.src === v.dest) out.push({ key: 'dest', level: 'warn', text: 'Traffic within a zone is governed by the zone\'s forward policy, so a forwarding from a zone to itself does nothing.' });
  if (v.enabled && v.src && v.dest && live(draft.forwardings).some(f => f !== item && f.values.enabled && f.values.src === v.src && f.values.dest === v.dest)) {
    out.push({ key: 'dest', level: 'warn', text: 'The same forwarding exists twice.' });
  }
  return out;
}

// The problems of a traffic rule item.
function ruleProblems(item, draft, data, ctx) {
  const v = item.values, out = tableProblems(RULE_FIELDS, v, ctx);
  out.push(...zoneRef(draft, data, 'src', v.src, 'source'), ...zoneRef(draft, data, 'dest', v.dest, 'destination'));
  if (v.target === 'MARK' && !v.set_mark.trim() && !v.set_xmark.trim()) out.push({ key: 'set_mark', level: 'error', text: 'The action MARK needs a mark to set.' });
  if (v.target === 'NOTRACK' && !v.src) out.push({ key: 'src', level: 'error', text: 'The action NOTRACK needs a source zone.' });
  const ports = portsIgnored(v.proto, v.src_port, v.dest_port);
  if (ports) out.push({ key: 'proto', level: 'warn', text: ports });
  const fam = familyMismatch(v.family, v.src_ip, v.dest_ip);
  if (fam) out.push({ key: 'family', level: 'warn', text: fam });
  return out;
}

// The problems of a port forward (redirect) item.
function redirectProblems(item, draft, data, ctx) {
  const v = item.values, snat = v.target === 'SNAT', out = tableProblems(REDIRECT_FIELDS, v, ctx);
  if (snat) {
    if (!v.dest) out.push({ key: 'dest', level: 'error', text: 'A source NAT needs a destination zone.' });
    else if (v.dest === '*') out.push({ key: 'dest', level: 'error', text: 'A source NAT cannot use "any zone" as the destination.' });
    out.push(...zoneRef(draft, data, 'src', v.src, 'source'), ...zoneRef(draft, data, 'dest', v.dest, 'destination', false));
  } else {
    if (!v.src) out.push({ key: 'src', level: 'error', text: 'A port forward needs a source zone, usually the one that faces the Internet.' });
    else if (v.src === '*') out.push({ key: 'src', level: 'error', text: 'A port forward cannot use "any zone" as the source.' });
    out.push(...zoneRef(draft, data, 'src', v.src, 'source', false), ...zoneRef(draft, data, 'dest', v.dest, 'destination'));
    if (v.dest_ip.trim().startsWith('!')) out.push({ key: 'dest_ip', level: 'error', text: 'The internal address cannot be negated.' });
    if (!v.dest_ip.trim() && !v.dest_port.trim() && !v.src_dport.trim()) out.push({ key: 'dest_port', level: 'error', text: 'Give an internal address or a port, otherwise there is nothing to forward to.' });
    else if (!v.src_dport.trim() && v.enabled) out.push({ key: 'src_dport', level: 'warn', text: 'Without a port to match, every port of the protocol is forwarded.' });
  }
  const ports = portsIgnored(v.proto, v.src_port, snat ? v.dest_port : v.src_dport);
  if (ports) out.push({ key: 'proto', level: 'warn', text: ports });
  const fam = familyMismatch(v.family, v.src_ip, v.dest_ip, snat ? v.src_dip : '');
  if (fam) out.push({ key: 'family', level: 'warn', text: fam });
  const zones = zoneMap(draft);
  v.reflection_zone.forEach((z, index) => { if (z.trim() && !zones.has(z)) out.push({ key: 'reflection_zone', index, level: 'error', text: `The reflection zone "${z}" does not exist.` }); });
  return out;
}

// The problems of the global defaults.
function defaultsProblems(values, ctx) {
  const out = tableProblems(DEFAULT_FIELDS, values, ctx);
  if (values.flow_offloading_hw && !values.flow_offloading) out.push({ key: 'flow_offloading_hw', level: 'warn', text: 'Hardware flow offloading depends on software flow offloading, which is off.' });
  return out;
}

//#endregion

//#region Titles

// A short name for an item in messages: "Zone lan", "Rule "Allow-SSH"", "Rule #3", "Forwarding lan › wan".
export function titleOf(key, item, draft) {
  const v = item.values;
  if (key === 'zones') return `Zone ${zoneName(item) || '(unnamed)'}`;
  if (key === 'forwardings') return `Forwarding ${v.src || '?'} › ${v.dest || '?'}`;
  const noun = key === 'rules' ? 'Rule' : 'Port forward';
  if (v.name.trim()) return `${noun} "${v.name.trim()}"`;
  // An item marked for removal has no place among the live ones: its position in the whole list is used.
  const place = live(draft[key]).indexOf(item);
  return `${noun} #${(place < 0 ? draft[key].indexOf(item) : place) + 1}`;
}

//#endregion

//#region Lock-out

// Whether a port range text ("22", "6666-6670") holds the port.
function portCovers(text, port) {
  const m = /^(\d+)(?:[-:](\d+))?$/.exec(text.trim());
  return Boolean(m) && +m[1] <= port && port <= +(m[2] ?? m[1]);
}

// Whether hosts in zone `z` can reach TCP port `port` of the router: the zone is enabled and its input policy accepts, or an enabled rule
// accepts it (a rule with a source zone and no destination zone is about traffic to the router itself).
function zoneReaches(draft, z, port) {
  if (!z.values.enabled) return false;
  if (policyOf(draft, z, 'input') === 'ACCEPT') return true;
  const name = zoneName(z);
  return live(draft.rules).some(r => {
    const v = r.values;
    if (!v.enabled || v.target !== 'ACCEPT' || v.dest || !v.src || (v.src !== '*' && v.src !== name)) return false;
    const tcp = v.proto.length === 0 || v.proto.some(p => ['tcp', 'all', 'tcpudp', '6', '*', 'any'].includes(p.toLowerCase()));
    const ports = v.dest_port.filter(p => p.trim());
    return tcp && (ports.length === 0 || ports.some(p => !p.trim().startsWith('!') && portCovers(p, port)));
  });
}

// For one port: which zones, and which interfaces (through their zone), can reach it. The first enabled zone that holds an interface counts.
function reach(draft, port) {
  const zones = new Map(), networks = new Map();
  for (const z of live(draft.zones)) {
    const ok = zoneReaches(draft, z, port);
    zones.set(zoneName(z), ok);
    for (const n of z.values.network) if (!networks.has(n) || (!networks.get(n) && ok)) networks.set(n, ok);
  }
  return { zones, networks };
}

// Warnings about changes that could cut the administrator off. `ctx.admin` are the interfaces whose address the page was opened with (the
// router's own address in the browser's URL), `ctx.host` that address, `ctx.port` the port of the web interface. For every zone that lets
// its hosts reach the web interface or SSH today and would not after the change, one warning; stronger when it is the zone of the interface
// the administrator is using. Hosts behind another zone, or a name instead of an address, cannot be recognized, so those zones are named too.
export function lockoutWarnings(data, draft, ctx = {}) {
  const before = draftFrom(data), out = [];
  const admin = ctx.admin ?? [];
  const targets = [{ port: ctx.port || 443, what: 'the web interface' }, { port: 22, what: 'SSH' }];
  const adminZones = new Set();
  for (const { port, what } of targets) {
    const b = reach(before, port), a = reach(draft, port);
    for (const n of admin) {
      if (b.networks.get(n) && !a.networks.get(n)) {
        const zone = before.zones.find(z => z.values.network.includes(n));
        adminZones.add(`${port}:${zone ? zoneName(zone) : ''}`);
        out.push(`Lock-out risk: you are reaching the router at ${ctx.host} (interface ${n}, zone ${zone ? zoneName(zone) : '?'}), and after this change that interface can no longer reach ${what} (port ${port}). The router restores the previous configuration by itself if this page cannot confirm the change within 30 seconds, but an administrator on another path may not get through.`);
      }
    }
    for (const [name, ok] of b.zones) {
      if (ok && !a.zones.get(name) && !adminZones.has(`${port}:${name}`)) {
        out.push(`Zone ${name} lets its hosts reach ${what} (port ${port}) today and would not after this change: its input policy or an accepting rule changes, or the zone is disabled or removed, or its interfaces move. If you manage the router from ${name}, you would lose access (the router restores the previous configuration within 30 seconds if this page cannot confirm).`);
      }
    }
  }
  return out;
}

//#endregion

//#region The whole draft

// The problems of one item turned into banner entries: an error of an item that the form has not touched (and that was not caused by this
// edit) is only a warning.
function collect(errors, warnings, key, item, found, draft, data) {
  const title = titleOf(key, item, draft);
  const touched = item.isNew || itemChanged(data, key, item);
  for (const p of found) {
    if (p.level === 'error' && (touched || p.introduced)) errors.push({ key: `${key}:${item.id}:${p.key}`, index: p.index, text: `${title}: ${p.text}` });
    else warnings.push(`${title}: ${p.text}${p.level === 'error' ? ' (this is already in the configuration)' : ''}`);
  }
}

// The errors and warnings of the draft: { errors: [{ key, index?, text }], warnings: [text] }, for every zone, forwarding, rule, port forward
// and the defaults, plus names used twice and the lock-out warnings. `ctx` is the context of lockoutWarnings; items marked for removal are
// not checked.
export function problems(data, draft, ctx = {}) {
  const errors = [], warnings = [];
  const c = { networks: networkNames(data) };
  const checks = { zones: zoneProblems, forwardings: forwardingProblems, rules: ruleProblems, redirects: redirectProblems };
  for (const key of Object.keys(KINDS)) {
    for (const item of live(draft[key])) collect(errors, warnings, key, item, checks[key](item, draft, data, c), draft, data);
  }
  const found = defaultsProblems(draft.defaults, c);
  const changed = changedFields(DEFAULT_FIELDS, formValues(DEFAULT_FIELDS, data.defaults.values), draft.defaults).length > 0;
  for (const p of found) {
    if (p.level === 'error' && changed) errors.push({ key: `defaults:${p.key}`, index: p.index, text: `Global settings: ${p.text}` });
    else warnings.push(`Global settings: ${p.text}`);
  }
  for (const key of ['rules', 'redirects']) {
    const names = new Map();
    for (const item of live(draft[key])) {
      const name = item.values.name.trim();
      if (!name || !item.values.enabled) continue;
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    for (const [name, n] of names) if (n > 1) warnings.push(`${n} ${key === 'rules' ? 'rules' : 'port forwards'} are called "${name}": their hit counters are added together.`);
  }
  warnings.push(...lockoutWarnings(data, draft, ctx));
  return { errors, warnings };
}

// The errors and warnings of one item's working copy in its dialog, as [{ key, index?, text, level }] (the field keys are the ones of the
// option table). `draft` is the page's draft; the item with id `id` (null for a new one) is taken as having the values `values`. An
// interface that a zone's form takes from another zone is not a problem there: accepting the form moves it.
export function itemProblems(key, id, values, draft, data) {
  const c = { networks: networkNames(data) };
  const item = { id: id ?? 'new:form', isNew: id == null, removed: false, values };
  const list = id == null ? [...draft[key], item] : draft[key].map(i => (i.id === id ? item : i));
  const trial = { ...draft, [key]: list };
  const checks = { zones: zoneProblems, forwardings: forwardingProblems, rules: ruleProblems, redirects: redirectProblems };
  return checks[key](item, trial, data, c).filter(p => !p.moved);
}

//#endregion
