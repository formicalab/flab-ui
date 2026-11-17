// The model of the Settings tab of the Traffic page: what the form holds, whether it is valid, what a setting does, which UCI
// operations write the change, and the checks after a save. Pure functions with no DOM and no network, so they are unit-tested
// directly. The options themselves come from settings-schema.js, so every function here works for any field in that table.
//
// Data shape (readNlbw):
//   { installed, section, values, extraSections, status, daemon, periods, networks, memTotal, paths, probes, staged }
//   `section` is the UCI name of the first `nlbwmon` section (null when the config has none), `values` its options as UCI returns
//   them (a string, or an array for a list). `daemon` is { known, running, pid, command } from procd, `periods` the reply of
//   flab.traffic usage_periods ({ running, list, current, today }), `networks` the logical interface names, `paths` the reply of
//   nlbwmon_paths for the saved settings and `probes` the same for paths typed but not saved yet ({ dir: {path: info}, file: {...} }).
// Draft shape (what the form edits):
//   { values: { <option>: string | boolean | string[] } }   an empty string or list means "not set".
import { asList, differs, errorsOf, flag, hasBlankRows, normalize, sectionsOf, show, valueOf } from '../../core/fields.js';
import { FIELDS } from './settings-schema.js';

// The config and the section type it holds.
export const CONFIG = 'nlbwmon';
const TYPE = 'nlbwmon';
// The most seconds nlbwmon accepts for an interval (it multiplies by 1000 into a 32-bit number): 24 days, 20 hours.
const MAX_SECONDS = 2147483;
// The smallest netlink buffer nlbwmon accepts, in bytes.
const MIN_BUFFER = 32768;
// What one database entry roughly costs in RAM, in bytes.
const ENTRY_BYTES = 100;
const SECONDS = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };

// The field with this key.
const fieldOf = key => FIELDS.find(f => f.key === key);
// A number with thousands separators, the same in every locale.
const fmtN = n => Math.round(n).toLocaleString('en-US');
// "1 day", "2 hours": a count with its unit, plural when it is not 1 (`many` is the plural when it is not just an "s").
const plural = (n, unit, many = `${unit}s`) => `${fmtN(n)} ${n === 1 ? unit : many}`;

//#region Reading

// The state of the nlbwmon daemon from procd's `service list nlbwmon` reply (or, without it, from the plugin's status).
// { known, running, pid, command } where `command` is the daemon's command line (the flags the init script built).
function daemonOf(svc, status) {
  if (svc) {
    const instances = Object.values(svc.nlbwmon?.instances ?? {});
    const up = instances.find(i => i.running);
    return { known: true, running: Boolean(up), pid: up?.pid ?? null, command: up?.command ?? instances[0]?.command ?? [] };
  }
  if (status && status.nlbwmon_running != null) return { known: true, running: Boolean(status.nlbwmon_running), pid: null, command: [] };
  return { known: false, running: false, pid: null, command: [] };
}

// The accounting periods from the plugin's usage_periods reply, or null.
const periodsOf = p => (p?.ok ? { running: Boolean(p.running), list: p.periods ?? [], current: p.current ?? null, today: p.today ?? null } : null);

// The logical network names of the router from the interface dump, or null when it is not known.
const networksOf = dump => (Array.isArray(dump?.interface) ? dump.interface.map(i => i.interface).filter(n => n && n !== 'loopback') : null);

// Reads the page's data from the replies: `cfg` is `uci get nlbwmon` (null when the router has no such config) and `live` holds
// the optional replies { status, svc, periods, dump, memTotal, paths }.
export function readNlbw(cfg, live = {}) {
  const sections = sectionsOf(cfg, TYPE);
  const first = sections[0] ?? { section: null, values: {} };
  return {
    installed: cfg != null,
    section: first.section,
    values: first.values,
    extraSections: Math.max(0, sections.length - 1),
    status: live.status ?? null,
    daemon: daemonOf(live.svc, live.status),
    periods: periodsOf(live.periods),
    networks: networksOf(live.dump),
    memTotal: live.memTotal ?? null,
    paths: live.paths ?? null,
    probes: { dir: {}, file: {} },
    staged: 0,
  };
}

// The form value of a field on the router: a boolean (the default when absent), a list, or a string ('' = not set).
export const currentValue = (field, data) => valueOf(field, data.values[field.key]);

// What the options mean to the init script: an absent or empty option takes its default. Returns { <key>: string | boolean |
// string[] } for the raw options `values` (strings are trimmed).
export function effective(values) {
  const out = {};
  for (const f of FIELDS) {
    const raw = values[f.key];
    if (f.type === 'bool') out[f.key] = valueOf(f, raw);
    else if (f.type === 'list') out[f.key] = asList(raw);
    else {
      const v = raw == null ? '' : String(raw).trim();
      out[f.key] = v === '' ? (f.default ?? '') : v;
    }
  }
  return out;
}

//#endregion

//#region Numbers, sizes and durations

// Seconds in an interval such as 30s, 10m, 24h, 1d, 2w or 90 (a bare number is seconds), or null when it is not one.
export function parseDuration(v) {
  const m = /^(\d{1,9})([wdhms]?)$/.exec(v);
  return m ? +m[1] * SECONDS[m[2] || 's'] : null;
}

// A span in seconds in words: "24 hours", "30 seconds", "1 day"; the largest unit that divides it evenly.
export function fmtSeconds(s) {
  if (s % 86400 === 0) return plural(s / 86400, 'day');
  if (s % 3600 === 0) return plural(s / 3600, 'hour');
  if (s % 60 === 0) return plural(s / 60, 'minute');
  return plural(s, 'second');
}

// Bytes in "524288", "0x80000", "512k" or "1M" (K and M are 1024 and 1048576), or null when it is not a size.
export function parseBytes(v) {
  let m = /^(\d{1,12})([kKmM]?)$/.exec(v);
  if (m) return +m[1] * (m[2] ? (m[2].toLowerCase() === 'k' ? 1024 : 1048576) : 1);
  m = /^0[xX]([0-9a-fA-F]{1,8})$/.exec(v);
  return m ? parseInt(m[1], 16) : null;
}

// How long ago a time was, in words ("5 minutes ago"), from two times in seconds.
export function fmtAgo(then, now) {
  const s = Math.max(0, now - then);
  if (s < 60) return 'just now';
  if (s < 3600) return `${plural(Math.floor(s / 60), 'minute')} ago`;
  if (s < 86400) return `${plural(Math.floor(s / 3600), 'hour')} ago`;
  return `${plural(Math.floor(s / 86400), 'day')} ago`;
}

// A size in bytes for a sentence ("606 bytes", "12.3 KiB"): core fmtBytes with the unit spelled out below 1 KiB.
function fmtSize(n) {
  if (n == null) return 'unknown size';
  const u = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return i ? `${n.toFixed(1)} ${u[i]}` : `${Math.round(n)} bytes`;
}

//#endregion

//#region Addresses

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

// Whether `s` is an IPv6 address as inet_pton reads it: eight groups, one "::" that stands for at least one group, and an
// optional IPv4 tail.
function isIPv6(s) {
  if (!/^[0-9A-Fa-f:.]+$/.test(s) || !s.includes(':')) return false;
  let groups = s;
  let need = 8;
  const tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    if (!IPV4.test(tail[1])) return false;
    groups = s.slice(0, s.length - tail[1].length) + '0:0';
  }
  if (groups.includes('.')) return false;
  const parts = groups.split('::');
  if (parts.length > 2) return false;
  // The groups of an IPv6 address part: none for an empty part.
  const list = part => (part === '' ? [] : part.split(':'));
  const head = list(parts[0]);
  const rest = parts.length === 2 ? list(parts[1]) : [];
  if ([...head, ...rest].some(g => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  need -= head.length + rest.length;
  return parts.length === 2 ? need >= 1 : need === 0;
}

// Whether `s` is an address with an optional prefix length or mask, as nlbwmon's -s option reads it (192.168.1.0/24,
// 192.168.1.0/255.255.255.0, fd00::/8, 10.0.0.1).
export function validSubnet(s) {
  const parts = s.split('/');
  if (parts.length > 2) return false;
  const v6 = isIPv6(parts[0]);
  if (!v6 && !IPV4.test(parts[0])) return false;
  if (parts.length === 1) return true;
  const mask = parts[1];
  if (/^\d{1,3}$/.test(mask)) return +mask <= (v6 ? 128 : 32);
  return v6 ? isIPv6(mask) : IPV4.test(mask);
}

//#endregion

//#region Accounting periods

// A date "YYYY-MM-DD" as a day number (days since 1970-01-01), or null when it is not a real date.
function dayOf(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t / 86400000 : null;
}

// The date "YYYY-MM-DD" of a day number.
const dateOf = day => new Date(day * 86400000).toISOString().slice(0, 10);

// The number of days in month `m` (1 to 12) of year `y`.
const monthLen = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// The accounting interval a database_interval value means: { kind: 'month', n } (a day of the month, negative from the end),
// { kind: 'days', base, n } (every n days from a date), or null when it is not valid. 0 is not accepted: the last day is -1.
export function parseInterval(v) {
  const days = /^(\d{4}-\d{2}-\d{2})\/(\d+)$/.exec(v);
  if (days) {
    const base = dayOf(days[1]);
    const year = +days[1].slice(0, 4);
    return base != null && year >= 2000 && year <= 3000 && +days[2] >= 1 && +days[2] <= 36500 ? { kind: 'days', base, n: +days[2] } : null;
  }
  if (/^-?\d{1,2}$/.test(v) && +v !== 0 && Math.abs(+v) <= 31) return { kind: 'month', n: +v };
  return null;
}

// The day number a monthly period starts on in month `m` of year `y`: day `n` of the month (cut to the month's length), or
// counted from the end for a negative `n` (-1 is the last day).
function monthStart(y, m, n) {
  const len = monthLen(y, m);
  const d = n > 0 ? Math.min(n, len) : len + n + 1;
  return Date.UTC(y, m - 1, Math.max(d, 1)) / 86400000;
}

// The period of interval `iv` that holds day `day`: { start, end } as day numbers, `end` being the first day of the next period.
function periodBounds(iv, day) {
  if (iv.kind === 'days') {
    const start = day < iv.base ? iv.base : iv.base + Math.floor((day - iv.base) / iv.n) * iv.n;
    return { start, end: start + iv.n };
  }
  const t = new Date(day * 86400000);
  let y = t.getUTCFullYear();
  let mo = t.getUTCMonth() + 1;
  let start = monthStart(y, mo, iv.n);
  if (start > day) {
    mo--;
    if (mo < 1) { mo = 12; y--; }
    start = monthStart(y, mo, iv.n);
  }
  let ny = y;
  let nm = mo + 1;
  if (nm > 12) { nm = 1; ny++; }
  return { start, end: monthStart(ny, nm, iv.n) };
}

// The start (a day number) of the period that began `back` periods before the one that holds `day`.
function startBack(iv, day, back) {
  let start = periodBounds(iv, day).start;
  for (let i = 0; i < back && i < 5000; i++) start = periodBounds(iv, start - 1).start;
  return start;
}

// The period now under the interval text `spec` ('' = the default, 1): { start, end, next, day, length } as dates and counts
// ("day 14 of 30"), or null when the interval is not valid or today is not known.
export function windowOf(spec, today) {
  const iv = parseInterval(spec === '' ? '1' : spec);
  const now = dayOf(today);
  if (!iv || now == null) return null;
  const { start, end } = periodBounds(iv, now);
  return { start: dateOf(start), end: dateOf(end - 1), next: dateOf(end), day: now - start + 1, length: end - start };
}

// The stored periods (dates, as `nlbw -c list` prints them) that nlbwmon deletes when it starts with `generations` periods to
// keep under the interval `spec`: those that began that many periods back or earlier. None for 0 (keep every period).
export function periodsToDelete(spec, today, generations, stored) {
  const iv = parseInterval(spec === '' ? '1' : spec);
  const now = dayOf(today);
  if (!iv || now == null || !/^\d+$/.test(generations) || +generations === 0) return [];
  const cut = startBack(iv, now, +generations);
  return stored.filter(p => dayOf(p) != null && dayOf(p) <= cut);
}

//#endregion

//#region The daemon's command line

// The flags the init script gave the running daemon, from its command line: { o, b, i, r, p, G, I, L: strings, Z, P: booleans,
// s: the subnets }.
export function parseCommand(command) {
  const out = { Z: false, P: false, s: [] };
  for (let i = 1; i < command.length; i++) {
    const m = /^-([A-Za-z])$/.exec(command[i]);
    if (!m) continue;
    if (m[1] === 'Z' || m[1] === 'P') out[m[1]] = true;
    else if (m[1] === 's') out.s.push(command[++i]);
    else out[m[1]] = command[++i];
  }
  return out;
}

// Whether two values of a field mean the same to nlbwmon (30s and 30, 524288 and 0x80000).
function sameValue(f, a, b) {
  if (a === b) return true;
  // How a value of this kind becomes a number (null for a kind that is plain text).
  const to = f.kind === 'duration' ? parseDuration : f.kind === 'bytes' ? parseBytes : f.type === 'int' ? v => (/^\d+$/.test(v) ? +v : null) : null;
  return to != null && to(a) != null && to(a) === to(b);
}

// The options for which the running daemon's command line differs from what the saved options mean:
// [{ key, label, running, configured }]. Only meaningful for a daemon that runs.
export function configDiffs(values, command) {
  const want = effective(values);
  const have = parseCommand(command);
  const out = [];
  for (const f of FIELDS.filter(x => x.arg)) {
    const flagName = f.arg.slice(1);
    if (f.type === 'bool') {
      if (have[flagName] !== want[f.key]) out.push({ key: f.key, label: f.label, running: have[flagName] ? 'on' : 'off', configured: want[f.key] ? 'on' : 'off' });
    } else if (have[flagName] == null || !sameValue(f, have[flagName], want[f.key])) {
      out.push({ key: f.key, label: f.label, running: have[flagName] ?? 'not set', configured: want[f.key] });
    }
  }
  return out;
}

// Waits until nlbwmon runs with the settings in `values` (the saved options) and keeps running: two reads of procd's service
// list `gapMs` apart must show the same process with the right command line. `readService` returns the reply of
// `service list nlbwmon`. Throws an Error that says what is wrong when that does not happen within `tries` reads.
export async function confirmDaemon(readService, values, { tries = 8, gapMs = 1500, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last = null;
  let seen = null;
  for (let i = 0; i < tries; i++) {
    const daemon = daemonOf(await readService(), null);
    const diffs = daemon.running ? configDiffs(values, daemon.command) : [];
    last = { daemon, diffs };
    if (daemon.running && !diffs.length) {
      if (seen && seen.pid === daemon.pid) return daemon;
      seen = daemon;
    } else {
      seen = null;
    }
    await sleep(gapMs);
  }
  if (!last.daemon.running) throw new Error('nlbwmon is not running with the new settings: it stopped or could not start');
  if (last.diffs.length) throw new Error(`nlbwmon is running with other settings than the saved ones (${last.diffs.map(d => `${d.label}: ${d.running}`).join(', ')})`);
  throw new Error('nlbwmon does not stay running with the new settings');
}

//#endregion

//#region The draft

// The form's starting values: the router's current values.
export const draftFrom = data => ({ values: Object.fromEntries(FIELDS.map(f => [f.key, currentValue(f, data)])) });

// A value as it is compared and written: a size is written in bytes whatever suffix was typed; the rest as `normalize` does.
function canonical(f, v) {
  const text = normalize(f, v);
  if (f.kind === 'bytes' && typeof text === 'string' && parseBytes(text) != null) return String(parseBytes(text));
  return text;
}

// The differences between the router's values and the draft, for the review list: [{ key, label, from, to }].
export function changesOf(data, draft) {
  const out = [];
  for (const f of FIELDS) {
    const from = canonical(f, currentValue(f, data));
    const to = canonical(f, draft.values[f.key]);
    if (differs(f, from, to)) out.push({ key: f.key, label: f.label, from: show(f, from), to: show(f, to) });
  }
  return out;
}

// Whether the draft differs from the router in any way, including blank list rows that were added.
export const isDirty = (data, draft) => changesOf(data, draft).length > 0 || FIELDS.some(f => hasBlankRows(f, draft.values[f.key]));

//#endregion

//#region Validation

// The error for one non-empty value of a custom-checked field, as words that follow the field's label, or null.
const CHECKS = {
  duration: v => {
    const s = parseDuration(v);
    if (s == null) return 'must be a number with w, d, h, m or s, for example 30s, 10m, 24h or 1d';
    if (s < 1) return 'must be at least 1 second';
    return s > MAX_SECONDS ? 'is too long: nlbwmon accepts at most 24 days (2147483 seconds)' : null;
  },
  bytes: v => {
    const n = parseBytes(v);
    if (n == null) return 'must be a number of bytes, optionally with a K or M suffix (512K, 1M)';
    if (n < MIN_BUFFER) return `must be at least ${MIN_BUFFER} bytes (32 KiB)`;
    return n > 2147483647 ? 'is too large: the most is 2147483647 bytes' : null;
  },
  interval: v => {
    if (parseInterval(v)) return null;
    return /^\d{4}-\d{2}-\d{2}\/\d+$/.test(v)
      ? 'has a date that does not exist (or a year outside 2000 to 3000), or a length that is not from 1 to 36500 days'
      : 'must be a day of the month (1 to 31, or -1 to -31 counted from the end) or YYYY-MM-DD/N for a period of N days';
  },
  // The database directory: an absolute path nlbwmon can create, away from the places that cannot hold a database.
  path: v => {
    const bad = pathError(v, 126);
    if (bad) return bad;
    if (v.replace(/\/+$/, '') === '') return 'must not be the root directory';
    if (/^\/(proc|sys|rom)(\/|$)/.test(v) || (/^\/dev(\/|$)/.test(v) && !/^\/dev\/shm(\/|$)/.test(v))) return 'is on a read-only or special filesystem that cannot hold the database';
    return null;
  },
  // The protocol file.
  file: v => pathError(v, 255),
  // A local network entry: a network name, or an address with an optional prefix or mask. nlbwmon treats an entry with a dot or
  // a colon as an address.
  network: v => {
    if (/[.:]/.test(v)) return validSubnet(v) ? null : 'is not an IPv4 or IPv6 address with an optional prefix length or mask (192.168.1.0/24, fd00::/8)';
    return /^[A-Za-z0-9_]+$/.test(v) ? null : 'is not a network name (letters, digits and _) or an address with a prefix (192.168.1.0/24)';
  },
};

// Why `v` cannot be the path of a directory or file here, or null: it must be absolute, at most `max` characters, made of
// letters, digits and . _ + @ : = , / - (the plugin that inspects it accepts no other), and have no ".." part.
function pathError(v, max) {
  if (!v.startsWith('/')) return 'must be an absolute path starting with /';
  if (v.length > max) return `must be at most ${max} characters`;
  if (!/^\/[A-Za-z0-9._+@:=,/-]*$/.test(v)) return 'may only contain letters, digits and . _ + @ : = , / -, with no spaces';
  if ((`${v}/`).includes('/../')) return 'must not contain a ".." part';
  return null;
}

// The effective path an option names in a draft (the default when it is empty).
export const draftPath = (draft, key) => normalize(fieldOf(key), draft.values[key]) || fieldOf(key).default;

// What is known about a path that was typed or saved: the reply of nlbwmon_paths for it (kind 'dir' or 'file'), or null when it
// is not (yet) known.
export function infoFor(data, kind, path) {
  const saved = effective(data.values)[kind === 'dir' ? 'database_directory' : 'protocol_database'];
  return data.probes[kind][path] ?? (path === saved ? data.paths?.[kind === 'dir' ? 'dir' : 'protocols'] : null) ?? null;
}

// What stops the form from being saved (`errors`: { key, index?, text }) and what only deserves a warning.
// `index` is the row of a list; an error on an option is reported under its key.
export function problems(data, draft) {
  const errors = [];
  const warnings = [];
  // The normalized draft value of the option with this key.
  const value = key => normalize(fieldOf(key), draft.values[key]);

  for (const f of FIELDS) {
    if (f.type === 'bool') continue;
    if (!f.kind || f.type === 'int') {
      for (const e of errorsOf(f, draft.values[f.key])) errors.push({ key: f.key, ...e });
    } else if (f.type === 'list') {
      const seen = new Set();
      draft.values[f.key].forEach((raw, index) => {
        const v = raw.trim();
        if (!v) return;
        const bad = CHECKS[f.kind](v);
        if (bad) errors.push({ key: f.key, index, text: `${f.label}: "${v}" ${bad}.` });
        else if (seen.has(v.toLowerCase())) errors.push({ key: f.key, index, text: `${f.label}: "${v}" is listed twice.` });
        seen.add(v.toLowerCase());
      });
    } else {
      const v = value(f.key);
      const bad = v ? CHECKS[f.kind](v) : null;
      if (bad) errors.push({ key: f.key, text: `${f.label} ${bad}.` });
    }
  }
  const failed = new Set(errors.map(e => e.key));

  const changed = new Set(changesOf(data, draft).map(c => c.key));
  const want = effective(Object.fromEntries(FIELDS.map(f => [f.key, f.type === 'bool' ? (draft.values[f.key] ? '1' : '0') : canonical(f, draft.values[f.key])])));

  //#region What the router says about the paths
  const dir = draftPath(draft, 'database_directory');
  const dirInfo = failed.has('database_directory') ? null : infoFor(data, 'dir', dir);
  if (dirInfo?.ok && dirInfo.blocked) errors.push({ key: 'database_directory', text: `Database directory: ${dir} is not a directory, or is below a file, so nlbwmon cannot create or use it.` });
  else if (dirInfo?.ok && dirInfo.kind === 'readonly') errors.push({ key: 'database_directory', text: `Database directory: ${dir} is on a read-only filesystem (${dirInfo.fstype}), so nlbwmon cannot write its database there.` });
  const file = draftPath(draft, 'protocol_database');
  const fileInfo = failed.has('protocol_database') ? null : infoFor(data, 'file', file);
  if (fileInfo?.ok && (!fileInfo.exists || !fileInfo.file)) errors.push({ key: 'protocol_database', text: `Protocol file: ${file} ${fileInfo.exists ? 'is not a regular file' : 'does not exist'}, and nlbwmon does not start without it.` });
  else if (fileInfo?.ok && !fileInfo.readable) errors.push({ key: 'protocol_database', text: `Protocol file: ${file} cannot be read, and nlbwmon does not start without it.` });
  //#endregion

  if (!want.local_network.length && !failed.has('local_network')) warnings.push('No local network is listed, so nlbwmon counts nothing.');
  if (data.networks && !failed.has('local_network')) {
    const unknown = want.local_network.filter(n => /^[A-Za-z0-9_]+$/.test(n) && !data.networks.includes(n));
    if (unknown.length) warnings.push(`${unknown.join(', ')} ${unknown.length > 1 ? 'are not networks' : 'is not a network'} of this router (it has ${data.networks.join(', ') || 'none'}), so ${unknown.length > 1 ? 'they add' : 'it adds'} no subnet.`);
  }

  if (changed.has('database_interval') && !failed.has('database_interval')) {
    const iv = parseInterval(want.database_interval);
    const was = parseInterval(effective(data.values).database_interval);
    if (iv && was && iv.kind !== was.kind) warnings.push('The accounting period changes from a day of the month to a fixed number of days (or back): the periods already stored were cut the other way and may not be readable as periods any more.');
    else if (iv) warnings.push('A new accounting interval moves the boundaries of the periods: the periods already stored keep the dates they were cut at.');
    if (iv?.kind === 'month' && iv.n >= 29) warnings.push(`A start day of ${iv.n} does not exist in every month, so how nlbwmon cuts the shorter months is not documented. Prefer 1 to 28 or a negative number.`);
    if (iv?.kind === 'days' && data.periods?.today && iv.base > dayOf(data.periods.today)) warnings.push('The start date is in the future. Use a date that is today or earlier: before that date the periods are not defined.');
  }

  if (changed.has('database_generations') && !failed.has('database_generations')) {
    const gone = data.periods ? periodsToDelete(want.database_interval, data.periods.today, want.database_generations, data.periods.list) : [];
    if (gone.length) warnings.push(`When nlbwmon restarts (it does when you save) it deletes the stored ${gone.length > 1 ? 'periods' : 'period'} ${gone.join(', ')}. That cannot be undone.`);
    if (want.database_generations === '0') warnings.push('Every period is kept forever, so the database directory grows without limit: make sure the storage has room.');
  }

  if (changed.has('database_directory') && !failed.has('database_directory')) {
    const old = effective(data.values).database_directory;
    warnings.push(`Nothing is moved: the periods already stored stay in ${old}, and the running period starts again from zero in ${dir}. Copy the files over first (while nlbwmon is stopped) to keep the history.`);
  }
  if (changed.has('protocol_database') && !failed.has('protocol_database')) {
    warnings.push(`nlbwmon will not start if ${file} is missing or unreadable. The page checks that nlbwmon runs after saving and puts the old settings back if it does not.`);
  }

  if (!failed.has('commit_interval') && changed.has('commit_interval')) {
    const secs = parseDuration(want.commit_interval);
    if (secs != null && secs < 3600 && dirInfo?.kind !== 'volatile') {
      const where = dirInfo?.kind === 'flash' ? 'flash' : dirInfo?.kind === 'storage' ? 'storage' : 'flash (if the database directory is on the router\'s flash)';
      warnings.push(`A commit every ${fmtSeconds(secs)} rewrites the database file ${fmtN(86400 / secs)} times a day on ${where}, which wears it. One hour or longer is gentle.`);
    }
  }
  if (!failed.has('refresh_interval') && changed.has('refresh_interval')) {
    const secs = parseDuration(want.refresh_interval);
    if (secs != null && secs < 5) warnings.push(`Reading the counters every ${fmtSeconds(secs)} costs CPU time on a router with many connections.`);
    if (secs != null && secs > 600) warnings.push(`With ${fmtSeconds(secs)} between reads, the traffic of a long-lived connection reaches the numbers late.`);
  }
  if (!failed.has('database_limit') && changed.has('database_limit')) {
    const limit = +want.database_limit;
    if (limit > 0 && limit < 1000) warnings.push(`With a limit of ${fmtN(limit)} entries nlbwmon overwrites the oldest entries early, so the history inside a period is cut short.`);
    if (limit === 0 || limit * ENTRY_BYTES > (data.memTotal ?? Infinity) / 4) warnings.push(limit === 0 ? 'Without a limit the database grows with the variety of traffic and can use a lot of RAM.' : `At ${fmtN(limit)} entries the database can use about ${fmtSize(limit * ENTRY_BYTES)} of RAM, over a quarter of this router's memory.`);
  }
  if (draft.values.database_prealloc && want.database_limit === '0' && !failed.has('database_limit')) warnings.push('Reserving memory has no effect without an entry limit above 0.');
  if (!failed.has('netlink_buffer_size') && changed.has('netlink_buffer_size')) {
    const n = parseBytes(want.netlink_buffer_size);
    if (n != null && n < 131072) warnings.push('With a buffer under 128 KiB, events can be lost on a router that opens many connections at once.');
  }
  if (data.daemon.known && !data.daemon.running) warnings.push('nlbwmon is not running now. Saving changes the settings but may not start it: start it on the Services page.');
  if (data.extraSections) warnings.push(`The config has ${data.extraSections + 1} nlbwmon sections. Only the first is edited here.`);
  return { errors, warnings };
}

//#endregion

//#region Effects

// What the storage a directory sits on means, in words, from the reply of nlbwmon_paths: [text, kind] where kind is 'warn'
// for something to be aware of or 'info'.
function storageWords(info) {
  const on = `${info.fstype}${info.device && info.device !== info.fstype ? ` on ${info.device}` : ''}`;
  if (info.kind === 'volatile') return [`On ${info.fstype} (RAM): no flash wear, but the history is lost at every reboot.`, 'warn'];
  if (info.kind === 'flash') return [`On the router's flash (${on}): every commit wears it.`, 'warn'];
  if (info.kind === 'readonly') return [`On a read-only filesystem (${on}): nlbwmon cannot write there.`, 'warn'];
  if (info.kind === 'storage') return [`On ${on} (mounted at ${info.mount}): storage of its own, so the flash is spared and the history survives a reboot, as long as it is mounted when nlbwmon starts.`, 'info'];
  return ['', 'info'];
}

// The text under each option that says what its value does, for the draft: { <key>: { text, kind } } (kind is 'info' or 'warn').
// A key is absent when there is nothing to say.
export function effects(data, draft) {
  const out = {};
  // Records the effect text of an option, if there is one.
  const set = (key, text, kind = 'info') => { if (text) out[key] = { text, kind }; };
  const bad = new Set(problems(data, draft).errors.map(e => e.key));
  // The normalized draft value of the option with this key.
  const val = key => normalize(fieldOf(key), draft.values[key]);

  // Local networks: what nlbwmon counts right now.
  const subnets = parseCommand(data.daemon.command).s;
  if (data.daemon.running) set('local_network', subnets.length ? `nlbwmon is counting ${plural(subnets.length, 'subnet')} now: ${subnets.slice(0, 8).join(', ')}${subnets.length > 8 ? ', …' : ''}.` : 'nlbwmon is running without any subnet, so it counts nothing.', subnets.length ? 'info' : 'warn');
  if (data.networks?.length) set('local_network', `${out.local_network?.text ?? ''} Networks of this router: ${data.networks.join(', ')}.`.trim(), out.local_network?.kind);

  // The accounting period: where today falls, and what a lower number of periods to keep would delete.
  if (!bad.has('database_interval') && data.periods?.today) {
    const w = windowOf(val('database_interval'), data.periods.today);
    if (w) set('database_interval', `The running period would be ${w.start} to ${w.end} (day ${w.day} of ${w.length}); the next one starts ${w.next}.`);
  }
  if (!bad.has('database_generations') && data.periods) {
    const stored = data.periods.list;
    const keep = val('database_generations') || '10';
    const gone = bad.has('database_interval') ? [] : periodsToDelete(val('database_interval'), data.periods.today, keep, stored);
    const have = stored.length ? `${plural(stored.length, 'finished period')} stored (${stored.slice(0, 6).join(', ')}${stored.length > 6 ? ', …' : ''}) besides the running one.` : 'No finished period is stored yet.';
    if (keep === '0') set('database_generations', `${have} Nothing is ever deleted.`);
    else if (gone.length) set('database_generations', `${have} The next start deletes ${gone.join(', ')}.`, 'warn');
    else set('database_generations', `${have} Nothing is deleted at the next start${/^\d+$/.test(keep) ? `: ${plural(+keep, 'period')} may be kept, the running one included.` : '.'}`);
  }

  // The database directory: where it really is and what is in it.
  const dir = draftPath(draft, 'database_directory');
  const info = bad.has('database_directory') ? null : infoFor(data, 'dir', dir);
  if (info?.ok) {
    const [words, kind] = storageWords(info);
    const parts = [];
    if (info.resolved !== info.path.replace(/\/+$/, '')) parts.push(`${info.path} is ${info.resolved}.`);
    if (!info.exists) parts.push('The directory does not exist yet: nlbwmon creates it.');
    parts.push(words);
    if (info.total) parts.push(`It holds ${plural(info.total, 'database file')} (${fmtSize(info.files.reduce((n, f) => n + (f.size ?? 0), 0))}), the latest written ${info.files[0].mtime != null && info.generated != null ? fmtAgo(info.files[0].mtime, info.generated) : 'at an unknown time'}.`);
    else if (info.exists) parts.push('It holds no database file yet.');
    set('database_directory', parts.filter(Boolean).join(' '), kind);
  } else if (!bad.has('database_directory') && data.paths != null && info == null) {
    set('database_directory', 'Checking where this directory is…');
  }

  // Commit and refresh intervals in words, and what a commit costs.
  const dirKind = info?.ok ? info.kind : null;
  if (!bad.has('commit_interval')) {
    const secs = parseDuration(val('commit_interval') || '24h');
    if (secs != null) set('commit_interval', `Written every ${fmtSeconds(secs)}: ${secs < 86400 ? `${fmtN(86400 / secs)} times a day` : 'at most once a day'}. After a crash or power loss up to ${fmtSeconds(secs)} of counts are lost${dirKind === 'volatile' ? ', and the file is in RAM anyway' : ''}.`);
  }
  if (!bad.has('refresh_interval')) {
    const secs = parseDuration(val('refresh_interval') || '30s');
    if (secs != null) set('refresh_interval', `The counters of open connections are read every ${fmtSeconds(secs)} (${fmtN(3600 / secs)} times an hour).`);
  }
  if (!bad.has('database_limit') && /^\d+$/.test(val('database_limit') || '10000')) {
    const limit = +(val('database_limit') || '10000');
    const share = data.memTotal ? limit * ENTRY_BYTES / data.memTotal * 100 : null;
    set('database_limit', limit === 0 ? 'No limit: the database grows with the variety of traffic.' : `At most ${plural(limit, 'entry', 'entries')}, roughly ${fmtSize(limit * ENTRY_BYTES)} of RAM when full${share != null ? ` (${share.toFixed(share < 10 ? 1 : 0)}% of this router's memory)` : ''}.`);
  }
  if (!bad.has('netlink_buffer_size')) {
    const n = parseBytes(val('netlink_buffer_size') || '524288');
    if (n != null) set('netlink_buffer_size', `${n} bytes = ${fmtSize(n)}.`);
  }
  const file = draftPath(draft, 'protocol_database');
  const finfo = bad.has('protocol_database') ? null : infoFor(data, 'file', file);
  if (finfo?.ok) set('protocol_database', finfo.exists && finfo.file ? `File found (${fmtSize(finfo.size)})${finfo.readable ? '.' : ', but it cannot be read.'}` : `${file} ${finfo.exists ? 'is not a regular file' : 'does not exist'}.`, finfo.exists && finfo.file && finfo.readable ? 'info' : 'warn');
  return out;
}

//#endregion

//#region Writing

// The UCI operations that turn the router's config into the draft, as data:
//   { op: 'set' | 'add' | 'delete', config, section, type?, values? | options? }
// Only what changed is written; an emptied option is deleted rather than set to ''; a size is written in bytes. A missing
// nlbwmon section is created (anonymous, as the package's own config has it).
export function plan(data, draft) {
  const set = {};
  const del = [];
  const changed = new Set(changesOf(data, draft).map(c => c.key));
  for (const f of FIELDS.filter(x => changed.has(x.key))) {
    const v = canonical(f, draft.values[f.key]);
    if (f.type === 'bool') set[f.key] = flag(v);
    else if (v.length === 0) del.push(f.key);
    else set[f.key] = v;
  }
  const ops = [];
  if (!data.section) {
    if (Object.keys(set).length) ops.push({ op: 'add', config: CONFIG, type: TYPE, values: set });
    return ops;
  }
  if (Object.keys(set).length) ops.push({ op: 'set', config: CONFIG, section: data.section, values: set });
  const existing = del.filter(o => data.values[o] !== undefined);
  if (existing.length) ops.push({ op: 'delete', config: CONFIG, section: data.section, options: existing });
  return ops;
}

// Throws unless the settings `after` (read back once the change is applied) hold what the draft asked for.
export function checkApplied(after, draft) {
  const left = changesOf(after, draft);
  if (left.length) throw new Error(`${left.map(c => c.label).join(', ')} ${left.length > 1 ? 'were' : 'was'} not saved`);
}

//#endregion
