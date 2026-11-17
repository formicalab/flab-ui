// Pure model of the Wi-Fi radios page's editing: the data the plugins report, the form's draft, the review list, validation, the UCI
// operations a save makes and the check after a save. No DOM and no network, so it is unit-tested on its own
// (tests/wifiedit/model.test.mjs). The geometry of channels is in channels.js, the option tables in schema.js.
//
// The config is edited through rpcd's `uci` object, but it is read through the flab.radio plugin's `config` method, which leaves
// out every secret (Wi-Fi keys, RADIUS secrets, EAP passwords, key-holder lists): the browser never receives one, only whether
// it is set (`secrets`). A secret field of the draft is therefore empty until the user types a value; empty keeps what is stored.
import { asList, differs, errorsOf, flag, normalize, show, valueOf } from '../../core/fields.js';
import { channelCheck, channelOf, widthOf } from './channels.js';
import { CONFIG, ENCRYPTIONS, IFACE_FIELDS, RADIO_FIELDS, encryptionInfo, encryptionLabel } from './schema.js';

export { CONFIG };

// The modes of wifi-iface the page edits; a section of another mode (adhoc, monitor) is left alone.
export const EDITABLE_MODES = ['ap', 'sta', 'mesh'];

// The key of the option that names a wireless network: the SSID, or the Mesh ID of a mesh point.
export const nameKey = mode => (mode === 'mesh' ? 'mesh_id' : 'ssid');

//#region Reading

// The page's data from the replies of `flab.radio status` (`hw`, the live state) and `flab.radio config` (`cfg`, the
// configuration without secrets; null when the plugin does not offer it, which makes the page read only):
//   radios   each radio of the status with its raw options (`values`), which secrets are set and the htmodes it supports
//   ifaces   every wifi-iface in file order: its section, device, mode, options, secrets, whether the page can edit it (ap, sta
//            and mesh) and the live state of its interface (`live`)
//   mesh     the nodes of the flab.mesh status (peers, paths, parameters), for the checks about a mesh point that has peers
//   networks, countries, features, others, regdomain   what the drop-downs and the checks need
export function readWifi(hw, cfg, mesh = null) {
  const live = new Map((hw?.radios ?? []).flatMap(r => (r.interfaces ?? []).map(i => [i.section, i])));
  const radios = (hw?.radios ?? []).map(r => {
    const c = cfg?.radios?.find(x => x.section === r.name);
    return { ...r, interfaces: r.interfaces ?? [], values: c?.values ?? {}, secrets: c?.secrets ?? {}, htmodes: c?.htmodes ?? { source: null, modes: [] } };
  });
  const ifaces = (cfg?.interfaces ?? []).map(i => {
    const mode = i.values?.mode ?? 'ap';
    return { section: i.section, anonymous: Boolean(i.anonymous), device: asList(i.values?.device)[0] ?? '', mode, editable: EDITABLE_MODES.includes(mode),
      values: i.values ?? {}, secrets: i.secrets ?? {}, live: live.get(i.section) ?? null };
  });
  return {
    editable: Boolean(cfg) && radios.length > 0,
    radios, ifaces,
    mesh: mesh?.nodes ?? [],
    networks: (cfg?.networks ?? []).map(n => n.name),
    countries: cfg?.countries ?? [],
    features: cfg?.features ?? {},
    others: cfg?.others ?? [],
    regdomain: hw?.regdomain ?? null,
  };
}

//#endregion

//#region The form

// The form values of a list of fields from a section's raw options: a boolean, a list or a string ('' = not set).
export const valuesOf = (fields, raw) => Object.fromEntries(fields.map(f => [f.key, valueOf(f, raw[f.key])]));

// A wireless network's form values: `encryption` 'none' is the same as no encryption option, and is kept as '' (the drop-down's
// "Open" choice) so the two are not told apart.
export function ifaceValues(raw) {
  const v = valuesOf(IFACE_FIELDS, raw);
  if (v.encryption === 'none') v.encryption = '';
  return v;
}

// What a field's `show` and the encryption-dependent checks are given for a radio, and for a wireless network with `values`.
export const radioCtx = radio => ({ radio });
export const ifaceCtx = (w, i, values) => ({ mode: i.mode, info: encryptionInfo(values.encryption), features: w.features, radio: w.radios.find(r => r.name === i.device) });

// Whether a field is shown for these values: it applies to the mode and its own `show` agrees. A field without `modes` applies to
// every mode but mesh. A hidden option keeps its value in the file and is neither validated nor written.
export const isShown = (field, values, ctx) => (field.modes ? field.modes.includes(ctx.mode ?? 'ap') : ctx.mode !== 'mesh') && (field.show ? Boolean(field.show(values, ctx)) : true);

// The form's starting values: the router's current ones. Added networks get an id of their own (`new1`, ...) because they have no
// section yet.
export const draftFrom = w => ({
  radios: Object.fromEntries(w.radios.map(r => [r.name, { channel: channelOf(r), ...valuesOf(RADIO_FIELDS, r.values) }])),
  ifaces: Object.fromEntries(w.ifaces.filter(i => i.editable).map(i => [i.section, ifaceValues(i.values)])),
  added: [],
  removed: {},
  next: 1,
});

// The wireless networks the form shows, in order: the router's (ap, sta and mesh), then the ones added in the form. Each has an `id`
// (the section name, or `new1`...), its `name` (section name), `device`, `mode`, `isNew` and `removed`.
export function ifaceList(w, draft) {
  return [
    ...w.ifaces.filter(i => i.editable).map(i => ({ ...i, id: i.section, name: i.section, isNew: false, removed: Boolean(draft.removed[i.section]) })),
    ...draft.added.map(a => ({ id: a.id, section: null, name: a.name, device: a.device, mode: a.mode, editable: true, values: {}, secrets: {}, live: null, isNew: true, removed: false })),
  ];
}

// The name a network goes by in messages: its SSID or Mesh ID (the saved one for a network that exists, so the name does not change
// while it is being edited), else its section name, else "New network".
export const ifaceTitle = (i, values) => (i.isNew ? values[nameKey(i.mode)].trim() || `New ${i.mode === 'mesh' ? 'mesh point' : 'network'}` : i.values[nameKey(i.mode)] || i.name);

// The words for a network of this mode in the review list and in warnings.
export const modeWords = mode => (mode === 'sta' ? 'client network' : mode === 'mesh' ? 'mesh point' : 'network');

// Adds a wireless network on radio `device` to the draft and returns its id. An access point starts protected (WPA3/WPA2 mixed
// when hostapd can do SAE, else WPA2) and attached to lan; a client network starts as WPA2 on wwan, when the router has them; a
// mesh point starts with SAE on lan (without SAE support it starts open, which the checks then warn about).
export function addIface(w, draft, device, mode) {
  const id = `new${draft.next++}`;
  const used = new Set([...w.radios.map(r => r.name), ...w.ifaces.map(i => i.section), ...w.others.map(o => o.section), ...draft.added.map(a => a.name)]);
  let n = 0;
  while (used.has(`wifinet${n}`)) n++;
  draft.added.push({ id, name: `wifinet${n}`, device, mode });
  const home = mode === 'sta' ? 'wwan' : 'lan';
  const sae = w.features.sae !== false;
  draft.ifaces[id] = {
    ...ifaceValues({}),
    network: w.networks.includes(home) ? [home] : [],
    encryption: mode === 'mesh' ? (sae ? 'sae' : '') : mode === 'ap' && sae ? 'sae-mixed' : 'psk2',
  };
  return id;
}

// Marks a network for removal, or drops it when it was only added in the form.
export function removeIface(draft, id) {
  const i = draft.added.findIndex(a => a.id === id);
  if (i < 0) { draft.removed[id] = true; return; }
  draft.added.splice(i, 1);
  delete draft.ifaces[id];
}

// Takes a network back from removal.
export function restoreIface(draft, id) {
  delete draft.removed[id];
}

//#endregion

//#region Review

// A value for the review list: the encryption and enum values in words, else as core/fields.js shows it.
function describe(f, v) {
  if (f.key === 'encryption') return encryptionLabel(v || 'none');
  if (f.type === 'enum' && v !== '' && f.labels?.[v]) return f.labels[v];
  return show(f, v);
}

// Adds to `out` one review entry per shown field of a section whose draft value `to` differs from `from` (both form values). A
// secret is never shown: the entry says only that it will be replaced.
function diffFields(fields, from, to, ctx, keyPrefix, labelPrefix, secrets, out) {
  for (const f of fields) {
    if (!isShown(f, to, ctx)) continue;
    const key = `${keyPrefix}:${f.key}`, label = `${labelPrefix}: ${f.label}`;
    if (f.secret) {
      if (to[f.key] !== '') out.push({ key, label, from: secrets[f.key] ? 'set (hidden)' : 'not set', to: 'new value (hidden)' });
      continue;
    }
    const a = normalize(f, from[f.key]), b = normalize(f, to[f.key]);
    if (differs(f, a, b)) out.push({ key, label, from: describe(f, a), to: describe(f, b) });
  }
}

// The differences between the router's values and the draft for the review list: [{ key, label, from, to }].
export function changesOf(w, draft) {
  const out = [];
  for (const r of w.radios) {
    const d = draft.radios[r.name];
    if (!d) continue;
    if (d.channel !== channelOf(r)) out.push({ key: `${r.name}:channel`, label: `${r.name}: channel`, from: channelOf(r), to: d.channel });
    diffFields(RADIO_FIELDS, valuesOf(RADIO_FIELDS, r.values), d, radioCtx(r), r.name, r.name, {}, out);
  }
  for (const i of ifaceList(w, draft)) {
    const v = draft.ifaces[i.id];
    const title = ifaceTitle(i, v);
    if (i.isNew) out.push({ key: `if:${i.id}`, label: `New ${modeWords(i.mode)} "${title}" on ${i.device}`, from: 'none', to: encryptionLabel(v.encryption || 'none') });
    else if (i.removed) out.push({ key: `if:${i.id}`, label: `Remove ${i.mode === 'mesh' ? 'mesh point' : 'network'} "${title}"`, from: `${i.device} · ${encryptionLabel(i.values.encryption || 'none')}`, to: 'removed' });
    else diffFields(IFACE_FIELDS, ifaceValues(i.values), v, ifaceCtx(w, i, v), `if:${i.id}`, title, i.secrets, out);
  }
  return out;
}

// Whether the draft differs from the router in any way.
export const isDirty = (w, draft) => changesOf(w, draft).length > 0;

//#endregion

//#region Validation

// The keys of the shown fields of a wireless network whose draft value differs from the router's (all of them for a new network).
function changedKeys(w, i, v) {
  const ctx = ifaceCtx(w, i, v);
  const base = i.isNew ? ifaceValues({}) : ifaceValues(i.values);
  return IFACE_FIELDS.filter(f => isShown(f, v, ctx) && (f.secret ? v[f.key] !== '' : differs(f, normalize(f, base[f.key]), normalize(f, v[f.key])))).map(f => f.key);
}

// The errors of one field's draft value as [{ index?, text }]: the generic checks of core/fields.js, then the field's own `test`
// on a non-empty value (a secret is tested as typed, not trimmed).
function fieldIssues(f, value, label) {
  const out = f.dynamic || f.secret ? [] : errorsOf(f, value, label);
  const v = f.secret ? value : typeof value === 'string' ? value.trim() : '';
  if (f.test && v) {
    const bad = f.test(v);
    if (bad) out.push({ text: `${label} ${bad}.` });
  }
  return out;
}

// "2 clients" / "1 client".
const clients = n => `${n} client${n === 1 ? '' : 's'}`;

// Errors and warnings for the radios whose settings changed.
function radioProblems(w, draft, errors, warnings) {
  for (const r of w.radios) {
    const d = draft.radios[r.name];
    if (!d) continue;
    const name = r.name;
    const base = { channel: channelOf(r), ...valuesOf(RADIO_FIELDS, r.values) };
    const ctx = radioCtx(r);
    // Whether the draft changes option `k` of a shown field (the channel has no field and is always shown).
    const was = k => base[k] !== d[k] && isShown(RADIO_FIELDS.find(f => f.key === k) ?? {}, d, ctx);
    // Records an error against the control of field `key`.
    const err = (key, text) => errors.push({ key: `${name}:${key}`, text: `${name}: ${text}` });
    // Records a warning prefixed with the radio's name.
    const warn = text => warnings.push(`${name}: ${text}`);

    for (const f of RADIO_FIELDS) {
      if (f.dynamic || !isShown(f, d, ctx) || !was(f.key)) continue;
      for (const e of fieldIssues(f, d[f.key], `${name}: ${f.label}`)) errors.push({ ...e, key: `${name}:${f.key}` });
    }

    // The values the hardware reports: a mode it does not list, a country the driver does not know. When it reported none the
    // value is only checked for its form.
    const modes = r.htmodes.modes;
    if (was('htmode') && d.htmode) {
      const ok = modes.includes(d.htmode) || d.htmode === 'NOHT' || (r.band === '2g' && /^HT40[+-]$/.test(d.htmode) && modes.includes('HT40'));
      if (!modes.length) for (const e of fieldIssues(RADIO_FIELDS.find(f => f.key === 'htmode'), d.htmode, `${name}: Mode and channel width`)) errors.push({ ...e, key: `${name}:htmode` });
      else if (!ok) err('htmode', `this radio does not report support for ${d.htmode}. It supports ${modes.join(', ')}.`);
    }
    if (was('country') && d.country) {
      if (!w.countries.length) for (const e of fieldIssues(RADIO_FIELDS.find(f => f.key === 'country'), d.country, `${name}: Country`)) errors.push({ ...e, key: `${name}:country` });
      else if (!w.countries.some(c => c.code === d.country)) err('country', `the driver does not know the country code ${d.country}.`);
    }

    // The channel must be allowed and fit the width the (new) mode needs.
    const channelChanged = was('channel'), modeChanged = was('htmode');
    if (channelChanged || modeChanged) {
      const res = channelCheck(r, d.channel, d.htmode);
      if (res.error) errors.push({ key: channelChanged ? `${name}:channel` : `${name}:htmode`, also: channelChanged ? undefined : `${name}:channel`, text: res.error });
      else for (const t of res.warnings) if (channelChanged || d.channel !== 'auto') warnings.push(t);
      const mesh = r.interfaces.find(i => i.mode === 'mesh');
      if (mesh) {
        warnings.push(channelChanged
          ? `${name} carries the mesh interface ${mesh.ssid ?? mesh.section}: the other mesh nodes must be moved to the same channel by hand, or they lose this node.`
          : `${name} carries the mesh interface ${mesh.ssid ?? mesh.section}: the other mesh nodes must use the same channel width, or they lose this node.`);
      }
    }
    if (modeChanged && r.band === '2g' && widthOf(d.htmode) >= 40) warn('a 40 MHz channel on 2.4 GHz covers most of the band and collides with every neighbor; 20 MHz is usually faster in a crowded place.');

    if (was('disabled') && d.disabled) {
      const nets = r.interfaces.filter(i => i.enabled && i.mode !== 'mesh');
      const connected = nets.reduce((n, i) => n + (i.clients ?? 0), 0);
      warn(`this radio will be switched off: ${nets.length ? `its ${nets.length} network${nets.length === 1 ? '' : 's'} (${nets.map(i => i.ssid ?? i.section).join(', ')}) stop${nets.length === 1 ? 's' : ''} and ${clients(connected)} lose${connected === 1 ? 's' : ''} the connection` : 'nothing runs on it'}. If you manage the router over Wi-Fi on this radio you lose access, and the router undoes the change by itself 30 seconds after the apply.`);
    }
    if (was('country') && !errors.some(e => e.key === `${name}:country`)) warn('changing the country changes which channels and how much power are allowed. Check the channel and the power after saving; the radio moves if its channel is no longer allowed.');
    if (was('txpower') && d.txpower && /^\d+$/.test(d.txpower)) {
      const channel = /^\d+$/.test(d.channel) ? r.channels?.find(c => c.channel === +d.channel) : null;
      const limits = channel ? [channel.max_power] : (r.channels ?? []).filter(c => !c.disabled).map(c => c.max_power);
      const max = limits.length ? Math.max(...limits.filter(x => x != null)) : null;
      if (max != null && +d.txpower > max) warn(`${d.txpower} dBm is above the regulatory limit of ${max} dBm ${channel ? `on channel ${channel.channel}` : 'in this regulatory domain'}; the radio transmits at most that.`);
    }
    if (was('legacy_rates') && d.legacy_rates) warn('allowing the legacy 802.11b rates lets old devices connect, but every beacon and broadcast then goes out at a very low rate and uses a lot of airtime.');
    if (was('require_mode') && d.require_mode === 'ac') warn('requiring 802.11ac or newer makes some Apple devices unreliable even though they support it, and keeps out every 2.4 GHz and 802.11n-only client.');
  }
}

// The words for features a network change disrupts, for the warning about connected clients.
const DISRUPTIVE = { ssid: 'the name', mesh_id: 'the Mesh ID', network: 'the networks it is attached to', encryption: 'the encryption', key: 'the password', disabled: 'switching it off', ieee80211w: 'protected management frames', sae_pwe: 'the SAE derivation', ocv: 'operating channel validation', hidden: 'hiding the name' };

// What is lost when a network of this mode goes away or restarts with other settings: its connected clients, or the peers of a mesh
// point, in words ("2 clients", "the 3 mesh peers"); `i` is the entry of ifaceList.
function whoLoses(w, i) {
  if (i.mode === 'mesh') {
    const n = (w.mesh ?? []).find(x => x.section === i.section)?.peers?.filter(p => p.plink === 'ESTAB').length;
    return n ? `${n} mesh peer${n === 1 ? '' : 's'}` : 'its mesh peers';
  }
  const n = i.live?.clients;
  return n ? clients(n) : 'the clients';
}

// "client network", "mesh" or "Wi-Fi network", for the sentence about managing the router over the network that changes.
const overWhat = mode => (mode === 'sta' ? 'client network' : mode === 'mesh' ? 'mesh' : 'Wi-Fi network');

// What is weak about an encryption value that `encryptionInfo` calls weak, in words.
function weakness(enc) {
  const info = encryptionInfo(enc);
  if (info.kind === 'wep') return 'WEP can be broken within minutes';
  if (/\+tkip/.test(enc)) return 'TKIP is deprecated and weak';
  return 'WPA version 1 is outdated';
}

// Errors and warnings for the wireless networks that were added or changed, and for the networks that share an SSID.
function ifaceProblems(w, draft, errors, warnings) {
  const touchedIds = new Set();
  const list = ifaceList(w, draft);
  for (const i of list) {
    const v = draft.ifaces[i.id];
    const title = ifaceTitle(i, v);
    // Records an error against the control of field `key`.
    const err = (key, text) => errors.push({ key: `if:${i.id}:${key}`, text: `${title}: ${text}` });
    // Records a warning prefixed with the network's name.
    const warn = text => warnings.push(`${title}: ${text}`);

    if (i.removed) {
      const who = i.mode === 'mesh' || i.live?.clients ? whoLoses(w, i) : null;
      if (!(i.values.disabled === '1')) warn(`this ${i.mode === 'mesh' ? 'mesh point' : 'network'} is removed${who ? `, which disconnects ${who}` : ''}. If you manage the router over this ${overWhat(i.mode)} you lose access, and the router undoes the change by itself 30 seconds after the apply.`);
      continue;
    }

    const keys = changedKeys(w, i, v);
    if (!keys.length && !i.isNew) continue;
    touchedIds.add(i.id);
    const ctx = ifaceCtx(w, i, v);
    const info = ctx.info;
    const radio = ctx.radio;
    const enabled = !v.disabled;
    const mesh = i.mode === 'mesh';

    for (const f of IFACE_FIELDS) {
      if (!isShown(f, v, ctx) || !keys.includes(f.key) || f.key === 'network') continue;
      for (const e of fieldIssues(f, v[f.key], `${title}: ${f.label}`)) errors.push({ ...e, key: `if:${i.id}:${f.key}` });
    }

    if (!radio) err(nameKey(i.mode), `the radio ${i.device} does not exist.`);
    if (enabled) {
      if (mesh) { if (!v.mesh_id.trim()) err('mesh_id', 'enter the Mesh ID, the name every node of the mesh shares.'); }
      else if (!v.ssid.trim()) err('ssid', 'enter the network name (SSID).');
      if (!v.network.length) err('network', mesh ? 'choose a network to attach the mesh to, or it carries no traffic for any network.' : 'choose a network to attach it to, or its clients get no connection.');
      for (const n of v.network) if (!w.networks.includes(n)) warn(`the network "${n}" is not in /etc/config/network.`);
    }
    if (info.needs && w.features[info.needs] === false && (i.isNew || keys.includes('encryption'))) {
      err('encryption', mesh
        ? 'this router\'s wpad was built without WPA3 (SAE) support, so an encrypted mesh is not possible. Install a wpad with mesh support (wpad-mesh-* or the full wpad), or leave the mesh open.'
        : `this router's hostapd was built without ${{ eap: 'WPA-Enterprise', sae: 'WPA3 (SAE)', owe: 'Enhanced Open (OWE)' }[info.needs]} support, so it cannot be used. Install the full wpad package, or choose another encryption.`);
    }
    if (enabled && info.key) {
      const stored = i.secrets.key || (info.sae && i.secrets.sae_password) || i.values.wpa_psk_file;
      if (!v.key && !stored) err('key', 'this encryption needs a password. Enter one.');
    }
    if (enabled && info.kind === 'eap' && i.mode === 'ap') {
      if (!v.auth_server.trim()) err('auth_server', 'enter the RADIUS server that authenticates the clients.');
      if (!v.auth_secret && !i.secrets.auth_secret) err('auth_secret', 'enter the secret shared with the RADIUS server.');
    }
    if (enabled && info.kind === 'eap' && i.mode === 'sta') {
      if (!v.eap_type) err('eap_type', 'choose the EAP method.');
      else if (v.eap_type === 'tls') {
        if (!v.client_cert.trim()) err('client_cert', 'enter the path of the client certificate.');
        if (!v.priv_key.trim()) err('priv_key', 'enter the path of the private key.');
      } else {
        if (!v.identity && !i.secrets.identity) err('identity', 'enter the identity (user name).');
        if (!v.password && !i.secrets.password) err('password', 'enter the EAP password.');
      }
    }
    if (!mesh && v.ieee80211w === '0' && (info.pmf || info.sae) && (i.isNew || keys.includes('ieee80211w') || keys.includes('encryption'))) {
      err('ieee80211w', 'WPA3 and Enhanced Open need protected management frames, so they cannot be disabled. Choose optional or required, or leave the default.');
    }
    if (enabled && v.macfilter === 'allow' && !v.maclist.some(x => x.trim()) && keys.some(k => k === 'macfilter' || k === 'maclist')) {
      warn('the filter only allows the listed devices and the list is empty, so no client can connect.');
    }
    if (v.ieee80211r && info.sae && v.pmk_r1_push && (i.isNew || keys.includes('pmk_r1_push') || keys.includes('ieee80211r') || keys.includes('encryption'))) warn('PMK-R1 push breaks fast transition (802.11r) with WPA3 (SAE).');
    if (v.ieee80211r && info.sae && v.ft_psk_generate_local === '1') warn('generating the PSK keys locally breaks fast transition (802.11r) with WPA3 and WPA2/WPA3 mixed mode.');

    // The dangerous settings: open and weak protection, and changes that cut off the clients connected now.
    if (enabled && info.kind === 'none') {
      warn(i.mode === 'sta'
        ? 'this client network is open: everything the router sends over it is unencrypted.'
        : mesh
          ? `this mesh is open: any device in range that uses the Mesh ID "${v.mesh_id.trim()}" and the same channel joins it and reaches ${v.network.length ? v.network.join(', ') : 'the network'}. Use SAE with a password.`
          : `this network is open: anyone in range can join it and reach ${v.network.length ? v.network.join(', ') : 'the network'}. Use WPA2 or WPA3 with a password, or Enhanced Open (OWE) if no password is wanted.`);
    }
    if (enabled && info.weak && (i.isNew || keys.includes('encryption'))) warn(`${weakness(v.encryption)}. Use WPA2 or WPA3.`);
    if (keys.includes('hidden') && v.hidden) warn('a hidden SSID is not a protection, and clients may fail to roam and waste airtime asking for it.');
    if (i.mode === 'sta' && enabled && i.isNew) warn('a client network makes this router join that network as a client; it needs the network\'s password and a signal strong enough to reach it.');
    if (radio && i.mode === 'sta' && enabled && keys.length && list.some(o => o.id !== i.id && !o.removed && o.device === i.device && o.mode === 'ap' && !draft.ifaces[o.id].disabled)) {
      warn('an access point and a client network on the same radio share its channel: the access point moves to the channel of the network that the client joins.');
    }
    // A mesh does not take part in spanning tree (the OpenWrt 802.11s page): frames enter the mesh after the bridge's STP, so a second path between the same nodes loops.
    if (mesh && enabled && (i.isNew || keys.some(k => k === 'network' || k === 'disabled'))) {
      const twin = list.find(o => o.id !== i.id && o.mode === 'mesh' && !o.removed && !draft.ifaces[o.id].disabled && draft.ifaces[o.id].network.some(n => v.network.includes(n)));
      warn(twin
        ? `it shares a network with the mesh point on ${twin.device}. Two mesh backhauls (2.4 and 5 GHz) on one bridge form a layer 2 loop: spanning tree does not see the mesh. Attach them to different networks, or use mesh11sd or an nftables rule that drops the looping frames.`
        : 'spanning tree has no effect on a mesh, so a cable between mesh nodes that is also in the same bridge forms a layer 2 loop. Keep a mesh node off the wired backhaul, or use mesh11sd or an nftables rule that drops the looping frames.');
    }
    if (!i.isNew && !ifaceValues(i.values).disabled) {
      const hit = keys.filter(k => DISRUPTIVE[k] && !(k === 'disabled' && !v.disabled) && !(k === 'hidden' && !v.hidden));
      if (hit.length) {
        warn(`this change (${hit.map(k => DISRUPTIVE[k]).join(', ')}) disconnects ${whoLoses(w, i)} connected now, and ${mesh ? 'the other nodes must use the same settings to rejoin' : `they must reconnect${hit.includes('key') ? ' with the new password' : ''}`}. If you manage the router over this ${overWhat(i.mode)} you lose access, and the router undoes the change by itself 30 seconds after the apply.`);
      }
    }
  }

  // Networks of one radio that broadcast the same SSID cannot be told apart by clients.
  const groups = new Map();
  for (const i of list) {
    const v = draft.ifaces[i.id];
    if (i.removed || i.mode !== 'ap' || v.disabled || !v.ssid.trim()) continue;
    const key = `${i.device}\n${v.ssid.trim()}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  for (const members of groups.values()) {
    if (members.length > 1 && members.some(i => touchedIds.has(i.id))) {
      warnings.push(`${members[0].device}: ${members.map(i => (i.isNew ? 'a new network' : i.name)).join(' and ')} broadcast the same SSID "${draft.ifaces[members[0].id].ssid.trim()}" on the same radio. Clients cannot tell them apart and may join the wrong one. Give them different names.`);
    }
  }
}

// The errors that block Save (keyed by the control they belong to, the key `${radio}:${option}` for a radio and
// `if:${id}:${option}` for a network) and the warnings that do not: { errors: [{ key, also?, index?, text }], warnings: [text] }.
// Only what the draft changes is checked, so a configuration that is already odd does not block an unrelated edit.
export function problems(w, draft) {
  const errors = [], warnings = [];
  radioProblems(w, draft, errors, warnings);
  ifaceProblems(w, draft, errors, warnings);
  return { errors, warnings };
}

//#endregion

//#region Writing

// The changed options of one section as { set, del }: shown fields only, a secret only when typed (as typed), an emptied option
// deleted, a boolean as '1' or '0', a list as a list (or a plain option when it holds one value and is `single`), and no
// encryption as 'none' so the option stays explicit.
function sectionChange(fields, from, to, ctx) {
  const set = {}, del = [];
  for (const f of fields) {
    if (!isShown(f, to, ctx)) continue;
    if (f.secret) {
      if (to[f.key] !== '') set[f.key] = to[f.key];
      continue;
    }
    const a = normalize(f, from[f.key]), b = normalize(f, to[f.key]);
    if (!differs(f, a, b)) continue;
    if (f.type === 'bool') set[f.key] = flag(b);
    else if (f.type === 'list') {
      if (b.length === 0) del.push(f.key);
      else set[f.key] = f.single && b.length === 1 ? b[0] : b;
    } else if (f.key === 'encryption' && b === '') set[f.key] = 'none';
    else if (b === '') del.push(f.key);
    else set[f.key] = b;
  }
  return { set, del };
}

// The UCI operations that turn the router's config into the draft, as data (see core/ops.js). Only what changed is written; an
// emptied option is deleted rather than set to ''; options the page does not know are left alone, and so is a secret that was
// not retyped. A new network is an `add` of a named wifi-iface section; a removed one a `delete`.
export function plan(w, draft) {
  const ops = [];
  // Queues the set and delete operations of one existing section; a delete is only queued for an option that exists.
  const emit = (section, { set, del }, raw, secrets) => {
    if (Object.keys(set).length) ops.push({ op: 'set', config: CONFIG, section, values: set });
    const existing = del.filter(o => raw[o] !== undefined || secrets[o]);
    if (existing.length) ops.push({ op: 'delete', config: CONFIG, section, options: existing });
  };

  for (const r of w.radios) {
    const d = draft.radios[r.name];
    if (!d) continue;
    const change = sectionChange(RADIO_FIELDS, valuesOf(RADIO_FIELDS, r.values), d, radioCtx(r));
    if (d.channel !== channelOf(r)) change.set.channel = d.channel;
    emit(r.name, change, r.values, {});
  }

  for (const i of ifaceList(w, draft)) {
    const v = draft.ifaces[i.id];
    if (i.removed) { ops.push({ op: 'delete', config: CONFIG, section: i.section }); continue; }
    const ctx = ifaceCtx(w, i, v);
    if (i.isNew) {
      ops.push({ op: 'add', config: CONFIG, type: 'wifi-iface', name: i.name, values: { device: i.device, mode: i.mode, ...sectionChange(IFACE_FIELDS, ifaceValues({}), v, ctx).set } });
      continue;
    }
    const change = sectionChange(IFACE_FIELDS, ifaceValues(i.values), v, ctx);
    // A password that no longer applies (open, OWE or enterprise) is removed from the file with the old encryption.
    if (i.secrets.key && !ctx.info.key && changedKeys(w, i, v).includes('encryption')) change.del.push('key');
    emit(i.section, change, i.values, i.secrets);
  }
  return ops;
}

//#endregion

//#region After a save

// The wireless networks the router should hold after the draft is saved, in file order: the ones that stay (with their draft, or
// null for one this page does not edit, such as a mesh interface), then the new ones. The config is read back by position
// because an anonymous section gets a new generated name whenever its options change.
function expectedIfaces(w, draft) {
  return [
    ...w.ifaces.filter(i => !draft.removed[i.section]).map(i => ({ i: { ...i, isNew: false }, d: i.editable ? draft.ifaces[i.section] : null })),
    ...draft.added.map(a => ({ i: { section: a.name, name: a.name, device: a.device, mode: a.mode, editable: true, isNew: true, values: {}, secrets: {} }, d: draft.ifaces[a.id] })),
  ];
}

// Records in `left` every shown field whose stored value `got` (form values) differs from the draft `want`, as "label: field".
function compareFields(fields, got, want, ctx, label, secrets, left) {
  for (const f of fields) {
    if (!isShown(f, want, ctx)) continue;
    if (f.secret) {
      if (want[f.key] !== '' && !secrets[f.key]) left.push(`${label}: ${f.label}`);
      continue;
    }
    if (differs(f, normalize(f, got[f.key]), normalize(f, want[f.key]))) left.push(`${label}: ${f.label}`);
  }
}

// Throws unless the config `after` (the reply of `flab.radio config` once the change is applied) holds what the draft asked for:
// every radio's channel and options, and the wireless networks (added ones present, removed ones gone, each option as drafted, a
// typed secret now stored). `w` is the data the draft was made from.
export function checkApplied(w, draft, after) {
  const left = [];
  for (const r of w.radios) {
    const d = draft.radios[r.name];
    const a = after.radios?.find(x => x.section === r.name);
    if (!d) continue;
    if (!a) { left.push(`Radio ${r.name}`); continue; }
    if (String(a.values.channel ?? 'auto') !== d.channel) left.push(`${r.name}: channel`);
    compareFields(RADIO_FIELDS, valuesOf(RADIO_FIELDS, a.values), d, radioCtx(r), r.name, a.secrets, left);
  }

  const expected = expectedIfaces(w, draft), got = after.interfaces ?? [];
  if (got.length !== expected.length) left.push(`The list of wireless networks (${expected.length} expected, ${got.length} found)`);
  else {
    expected.forEach(({ i, d }, k) => {
      const a = got[k];
      const title = d ? ifaceTitle(i, d) : i.section;
      if (asList(a.values.device)[0] !== i.device || (a.values.mode ?? 'ap') !== i.mode) left.push(`${title}: radio or mode`);
      else if (d) compareFields(IFACE_FIELDS, ifaceValues(a.values), d, ifaceCtx(w, i, d), title, a.secrets, left);
    });
  }
  if (left.length) throw new Error(`${left.slice(0, 4).join(', ')}${left.length > 4 ? ` and ${left.length - 4} more` : ''} ${left.length > 1 ? 'were' : 'was'} not saved`);
}

// What to wait for once the change is applied: the radios that must come up again, as [{ radio, sections }], where `sections` are
// the names (in the config read back, `after`) of the new or changed networks on it that must be running. A radio that was
// not touched, that the draft switches off, or that has no enabled network is not waited for.
export function upTargets(w, draft, after) {
  const expected = expectedIfaces(w, draft);
  const out = [];
  for (const r of w.radios) {
    const d = draft.radios[r.name];
    if (!d || d.disabled) continue;
    const mine = expected.map((e, k) => ({ ...e, k })).filter(e => e.i.device === r.name);
    const enabled = e => (e.d ? !e.d.disabled : e.i.values.disabled !== '1');
    if (!mine.some(enabled)) continue;
    const base = { channel: channelOf(r), ...valuesOf(RADIO_FIELDS, r.values) };
    const radioChanged = d.channel !== base.channel || RADIO_FIELDS.some(f => isShown(f, d, radioCtx(r)) && differs(f, base[f.key], d[f.key]));
    const changedNets = mine.filter(e => enabled(e) && e.d && (e.i.isNew || changedKeys(w, e.i, e.d).length));
    const removed = w.ifaces.some(i => i.device === r.name && draft.removed[i.section]);
    if (!radioChanged && !changedNets.length && !removed) continue;
    out.push({ radio: r.name, sections: changedNets.map(e => after.interfaces?.[e.k]?.section).filter(Boolean) });
  }
  return out;
}

//#endregion

// Whether the encryption drop-down offers `value` to this router: its hostapd was not found to lack the feature it needs.
export const encryptionOffered = (w, value) => {
  const needs = ENCRYPTIONS.find(e => e.value === value)?.needs;
  return !needs || w.features[needs] !== false;
};
