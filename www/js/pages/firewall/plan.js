// The Firewall page's draft turned into what is shown and what is written: the review list (what changes from what to what), the UCI
// operations a save stages (as data, see core/ops.js), and the check that the router kept what was saved and that the firewall is still
// loaded. No DOM and no network.
import { flag, uciBool } from '../../core/fields.js';
import { CONFIG, DEFAULT_FIELDS } from './schema.js';
import { KINDS, KIND_KEYS, changedFields, fieldFor, formValues, isShown, live, zoneName } from './edit.js';
import { forwardingWords, ruleWords, redirectWords, zoneLine } from './describe.js';
import { titleOf } from './validate.js';

//#region Review

// A value for the review list: on/off, a comma list, the zone words, or "not set" / "default" when empty.
function shown(f, v) {
  if (f.type === 'bool') return v ? 'on' : 'off';
  if (f.type === 'list') return v.length ? v.join(', ') : 'none';
  if (v === '' || v == null) return f.default != null ? 'default' : 'not set';
  if (v === '*' && f.zone) return 'any zone';
  return String(v).length > 60 ? `${String(v).slice(0, 57)}…` : String(v);
}

// A section in one line for the review list.
function lineOf(key, values) {
  if (key === 'zones') return zoneLine(values);
  if (key === 'forwardings') return forwardingWords(values);
  return key === 'rules' ? ruleWords(values) : redirectWords(values);
}

// The review entries for the options of one section whose form value differs: [{ key, label, from, to }].
function diffFields(fields, from, to, keyPrefix, labelPrefix) {
  return changedFields(fields, from, to).map(f => {
    const g = fieldFor(f, to);
    return { key: `${keyPrefix}:${f.key}`, label: `${labelPrefix}: ${g.label}`, from: shown(f, from[f.key]), to: shown(f, to[f.key]) };
  });
}

// The name an item goes by in an order entry.
const nameOf = item => item.values.name?.trim() || item.values.src || item.id;

// The differences between the router's config and the draft for the review list: [{ key, label, from, to }].
export function changesOf(data, draft) {
  const out = diffFields(DEFAULT_FIELDS, formValues(DEFAULT_FIELDS, data.defaults.values), draft.defaults, 'defaults', 'Global settings');
  for (const key of KIND_KEYS) {
    const { fields, noun } = KINDS[key];
    const baseValues = id => formValues(fields, data[key].find(s => s.section === id)?.values ?? {});
    const alive = live(draft[key]);
    for (const item of draft[key]) {
      const title = titleOf(key, item, draft);
      if (item.isNew) {
        const at = alive.indexOf(item);
        out.push({ key: `${key}:${item.id}`, label: `New ${noun}${key === 'zones' ? ` ${zoneName(item)}` : ''}`, from: 'none', to: `${lineOf(key, item.values)}${key === 'rules' || key === 'redirects' ? (at < alive.length - 1 ? ` (position ${at + 1})` : '') : ''}` });
      } else if (item.removed) {
        out.push({ key: `${key}:${item.id}`, label: `Remove ${title.charAt(0).toLowerCase()}${title.slice(1)}`, from: lineOf(key, baseValues(item.id)), to: 'removed' });
      } else {
        out.push(...diffFields(fields, baseValues(item.id), item.values, `${key}:${item.id}`, title));
      }
    }
    // Moving a rule or port forward changes the order of the survivors that were already in the file.
    if (key === 'rules' || key === 'redirects') {
      const kept = alive.filter(i => !i.isNew);
      const was = data[key].map(s => s.section).filter(id => kept.some(i => i.id === id));
      if (kept.map(i => i.id).join('\n') !== was.join('\n')) {
        out.push({ key: `${key}:order`, label: `${key === 'rules' ? 'Traffic rules' : 'Port forwards'}: order`, from: was.map(id => nameOf(kept.find(i => i.id === id))).join(' › '), to: kept.map(nameOf).join(' › ') });
      }
    }
  }
  return out;
}

// Whether the draft differs from the router in any way.
export const isDirty = (data, draft) => changesOf(data, draft).length > 0;

//#endregion

//#region Writing

// The options to set and delete to turn a section's raw options into the form values `values`.
function sectionChange(fields, raw, values) {
  const set = {}, del = [];
  for (const f of changedFields(fields, formValues(fields, raw), values)) {
    const to = values[f.key];
    if (f.type === 'bool') set[f.key] = flag(to);
    else if (f.type === 'list') {
      const list = to.map(s => s.trim()).filter(Boolean);
      if (list.length) set[f.key] = list; else del.push(f.key, ...(f.alias ? [f.alias] : []));
    } else if (String(to).trim()) set[f.key] = String(to).trim();
    else del.push(f.key, ...(f.alias ? [f.alias] : []));
  }
  return { set, del };
}

// The options a new section gets: the ones the form sets to something other than what the firewall assumes for an absent option, and the
// ones it always writes (a rule's action).
function newSection(fields, values) {
  const out = {};
  for (const base of fields) {
    const f = fieldFor(base, values);
    if (!isShown(f, values)) continue;
    const v = values[f.key];
    if (f.type === 'bool') {
      if (v !== (f.default ?? false)) out[f.key] = flag(v);
    } else if (f.type === 'list') {
      const list = v.map(s => s.trim()).filter(Boolean);
      if (list.length) out[f.key] = list;
    } else {
      const s = String(v).trim();
      if (s && (f.always || s !== (f.default != null ? String(f.default) : ''))) out[f.key] = s;
    }
  }
  return out;
}

// The lists whose order matters to the firewall.
const ORDERED = ['rules', 'redirects'];

// The order of every section of the file after the change, as ids (a new section has the id of its item), and the order the sections would
// have without any `uci order` call (survivors as they are, then the new ones in the order they are added). Only the order of the rules
// and of the port forwards matters to the firewall (it reads the sections of a type in file order, the types in any order): the survivors
// of such a kind take the slots they had, in the order of the draft, and a new one goes right after the item before it in the draft.
export function orderPlan(data, draft) {
  const gone = new Set(KIND_KEYS.flatMap(key => draft[key].filter(i => i.removed).map(i => i.id)));
  const newDefaults = !data.defaults.section && changedFields(DEFAULT_FIELDS, formValues(DEFAULT_FIELDS, {}), draft.defaults).length > 0;
  const natural = [
    ...data.sections.map(s => s.section).filter(id => !gone.has(id)),
    ...(newDefaults ? ['new:defaults'] : []),
    ...KIND_KEYS.flatMap(key => live(draft[key]).filter(i => i.isNew).map(i => i.id)),
  ];
  const final = natural.slice();
  for (const key of ORDERED) {
    const wanted = live(draft[key]);
    const kept = wanted.filter(i => !i.isNew).map(i => i.id);
    const fresh = new Set(wanted.filter(i => i.isNew).map(i => i.id));
    for (let at = final.length - 1; at >= 0; at--) if (fresh.has(final[at])) final.splice(at, 1);
    const slots = [];
    final.forEach((id, at) => { if (kept.includes(id)) slots.push(at); });
    slots.forEach((at, n) => { final[at] = kept[n]; });
    wanted.forEach((item, n) => {
      if (!item.isNew) return;
      const before = n ? final.indexOf(wanted[n - 1].id) : -1;
      final.splice(before >= 0 ? before + 1 : slots.length ? slots[0] : final.length, 0, item.id);
    });
  }
  return { final, natural };
}

// The UCI operations that turn the router's config into the draft, as data (see core/ops.js): the changed options of each section, the
// sections removed and added, and the order of the sections when it is not what adding and removing leaves. Only what changed is written; an
// emptied option is deleted rather than set to ''; options the page has no control for are left alone.
export function plan(data, draft) {
  const ops = [];
  const glob = sectionChange(DEFAULT_FIELDS, data.defaults.values, draft.defaults);
  if (!data.defaults.section) {
    const values = newSection(DEFAULT_FIELDS, draft.defaults);
    if (Object.keys(values).length) ops.push({ op: 'add', config: CONFIG, type: 'defaults', id: 'new:defaults', values });
  } else {
    if (Object.keys(glob.set).length) ops.push({ op: 'set', config: CONFIG, section: data.defaults.section, values: glob.set });
    const existing = glob.del.filter(o => data.defaults.values[o] !== undefined);
    if (existing.length) ops.push({ op: 'delete', config: CONFIG, section: data.defaults.section, options: existing });
  }
  for (const key of KIND_KEYS) {
    const { type, fields } = KINDS[key];
    for (const item of draft[key]) {
      if (item.removed) {
        ops.push({ op: 'delete', config: CONFIG, section: item.id });
      } else if (item.isNew) {
        ops.push({ op: 'add', config: CONFIG, type, id: item.id, values: newSection(fields, item.values) });
      } else {
        const raw = data[key].find(s => s.section === item.id)?.values ?? {};
        const { set, del } = sectionChange(fields, raw, item.values);
        if (Object.keys(set).length) ops.push({ op: 'set', config: CONFIG, section: item.id, values: set });
        const existing = del.filter(o => raw[o] !== undefined);
        if (existing.length) ops.push({ op: 'delete', config: CONFIG, section: item.id, options: existing });
      }
    }
  }
  const { final, natural } = orderPlan(data, draft);
  if (final.join('\n') !== natural.join('\n')) ops.push({ op: 'order', config: CONFIG, sections: final });
  return ops;
}

//#endregion

//#region Checking the result

// Why the firewall does not look loaded after a change, or null when it does (or was not loaded before, so nothing can be said): nftables
// must have the fw4 table, with a chain set for exactly the enabled zones of the file (a zone the firewall refuses is not loaded).
export function notLoaded(data, after) {
  if (!data.status?.running) return null;
  if (!after.status?.running) return 'the firewall is no longer loaded: nftables has no fw4 table after the change.';
  if (!after.loadedZones) return null;
  const wanted = after.zones.filter(z => uciBool(z.values.enabled, true) && z.values.name).map(z => z.values.name);
  const missing = wanted.filter(n => !after.loadedZones.includes(n)), stale = after.loadedZones.filter(n => !wanted.includes(n));
  if (!missing.length && !stale.length) return null;
  return `the firewall did not load the new configuration (${missing.length ? `no rules for zone ${missing.join(', ')}` : `still has rules for zone ${stale.join(', ')}`}); it may refuse the configuration.`;
}

// Throws unless the config read back after the change (`after`, see readFirewall) holds what the draft asked for, and the firewall is still
// loaded: every list holds the same items in the same order with the same values (a new section is recognized by its place, because the
// router names it itself), and, when the firewall was loaded before, nftables has a chain set for exactly the enabled zones of the file.
export function checkApplied(data, draft, after) {
  const left = [];
  for (const f of changedFields(DEFAULT_FIELDS, formValues(DEFAULT_FIELDS, after.defaults.values), draft.defaults)) left.push(`Global settings: ${f.label}`);
  for (const key of KIND_KEYS) {
    const { fields, noun } = KINDS[key];
    const want = live(draft[key]), have = after[key];
    if (want.length !== have.length) {
      left.push(`the number of ${noun}s (${have.length} instead of ${want.length})`);
      continue;
    }
    want.forEach((item, i) => {
      for (const f of changedFields(fields, formValues(fields, have[i].values), item.values)) left.push(`${titleOf(key, item, draft)}: ${f.label}`);
    });
  }
  if (left.length) throw new Error(`the router did not keep ${left.slice(0, 6).join('; ')}${left.length > 6 ? `; and ${left.length - 6} more` : ''}.`);
  const why = notLoaded(data, after);
  if (why) throw new Error(why);
}

//#endregion
