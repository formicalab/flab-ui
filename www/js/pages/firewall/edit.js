// Pure model of the Firewall page's editing: the configuration as the page reads it, the draft of the form (zones, forwardings, rules, port
// forwards and the global defaults), and the operations that change the draft (adding, removing, moving, a zone's interfaces, the matrix's
// forwardings). Validation is in validate.js and the UCI plan in plan.js. No DOM and no network, so it is unit-tested on its own
// (tests/fwedit/model.test.mjs).
//
// The config is read twice: `uci get firewall` gives every section with its own name (the identity of a section: an anonymous one is
// called cfgXXXXXX, never by its position, because positions change when sections are added or removed), and the flab.firewall plugin gives
// what the firewall really loaded (hit counters, the devices behind a zone, the router's interfaces). A section is joined to its counters
// through that name.
import { valueOf } from '../../core/fields.js';
import { CONFIG, DEFAULT_FIELDS, FORWARDING_FIELDS, REDIRECT_FIELDS, RULE_FIELDS, ZONE_FIELDS } from './schema.js';

export { CONFIG };

// The lists of the draft: the draft's key, the UCI section type, the option table and the word for the thing in messages.
export const KINDS = {
  zones: { type: 'zone', fields: ZONE_FIELDS, noun: 'zone' },
  forwardings: { type: 'forwarding', fields: FORWARDING_FIELDS, noun: 'forwarding' },
  rules: { type: 'rule', fields: RULE_FIELDS, noun: 'rule' },
  redirects: { type: 'redirect', fields: REDIRECT_FIELDS, noun: 'port forward' },
};
// The draft's list names, in the order sections are staged.
export const KIND_KEYS = Object.keys(KINDS);

//#region Reading

// The options of a section as `uci get` returns it, without its bookkeeping keys (.type, .name, .anonymous, .index).
const optionsOf = section => Object.fromEntries(Object.entries(section).filter(([k]) => !k.startsWith('.')));

// The reply of `uci get firewall` (every section keyed by name; null when the login may not read it) joined with the reply of
// `flab.firewall status` (null when absent) as the page's data. `sections` lists every section in file order, which `uci order` needs.
export function readFirewall(status, cfg) {
  const all = Object.values(cfg ?? {})
    .sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0))
    .map(s => ({ section: s['.name'], type: s['.type'], anonymous: Boolean(s['.anonymous']), values: optionsOf(s) }));
  // The sections of one type, in file order.
  const ofType = t => all.filter(s => s.type === t);
  const defaults = ofType('defaults')[0];
  return {
    status: status ?? null,
    editable: cfg != null,
    sections: all.map(s => ({ section: s.section, type: s.type })),
    defaults: { section: defaults?.section ?? null, values: defaults?.values ?? {} },
    zones: ofType('zone'),
    forwardings: ofType('forwarding'),
    rules: ofType('rule'),
    redirects: ofType('redirect'),
    nat: ofType('nat'),
    networks: status?.networks ?? [],
    loadedZones: status?.loaded_zones ?? null,
  };
}

// The names of the router's interfaces (from /etc/config/network).
export const networkNames = data => data.networks.map(n => n.name);

//#endregion

//#region Form values

// The listed spelling of an enum value that fw4 reads loosely (without regard to case and by its first letters), or the value itself.
function canonical(f, text) {
  const s = text.toLowerCase();
  if (f.key === 'family') return ['any', 'all', '*'].includes(s) ? 'any' : s === 'inet' || s.includes('4') ? 'ipv4' : s.includes('6') ? 'ipv6' : text;
  return s ? f.options.find(o => o.toLowerCase().startsWith(s)) ?? text : text;
}

// The form value of one field from the raw options of a section: a boolean, a list, or a string ('' = not set). An absent option is the
// value the firewall uses (the field's default, or its `fallback`).
function formValue(f, raw) {
  let v = raw[f.key];
  if (v == null && f.alias) v = raw[f.alias];
  if (v == null) return f.fallback != null ? f.fallback : valueOf(f, undefined);
  if (f.type === 'enum' && f.caseless) return canonical(f, String(v).trim());
  if (f.type === 'string' && Array.isArray(v)) return v.join(' ');
  return valueOf(f, v);
}

// The form values of a whole option table from a section's raw options.
export const formValues = (fields, raw) => Object.fromEntries(fields.map(f => [f.key, formValue(f, raw)]));

// The field `f` as it applies to the values of a form: a port forward of kind SNAT words some of its fields differently.
export const fieldFor = (f, values) => (f.snat && values.target === 'SNAT' ? { ...f, ...f.snat } : f);

// Whether the field is shown for these values.
export const isShown = (f, values) => (f.show ? Boolean(f.show(values)) : true);

//#endregion

//#region The draft

// One list's items from the router: each has its `id` (the section's own name), whether it is new, whether it is marked for removal,
// and the form values.
const itemsOf = (fields, list) => list.map(s => ({ id: s.section, section: s.section, isNew: false, removed: false, values: formValues(fields, s.values) }));

// The form's starting values: the router's current ones. A new item gets an id of its own (`new:1`, ...) until it is saved.
export function draftFrom(data) {
  const draft = { defaults: formValues(DEFAULT_FIELDS, data.defaults.values), next: 1, cascade: {} };
  for (const [key, kind] of Object.entries(KINDS)) draft[key] = itemsOf(kind.fields, data[key]);
  return draft;
}

// The items of a list that are not marked for removal.
export const live = list => list.filter(i => !i.removed);

// The item of a list with this id, or undefined.
export const findItem = (draft, key, id) => draft[key].find(i => i.id === id);

// The trimmed name of a zone item.
export const zoneName = z => z.values.name.trim();

// The values of a new item of a kind: what the firewall assumes for an absent option, with the choices a person adding one expects.
export function newValues(key, data) {
  const base = formValues(KINDS[key].fields, {});
  if (key === 'zones') return { ...base, input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', name: freshZoneName(data) };
  if (key === 'rules') return { ...base, target: 'ACCEPT' };
  return base;
}

// A zone name that no section uses yet.
function freshZoneName(data) {
  const taken = new Set(data.zones.map(z => z.values.name));
  let name = 'zone1';
  for (let n = 2; taken.has(name); n++) name = `zone${n}`;
  return name;
}

// Adds an item with the form values `values` to a list of the draft and returns its id.
export function addItem(draft, key, values) {
  const id = `new:${draft.next++}`;
  draft[key].push({ id, section: null, isNew: true, removed: false, values });
  return id;
}

// Marks an item for removal, or drops it when it was only added in the form.
export function removeItem(draft, key, id) {
  const i = draft[key].findIndex(x => x.id === id);
  if (i < 0) return;
  if (draft[key][i].isNew) draft[key].splice(i, 1);
  else draft[key][i].removed = true;
}

// Takes an item back from removal.
export function restoreItem(draft, key, id) {
  const item = findItem(draft, key, id);
  if (item) item.removed = false;
}

// Moves a (non-removed) item up (-1) or down (1) among the items that are not marked for removal; does nothing at either end.
export function moveItem(draft, key, id, delta) {
  const list = draft[key];
  const at = list.findIndex(i => i.id === id);
  if (at < 0) return;
  let to = at + delta;
  while (to >= 0 && to < list.length && list[to].removed) to += delta;
  if (to < 0 || to >= list.length) return;
  [list[at], list[to]] = [list[to], list[at]];
}

// Removes a zone, and with it the forwardings that name it (they would refer to a zone that is gone). The ids of the forwardings that were
// already in the file are remembered, so that taking the zone back also takes them back.
export function removeZone(draft, id) {
  const z = findItem(draft, 'zones', id);
  if (!z) return;
  const name = zoneName(z);
  const gone = live(draft.forwardings).filter(f => f.values.src === name || f.values.dest === name).map(f => f.id);
  for (const fid of gone) removeItem(draft, 'forwardings', fid);
  if (!z.isNew) draft.cascade[id] = gone.filter(fid => findItem(draft, 'forwardings', fid));
  removeItem(draft, 'zones', id);
}

// Takes a removed zone back, with the forwardings that were removed along with it.
export function restoreZone(draft, id) {
  restoreItem(draft, 'zones', id);
  for (const fid of draft.cascade[id] ?? []) restoreItem(draft, 'forwardings', fid);
  delete draft.cascade[id];
}

// Puts the working copy of a form into the draft: a new item is added, an existing one gets the values. A zone that takes interfaces
// away from other zones removes them there: an interface can be in one zone only. Returns the item's id.
export function commitItem(draft, key, id, values) {
  let at = id;
  if (id == null) at = addItem(draft, key, values);
  else findItem(draft, key, id).values = values;
  if (key === 'zones') {
    for (const z of draft.zones) {
      if (z.id !== at) z.values = { ...z.values, network: z.values.network.filter(n => !values.network.includes(n)) };
    }
  }
  return at;
}

// Switches the forwarding from zone `src` to zone `dest`: when one is enabled it is removed, when a disabled one exists it is enabled,
// otherwise a new one is added. Returns what happened: 'removed', 'enabled' or 'added'.
export function toggleForwarding(draft, src, dest) {
  const same = live(draft.forwardings).filter(f => f.values.src === src && f.values.dest === dest);
  if (same.some(f => f.values.enabled)) {
    for (const f of same) removeItem(draft, 'forwardings', f.id);
    return 'removed';
  }
  if (same.length) {
    same[0].values.enabled = true;
    return 'enabled';
  }
  addItem(draft, 'forwardings', { ...formValues(FORWARDING_FIELDS, {}), src, dest });
  return 'added';
}

// The other zones the zone `name` may forward to (`to`) and the ones that may forward to it (`from`), from the enabled forwardings of the draft.
export function forwardLinks(draft, name) {
  const on = live(draft.forwardings).filter(f => f.values.enabled);
  return { to: on.filter(f => f.values.src === name).map(f => f.values.dest), from: on.filter(f => f.values.dest === name).map(f => f.values.src) };
}

// Makes the forwardings between the zone `name` and each of the zones `others` match `links` ({ to, from }, as forwardLinks returns them): a pair
// that should be open and is not gets a forwarding (or its disabled one is enabled), one that should be closed loses it. Forwardings that name
// something else (a zone not in `others`, "any zone") are left alone.
export function setForwardLinks(draft, name, links, others) {
  const apply = (src, dest, want) => {
    const have = live(draft.forwardings).some(f => f.values.enabled && f.values.src === src && f.values.dest === dest);
    if (want !== have) toggleForwarding(draft, src, dest);
  };
  for (const other of others) {
    apply(name, other, links.to.includes(other));
    apply(other, name, links.from.includes(other));
  }
}

//#endregion

//#region Comparing

// Whether two form values of a field differ.
function valueDiffers(f, a, b) {
  return f.type === 'list' ? a.length !== b.length || a.some((x, i) => x.trim() !== b[i].trim()) : f.type === 'bool' ? a !== b : String(a).trim() !== String(b).trim();
}

// The fields of an option table whose values differ between two sets of form values.
export const changedFields = (fields, from, to) => fields.filter(f => valueDiffers(f, from[f.key], to[f.key]));

// The item as the router has it (for comparing), or undefined for a new item.
function baseItem(data, key, id) {
  const s = data[key].find(x => x.section === id);
  return s ? { values: formValues(KINDS[key].fields, s.values) } : undefined;
}

// Whether an existing item differs from what the router has (a new item always counts as changed).
export function itemChanged(data, key, item) {
  const base = baseItem(data, key, item.id);
  return !base || changedFields(KINDS[key].fields, base.values, item.values).length > 0;
}

//#endregion

//#region Effective values

// The effective policy of a zone for one direction: its own, else the global default, else what the firewall uses without any (drop).
export const policyOf = (draft, z, key) => z.values[key] || draft.defaults[key] || 'DROP';

// The router's addresses of every interface, to recognize the interface the administrator reaches the router through.
export function adminNetworks(data, host) {
  const bare = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!bare) return [];
  return data.networks.filter(n => (n.addrs ?? []).some(a => a.toLowerCase() === bare)).map(n => n.name);
}

//#endregion
