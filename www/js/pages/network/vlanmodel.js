// Pure model of the VLAN editor on the Ethernet ports view: the VLAN tables as the network config holds them (the `bridge-vlan`
// sections of DSA and VLAN-filtering bridges, the `switch_vlan` sections of swconfig switches), the draft the matrix edits, the
// review list, validation, the UCI operations a save makes and the check after a save. No DOM and no network, so it is unit-tested
// on its own (tests/vlanedit/model.test.mjs).
//
// The editor works on the CONFIG, not on the live table: what the router runs is only shown next to it. The config is read with
// `uci get` filtered by section type (bridge-vlan, device, switch, switch_vlan, switch_port); those types hold no secrets, and the
// page never reads the whole network config, which does.
//
// A cell of a bridge table is the membership of one port in one VLAN, in the notation of the `ports` list of a bridge-vlan
// section: '' not a member, 't' tagged, 'u' untagged, 'u*' untagged and the port's PVID, 't*' tagged and PVID. A cell of a
// swconfig table is '' (not a member), 't' (tagged, the port number followed by `t`) or 'u' (untagged: the bare port number).
import { asList, uciBool } from '../../core/fields.js';

export const CONFIG = 'network';
// The section types the editor reads, in the order of the reply it gets (see readConfig).
export const TYPES = ['bridge-vlan', 'device', 'switch', 'switch_vlan', 'switch_port'];

// The words for a cell state of a bridge table.
export const STATE_LABEL = { '': 'not a member', t: 'tagged', u: 'untagged', 'u*': 'untagged + PVID', 't*': 'tagged + PVID' };

//#region Reading the config

// The sections of an `uci get` reply (a map of section name to options) in file order, each as its options plus `sec`, the name
// uci gives the section (an option called `name` stays an option).
function sectionsOf(values) {
  const map = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  return Object.entries(map).sort(([, a], [, b]) => (a['.index'] ?? 0) - (b['.index'] ?? 0)).map(([name, s]) => ({ ...s, sec: s['.name'] ?? name }));
}

// A port entry of a bridge-vlan `ports` list ("lan2:u*") as { port, state }. Without flags a port is untagged and has no PVID;
// `t` makes it tagged and `*` makes the VLAN its PVID (netifd ignores a `u`).
export function parseEntry(entry) {
  const m = /^([^:]+)(?::(.*))?$/.exec(String(entry).trim());
  if (!m) return null;
  const flags = m[2] ?? '';
  return { port: m[1], state: `${flags.includes('t') ? 't' : 'u'}${flags.includes('*') ? '*' : ''}` };
}

// The `ports` entry for a port in a state (the inverse of parseEntry); '' gives null.
export const formatEntry = (port, state) => (state ? `${port}:${state}` : null);

// A swconfig port token ("3t", "5") as { port, state }; null for anything else.
export function parseToken(token) {
  const m = /^([0-9]+)(t?)$/.exec(token);
  return m ? { port: m[1], state: m[2] ? 't' : 'u' } : null;
}

// The config as the editor needs it, from the replies of `uci get` by type ({ 'bridge-vlan': values, device: values, ... }; a
// missing reply is an empty list). `devices` are the bridge devices by name, `switches` the switch sections by the name of their
// switch.
export function readConfig(raw) {
  const sections = type => sectionsOf(raw?.[type]);
  const bridgeVlans = sections('bridge-vlan').map(s => ({
    sec: s.sec, device: s.device ?? '', vid: s.vlan == null ? '' : String(s.vlan), local: uciBool(s.local, true), entries: asList(s.ports),
  }));
  // A bridge device section names its device in `option name`.
  const devices = {};
  for (const s of sections('device')) {
    if (s.type === 'bridge' && s.name) devices[s.name] = { sec: s.sec, filtering: uciBool(s.vlan_filtering, false), ports: asList(s.ports) };
  }
  // A switch section names its switch in `option name`, or is named after it.
  const switches = {};
  for (const s of sections('switch')) switches[s.name ?? s.sec] = { sec: s.sec, enable: uciBool(s.enable_vlan, false) };
  const switchVlans = sections('switch_vlan').map(s => ({
    sec: s.sec, device: s.device ?? '', vlan: s.vlan == null ? '' : String(s.vlan), vid: s.vid == null ? '' : String(s.vid), tokens: asList(s.ports),
  }));
  const switchPorts = sections('switch_port').map(s => ({ device: s.device ?? '', port: s.port == null ? '' : String(s.port), pvid: s.pvid == null ? '' : String(s.pvid) }));
  return { bridgeVlans, devices, switches, switchVlans, switchPorts };
}

//#endregion

//#region The tables

// The addresses of an interface of netifd's dump as "address/prefix" strings.
const addressesOf = i => [...(i['ipv4-address'] ?? []), ...(i['ipv6-address'] ?? [])].map(a => `${a.address}/${a.mask}`);

// The interfaces that are up and have an address on a device of `devices` ({ device name: vid }): what the router itself uses VLANs
// for. `host` is the address or name the page was opened with; an interface that has that address is the one this page reaches
// the router through (`mgmt`).
function carriersOf(ifs, devices, host) {
  const out = [];
  for (const i of ifs ?? []) {
    const device = i.l3_device || i.device;
    if (!i.up || !devices.has(device)) continue;
    const addresses = addressesOf(i);
    if (!addresses.length) continue;
    out.push({ vid: devices.get(device), iface: i.interface, device, addresses, mgmt: addresses.some(a => a.split('/')[0] === host) });
  }
  return out;
}

// The cells of a row from its port entries, and which port came first.
function cellsOfEntries(entries) {
  const cells = {};
  for (const e of entries) {
    const p = parseEntry(e);
    if (p) cells[p.port] = p.state;
  }
  return cells;
}

// The editable table of one bridge. `net` is the flab.network status. Null when the bridge has no Ethernet member and no VLAN.
function bridgeTable(b, net, conf, ifs, host) {
  const device = conf.devices[b.name] ?? null;
  const own = conf.bridgeVlans.filter(v => v.device === b.name);
  const ethernet = b.members.filter(m => m.kind === 'ethernet').map(m => m.name);
  if (!ethernet.length && !own.length && !b.vlan_table) return null;

  // Columns: the ports the config gives the bridge (else the ones it has now), then anything a VLAN names that is neither.
  const order = [...(device?.ports ?? []), ...ethernet];
  const memberNames = new Set([...order, ...b.members.map(m => m.name)]);
  const referenced = own.flatMap(v => v.entries.map(e => parseEntry(e)?.port)).filter(Boolean);
  const columns = [...new Set([...order, ...referenced])].map(id => ({ id, label: id, member: memberNames.has(id) }));

  const vlanDevices = (net.vlans ?? []).filter(v => v.parent === b.name).map(v => ({ name: v.name, vid: v.vid }));
  const devices = new Map([[b.name, b.default_pvid ?? 1], ...vlanDevices.map(v => [v.name, v.vid])]);
  for (const i of ifs ?? []) {
    const m = /^(.+)\.([0-9]+)$/.exec(i.l3_device || i.device || '');
    if (m && m[1] === b.name && !devices.has(m[0])) devices.set(m[0], +m[2]);
  }
  return {
    kind: 'bridge', key: `bridge:${b.name}`, name: b.name, label: `Bridge ${b.name}`,
    filteringLive: Boolean(b.vlan_filtering), filtering: device ? device.filtering : null, deviceSection: device?.sec ?? null,
    defaultPvid: b.default_pvid ?? 1, columns, vlanDevices, carriers: carriersOf(ifs, devices, host),
    rows: own.map(v => ({ key: v.sec, sec: v.sec, vid: v.vid, local: v.local, cells: cellsOfEntries(v.entries), orig: v.entries })),
    live: liveDifference(b, own),
  };
}

// How the live table differs from the config, in words, or null when the kernel table is not known (no `bridge` tool) or agrees.
// Only what the config states is compared: its ports and their tagging, and the VLANs the kernel has that the config does not name.
function liveDifference(b, own) {
  if (b.vlan_table?.source !== 'kernel') return null;
  const live = new Map(b.vlan_table.vlans.map(v => [v.vid, v]));
  const memberNames = new Set(b.members.map(m => m.name));
  const problems = [];
  const configured = new Set();
  for (const v of own) {
    const vid = Number(v.vid);
    configured.add(vid);
    const row = live.get(vid);
    if (!row) { problems.push(`VLAN ${vid} is in the config but not in the kernel`); continue; }
    for (const e of v.entries) {
      const p = parseEntry(e);
      if (!p) continue;
      const lp = row.ports.find(x => x.name === p.port);
      if (!lp) problems.push(`${p.port} is not in VLAN ${vid} in the kernel`);
      else if (lp.tagged !== p.state.startsWith('t')) problems.push(`${p.port} is ${lp.tagged ? 'tagged' : 'untagged'} in VLAN ${vid} in the kernel`);
    }
    for (const lp of row.ports) {
      if (memberNames.has(lp.name) && !v.entries.some(e => parseEntry(e)?.port === lp.name)) problems.push(`${lp.name} is in VLAN ${vid} in the kernel but not in the config`);
    }
  }
  for (const vid of live.keys()) {
    if (!configured.has(vid) && vid !== (b.default_pvid ?? 1)) problems.push(`VLAN ${vid} is in the kernel but not in the config`);
  }
  return problems.length ? problems : null;
}

// The editable table of one swconfig switch. Its CPU port is a column of its own.
function switchTable(sw, net, conf, ifs, host) {
  const name = String(sw.node).replace(/^swconfig:/, '');
  const own = conf.switchVlans.filter(v => v.device === name);
  const section = conf.switches[name] ?? null;
  const cpu = (sw.cpu_ports ?? []).filter(c => c.port != null);
  const numberOf = port => String(port).replace(/^port/, '');
  const columns = [
    ...sw.ports.map(p => ({ id: numberOf(p), label: p, cpu: false })),
    ...cpu.map(c => ({ id: String(c.port), label: `CPU (${c.port})`, cpu: true })),
  ];
  const known = new Set(columns.map(c => c.id));
  for (const v of own) for (const t of v.tokens) {
    const p = parseToken(t);
    if (p && !known.has(p.port)) { known.add(p.port); columns.push({ id: p.port, label: `port ${p.port}`, cpu: false }); }
  }
  const conduits = new Set(cpu.map(c => c.conduit).filter(Boolean));
  const devices = new Map();
  for (const v of net.vlans ?? []) if (conduits.has(v.parent)) devices.set(v.name, v.vid);
  for (const i of ifs ?? []) {
    const m = /^(.+)\.([0-9]+)$/.exec(i.l3_device || i.device || '');
    if (m && conduits.has(m[1]) && !devices.has(m[0])) devices.set(m[0], +m[2]);
  }
  const rows = own.map(v => ({
    key: v.sec, sec: v.sec, vlan: v.vlan, vid: v.vid, cells: Object.fromEntries(v.tokens.map(parseToken).filter(Boolean).map(p => [p.port, p.state])),
    orig: v.tokens, foreign: v.tokens.filter(t => !parseToken(t)),
  }));
  return {
    kind: 'switch', key: `switch:${name}`, name, label: `Switch ${sw.label ?? name}`, enable: section ? section.enable : null, enableSection: section?.sec ?? null,
    enableLive: Boolean(sw.vlan_enabled), columns, carriers: carriersOf(ifs, devices, host), conduits: [...conduits],
    pvids: conf.switchPorts.filter(p => p.device === name && p.pvid).map(p => ({ port: p.port, pvid: p.pvid })), rows,
  };
}

// The editable tables of the router, bridges first then swconfig switches, from the flab.network status `net`, the config read by
// readConfig, netifd's interface list and the host name the page was opened with.
export function tablesOf(net, conf, ifs, host) {
  return [
    ...(net.bridges ?? []).map(b => bridgeTable(b, net, conf, ifs, host)),
    ...(net.switches ?? []).filter(s => s.kind === 'swconfig').map(s => switchTable(s, net, conf, ifs, host)),
  ].filter(Boolean);
}

//#endregion

//#region The draft

// The effective VLAN id of a swconfig row: its `vid` option, else its group number.
export const switchVid = row => (row.vid !== '' ? row.vid : row.vlan);

// The page's VLAN data: the tables of `tablesOf`, or none when the config could not be read (then nothing is editable).
export const dataOf = (net, rawConfig, ifs, host) => ({ tables: rawConfig ? tablesOf(net, readConfig(rawConfig), ifs, host) : [] });

// A copy of a row for the draft.
const copyRow = r => ({ ...r, cells: { ...r.cells } });

// The form's starting values: every table's rows and switches, copied from the config.
export const draftFrom = data => ({
  tables: Object.fromEntries((data.vlan?.tables ?? []).map(t => [t.key, { rows: t.rows.map(copyRow), filtering: t.filtering, enable: t.enable, next: 1 }])),
});

// The table of the data with this key.
const tableOf = (data, key) => data.vlan.tables.find(t => t.key === key);

// A cell of a row, '' when absent.
const cellOf = (row, id) => row.cells[id] ?? '';

// The rows that differ from the config, as { kind: 'added' | 'removed' | 'changed', table, row, before }.
function rowChanges(table, draft) {
  const out = [];
  const base = new Map(table.rows.map(r => [r.key, r]));
  const seen = new Set();
  for (const r of draft.rows) {
    const b = base.get(r.key);
    if (!b) { out.push({ kind: 'added', table, row: r }); continue; }
    seen.add(r.key);
    const same = table.kind === 'bridge' ? b.local === r.local : true;
    if (!same || table.columns.some(c => cellOf(b, c.id) !== cellOf(r, c.id))) out.push({ kind: 'changed', table, row: r, before: b });
  }
  for (const b of table.rows) if (!seen.has(b.key)) out.push({ kind: 'removed', table, row: b, before: b });
  return out;
}

// The words for a row's membership, for the review list: "lan1 tagged, lan2 untagged + PVID, bridge".
export function describeRow(table, row) {
  const parts = table.columns.filter(c => cellOf(row, c.id)).map(c => `${c.label} ${table.kind === 'bridge' ? STATE_LABEL[cellOf(row, c.id)] : cellOf(row, c.id) === 't' ? 'tagged' : 'untagged'}`);
  if (table.kind === 'bridge' && row.local) parts.push('router');
  return parts.length ? parts.join(', ') : 'no ports';
}

// The name of a row in messages: "VLAN 20" (a swconfig group with another index says so).
const rowName = (table, row) => (table.kind === 'switch' && row.vid !== '' && row.vid !== row.vlan ? `VLAN ${row.vid} (group ${row.vlan})` : `VLAN ${table.kind === 'switch' ? switchVid(row) : row.vid}`);

// The review list: what changes from what to what.
export function changesOf(data, draft) {
  const out = [];
  for (const table of data.vlan?.tables ?? []) {
    const d = draft.tables[table.key];
    if (!d) continue;
    for (const c of rowChanges(table, d)) {
      const name = `${table.name} ${rowName(table, c.row)}`;
      if (c.kind === 'added') out.push({ label: `${name} added`, from: 'none', to: describeRow(table, c.row) });
      else if (c.kind === 'removed') out.push({ label: `${name} removed`, from: describeRow(table, c.before), to: 'none' });
      else out.push({ label: name, from: describeRow(table, c.before), to: describeRow(table, c.row) });
    }
    if (table.kind === 'bridge' && table.filtering !== null && d.filtering !== table.filtering) out.push({ label: `${table.name} VLAN filtering`, from: table.filtering ? 'on' : 'off', to: d.filtering ? 'on' : 'off' });
    if (table.kind === 'switch' && table.enable !== null && d.enable !== table.enable) out.push({ label: `${table.name} enable_vlan`, from: table.enable ? 'on' : 'off', to: d.enable ? 'on' : 'off' });
  }
  return out;
}

// Whether the form holds edits that are not saved.
export const isDirty = (data, draft) => changesOf(data, draft).length > 0;

// Adds a row for a VLAN to the draft's table. A bridge row starts with the router (the bridge itself) as a member; a switch row
// starts with the CPU ports tagged. The group number of a switch row is the lowest free one from 1. Returns the problem as text
// when the id cannot be used, else null.
export function addRow(data, draft, key, vidText) {
  const table = tableOf(data, key);
  const d = draft.tables[key];
  const vid = String(vidText ?? '').trim();
  if (!/^[0-9]+$/.test(vid) || +vid < 1 || +vid > 4094) return 'A VLAN id is a whole number from 1 to 4094.';
  const exists = d.rows.some(r => (table.kind === 'switch' ? switchVid(r) : r.vid) === String(+vid));
  if (exists) return `VLAN ${+vid} is already in the table.`;
  const id = `new:${d.next++}`;
  if (table.kind === 'bridge') {
    d.rows.push({ key: id, sec: null, vid: String(+vid), local: true, cells: {}, orig: [] });
  } else {
    const used = new Set(d.rows.map(r => r.vlan));
    let vlan = 1;
    while (used.has(String(vlan))) vlan++;
    d.rows.push({ key: id, sec: null, vlan: String(vlan), vid: String(vlan) === String(+vid) ? '' : String(+vid), cells: Object.fromEntries(table.columns.filter(c => c.cpu).map(c => [c.id, 't'])), orig: [], foreign: [] });
  }
  return null;
}

// Removes a row (an existing VLAN is deleted from the config when saved).
export function removeRow(draft, key, rowKey) {
  const d = draft.tables[key];
  d.rows = d.rows.filter(r => r.key !== rowKey);
}

//#endregion

//#region Validation

// A whole number in a range, or null.
const intIn = (text, min, max) => (/^[0-9]+$/.test(String(text).trim()) && +text >= min && +text <= max ? +text : null);

// The cells key of the matrix controls (also what the page registers its inputs under).
export const cellKey = (table, row, col) => `cell:${table.key}|${row.key}|${col}`;

// Problems of a bridge table: errors block saving, warnings do not.
function bridgeProblems(table, d, errors, warnings) {
  const filtering = d.filtering ?? table.filteringLive;
  const vids = new Map();
  for (const r of d.rows) {
    const vid = intIn(r.vid, 1, 4094);
    const name = `VLAN ${r.vid}`;
    if (vid === null) { errors.push({ text: `${table.name}: "${r.vid}" is not a VLAN id (a whole number from 1 to 4094).`, key: `row:${table.key}|${r.key}` }); continue; }
    if (vids.has(vid)) errors.push({ text: `${table.name}: ${name} is in the table twice.`, key: `row:${table.key}|${r.key}`, also: `row:${table.key}|${vids.get(vid)}` });
    vids.set(vid, r.key);
  }
  const base = new Map(table.rows.map(r => [r.key, r]));
  const pvids = new Map();
  const untagged = new Map();
  for (const c of table.columns) {
    for (const r of d.rows) {
      const state = cellOf(r, c.id);
      if (!state) continue;
      if (!c.member && state !== cellOf(base.get(r.key) ?? { cells: {} }, c.id)) errors.push({ text: `${table.name}: ${c.label} is not a member of the bridge, so it cannot be in a VLAN of it.`, key: cellKey(table, r, c.id) });
      if (state.endsWith('*')) pvids.set(c.id, [...(pvids.get(c.id) ?? []), r]);
      if (state.startsWith('u')) untagged.set(c.id, [...(untagged.get(c.id) ?? []), r]);
    }
  }
  for (const [id, rows] of pvids) {
    if (rows.length > 1) errors.push({ text: `${table.name}: ${id} is the PVID of ${rows.map(r => `VLAN ${r.vid}`).join(' and ')}, but a port has only one PVID.`, key: cellKey(table, rows[0], id), also: cellKey(table, rows[1], id) });
  }
  for (const [id, rows] of untagged) {
    if (rows.length > 1) warnings.push(`${table.name}: ${id} is untagged in ${rows.map(r => `VLAN ${r.vid}`).join(' and ')}. A port normally sends a single VLAN untagged; the others should be tagged.`);
    if (!pvids.has(id)) warnings.push(`${table.name}: ${id} is untagged in VLAN ${rows[0].vid} but no VLAN is marked as its PVID, so what happens to frames that arrive on it without a tag depends on the netifd version.`);
  }
  if (!filtering) warnings.push(`VLAN filtering is off on ${table.name}, so this table has no effect until it is turned on${table.filtering === null ? ' (the vlan_filtering option of the bridge device)' : ''}.`);
  if (filtering && d.filtering === true && table.filtering === false) {
    warnings.push(`Turning VLAN filtering on changes how every port of ${table.name} forwards at once: a port that is in no VLAN carries no traffic, and frames without a tag join only the VLAN marked PVID on that port. If you reach the router through this bridge, check the table first; the router puts the old settings back by itself if the page loses contact.`);
  }
  if (filtering) {
    for (const c of table.columns.filter(x => x.member)) {
      if (!d.rows.some(r => cellOf(r, c.id))) warnings.push(`${table.name}: ${c.label} is in no VLAN, so it carries no traffic.`);
    }
  }
  for (const r of d.rows) if (!r.local && !table.columns.some(c => cellOf(r, c.id))) warnings.push(`${table.name}: VLAN ${r.vid} has no member at all.`);
  // The VLAN devices on top of the bridge need their VLAN, with the bridge itself in it, once the bridge filters.
  if (filtering) {
    for (const v of table.vlanDevices) {
      const row = d.rows.find(r => r.vid === String(v.vid));
      if (!row || !row.local) warnings.push(`${v.name} is a VLAN device on ${table.name}: with VLAN filtering on it carries nothing unless VLAN ${v.vid} is in this table with the router as a member.`);
    }
  }
  if (d.filtering === false && table.filtering === true) warnings.push(`Turning VLAN filtering off removes the separation between the VLANs of ${table.name}: the ports go back to forwarding between each other as one network.`);
  // While the bridge does not filter, its table is not in force and cannot cut anything off.
  if (filtering) lockoutWarnings(table, d, warnings, d.filtering === true && table.filtering === false);
}

// Warnings for edits that can cut off the router's own interfaces (and so possibly this page): a VLAN that carries an address of
// the router is removed, the router leaves it, or one of its ports changes. `turnedOn` is whether this edit turns the filtering (or
// the switch's VLANs) on, which makes every interface depend on the table.
function lockoutWarnings(table, d, warnings, turnedOn) {
  const base = new Map(table.rows.map(r => [r.key, r]));
  for (const car of table.carriers) {
    const via = car.mgmt ? ` You are connected through this address (${car.addresses[0].split('/')[0]}).` : '';
    const what = `VLAN ${car.vid} carries ${car.iface} (${car.addresses[0]})`;
    const row = d.rows.find(r => (table.kind === 'bridge' ? r.vid : switchVid(r)) === String(car.vid));
    const before = base.get(row?.key) ?? [...base.values()].find(r => (table.kind === 'bridge' ? r.vid : switchVid(r)) === String(car.vid));
    if (!row) {
      if (before || turnedOn) warnings.push(`${table.name}: ${what}; without this VLAN in the table the interface loses its traffic.${via}`);
      continue;
    }
    if (!before) continue;
    if (table.kind === 'bridge' && before.local && !row.local) warnings.push(`${table.name}: ${what}, and the router leaves this VLAN, so the interface stops working.${via}`);
    if (table.kind === 'switch') {
      const lost = table.columns.filter(c => c.cpu && cellOf(before, c.id) && cellOf(row, c.id) !== cellOf(before, c.id));
      if (lost.length) warnings.push(`${table.name}: ${what}; the CPU port no longer carries it the same way, so the interface stops working.${via}`);
    }
    const hurt = table.columns.filter(c => !c.cpu && cellOf(before, c.id) && cellOf(row, c.id) !== cellOf(before, c.id));
    if (hurt.length) warnings.push(`${table.name}: ${what}; ${hurt.map(c => c.label).join(', ')} ${hurt.length > 1 ? 'change' : 'changes'} here, so devices behind ${hurt.length > 1 ? 'them' : 'it'} may lose the router.${via}`);
  }
}

// Problems of a swconfig table.
function switchProblems(table, d, errors, warnings) {
  const groups = new Map();
  const vids = new Map();
  for (const r of d.rows) {
    const index = intIn(r.vlan, 0, 4094);
    const vid = intIn(switchVid(r), 1, 4094);
    if (index === null) errors.push({ text: `${table.name}: "${r.vlan}" is not a VLAN group number.`, key: `row:${table.key}|${r.key}` });
    else if (groups.has(index)) errors.push({ text: `${table.name}: group ${index} is in the table twice.`, key: `row:${table.key}|${r.key}`, also: `row:${table.key}|${groups.get(index)}` });
    else groups.set(index, r.key);
    if (vid === null) errors.push({ text: `${table.name}: "${switchVid(r)}" is not a VLAN id (a whole number from 1 to 4094).`, key: `row:${table.key}|${r.key}` });
    else if (vids.has(vid)) errors.push({ text: `${table.name}: VLAN ${vid} is in the table twice.`, key: `row:${table.key}|${r.key}`, also: `row:${table.key}|${vids.get(vid)}` });
    else vids.set(vid, r.key);
  }
  for (const c of table.columns) {
    const untagged = d.rows.filter(r => cellOf(r, c.id) === 'u');
    if (untagged.length > 1) errors.push({ text: `${table.name}: ${c.label} is untagged in ${untagged.map(r => `VLAN ${switchVid(r)}`).join(' and ')}, but an untagged port can only be in one VLAN.`, key: cellKey(table, untagged[0], c.id), also: cellKey(table, untagged[1], c.id) });
  }
  const enabled = d.enable ?? table.enableLive;
  if (!enabled) warnings.push(`VLANs are off on ${table.name} (the enable_vlan option of its switch section), so these groups have no effect until they are turned on.`);
  if (d.enable === true && table.enable === false) warnings.push(`Turning VLANs on changes how every port of ${table.name} forwards at once: a port that is in no group carries no traffic.`);
  for (const c of table.columns.filter(x => !x.cpu)) {
    if (!d.rows.some(r => cellOf(r, c.id))) warnings.push(`${table.name}: ${c.label} is in no VLAN, so it carries no traffic.`);
  }
  for (const r of d.rows) if (!table.columns.some(c => cellOf(r, c.id))) warnings.push(`${table.name}: ${rowName(table, r)} has no port.`);
  const cpuIds = table.columns.filter(c => c.cpu).map(c => c.id);
  if (cpuIds.length && d.rows.length && !d.rows.some(r => cpuIds.some(id => cellOf(r, id)))) warnings.push(`${table.name}: the CPU port is in no VLAN, so the router cannot reach any port.`);
  if (d.enable === false && table.enable === true) warnings.push(`Turning VLANs off on ${table.name} makes the switch forward between all its ports as one network.`);
  if (enabled) lockoutWarnings(table, d, warnings, d.enable === true && table.enable === false);
}

// The errors and warnings of the draft, only for the tables that were edited (a table that was already odd in the config is not
// reported until it is touched). An error is { text, key?, also? } (the keys name the controls to mark), a warning is text.
export function problems(data, draft) {
  const errors = [];
  const warnings = [];
  for (const table of data.vlan?.tables ?? []) {
    const d = draft.tables[table.key];
    if (!d || !changesOf({ vlan: { tables: [table] } }, { tables: { [table.key]: d } }).length) continue;
    (table.kind === 'bridge' ? bridgeProblems : switchProblems)(table, d, errors, warnings);
  }
  return { errors, warnings };
}

//#endregion

//#region The UCI plan

// The `ports` entries of a bridge row after the edit: entries the edit did not touch keep their spelling and place, removed
// ports leave, new ports follow in column order.
function bridgeEntries(table, base, row) {
  const out = [];
  const used = new Set();
  for (const raw of base?.orig ?? []) {
    const p = parseEntry(raw);
    if (!p || used.has(p.port)) continue;
    used.add(p.port);
    const want = cellOf(row, p.port);
    if (want) out.push(want === p.state ? raw : formatEntry(p.port, want));
  }
  for (const c of table.columns) if (!used.has(c.id) && cellOf(row, c.id)) out.push(formatEntry(c.id, cellOf(row, c.id)));
  return out;
}

// The `ports` string of a swconfig row after the edit, in the same way (a token that is not a port number stays); new ports follow
// with the CPU port first, as the documentation writes them.
function switchTokens(table, base, row) {
  const out = [];
  const used = new Set();
  for (const raw of base?.orig ?? []) {
    const p = parseToken(raw);
    if (!p) { out.push(raw); continue; }
    if (used.has(p.port)) continue;
    used.add(p.port);
    const want = cellOf(row, p.port);
    if (want) out.push(want === p.state ? raw : `${p.port}${want === 't' ? 't' : ''}`);
  }
  const order = [...table.columns.filter(c => c.cpu), ...table.columns.filter(c => !c.cpu)];
  for (const c of order) if (!used.has(c.id) && cellOf(row, c.id)) out.push(`${c.id}${cellOf(row, c.id) === 't' ? 't' : ''}`);
  return out;
}

// The UCI operations a save makes (see core/ops.js): removed sections are deleted, changed rows set only what changed, added rows
// become new sections, and the switch for filtering or VLANs is set on the bridge device or switch section.
export function plan(data, draft) {
  const ops = [];
  const adds = [];
  for (const table of data.vlan?.tables ?? []) {
    const d = draft.tables[table.key];
    if (!d) continue;
    for (const c of rowChanges(table, d)) {
      if (c.kind === 'removed') {
        ops.push({ op: 'delete', config: CONFIG, section: c.row.sec });
      } else if (c.kind === 'changed') {
        const set = {};
        const drop = [];
        if (table.kind === 'bridge') {
          if (c.before.local !== c.row.local) { if (c.row.local) drop.push('local'); else set.local = '0'; }
          if (table.columns.some(col => cellOf(c.before, col.id) !== cellOf(c.row, col.id))) {
            const entries = bridgeEntries(table, c.before, c.row);
            if (entries.length) set.ports = entries; else drop.push('ports');
          }
        } else {
          const tokens = switchTokens(table, c.before, c.row);
          if (tokens.length) set.ports = tokens.join(' '); else drop.push('ports');
        }
        if (Object.keys(set).length) ops.push({ op: 'set', config: CONFIG, section: c.row.sec, values: set });
        if (drop.length) ops.push({ op: 'delete', config: CONFIG, section: c.row.sec, options: drop });
      } else if (table.kind === 'bridge') {
        const entries = bridgeEntries(table, null, c.row);
        adds.push({ op: 'add', config: CONFIG, type: 'bridge-vlan', values: { device: table.name, vlan: c.row.vid, ...(entries.length ? { ports: entries } : {}), ...(c.row.local ? {} : { local: '0' }) } });
      } else {
        const tokens = switchTokens(table, null, c.row);
        adds.push({ op: 'add', config: CONFIG, type: 'switch_vlan', values: { device: table.name, vlan: c.row.vlan, ...(c.row.vid !== '' ? { vid: c.row.vid } : {}), ...(tokens.length ? { ports: tokens.join(' ') } : {}) } });
      }
    }
    if (table.kind === 'bridge' && table.filtering !== null && d.filtering !== table.filtering) {
      ops.push(d.filtering ? { op: 'set', config: CONFIG, section: table.deviceSection, values: { vlan_filtering: '1' } } : { op: 'delete', config: CONFIG, section: table.deviceSection, options: ['vlan_filtering'] });
    }
    if (table.kind === 'switch' && table.enable !== null && d.enable !== table.enable) {
      ops.push({ op: 'set', config: CONFIG, section: table.enableSection, values: { enable_vlan: d.enable ? '1' : '0' } });
    }
  }
  return [...ops, ...adds];
}

//#endregion

//#region The check after a save

// Throws when the config read back after a save does not hold what the draft says: every row of an edited table is there with the
// same members, the removed rows are gone, and the switch for filtering or VLANs is as chosen. `afterRaw` is the raw reply of the
// `uci get` calls by type (see readConfig).
export function checkApplied(data, draft, afterRaw) {
  const conf = readConfig(afterRaw);
  const bad = [];
  for (const table of data.vlan?.tables ?? []) {
    const d = draft.tables[table.key];
    if (!d || (!rowChanges(table, d).length && (table.kind === 'bridge' ? d.filtering === table.filtering : d.enable === table.enable))) continue;
    const stored = table.kind === 'bridge'
      ? conf.bridgeVlans.filter(v => v.device === table.name).map(v => ({ id: v.vid, local: v.local, cells: cellsOfEntries(v.entries) }))
      : conf.switchVlans.filter(v => v.device === table.name).map(v => ({ id: v.vid !== '' ? v.vid : v.vlan, cells: Object.fromEntries(v.tokens.map(parseToken).filter(Boolean).map(p => [p.port, p.state])) }));
    const ids = new Set();
    for (const r of d.rows) {
      const id = table.kind === 'bridge' ? r.vid : switchVid(r);
      ids.add(id);
      const s = stored.find(x => x.id === id);
      if (!s) { bad.push(`${table.name} VLAN ${id} is not in the config`); continue; }
      const cells = [...new Set([...table.columns.map(c => c.id), ...Object.keys(s.cells)])];
      if (cells.some(c => (s.cells[c] ?? '') !== cellOf(r, c)) || (table.kind === 'bridge' && s.local !== r.local)) bad.push(`${table.name} VLAN ${id} was stored differently from what was saved`);
    }
    for (const s of stored) if (!ids.has(s.id)) bad.push(`${table.name} VLAN ${s.id} is still in the config`);
    if (table.kind === 'bridge' && table.filtering !== null && (conf.devices[table.name]?.filtering ?? false) !== d.filtering) bad.push(`VLAN filtering on ${table.name} is not ${d.filtering ? 'on' : 'off'} in the config`);
    if (table.kind === 'switch' && table.enable !== null && (conf.switches[table.name]?.enable ?? false) !== d.enable) bad.push(`enable_vlan of ${table.name} is not ${d.enable ? 'on' : 'off'} in the config`);
  }
  if (bad.length) throw new Error(`The router did not keep the change: ${bad.join('; ')}.`);
}

//#endregion
