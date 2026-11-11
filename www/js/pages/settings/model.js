// The System settings page's model: what the form holds, whether it is valid, what changed, and which UCI
// operations write the change. Pure functions with no DOM and no network, so they are unit-tested directly.
// The options themselves come from schema.js, so every function here works for any field in that table.
//
// Data shape (readSettings):
//   { system: { section, values }, ntp: { section, values }, clock, ntpd }
//   `section` is the UCI section name (null when the config has none), `values` its options as UCI returns them
//   (a string, or an array for a list).
// Draft shape (what the form edits):
//   { values: { <option>: string | boolean | string[] }, zone: { name, rule } }
//   An empty string or list means "not set". `zone.name` '' means "custom rule".
import { FIELDS } from './schema.js';
import { ZONES } from './zones.js';

// The config both sections live in, and the name given to the `timeserver` section when the router has none.
export const CONFIG = 'system';
export const NTP_SECTION = 'ntp';

//#region Reading

// The options of a section as UCI returns it, without its bookkeeping keys (.type, .name, .anonymous).
const optionsOf = section => Object.fromEntries(Object.entries(section).filter(([k]) => !k.startsWith('.')));

// The first section of a type as { section, values }; { section: null, values: {} } when there is none.
function firstSection(cfg, type) {
  for (const [name, s] of Object.entries(cfg ?? {})) {
    if (s['.type'] === type) return { section: s['.name'] ?? name, values: optionsOf(s) };
  }
  return { section: null, values: {} };
}

// The settings from the replies of `uci get system` (all sections), `system info` and `service list sysntpd`.
// The last two are optional: without them the clock and the NTP client state are null.
export function readSettings(cfg, info, svc) {
  const instances = Object.values(svc?.sysntpd?.instances ?? {});
  return {
    system: firstSection(cfg, 'system'),
    ntp: firstSection(cfg, 'timeserver'),
    clock: info?.unixtime != null && info?.localtime != null
      ? { unixtime: info.unixtime, localtime: info.localtime, offset: info.localtime - info.unixtime }
      : null,
    // Whether sysntpd runs, and the servers on its command line (the -p arguments), which include DHCP ones.
    ntpd: svc ? {
      running: instances.some(i => i.running),
      servers: instances.flatMap(i => (i.command ?? []).flatMap((a, n, cmd) => (a === '-p' && cmd[n + 1] ? [cmd[n + 1]] : []))),
    } : null,
  };
}

// UCI spells booleans several ways; `fallback` is the value when the option is absent or unrecognized.
export function uciBool(v, fallback) {
  const s = String(v ?? '').toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(s)) return false;
  return fallback;
}

// A UCI option as a list: a single value may hold several words separated by spaces; absent is empty.
const asList = v => (v == null ? [] : Array.isArray(v) ? v.map(String) : String(v).trim().split(/\s+/).filter(Boolean));

// The form value of a field on the router: a boolean (the default when absent), a list, or a string ('' = not set).
export function currentValue(field, data) {
  const raw = data[field.section].values[field.key];
  if (field.type === 'bool') return uciBool(raw, field.default ?? false);
  if (field.type === 'list') return asList(raw);
  return raw == null ? '' : String(raw);
}

//#endregion

//#region The time zone

// The POSIX TZ rule of an IANA zone name, or undefined for a name that is not in the table.
export const ruleOf = zonename => ZONES[zonename];

// Zone names by region for the drop-down: [['Europe', ['Europe/Amsterdam', ...]], ...]; "UTC" is its own group.
export function zoneGroups() {
  const groups = new Map();
  for (const name of Object.keys(ZONES)) {
    const region = name.includes('/') ? name.slice(0, name.indexOf('/')) : name;
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push(name);
  }
  return [...groups];
}

// A POSIX TZ rule such as "CET-1CEST,M3.5.0,M10.5.0/3": a standard-time name and offset, optionally a
// daylight-time name (with offset) and the start and end rules. Loose on purpose; it catches typos.
const TZ_RULE = /^(<[A-Za-z0-9+-]+>|[A-Za-z]{3,})[-+]?\d{1,2}(:\d{2}){0,2}([<A-Za-z][^,\s]*)?(,[A-Za-z0-9./:+-]+,[A-Za-z0-9./:+-]+)?$/;
export const validRule = rule => TZ_RULE.test(rule);

// The zone as the form holds it: the zone name when the table knows it, else '' (custom) with the rule as is.
const zoneOf = data => ({ name: ruleOf(data.system.values.zonename) ? data.system.values.zonename : '', rule: data.system.values.timezone ?? '' });

//#endregion

//#region The draft

// The form's starting values: the router's current values.
export const draftFrom = data => ({
  values: Object.fromEntries(FIELDS.map(f => [f.key, currentValue(f, data)])),
  zone: zoneOf(data),
});

// A value as it will be written: strings trimmed (notes keep inner line breaks), lists trimmed without blanks.
function normalize(field, v) {
  if (field.type === 'list') return v.map(s => s.trim()).filter(Boolean);
  if (field.type === 'bool') return v;
  return field.type === 'text' ? v.replace(/\r\n/g, '\n').trim() : v.trim();
}

// A value for the review list: on/off, a comma list, the text, or "default" when empty.
function show(field, v) {
  if (field.type === 'bool') return v ? 'on' : 'off';
  if (field.type === 'list') return v.length ? v.join(', ') : 'none';
  return v === '' ? 'default' : v.length > 60 ? `${v.slice(0, 57)}…` : v;
}

// Whether two normalized values differ.
const differs = (field, a, b) => (field.type === 'list' ? a.join('\n') !== b.join('\n') : a !== b);

// The differences between the router's values and the draft, for the review list:
// [{ key, label, from, to }]. The time zone is reported under the key 'zone'.
export function changesOf(data, draft) {
  const out = [];
  for (const f of FIELDS) {
    const from = normalize(f, currentValue(f, data));
    const to = normalize(f, draft.values[f.key]);
    if (differs(f, from, to)) out.push({ key: f.key, label: f.label, from: show(f, from), to: show(f, to) });
  }
  const zone = zoneChange(data, draft);
  if (zone) out.unshift({ key: 'zone', label: 'Time zone', from: data.system.values.zonename || data.system.values.timezone || 'not set', to: zone.name || zone.rule });
  return out;
}

// The zone as it will be written ({ name, rule }), or null when the draft leaves it as it is. A named zone
// changes when the name does; a custom rule when its text does, or when it replaces a named zone.
function zoneChange(data, draft) {
  const now = zoneOf(data);
  const rule = draft.zone.rule.trim();
  if (draft.zone.name) return draft.zone.name !== now.name ? { name: draft.zone.name, rule: ruleOf(draft.zone.name) } : null;
  return now.name !== '' || rule !== now.rule ? { name: '', rule } : null;
}

// Whether the draft differs from the router in any way, including blank list rows that were added.
export const isDirty = (data, draft) => changesOf(data, draft).length > 0
  || FIELDS.some(f => f.type === 'list' && draft.values[f.key].length !== normalize(f, draft.values[f.key]).length);

//#endregion

//#region Validation

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^(?=.*:.*:)[0-9A-Fa-f:]+(\.[0-9]{1,3}){0,3}$/;

// Whether `s` can be given to ntpd as a server: a host name, an IPv4 address or an IPv6 address.
export const validServer = s => HOSTNAME.test(s) || IPV6.test(s);

// The checks a field's `check` names: each returns an error message, or null when the value is fine.
// They run on non-empty values only (an empty value means "not set").
const CHECKS = {
  label: v => (LABEL.test(v) ? null : 'must be one name of letters, digits and hyphens, without dots or spaces'),
  host: v => (validServer(v) ? null : 'is not a valid host name or IP address'),
  ip: v => (IPV4.test(v) || IPV6.test(v) ? null : 'is not an IP address'),
  path: v => (/^\/\S+$/.test(v) ? null : 'must be an absolute path without spaces'),
  seed: v => (v === '0' || /^\/\S+$/.test(v) ? null : 'must be 0 or an absolute path without spaces'),
  ifname: v => (/^[A-Za-z0-9_.-]+$/.test(v) ? null : 'must be a network interface name (letters, digits, _ . -)'),
};

// The error for one non-empty value of a field, or null.
function fieldError(field, v) {
  if (field.type === 'int') {
    if (!/^\d+$/.test(v)) return 'must be a whole number';
    const n = +v;
    if (field.min != null && n < field.min) return `must be at least ${field.min}`;
    if (field.max != null && n > field.max) return `must be at most ${field.max}`;
    return null;
  }
  if (field.type === 'enum') return field.options.includes(v) ? null : `must be one of ${field.options.join(', ')}`;
  if (field.type === 'string' && /[\r\n]/.test(v)) return 'must be a single line';
  return field.check ? CHECKS[field.check](v) : null;
}

// What stops the form from being saved (`errors`: { key, index?, text }) and what only deserves a warning.
// `index` is the row of a list; the zone's custom rule is reported under the key 'zone'.
export function problems(data, draft) {
  const errors = [];
  const warnings = [];
  const value = key => normalize(FIELDS.find(f => f.key === key), draft.values[key]);

  for (const f of FIELDS) {
    if (f.type === 'bool') continue;
    if (f.type === 'list') {
      const seen = new Set();
      draft.values[f.key].forEach((raw, index) => {
        const v = raw.trim();
        if (!v) return;
        const bad = fieldError(f, v);
        if (bad) errors.push({ key: f.key, index, text: `${f.label}: "${v}" ${bad}.` });
        else if (seen.has(v.toLowerCase())) errors.push({ key: f.key, index, text: `${f.label}: "${v}" is listed twice.` });
        seen.add(v.toLowerCase());
      });
      continue;
    }
    const v = normalize(f, draft.values[f.key]);
    const bad = v ? fieldError(f, v) : null;
    if (bad) errors.push({ key: f.key, text: `${f.label} ${bad}.` });
  }

  if (zoneChange(data, draft) && !draft.zone.name) {
    const rule = draft.zone.rule.trim();
    if (!rule) errors.push({ key: 'zone', text: 'Enter a POSIX time zone rule, or pick a zone.' });
    else if (!validRule(rule)) errors.push({ key: 'zone', text: `"${rule}" is not a POSIX time zone rule such as CET-1CEST,M3.5.0,M10.5.0/3.` });
  }

  if (draft.values.enabled && !value('server').length && !draft.values.use_dhcp) warnings.push('NTP is on but no server is set and DHCP servers are not used, so the router will not synchronize its clock.');
  if (draft.values.enabled && !value('server').length && draft.values.use_dhcp) warnings.push('No server is set: the clock will only follow servers offered by DHCP, and the NTP client does not start when DHCP offers none.');
  if (value('log_type') === 'file' && !value('log_file')) warnings.push('The log storage is "file" but no log file is set.');
  if (draft.values.log_remote && !value('log_ip') && changesOf(data, draft).some(c => c.key === 'log_remote')) warnings.push('Remote logging is switched on but no remote syslog server is set, so nothing is sent.');
  return { errors, warnings };
}

//#endregion

//#region Writing

// UCI booleans are written as '1' / '0'.
const flag = b => (b ? '1' : '0');

// The UCI operations that turn the router's config into the draft, as data:
//   { op: 'set' | 'add' | 'delete', config, section, type?, name?, values? | options? }
// Only what changed is written; an emptied option is deleted rather than set to ''. A missing `system` or
// `timeserver` section is created.
export function plan(data, draft) {
  const bySection = { system: { set: {}, del: [] }, ntp: { set: {}, del: [] } };
  const changed = new Set(changesOf(data, draft).map(c => c.key));

  for (const f of FIELDS.filter(x => changed.has(x.key))) {
    const v = normalize(f, draft.values[f.key]);
    const target = bySection[f.section];
    if (f.type === 'bool') target.set[f.key] = flag(v);
    else if (v.length === 0) target.del.push(f.key);
    else target.set[f.key] = v;
  }

  // Both zone options are written together; a custom rule drops the zone name, which would no longer match.
  const zone = changed.has('zone') ? zoneChange(data, draft) : null;
  if (zone) {
    bySection.system.set.timezone = zone.rule;
    if (zone.name) bySection.system.set.zonename = zone.name;
    else bySection.system.del.push('zonename');
  }

  const ops = [];
  const emit = (key, type, name) => {
    const { set, del } = bySection[key];
    const section = data[key].section;
    if (!section) {
      if (Object.keys(set).length) ops.push({ op: 'add', config: CONFIG, type, ...(name ? { name } : {}), values: set });
      return;
    }
    if (Object.keys(set).length) ops.push({ op: 'set', config: CONFIG, section, values: set });
    const existing = del.filter(o => data[key].values[o] !== undefined);
    if (existing.length) ops.push({ op: 'delete', config: CONFIG, section, options: existing });
  };
  emit('system', 'system');
  emit('ntp', 'timeserver', NTP_SECTION);
  return ops;
}

// Stages the planned operations through a uci API (core/uci.js).
export async function stage(ed, ops) {
  for (const o of ops) {
    if (o.op === 'set') await ed.set(o.config, o.section, o.values);
    else if (o.op === 'add') await ed.add(o.config, o.type, o.values, o.name);
    else await ed.delete(o.config, o.section, o.options);
  }
}

// Throws unless the settings `after` (read back once the change is applied) hold what the draft asked for.
// `before` is what the draft was made from: the zone rule is only checked when the draft changed the zone.
export function checkApplied(before, after, draft) {
  const left = changesOf(after, draft);
  if (left.length) throw new Error(`${left.map(c => c.label).join(', ')} ${left.length > 1 ? 'were' : 'was'} not saved`);
  const zone = zoneChange(before, draft);
  if (zone?.name && after.system.values.timezone !== zone.rule) throw new Error('the time zone rule was not saved');
}

//#endregion

//#region Formatting

// "UTC+01:00" for an offset in seconds (negative west of Greenwich).
export function fmtOffset(seconds) {
  const sign = seconds < 0 ? '-' : '+';
  const abs = Math.abs(seconds);
  const pad = n => String(n).padStart(2, '0');
  return `UTC${sign}${pad(Math.floor(abs / 3600))}:${pad(Math.floor(abs % 3600 / 60))}`;
}

// The router's local seconds (the clock value that already includes the zone offset) as "2026-11-11 12:52:53",
// and its date and time parts; read as UTC so the browser's own time zone does not shift them.
export const fmtLocal = localtime => new Date(localtime * 1000).toISOString().replace('T', ' ').slice(0, 19);
export const fmtDate = localtime => fmtLocal(localtime).slice(0, 10);
export const fmtTime = localtime => fmtLocal(localtime).slice(11);

//#endregion
