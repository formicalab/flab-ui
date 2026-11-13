// Pure model of the Dynamic DNS page: the data the plugin reports, the form's draft, the review list, validation, the UCI
// operations a save makes, the check after a save, and the verdict on what each service is doing. No DOM and no network, so
// it is unit-tested on its own (tests/ddns/model.test.mjs).
//
// The config is edited through rpcd's `uci` object, but it is read through the flab.ddns plugin, which leaves out the
// secrets: the password or token is never in the data, only whether it is set (`secrets`). A secret field of the draft is
// therefore empty until the user types a value; empty means "keep what is stored".
import { differs, errorsOf, flag, normalize, show, valueOf } from '../../core/fields.js';
import { parseAddress } from '../../core/ip.js';
import { fmtSpan } from '../../core/format.js';
import { CHECK_FLOOR_SECONDS, CONFIG, GLOBAL_FIELDS, GLOBAL_SECTION, SERVICE_FIELDS, UNIT_OF, UNIT_SECONDS } from './schema.js';

export { CONFIG };

//#region Reading

// The reply of `flab.ddns status` as the page's data, with every part present.
export function readDdns(s) {
  return {
    generated: s?.generated ?? 0,
    uptime: s?.uptime ?? null,
    installed: s?.installed !== false,
    version: s?.version ?? null,
    running: Boolean(s?.running),
    atBoot: Boolean(s?.at_boot),
    rundir: s?.rundir ?? '/var/run/ddns',
    logdir: s?.logdir ?? '/var/log/ddns',
    ca: s?.ca ?? '',
    passwordExact: Boolean(s?.password_exact),
    global: { section: s?.global?.section ?? null, values: s?.global?.values ?? {} },
    services: (s?.services ?? []).map(x => ({ section: x.section, values: x.values ?? {}, secrets: x.secrets ?? {}, runtime: x.runtime ?? {} })),
    providers: s?.providers ?? [],
    networks: s?.networks ?? [],
    devices: s?.devices ?? [],
    tools: s?.tools ?? {},
  };
}

// The provider called `name` (from the provider list the router reported), or null.
export const providerOf = (data, name) => data.providers.find(p => p.name === name) ?? null;

// The words shown for a provider in the drop-down: its name, and what is wrong with it.
export const providerLabel = p => (p.available ? p.name : `${p.name} (its script is not installed)`);

//#endregion

//#region The form

// The form values of a list of fields from a section's raw options: a boolean, or a string ('' = not set).
const valuesOf = (fields, raw) => Object.fromEntries(fields.map(f => [f.key, valueOf(f, raw[f.key])]));

// The form's starting values: the router's current values. A new service gets an id of its own (`new1`, ...) because its name
// is typed into the form and may change until it is saved.
export const draftFrom = data => ({
  global: valuesOf(GLOBAL_FIELDS, data.global.values),
  services: Object.fromEntries(data.services.map(s => [s.section, valuesOf(SERVICE_FIELDS, s.values)])),
  added: [],
  removed: {},
  next: 1,
});

// The services the form shows, in order: the router's, then the ones added in the form. Each has an `id` (the section name, or
// `new1`... for a new one), its section `name`, and `isNew` and `removed`. A new service has no options on the router yet.
export function serviceList(data, draft) {
  return [
    ...data.services.map(s => ({ ...s, id: s.section, name: s.section, isNew: false, removed: Boolean(draft.removed[s.section]) })),
    ...draft.added.map(a => ({ id: a.id, section: null, name: a.name, values: {}, secrets: {}, runtime: null, isNew: true, removed: false })),
  ];
}

// The values of a service as they take effect: with a provider chosen, an update address or script left over from a custom
// provider is dropped (the documentation says to remove them, and the provider's own address would be replaced by them).
export function effective(values) {
  return values.service_name === '' ? values : { ...values, update_url: '', update_script: '' };
}

// Whether a field is shown for these values.
export const isShown = (field, values) => (field.show ? field.show(effective(values)) : true);

// The names a new service may not take: the sections of the config (a removed one counts until the change is saved) and the
// names of the other services added in the form.
const takenNames = (data, draft, exceptId) => new Set([GLOBAL_SECTION, ...data.services.map(s => s.section), ...draft.added.filter(a => a.id !== exceptId).map(a => a.name)]);

// The error for a new service's name, or null. ddns-scripts allows letters, digits and underscores only.
export function nameError(data, draft, id) {
  const name = draft.added.find(a => a.id === id)?.name.trim() ?? '';
  if (!name) return 'Give the service a name.';
  if (!/^[A-Za-z0-9_]+$/.test(name)) return 'The name may only contain letters, digits and underscores (ddns-scripts does not allow a dash).';
  if (name.length > 32) return 'The name may be at most 32 characters.';
  if (takenNames(data, draft, id).has(name)) return `There is already a section called "${name}".`;
  return null;
}

// Adds a service to the draft and returns its id. It starts as the common case: enabled, HTTPS with the router's CA
// certificates, sending the address of the wan network, started when wan comes up.
export function addService(data, draft) {
  const id = `new${draft.next++}`;
  const taken = takenNames(data, draft, null);
  let name = 'myddns';
  for (let n = 2; taken.has(name); n++) name = `myddns_${n}`;
  draft.added.push({ id, name });
  draft.services[id] = { ...valuesOf(SERVICE_FIELDS, {}), enabled: true, use_https: true, cacert: data.ca, interface: data.networks.includes('wan') ? 'wan' : '' };
  return id;
}

// Marks a service for removal, or drops it when it was only added in the form.
export function removeService(draft, id) {
  const i = draft.added.findIndex(a => a.id === id);
  if (i < 0) { draft.removed[id] = true; return; }
  draft.added.splice(i, 1);
  delete draft.services[id];
}

// Takes a service back from removal.
export function restoreService(draft, id) {
  delete draft.removed[id];
}

//#endregion

//#region Timing

// A number option as a number: the default when it is not set (the empty string, or absent).
const numberOr = (v, fallback) => (v === '' || v == null || !/^\d+$/.test(String(v)) ? fallback : +v);
// The seconds in a unit option: the default unit when it is not set, and, as in ddns-scripts, seconds for a unit it does not know.
const unitSeconds = (v, fallback) => UNIT_SECONDS[v === '' || v == null ? fallback : v] ?? 1;

// A number of seconds in words that keep the unit it was written in: "5 minutes", "72 hours", "30 seconds", "1 day".
export function spanWords(seconds) {
  for (const [n, word] of [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']]) {
    if (seconds >= n && seconds % n === 0) { const k = seconds / n; return `${k} ${word}${k === 1 ? '' : 's'}`; }
  }
  return '0 seconds';
}

// The intervals of a service in seconds as ddns-scripts works them out, from its raw options or from a form's values:
//   { check, force, retry, requested } where `check` is the interval the updater really uses (a check shorter than 5
//   minutes is replaced by the shortest check interval, which is also in the unit of the check interval), `requested` the
//   one that was asked for, `force` the interval of a forced update (0: never; raised to the check interval when shorter)
//   and `retry` the time before a retry.
export function timing(values) {
  const cu = unitSeconds(values.check_unit, 'minutes');
  const requested = numberOr(values.check_interval, 10) * cu;
  const check = requested < CHECK_FLOOR_SECONDS ? numberOr(values.check_interval_min, 5) * cu : requested;
  let force = numberOr(values.force_interval, 72) * unitSeconds(values.force_unit, 'hours');
  if (force > 0 && force < check) force = check;
  const retry = numberOr(values.retry_interval, 60) * unitSeconds(values.retry_unit, 'seconds');
  return { check, force, retry, requested };
}

//#endregion

//#region Review

// A service in one line for the review list: provider (or custom), the names and the interval.
function serviceLine(values) {
  const v = effective(values);
  return [v.service_name || (v.update_url ? 'custom provider' : 'no provider'), v.lookup_host || v.domain, v.enabled ? 'enabled' : 'disabled'].filter(Boolean).join(' · ');
}

// The differences between the router's values and the draft for the review list: [{ key, label, from, to }]. A secret is never
// shown: the list says only that it is set or will be replaced.
export function changesOf(data, draft) {
  const out = [];
  // One review entry per field whose draft value differs from the router's value.
  const diffFields = (fields, raw, values, keyPrefix, labelPrefix, secrets = {}) => {
    for (const f of fields) {
      if (f.secret) {
        if (normalize(f, values[f.key]) !== '') out.push({ key: `${keyPrefix}:${f.key}`, label: `${labelPrefix}: ${f.label}`, from: secrets[f.key] ? 'set (hidden)' : 'not set', to: 'new value (hidden)' });
        continue;
      }
      const from = normalize(f, valueOf(f, raw[f.key]));
      const to = normalize(f, values[f.key]);
      if (differs(f, from, to)) out.push({ key: `${keyPrefix}:${f.key}`, label: `${labelPrefix}: ${f.label}`, from: show(f, from), to: show(f, to) });
    }
  };
  diffFields(GLOBAL_FIELDS, data.global.values, draft.global, 'global', 'Global');
  for (const s of serviceList(data, draft)) {
    if (s.isNew) out.push({ key: `svc:${s.id}`, label: `New service ${s.name.trim() || '(unnamed)'}`, from: 'none', to: serviceLine(draft.services[s.id]) });
    else if (s.removed) out.push({ key: `svc:${s.id}`, label: `Remove service ${s.name}`, from: serviceLine(valuesOf(SERVICE_FIELDS, s.values)), to: 'removed' });
    else diffFields(SERVICE_FIELDS, valuesOf(SERVICE_FIELDS, s.values), effective(draft.services[s.id]), `svc:${s.id}`, s.name, s.secrets);
  }
  return out;
}

// Whether the draft differs from the router in any way.
export const isDirty = (data, draft) => changesOf(data, draft).length > 0;

//#endregion

//#region Validation

// The words that say why a field is required: what the provider's update address needs.
const NEEDS_TAG = { DOMAIN: 'domain', USERNAME: 'username', PASSWORD: 'password' };

// Which of DOMAIN, USERNAME and PASSWORD a service's update requires: what the provider's update address contains, or the
// tags of a custom update address. A provider that is a script reads the options itself, so nothing is known about it (null).
function requiredTags(data, v) {
  if (v.service_name !== '') return providerOf(data, v.service_name)?.needs ?? null;
  return ['DOMAIN', 'USERNAME', 'PASSWORD'].filter(t => v.update_url.includes(`[${t}]`));
}

// The errors and warnings of the draft: { errors: [{ key, text, also? }], warnings: [text] }. `key` names the control that
// holds the mistake (the same name the page registers it under), so the page can mark it and open the group it is in.
export function problems(data, draft) {
  const errors = [], warnings = [];
  for (const f of GLOBAL_FIELDS) for (const e of errorsOf(f, draft.global[f.key], `Global: ${f.label}`)) errors.push({ ...e, key: `global:${f.key}` });

  const enabledNames = new Map();
  for (const s of serviceList(data, draft)) {
    if (s.removed) continue;
    const raw = draft.services[s.id];
    const v = effective(raw);
    const title = s.name.trim() || 'New service';
    // Adds an error against the control of field `key`.
    const err = (key, text) => errors.push({ key: `svc:${s.id}:${key}`, text: `${title}: ${text}` });
    const warn = text => warnings.push(`${title}: ${text}`);

    if (s.isNew) {
      const bad = nameError(data, draft, s.id);
      if (bad) errors.push({ key: `svc:${s.id}:name`, text: `${title}: ${bad}` });
    }
    for (const f of SERVICE_FIELDS) {
      // A drop-down filled in from the router (providers, networks, devices) has no fixed set of values to check against.
      if (f.dynamic || !isShown(f, raw)) continue;
      for (const e of errorsOf(f, v[f.key], `${title}: ${f.label}`)) errors.push({ ...e, key: `svc:${s.id}:${f.key}` });
    }
    if (v.proxy.includes(':***@') && v.proxy !== (s.values.proxy ?? '')) err('proxy', 'the password of the proxy is hidden (***) and cannot be saved; type the whole address again.');

    const provider = providerOf(data, v.service_name);
    if (v.service_name !== '' && !provider) warn(`the provider "${v.service_name}" is not in the router's list of providers.`);
    if (v.enabled) {
      const needs = requiredTags(data, v);
      if (v.service_name === '' && !v.update_url && !v.update_script) err('service_name', 'choose a provider, or enter an update address or script for a custom one.');
      if (provider && !provider.available) err('service_name', `the script of this provider (${provider.script}) is not installed. Install the ddns-scripts package that provides it.`);
      if (!v.lookup_host && !v.domain) err('lookup_host', 'enter the name to keep up to date.');
      if (needs?.includes('DOMAIN') && !v.domain) err('domain', 'the provider needs a domain.');
      if (needs?.includes('USERNAME') && !v.username) err('username', 'the provider needs a username (enter "X" if it is not used).');
      if (needs?.includes('PASSWORD') && !raw.password && !s.secrets.password) err('password', 'the provider needs a password or token.');
      if (v.ip_source === 'interface' && !v.ip_interface) err('ip_interface', 'choose the device whose address is sent.');
      if (v.ip_source === 'script' && !v.ip_script) err('ip_script', 'enter the script that prints the address.');
      if (!v.interface) warn('no interface is set, so the updater is not restarted when a network comes up.');
      if (v.use_ipv6 && provider && !provider.ipv6) warn(`${provider.name} does not support IPv6; the update will fail.`);
      const t = timing(v);
      if (t.requested < CHECK_FLOOR_SECONDS && t.check !== t.requested) warn(`a check every ${spanWords(t.requested)} is replaced by the shortest check interval, so it runs every ${spanWords(t.check)}. Lower the shortest check interval to check more often.`);
      if (t.force > 0 && t.force === t.check && numberOr(v.force_interval, 72) * unitSeconds(v.force_unit, 'hours') < t.check) warn('the forced update interval is shorter than the check interval and is raised to it.');
      if (v.use_https && !v.cacert) warn('HTTPS is on without CA certificates, so the provider\'s certificate cannot be checked.');
      if (v.use_https && v.cacert === 'IGNORE') warn('the provider\'s certificate is not checked (CA certificates: IGNORE), which is insecure.');
      if (/^https:/i.test(v.update_url)) warn('write "http:" in the update address; HTTPS is switched on with "Use HTTPS".');
      if (!data.passwordExact && /['\\]|[^\x00-\x7f]/.test(raw.password)) warn('this router\'s updater mangles a single quote, a backslash or a non-ASCII character in a password, so the provider would reject it. Run tools/patch-ddns-scripts.sh on the router (deploy.ps1 does) to make it pass every character unchanged.');
      if ((v.force_ipversion || v.force_dnstcp || v.is_glue) && data.tools.host === false) warn('forcing the IP version, DNS over TCP and glue records need the host command (the bind-host package), which the router does not have.');
      if (v.is_glue && !v.dns_server) warn('a glue record needs a DNS server to compare against.');
      for (const [key, label] of [['interface', 'Interface'], ['ip_network', 'Network'], ['bind_network', 'Send from network']]) {
        if (v[key] && !data.networks.includes(v[key])) warn(`${label} "${v[key]}" is not a network of the router.`);
      }
      const family = v.use_ipv6 ? '6' : '4';
      const same = enabledNames.get(`${(v.lookup_host || v.domain).toLowerCase()}/${family}`);
      if ((v.lookup_host || v.domain) && same) warn(`${same} also updates ${v.lookup_host || v.domain} (${v.use_ipv6 ? 'IPv6' : 'IPv4'}); two services should not feed the same record.`);
      else if (v.lookup_host || v.domain) enabledNames.set(`${(v.lookup_host || v.domain).toLowerCase()}/${family}`, title);
    }
  }
  return { errors, warnings };
}

//#endregion

//#region Writing

// The UCI operations that turn the router's config into the draft, as data (see core/ops.js). Only what changed is written; an
// emptied option is deleted rather than set to ''; options the page does not know are left alone, and so is a secret that was
// not retyped.
export function plan(data, draft) {
  const ops = [];

  // One section's changed options as { set, del }.
  const sectionChange = (fields, raw, values) => {
    const set = {}, del = [];
    for (const f of fields) {
      const to = normalize(f, values[f.key]);
      if (f.secret) { if (to !== '') set[f.key] = to; continue; }
      const from = normalize(f, valueOf(f, raw[f.key]));
      if (!differs(f, from, to)) continue;
      if (f.type === 'bool') set[f.key] = flag(to);
      else if (to.length === 0) del.push(f.key);
      else set[f.key] = to;
    }
    return { set, del };
  };
  // Queues the set and delete operations of one section; a delete is only queued for an option that exists.
  const emit = (section, { set, del }, raw) => {
    if (Object.keys(set).length) ops.push({ op: 'set', config: CONFIG, section, values: set });
    const existing = del.filter(o => raw[o] !== undefined);
    if (existing.length) ops.push({ op: 'delete', config: CONFIG, section, options: existing });
  };

  const glob = sectionChange(GLOBAL_FIELDS, data.global.values, draft.global);
  if (!data.global.section) {
    if (Object.keys(glob.set).length) ops.push({ op: 'add', config: CONFIG, type: 'ddns', name: GLOBAL_SECTION, values: glob.set });
  } else emit(data.global.section, glob, data.global.values);

  for (const s of serviceList(data, draft)) {
    if (s.removed) ops.push({ op: 'delete', config: CONFIG, section: s.section });
    else if (s.isNew) ops.push({ op: 'add', config: CONFIG, type: 'service', name: s.name.trim(), values: sectionChange(SERVICE_FIELDS, {}, effective(draft.services[s.id])).set });
    else emit(s.section, sectionChange(SERVICE_FIELDS, s.values, effective(draft.services[s.id])), s.values);
  }
  return ops;
}

// Throws unless the config `after` (read back through the plugin once the change is applied) holds what the draft asked for:
// every option of the global section and of each service (a new one by the name chosen for it, a removed one gone), and that a
// secret that was typed is now stored.
export function checkApplied(after, draft) {
  const left = [];
  // Records every field whose applied value differs from the draft as "label: field".
  const compare = (fields, raw, values, label, secrets = {}) => {
    for (const f of fields) {
      if (f.secret) { if (normalize(f, values[f.key]) !== '' && !secrets[f.key]) left.push(`${label}: ${f.label}`); continue; }
      if (differs(f, normalize(f, valueOf(f, raw[f.key])), normalize(f, values[f.key]))) left.push(`${label}: ${f.label}`);
    }
  };
  compare(GLOBAL_FIELDS, after.global.values, draft.global, 'Global');
  const have = new Map(after.services.map(s => [s.section, s]));
  for (const [id, values] of Object.entries(draft.services)) {
    const name = draft.added.find(a => a.id === id)?.name.trim() ?? id;
    const found = have.get(name);
    if (draft.removed[id]) { if (found) left.push(`Service ${name}`); continue; }
    if (!found) left.push(`Service ${name}`);
    else compare(SERVICE_FIELDS, valuesOf(SERVICE_FIELDS, found.values), effective(values), name, found.secrets);
  }
  if (left.length) throw new Error(`${left.slice(0, 4).join(', ')}${left.length > 4 ? ` and ${left.length - 4} more` : ''} ${left.length > 1 ? 'were' : 'was'} not saved`);
}

//#endregion

//#region Status

// Whether two addresses are the same one, whatever the spelling (IPv6 may be compressed or written out).
export function sameIp(a, b) {
  if (!a || !b) return false;
  const x = parseAddress(a), y = parseAddress(b);
  return x && y ? x.family === y.family && x.value === y.value : a === b;
}

// The address the router has for a service now, as the updater will see it: the one read locally, else the one the updater
// detected last (for a web page or a script as the source).
export const currentIp = rt => rt?.local_ip ?? rt?.detected_ip ?? null;

// A time of day from the log's "HHMMSS".
export const clock = t => (/^\d{6}$/.test(t ?? '') ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}` : '');

// What a service is doing, for its badge and the line below it: { kind, text, detail } where kind is
//   disabled | stopped | error | ok | pending | unknown
// and `detail` the sentence that explains it. `svc` is a service of the data.
export function verdictOf(svc) {
  const rt = svc.runtime ?? {};
  const v = svc.values;
  const name = v.lookup_host || v.domain || svc.section;
  if (!['1', 'true', 'yes', 'on'].includes(String(v.enabled ?? '0'))) return { kind: 'disabled', text: 'Disabled', detail: 'Not updating. Enable it and save to start the updater.' };
  if (!rt.running) {
    return { kind: 'stopped', text: 'Not running', detail: rt.terminated ? `The updater stopped: ${rt.terminated}.` : 'The updater is not running. Use "Check now" to start it.' };
  }
  if (rt.problem) return { kind: 'error', text: rt.problem.level === 'WARN' ? 'Warning' : 'Problem', detail: `${clock(rt.problem.time) ? `${clock(rt.problem.time)} · ` : ''}${rt.problem.text}` };
  const now = currentIp(rt);
  if (!rt.registered_ip || !now) return { kind: 'unknown', text: 'Checking', detail: 'Waiting for the first check to read the address and the registered one.' };
  if (sameIp(rt.registered_ip, now)) return { kind: 'ok', text: 'Up to date', detail: `${name} resolves to ${rt.registered_ip}, the address of the router.` };
  return { kind: 'pending', text: 'Update pending', detail: `The router has ${now}, but ${name} resolves to ${rt.registered_ip}. The updater sends the new address at its next check.` };
}

// A time that was `seconds` ago or is `seconds` ahead, in words ("12m 3s ago", "in 40s").
export const ago = (ts, now) => (ts == null ? 'never' : ts <= now ? `${fmtSpan(now - ts)} ago` : `in ${fmtSpan(ts - now)}`);

// The figures of the summary tiles over the enabled services:
//   { enabled, total, running, upToDate, lastUpdate, nextCheck, ... }
// `now` is the epoch time to count from.
export function summarize(data, now) {
  const enabled = data.services.filter(s => !['0', 'false', 'no', 'off'].includes(String(s.values.enabled ?? '0')));
  const verdicts = enabled.map(verdictOf);
  const lastUpdate = Math.max(0, ...enabled.map(s => s.runtime?.last_update ?? 0)) || null;
  const next = enabled.map(s => s.runtime?.next_check).filter(t => t != null && t > now);
  return {
    total: data.services.length,
    enabled: enabled.length,
    running: enabled.filter(s => s.runtime?.running).length,
    upToDate: verdicts.filter(x => x.kind === 'ok').length,
    problems: verdicts.filter(x => x.kind === 'error' || x.kind === 'stopped').length,
    lastUpdate,
    lastUpdateName: lastUpdate ? enabled.find(s => s.runtime?.last_update === lastUpdate)?.section : null,
    nextCheck: next.length ? Math.min(...next) : null,
  };
}

// Whether a log line is worth showing by default: warnings and errors, notes, and information except the updater's routine
// "Rerun IP check" line, which repeats at every check.
export const isNoteworthy = line => Boolean(line.level) && !(line.level === 'info' && /^Rerun IP check/.test(line.text));

// The lines of a service's log as [{ time, level, text }] with the time written "HH:MM:SS" and the level lowercase: error
// (ERROR, CRIT, ALERT, EMERG), warn, note, info, or '' for the updater's debug lines. A line that is not in the usual format is kept
// with no time.
export function parseLog(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    const m = /^ *(\d{6}) +(EMERG|ALERT|CRIT|ERROR|WARN|note|info)? *: ?(.*)$/.exec(line);
    if (!m) { out.push({ time: '', level: '', text: line.trim() }); continue; }
    const level = { EMERG: 'error', ALERT: 'error', CRIT: 'error', ERROR: 'error', WARN: 'warn', note: 'note', info: 'info' }[m[2]] ?? '';
    out.push({ time: clock(m[1]), level, text: m[3] });
  }
  return out;
}

//#endregion
