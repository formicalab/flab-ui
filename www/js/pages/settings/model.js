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
import { differs, errorsOf, flag, hasBlankRows, normalize, sectionsOf, show, valueOf, validServer } from '../../core/fields.js';
import { stageOps } from '../../core/ops.js';
import { FIELDS } from './schema.js';
import { ZONES } from './zones.js';

export { validServer };

// The config both sections live in, and the name given to the `timeserver` section when the router has none.
export const CONFIG = 'system';
export const NTP_SECTION = 'ntp';

//#region Reading

// The first section of a type as { section, values }; { section: null, values: {} } when there is none.
const firstSection = (cfg, type) => sectionsOf(cfg, type)[0] ?? { section: null, values: {} };

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

// The form value of a field on the router: a boolean (the default when absent), a list, or a string ('' = not set).
export const currentValue = (field, data) => valueOf(field, data[field.section].values[field.key]);

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
  || FIELDS.some(f => hasBlankRows(f, draft.values[f.key]));

//#endregion

//#region Validation

// What stops the form from being saved (`errors`: { key, index?, text }) and what only deserves a warning.
// `index` is the row of a list; the zone's custom rule is reported under the key 'zone'.
export function problems(data, draft) {
  const errors = [];
  const warnings = [];
  const value = key => normalize(FIELDS.find(f => f.key === key), draft.values[key]);

  for (const f of FIELDS) {
    for (const e of errorsOf(f, draft.values[f.key])) errors.push({ key: f.key, ...e });
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
export const stage = stageOps;

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
