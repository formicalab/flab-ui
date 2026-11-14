// The firewall as the page's cards show it while there are edits: the state the plugin reported (what is loaded, the counters) with the draft
// laid over it, in the shape the cards and the matrix already read (zones, rules, port forwards, defaults, unzoned interfaces), so that
// the matrix, the findings and the tables show what the configuration will be once the edits are saved. Pure: no DOM and no network.
//
// Every item also carries what the editing controls need: its `id` (the section's own name, or `new:N` until it is saved), `pending`
// ('new', 'edited' or null), `removed`, the form `values`, and a sentence saying what it does.
import { asList, uciBool } from '../../core/fields.js';
import { forwardingWords, redirectWords, ruleWords } from './describe.js';
import { itemChanged, live, policyOf, zoneName } from './edit.js';

// 'new', 'edited' or null for an item of the draft.
const pendingOf = (data, key, item) => (item.isNew ? 'new' : itemChanged(data, key, item) ? 'edited' : null);

// A list of values without blank rows.
const filled = list => list.map(s => s.trim()).filter(Boolean);

// Whether a rule has any schedule option.
const scheduled = v => Boolean(v.start_time || v.stop_time || v.weekdays || v.start_date || v.stop_date);

// Whether the page can render the draft: the plugin's reply and the config agree on which sections exist, so each item can be joined to its
// counters. A reply that was made for another config (or a change between the two reads) shows the plugin's own data, read only.
export function consistent(data) {
  const st = data.status;
  if (!st || !data.editable) return false;
  const ids = list => list.map(x => x.section).sort().join('\n');
  const sections = types => data.sections.filter(s => types.includes(s.type)).map(s => s.section).sort().join('\n');
  const names = (st.zones ?? []).map(z => z.name).sort().join('\n');
  if (ids(st.rules ?? []) !== sections(['rule']) || ids(st.redirects ?? []) !== sections(['redirect', 'nat'])
    || names !== data.zones.map(z => z.values.name ?? '').filter(Boolean).sort().join('\n')) return false;
  // The same sections, but are they in the state the config says? (the reply may have been made a moment before a change)
  const rawOf = section => [...data.rules, ...data.redirects, ...data.nat].find(s => s.section === section)?.values ?? {};
  // Whether every item of a reply list has the enabled flag the config gives its section.
  const sameEnabled = list => list.every(x => x.enabled === uciBool(rawOf(x.section).enabled, true));
  const sameZones = st.zones.every(z => {
    const cfg = data.zones.find(c => c.values.name === z.name)?.values ?? {};
    return z.enabled === uciBool(cfg.enabled, true) && (z.networks ?? []).join('\n') === asList(cfg.network).join('\n');
  });
  return sameEnabled(st.rules) && sameEnabled(st.redirects) && sameZones;
}

// The matrix, tables and findings' view of the draft: { ...plugin reply, zones, rules, redirects, defaults, unzoned, rows }, where `zones`,
// `rules` and `redirects` hold what stays and `rows` all items (those marked for removal included) in the draft's order.
export function effectiveView(data, draft) {
  const st = data.status;
  const forwardsOf = name => live(draft.forwardings).filter(f => f.values.enabled && f.values.src === name && f.values.dest).map(f => f.values.dest);

  const zoneRow = item => {
    const v = item.values, name = zoneName(item), pending = pendingOf(data, 'zones', item);
    const loaded = st.zones.find(z => z.name === name);
    return {
      id: item.id, pending, removed: item.removed, values: v, name, enabled: v.enabled,
      networks: filled(v.network), devices: pending || !loaded ? [] : loaded.devices,
      input: policyOf(draft, item, 'input'), output: policyOf(draft, item, 'output'), forward: policyOf(draft, item, 'forward'),
      masq: v.masq, mtu_fix: v.mtu_fix, forwards: forwardsOf(name),
      blocked_from: pending ? null : loaded?.blocked_from ?? null, blocked_to: pending ? null : loaded?.blocked_to ?? null,
    };
  };
  const zoneRows = draft.zones.map(zoneRow);

  const ruleRow = item => {
    const v = item.values, pending = pendingOf(data, 'rules', item), loaded = st.rules.find(r => r.section === item.id);
    return {
      id: item.id, pending, removed: item.removed, values: v, words: ruleWords(v), kind: 'rule',
      name: v.name.trim() || null, key: loaded?.key ?? item.id,
      src: v.src || undefined, dest: v.dest || undefined,
      proto: filled(v.proto), src_ip: filled(v.src_ip), dest_ip: filled(v.dest_ip), src_port: filled(v.src_port), dest_port: filled(v.dest_port), icmp_type: filled(v.icmp_type),
      family: v.family || 'any', target: (v.target || 'DROP').toUpperCase(), limit: v.limit.trim() || undefined, scheduled: scheduled(v),
      enabled: v.enabled, hits: pending || !v.enabled ? null : loaded?.hits ?? null,
    };
  };
  const ruleRows = draft.rules.map(ruleRow);

  const redirectRow = item => {
    const v = item.values, pending = pendingOf(data, 'redirects', item), loaded = st.redirects.find(r => r.section === item.id);
    return {
      id: item.id, pending, removed: item.removed, values: v, words: redirectWords(v), kind: 'redirect',
      name: v.name.trim() || null, key: loaded?.key ?? item.id,
      src: v.src || undefined, dest: v.dest || undefined,
      proto: v.proto.length ? filled(v.proto) : ['tcp', 'udp'], src_ip: v.src_ip.trim() ? [v.src_ip.trim()] : [], src_dip: v.src_dip.trim() ? [v.src_dip.trim()] : [],
      src_dport: v.src_dport.trim() ? [v.src_dport.trim()] : [], dest_ip: v.dest_ip.trim() || undefined, dest_port: v.dest_port.trim() ? [v.dest_port.trim()] : [],
      family: v.family || 'any', target: (v.target || 'DNAT').toUpperCase(),
      enabled: v.enabled, hits: pending || !v.enabled ? null : loaded?.hits ?? null,
    };
  };
  // A `nat` section is shown as the plugin reports it, read only, after the port forwards.
  const natRows = st.redirects.filter(r => r.kind === 'nat').map(r => ({ ...r, id: r.section, pending: null, removed: false, readOnly: true, words: '' }));
  const redirectRows = [...draft.redirects.map(redirectRow), ...natRows];

  const zones = zoneRows.filter(z => !z.removed);
  const inZone = new Set(zones.flatMap(z => z.networks));
  const d = draft.defaults;
  // Which zone pairs have a forwarding that was added, removed or changed in the form: 'src>dest' to 'added', 'removed' or 'edited'.
  const forwardPending = {};
  for (const item of draft.forwardings) {
    const state = item.removed ? 'removed' : pendingOf(data, 'forwardings', item);
    if (state) forwardPending[`${item.values.src}>${item.values.dest}`] = state === 'new' ? 'added' : state;
  }
  return {
    ...st,
    defaults: {
      input: d.input || 'DROP', output: d.output || 'DROP', forward: d.forward || 'DROP',
      synflood_protect: d.synflood_protect, flow_offloading: d.flow_offloading, flow_offloading_hw: d.flow_offloading_hw, drop_invalid: d.drop_invalid,
    },
    zones,
    rules: ruleRows.filter(r => !r.removed),
    redirects: redirectRows.filter(r => !r.removed),
    unzoned: data.networks.filter(n => n.name !== 'loopback' && !n.disabled && !inZone.has(n.name)).map(n => n.name).sort(),
    rows: { zones: zoneRows, rules: ruleRows, redirects: redirectRows },
    forwardPending,
  };
}

// The forwardings of the draft as rows for the list under the matrix: the zone names, whether the forwarding is enabled, and whether the
// matrix can show it (both zones exist, are different and are not "any zone").
export function forwardingRows(data, draft) {
  const names = new Set(live(draft.zones).map(zoneName));
  return draft.forwardings.map(item => ({
    id: item.id, removed: item.removed, pending: pendingOf(data, 'forwardings', item), values: item.values, words: forwardingWords(item.values),
    plain: names.has(item.values.src) && names.has(item.values.dest) && item.values.src !== item.values.dest,
  }));
}
