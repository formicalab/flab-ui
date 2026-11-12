// What the DNS page needs to change the resolver's options: the draft the form edits, the differences from what the router
// has, what stops a save and what only deserves a warning, the UCI operations that write the change, and the check that it
// was kept. Pure functions with no DOM and no network, in the shape the editing pages share (see core/editpage.js).
//
// Only the options of the resolver's own section can be changed through the option controls, and only the single-valued
// ones: a yes/no option, a choice, a number or a name. Lists (the interfaces, the domains) and options the page has no
// description for are shown but not editable there. The zones (Unbound's `config zone` sections, dnsmasq's `server` entries)
// have their own part of the draft, `forwarders`, edited in a dialog (see zones.js).
//
// The data is the reply of `flab.dns status`: `config` holds the options that are set, `config_section` the UCI section that
// holds them ({ config, name }), `engines` and `configured` say whether the engine runs.
// The draft is { values: { <option>: string | boolean | string[] } for every option the page shows ('' means "not set"),
// forwarders: the working copy of the zones }.
import { differs, errorsOf, flag, normalize, show, valueOf } from '../../core/fields.js';
import { configDraft, configFields, engineName, subject } from './model.js';
import { forwarderChanges, forwarderLeftovers, forwarderPlan, forwarderProblems, forwardersDraft, forwardingProblem } from './zones.js';

// The kinds of option that can be changed.
const EDITABLE = new Set(['bool', 'enum', 'int', 'string']);

// Whether the page lets the user change this field: a described option of a single value.
export const isEditable = field => !field.unknown && EDITABLE.has(field.type);

// The fields that can be changed for the engine this data describes.
const editableFields = data => configFields(data).filter(isEditable);

// The form's starting values: what the router has (a boolean takes the package's default when the option is absent), and a
// working copy of its zones.
export const draftFrom = data => ({ values: configDraft(data), forwarders: forwardersDraft(data) });

// A value in words for the review list: on/off, the words of a choice, the number or text, or "default" when empty.
function words(field, v) {
  if (field.type === 'bool') return v ? 'on' : 'off';
  if (field.type === 'enum') return v === '' ? 'default' : field.labels?.[v] ?? v;
  return show(field, v);
}

// The router's value of a field, normalized as the draft's is.
const currentOf = (field, data) => normalize(field, valueOf(field, data.config?.[field.key]));

// The differences between the router's options and the draft, for the review list: [{ key, label, from, to }].
function optionChanges(data, draft) {
  const out = [];
  for (const f of editableFields(data)) {
    const from = currentOf(f, data);
    const to = normalize(f, draft.values[f.key]);
    if (differs(f, from, to)) out.push({ key: f.key, label: f.label, from: words(f, from), to: words(f, to) });
  }
  return out;
}

// Every difference between the router and the draft: the options, then the zones.
export const changesOf = (data, draft) => [...optionChanges(data, draft), ...forwarderChanges(data, draft)];

// Whether the draft differs from the router.
export const isDirty = (data, draft) => changesOf(data, draft).length > 0;

// The value in force in the draft: the one set, else the package's default.
const effective = (field, draft) => (draft.values[field.key] === '' ? field.default : draft.values[field.key]);

// What a change deserves a warning about, by option: the text, or null when the new value is harmless. `now` is the value in
// force in the draft; `data` is what the router reports (for what the build supports).
const WARNINGS = {
  unbound: {
    enabled: now => (now ? null : 'Unbound will be stopped and will not start at boot, so nothing on this router answers DNS until another resolver runs.'),
    manual_conf: now => (now ? 'Unbound will ignore every other option and read /etc/unbound/unbound.conf as it is written.' : null),
    unbound_control: now => (String(now) === '0' ? 'This page reads the counters and the forwarders through unbound-control, so with it off the statistics and the forwarders are no longer available.' : null),
    listen_port: now => (String(now) === '53' ? null : `Unbound will answer on port ${now} instead of 53: clients, and the DNS address DHCP hands out, will not reach it.`),
    localservice: now => (now ? null : 'Any host that can reach the router can use it as an open resolver, which can be abused for amplification attacks.'),
    rebind_protection: now => (String(now) === '0' ? 'Answers from the internet may point to private addresses, so a web page could reach devices on the LAN through DNS.' : null),
    validator: now => (now ? null : 'Answers are no longer checked for forgery (DNSSEC).'),
  },
  dnsmasq: {
    port: now => (String(now) === '0' ? 'dnsmasq will stop answering DNS and only serve DHCP.' : String(now) === '53' ? null : `dnsmasq will answer on port ${now} instead of 53: clients, and the DNS address DHCP hands out, will not reach it.`),
    localservice: now => (now ? null : 'Any host that can reach the router can use it as an open resolver, which can be abused for amplification attacks.'),
    rebind_protection: now => (now ? null : 'Answers from the internet may point to private addresses, so a web page could reach devices on the LAN through DNS.'),
    dnssec: (now, data) => (now && data.dnssec?.supported === false ? 'This build of dnsmasq has no DNSSEC support, so the option does nothing.' : null),
  },
};

// What stops the form from being saved (`errors`: { key, index?, text }) and what only deserves a warning (`warnings`: text).
export function problems(data, draft) {
  const errors = [];
  const warnings = [];
  const fields = editableFields(data);
  for (const f of fields) {
    for (const e of errorsOf(f, draft.values[f.key])) errors.push({ key: f.key, ...e });
  }
  const table = WARNINGS[subject(data)] ?? {};
  for (const c of optionChanges(data, draft)) {
    const f = fields.find(x => x.key === c.key);
    const text = table[c.key]?.(effective(f, draft), data);
    if (text) warnings.push(text);
  }
  const zones = forwarderProblems(data, draft);
  return { errors: [...errors, ...zones.errors], warnings: [...warnings, ...zones.warnings] };
}

// The UCI operations that turn the router's options into the draft, as data (see core/ops.js): one `set` for the options
// that changed to a value and one `delete` for the ones that were emptied (and exist). A boolean is written as '1' or '0'.
export function plan(data, draft) {
  const section = data.config_section;
  if (!section) return [];
  const set = {};
  const del = [];
  const changed = new Set(optionChanges(data, draft).map(c => c.key));
  for (const f of editableFields(data).filter(x => changed.has(x.key))) {
    const v = normalize(f, draft.values[f.key]);
    if (f.type === 'bool') set[f.key] = flag(v);
    else if (v === '') del.push(f.key);
    else set[f.key] = v;
  }
  const ops = [];
  if (Object.keys(set).length) ops.push({ op: 'set', config: section.config, section: section.name, values: set });
  const existing = del.filter(k => data.config?.[k] !== undefined);
  if (existing.length) ops.push({ op: 'delete', config: section.config, section: section.name, options: existing });
  return [...ops, ...forwarderPlan(data, draft)];
}

// Whether the engine this data describes is running.
export const engineRunning = data => Boolean(data?.engines?.[data.configured]?.running);

// Throws unless the status read after the change (`after`) holds what the draft asked for and the resolver still runs.
// `before` is what the draft was made from; turning the Unbound service off is the one change that is meant to stop it.
export function checkApplied(before, after, draft) {
  const left = optionChanges(after, draft);
  const parts = [];
  if (left.length) parts.push(`${left.map(c => c.label).join(', ')} ${left.length > 1 ? 'were' : 'was'} not saved`);
  parts.push(...forwarderLeftovers(before, after, draft));
  if (parts.length) throw new Error(parts.join('; '));
  const problem = forwardingProblem(before, after, draft);
  if (problem) throw new Error(problem);
  const stops = subject(before) === 'unbound' && draft.values.enabled === false && optionChanges(before, draft).some(c => c.key === 'enabled');
  if (engineRunning(before) && !engineRunning(after) && !stops) throw new Error(`${engineName(before.configured)} is not running after the change`);
}

// Whether the status read after a save already shows what the zones should look like (the resolver may still be restarting).
export const zonesReady = (before, after, draft) => !forwarderLeftovers(before, after, draft).length && !forwardingProblem(before, after, draft);
