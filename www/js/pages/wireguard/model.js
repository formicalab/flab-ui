// Pure model of the WireGuard page: the data the plugin reports, the form's draft, the review list, validation, the UCI operations a
// save makes, the check after a save, and the helpers of the "add a device" flow (the next free tunnel address, the configuration
// text for the device) and of the warnings about changes that may cut the tunnel the administrator is working through. No DOM and no
// network, so it is unit-tested on its own (tests/wgedit/model.test.mjs).
//
// The config is edited through rpcd's `uci` object, but it is read through the flab.wireguard plugin, which leaves out the keys:
// the private and pre-shared keys are never in the data, only whether they are set (`secrets`). A key field of the draft is
// therefore empty until the user types or generates a value; empty means "keep what is stored".
import { differs, errorsOf, flag, normalize, show, uciBool, valueOf } from '../../core/fields.js';
import { parseAddress } from '../../core/ip.js';
import { addressText, endpointProblems, holds, isHostname, networkText, nextFreeHost, overlaps, parseCidr } from './addr.js';
import { isKey } from './keys.js';
import { CONFIG, IFACE_FIELDS, PEER_FIELDS, peerType } from './schema.js';

export { CONFIG };

// The UDP port a new interface starts with (the first free one from here up).
const DEFAULT_PORT = 51820;

//#region Reading

// The reply of `flab.wireguard status` as the page's data, with every part present (a plugin from before the page edited the
// configuration has no values, no names and no sessions).
export function readWireguard(s) {
  return {
    generated: s?.generated ?? 0,
    protoInstalled: s?.proto_installed !== false,
    names: s?.names ?? [],
    sessions: s?.sessions ?? [],
    interfaces: (s?.interfaces ?? []).map(i => ({
      ...i, values: i.values ?? {}, secrets: i.secrets ?? {},
      peers: (i.peers ?? []).map(p => ({ ...p, values: p.values ?? {}, secrets: p.secrets ?? {}, section: p.section ?? null })),
    })),
  };
}

// A key shortened for display: "abcdefgh…xyz12=".
export const shortKey = k => (k ? `${k.slice(0, 8)}…${k.slice(-5)}` : '');

//#endregion

//#region The form

// The form values of a list of fields from a section's raw options: a boolean, a list, or a string ('' = not set).
const valuesOf = (fields, raw) => Object.fromEntries(fields.map(f => [f.key, valueOf(f, raw[f.key])]));

// The form's starting values: the router's current values for every interface of the configuration and its configured peers. A
// new interface or peer gets an id of its own (`new1`, `p1`, ...) because its name or key is typed into the form.
export const draftFrom = data => ({
  interfaces: Object.fromEntries(data.interfaces.filter(i => i.configured).map(i => [i.name, {
    values: valuesOf(IFACE_FIELDS, i.values),
    peers: Object.fromEntries(i.peers.filter(p => p.section).map(p => [p.section, valuesOf(PEER_FIELDS, p.values)])),
    added: [],
    removed: {},
  }])),
  added: [],
  removed: {},
  next: 1,
});

// The interfaces the form shows, in order: the router's (including the ones only the kernel has, which cannot be edited), then the
// ones added in the form. Each has an `id` (the interface name, or `new1`...), its `name`, the plugin's `data` (null for a new one),
// `isNew`, `editable` and `removed`.
export function ifaceList(data, draft) {
  return [
    ...data.interfaces.map(i => ({ id: i.name, name: i.name, data: i, isNew: false, editable: i.configured, removed: Boolean(draft.removed[i.name]) })),
    ...draft.added.map(a => ({ id: a.id, name: a.name, data: null, isNew: true, editable: true, removed: false })),
  ];
}

// The peers of one interface of ifaceList(), in order: the ones the plugin reports (`p` is the live view; a peer only the kernel has
// is not editable), then the ones added in the form (`p` is null). `id` is the section name of a configured peer, `p1`... of a new one.
export function peerList(item, draft) {
  const d = draft.interfaces[item.id];
  return [
    ...(item.data?.peers ?? []).map(p => ({ id: p.section, p, isNew: false, editable: Boolean(p.section && d), removed: Boolean(p.section && d?.removed[p.section]) })),
    ...(d?.added ?? []).map(id => ({ id, p: null, isNew: true, editable: true, removed: false })),
  ];
}

// The name of a peer for messages: its description, else its shortened public key.
export const peerLabel = (values, key) => values.description.trim() || shortKey(values.public_key.trim() || key) || 'unnamed peer';

// The names a new interface may not take: every named section of the network config, the interfaces the kernel has, the names of the
// other interfaces added in the form.
function takenNames(data, draft, exceptId) {
  return new Set(['lo', ...data.names, ...data.interfaces.map(i => i.name), ...draft.added.filter(a => a.id !== exceptId).map(a => a.name.trim())]);
}

// The error for a new interface's name, or null. The name is the UCI section name and the kernel's device name.
export function nameError(data, draft, id) {
  const name = draft.added.find(a => a.id === id)?.name.trim() ?? '';
  if (!name) return 'Give the interface a name.';
  if (!/^[A-Za-z0-9_]+$/.test(name)) return 'The name may only contain letters, digits and underscores (a section name of the network config has no dash or dot).';
  if (name.length > 15) return 'The name may be at most 15 characters (the kernel\'s limit for an interface name).';
  if (takenNames(data, draft, id).has(name)) return `There is already an interface or section called "${name}".`;
  return null;
}

// The listen ports in use by the interfaces of the data that are not in the form's hands: the kernel's own (not configured) ones.
const kernelPorts = data => new Map(data.interfaces.filter(i => !i.configured && i.listen_port != null).map(i => [String(i.listen_port), i.name]));

// Adds an interface to the draft and returns its id. It starts with the first name wgN that is free, the first listen port from 51820
// that no interface uses, and one empty address row; the page generates its private key.
export function addInterface(data, draft) {
  const id = `new${draft.next++}`;
  const taken = takenNames(data, draft, null);
  let name = 'wg0';
  for (let n = 1; taken.has(name); n++) name = `wg${n}`;
  const ports = new Set([...kernelPorts(data).keys(), ...Object.values(draft.interfaces).map(d => d.values.listen_port.trim())]);
  let port = DEFAULT_PORT;
  while (ports.has(String(port))) port++;
  draft.added.push({ id, name });
  draft.interfaces[id] = { values: { ...valuesOf(IFACE_FIELDS, {}), listen_port: String(port), addresses: [''] }, peers: {}, added: [], removed: {} };
  return id;
}

// Marks an interface for removal (with its peers), or drops it when it was only added in the form.
export function removeInterface(draft, id) {
  const i = draft.added.findIndex(a => a.id === id);
  if (i < 0) { draft.removed[id] = true; return; }
  draft.added.splice(i, 1);
  delete draft.interfaces[id];
}

// Takes an interface back from removal.
export function restoreInterface(draft, id) {
  delete draft.removed[id];
}

// Adds a peer to an interface of the draft and returns its id. `values` overrides the starting values (the add-a-device flow).
export function addPeer(draft, ifId, values = {}) {
  const id = `p${draft.next++}`;
  const d = draft.interfaces[ifId];
  d.added.push(id);
  d.peers[id] = { ...valuesOf(PEER_FIELDS, {}), ...values };
  return id;
}

// Marks a peer for removal, or drops it when it was only added in the form.
export function removePeer(draft, ifId, id) {
  const d = draft.interfaces[ifId];
  const i = d.added.indexOf(id);
  if (i < 0) { d.removed[id] = true; return; }
  d.added.splice(i, 1);
  delete d.peers[id];
}

// Takes a peer back from removal.
export function restorePeer(draft, ifId, id) {
  delete draft.interfaces[ifId].removed[id];
}

//#endregion

//#region Dangerous changes

// The administration connections that come through a tunnel: [{ iface, peer, remote, port }]. A connection to the router's web
// interface or SSH port whose remote address is inside an enabled peer's allowed IPs (the most specific one; a /0 does not count, it
// would match every address) of a running interface is most probably the administrator's own, so that interface and peer carry the
// session this page is working in.
export function adminLinks(data) {
  const out = [];
  for (const s of data.sessions) {
    const remote = parseAddress(s.remote);
    if (!remote) continue;
    let best = null;
    for (const i of data.interfaces.filter(x => x.up)) {
      for (const p of i.peers.filter(x => x.enabled)) {
        for (const a of p.allowed_ips) {
          const c = parseCidr(a, { bare: true });
          if (c && c.prefix > 0 && holds(c, remote) && (!best || c.prefix > best.prefix)) best = { iface: i.name, peer: p, prefix: c.prefix, remote: s.remote, port: s.port };
        }
      }
    }
    if (best) out.push(best);
  }
  return out;
}

// The sentence that says who is probably connected through an interface, or through one of its peers when `peer` is given.
export function adminSentence(links, ifName, peer = null) {
  const mine = links.filter(l => l.iface === ifName && (!peer || l.peer === peer));
  if (!mine.length) return null;
  const from = [...new Set(mine.map(l => l.remote))].join(', ');
  return `This looks like your own connection: the router's web interface or SSH is in use from ${from}, an address of ${peer ? 'this peer' : `peer ${[...new Set(mine.map(l => l.peer.name ?? shortKey(l.peer.public_key)))].join(', ')}`} on ${ifName}.`;
}

//#endregion

//#region Review

// A short description of an interface's settings for the review list.
const ifaceLine = v => [`UDP ${v.listen_port.trim() || 'random port'}`, v.addresses.map(a => a.trim()).filter(Boolean).join(', ')].filter(Boolean).join(' · ');
// A short description of a peer for the review list.
const peerLine = v => [peerLabel(v, ''), v.allowed_ips.map(a => a.trim()).filter(Boolean).join(', ')].filter(Boolean).join(' · ');

// Records one review entry for every field whose draft value differs from the router's value. A key is never shown: the list says
// only that it is set or will be replaced.
function diffFields(out, fields, raw, values, key, label, secrets) {
  for (const f of fields) {
    if (f.secret) {
      if (normalize(f, values[f.key]) !== '') out.push({ key: `${key}:${f.key}`, label: `${label}: ${f.label}`, from: secrets[f.key] ? 'set (hidden)' : 'not set', to: 'new value (hidden)' });
      continue;
    }
    const from = normalize(f, valueOf(f, raw[f.key]));
    const to = normalize(f, values[f.key]);
    if (differs(f, from, to)) out.push({ key: `${key}:${f.key}`, label: `${label}: ${f.label}`, from: show(f, from), to: show(f, to) });
  }
}

// The differences between the router's values and the draft for the review list: [{ key, label, from, to }].
export function changesOf(data, draft) {
  const out = [];
  for (const item of ifaceList(data, draft)) {
    if (!item.editable) continue;
    const d = draft.interfaces[item.id];
    if (item.isNew) out.push({ key: `if:${item.id}`, label: `New interface ${item.name.trim() || '(unnamed)'}`, from: 'none', to: ifaceLine(d.values) });
    else if (item.removed) {
      const n = item.data.peers.filter(p => p.section).length;
      out.push({ key: `if:${item.id}`, label: `Remove interface ${item.name}`, from: `${ifaceLine(valuesOf(IFACE_FIELDS, item.data.values))}, ${n} peer${n === 1 ? '' : 's'}`, to: 'removed' });
      continue;
    } else diffFields(out, IFACE_FIELDS, item.data.values, d.values, `if:${item.id}`, item.name, item.data.secrets);
    for (const pe of peerList(item, draft).filter(x => x.editable)) {
      const v = d.peers[pe.id];
      const who = `${item.name} peer ${peerLabel(v, pe.p?.public_key ?? '')}`;
      if (pe.isNew) out.push({ key: `peer:${item.id}:${pe.id}`, label: `New peer on ${item.name} (${peerLabel(v, '')})`, from: 'none', to: peerLine(v) });
      else if (pe.removed) out.push({ key: `peer:${item.id}:${pe.id}`, label: `Remove peer ${peerLabel(valuesOf(PEER_FIELDS, pe.p.values), pe.p.public_key)} from ${item.name}`, from: peerLine(valuesOf(PEER_FIELDS, pe.p.values)), to: 'removed' });
      else diffFields(out, PEER_FIELDS, pe.p.values, v, `peer:${item.id}:${pe.id}`, who, pe.p.secrets);
    }
  }
  return out;
}

// Whether the draft differs from the router in any way.
export const isDirty = (data, draft) => changesOf(data, draft).length > 0;

//#endregion

//#region Validation

// A number of whole seconds or a port in range, as errorsOf() reports it; a plain wrapper that names the control.
const fieldErrors = (fields, values, keyPrefix, titlePrefix) => fields
  .filter(f => !f.secret)
  .flatMap(f => errorsOf(f, values[f.key], `${titlePrefix}: ${f.label}`).map(e => ({ ...e, key: `${keyPrefix}:${f.key}` })));

// Whether a firewall mark is a decimal or hexadecimal number.
const validMark = v => /^(0x[0-9A-Fa-f]{1,8}|\d{1,10})$/.test(v);

// The CIDRs of a draft list, parsed (the entries that do not parse are left out; validation reports them).
const parsedList = (list, opts) => list.map(a => parseCidr(a, opts)).filter(Boolean);

// What the interface keeps stored or typed as a private key: true when a key will be there after the save.
const hasPrivateKey = (item, d) => normalize({ type: 'string' }, d.values.private_key) !== '' || Boolean(item.data?.secrets.private_key);

// The errors and warnings of the draft: { errors: [{ key, text, index?, also? }], warnings: [text] }. `key` names the control that
// holds the mistake (the same name the page registers it under), so the page can mark it and open what hides it.
export function problems(data, draft) {
  const errors = [], warnings = [];
  const links = adminLinks(data);
  const items = ifaceList(data, draft).filter(i => i.editable);
  const active = items.filter(i => !i.removed);
  const kernel = kernelPorts(data);
  const ports = new Map();

  for (const item of items) {
    const d = draft.interfaces[item.id];
    const base = item.data;
    const title = item.name.trim() || 'New interface';

    // Removing or disabling an interface that carries sessions.
    if (item.removed) {
      const you = adminSentence(links, item.name);
      const connected = base.peers.filter(p => p.state === 'connected').length;
      if (you) warnings.push(`Removing ${item.name} cuts your own connection. ${you} If this page cannot reach the router afterwards, the router puts the old settings back by itself within 30 seconds.`);
      else if (base.up && connected) warnings.push(`Removing ${item.name} disconnects its ${connected} connected peer${connected === 1 ? '' : 's'}. If you are working through this tunnel from somewhere else, you lose access.`);
      if (base.zone) warnings.push(`${item.name} is listed in the firewall zone ${base.zone}; after removing the interface the zone still names it. Edit the zone on the Firewall page.`);
      continue;
    }

    // Records an error against the control `key` of this interface.
    const err = (key, text, extra = {}) => errors.push({ key: `if:${item.id}:${key}`, text: `${title}: ${text}`, ...extra });
    if (item.isNew) {
      const bad = nameError(data, draft, item.id);
      if (bad) errors.push({ key: `if:${item.id}:name`, text: `${title}: ${bad}` });
    }
    errors.push(...fieldErrors(IFACE_FIELDS, d.values, `if:${item.id}`, title));
    d.values.addresses.forEach((raw, index) => {
      const a = raw.trim();
      if (a && !parseCidr(a, { bare: true, mask: true })) err('addresses', `"${a}" is not an address with a prefix length such as 10.8.0.1/24 or fd00:8::1/64.`, { index });
    });
    const mark = d.values.fwmark.trim();
    if (mark && !validMark(mark)) err('fwmark', `the firewall mark "${mark}" must be a number, decimal or hexadecimal (0x51820).`);
    const typedKey = d.values.private_key.trim();
    if (typedKey && !isKey(typedKey)) err('private_key', 'the private key must be a WireGuard key: 44 characters of base64 ending in "=". Generate one, or paste the output of wg genkey.');
    if (typedKey && !item.isNew && item.data.secrets.private_key) {
      const you = adminSentence(links, item.name);
      warnings.push(`${title}: a new private key means a new public key, so every peer stops working until it has been given the new one.${you ? ` ${you} Your connection through it would break.` : ''}`);
    }
    if (!d.values.disabled && !hasPrivateKey(item, d)) {
      if (item.isNew) err('private_key', 'an interface needs a private key. Generate one or paste one.');
      else warnings.push(`${title} has no private key, so it cannot start. Generate one.`);
    }

    // Listen port: one interface per UDP port.
    const port = d.values.listen_port.trim();
    if (port && !d.values.disabled) {
      if (ports.has(port)) errors.push({ key: `if:${item.id}:listen_port`, also: `if:${ports.get(port).id}:listen_port`, text: `${title}: UDP port ${port} is also the listen port of ${ports.get(port).title}; each interface needs its own port.` });
      else ports.set(port, { id: item.id, title });
      if (kernel.has(port)) err('listen_port', `UDP port ${port} is in use by ${kernel.get(port)}, an interface that is not in the configuration.`);
    }

    // Addresses, MTU and the like.
    const addresses = d.values.addresses.map(a => a.trim()).filter(Boolean);
    const nets = parsedList(addresses, { bare: true, mask: true });
    if (!addresses.length) warnings.push(`${title} has no address, so the router has no address of its own in the tunnel and routes nothing into it.`);
    for (const a of addresses) {
      const c = parseCidr(a, { bare: true, mask: true });
      if (c && !a.includes('/')) warnings.push(`${title}: the address ${a} has no prefix length, so it is a single host (/${c.bits}) and the rest of the tunnel network is not reachable. Write it as ${a}/${c.family === 4 ? 24 : 64}, for example.`);
    }
    for (const other of active.slice(0, active.indexOf(item))) {
      const od = draft.interfaces[other.id];
      if (od.values.disabled) continue;
      const clash = parsedList(od.values.addresses, { bare: true, mask: true }).find(oc => oc.prefix < oc.bits && nets.some(n => n.prefix < n.bits && overlaps(n, oc)));
      if (clash) warnings.push(`${title}: its address range overlaps the one of ${other.name.trim() || 'another new interface'} (${networkText(clash)}), so the router cannot tell the two tunnels apart.`);
    }
    const mtu = Number(d.values.mtu.trim());
    if (d.values.mtu.trim() && mtu >= 68) {
      if (mtu < 1280 && nets.some(n => n.family === 6)) warnings.push(`${title}: an MTU below 1280 is too small for IPv6; IPv6 needs at least 1280.`);
      if (mtu > 1420) warnings.push(`${title}: an MTU above 1420 may fragment packets when the tunnel runs over IPv6 or PPPoE.`);
    }

    // Peers.
    const peers = peerList(item, draft).filter(p => p.editable);
    const live = peers.filter(p => !p.removed && !d.peers[p.id].disabled);
    const keys = new Map();
    const claims = [];
    if (!d.values.listen_port.trim() && live.some(p => !d.peers[p.id].endpoint_host.trim())) warnings.push(`${title}: without a listen port WireGuard picks a random one every time it starts, so peers that connect to this router cannot know where to send, and a firewall rule cannot allow it.`);
    for (const pe of peers) {
      const v = d.peers[pe.id];
      const label = peerLabel(v, pe.p?.public_key ?? '');
      const ptitle = `${title} peer ${label}`;
      const key = `peer:${item.id}:${pe.id}`;
      // Records an error against the control `field` of this peer.
      const perr = (field, text, extra = {}) => errors.push({ key: `${key}:${field}`, text: `${ptitle}: ${text}`, ...extra });
      // Records a warning about this peer.
      const pwarn = text => warnings.push(`${ptitle}: ${text}`);

      if (pe.removed) {
        if (pe.p.state === 'connected') {
          const you = adminSentence(links, item.name, pe.p);
          if (you) warnings.push(`Removing peer ${label} from ${item.name} cuts your own connection. ${you} If this page cannot reach the router afterwards, the router puts the old settings back by itself within 30 seconds.`);
          else warnings.push(`Peer ${label} is connected right now; removing it from ${item.name} disconnects it.`);
        }
        continue;
      }
      errors.push(...fieldErrors(PEER_FIELDS, v, key, ptitle));
      const pub = v.public_key.trim();
      if (!pub) perr('public_key', 'enter the peer\'s public key.');
      else if (!isKey(pub)) perr('public_key', 'the public key must be 44 characters of base64 ending in "=".');
      else if (item.data?.public_key === pub) perr('public_key', 'this is the public key of the interface itself, not of a peer.');
      else if (keys.has(pub)) perr('public_key', 'another peer of this interface has the same public key.', { also: `${keys.get(pub)}:public_key` });
      else keys.set(pub, key);
      const psk = v.preshared_key.trim();
      if (psk && !isKey(psk)) perr('preshared_key', 'the pre-shared key must be 44 characters of base64 ending in "=". Generate one, or paste the output of wg genpsk.');
      if (pe.p?.state === 'connected' && v.disabled && !uciBool(pe.p.values.disabled, false)) {
        const you = adminSentence(links, item.name, pe.p);
        warnings.push(you ? `Disabling peer ${label} on ${item.name} cuts your own connection. ${you}` : `Peer ${label} is connected right now; disabling it disconnects it.`);
      }

      // Endpoint.
      const host = v.endpoint_host.trim();
      if (host.startsWith('[')) perr('endpoint_host', 'write an IPv6 address without square brackets.');
      else if (host && !parseAddress(host) && !isHostname(host)) perr('endpoint_host', `"${host}" is not a host name or an IP address.`);
      else for (const why of endpointProblems(host, nets.filter(n => n.prefix < n.bits))) pwarn(`the endpoint ${host} ${why}.`);
      if (!host && v.endpoint_port.trim()) pwarn('an endpoint port is set but no endpoint host, so the port is not used.');

      // Allowed IPs.
      const allowed = v.allowed_ips.map(a => a.trim());
      allowed.forEach((a, index) => { if (a && !parseCidr(a)) perr('allowed_ips', `"${a}" is not an address with a prefix length such as 10.8.0.2/32 or fd00:8::2/128.`, { index }); });
      const cidrs = parsedList(allowed.filter(Boolean));
      if (!cidrs.length) pwarn('no allowed IPs, so nothing is accepted from this peer and nothing is sent to it.');
      const zero = cidrs.filter(c => c.prefix === 0);
      if (zero.length) {
        if (v.route_allowed_ips) pwarn(`${zero.map(c => c.text).join(' and ')} makes this peer the default route of the router: all the traffic that no other route claims goes through this tunnel.`);
        else pwarn(`${zero.map(c => c.text).join(' and ')} lets this peer carry any address, but no route is created for it ("Create routes for the allowed IPs" is off), so nothing is sent through it unless you add routes yourself.`);
      }
      const nets2 = cidrs.filter(c => c.prefix > 0 && c.prefix < c.bits);
      if (nets2.length && !v.route_allowed_ips) pwarn(`it may carry ${nets2.map(c => c.text).join(', ')} but no routes are created for these networks ("Create routes for the allowed IPs" is off).`);
      if (!d.values.disabled) claims.push(...cidrs.map(c => ({ c, label, id: pe.id, disabled: v.disabled })));
    }

    // The same address (or a network that holds another) allowed for two peers.
    const seen = new Set();
    for (let a = 0; a < claims.length; a++) {
      for (let b = a + 1; b < claims.length; b++) {
        const x = claims[a], y = claims[b];
        if (x.id === y.id || x.disabled || y.disabled || !overlaps(x.c, y.c)) continue;
        const pair = `${x.id}|${y.id}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        const same = x.c.first === y.c.first && x.c.last === y.c.last;
        warnings.push(`${title}: the peers ${x.label} and ${y.label} overlap (${x.c.text} and ${y.c.text}). ${same ? 'An address can belong to one peer only: WireGuard gives it to the one configured last.' : 'WireGuard sends a packet to the peer with the most specific match, so the broader one only gets what the other does not.'}`);
      }
    }

    // Changes to a tunnel that carries your own session.
    if (!item.isNew && changesOf(data, draft).some(c => c.key.startsWith(`if:${item.id}`) || c.key.startsWith(`peer:${item.id}:`))) {
      const you = adminSentence(links, item.name);
      if (you) warnings.push(`Applying a change to ${item.name} restarts the tunnel, which briefly interrupts everything that goes through it, including your own connection. ${you}`);
    }
    if (item.isNew) warnings.push(`${title} is in no firewall zone yet, so its peers cannot reach the router or the other networks. Put it in a zone on the Firewall page after saving.`);
    // Disabling a running interface.
    if (!item.isNew && d.values.disabled && !uciBool(base.values.disabled, false) && base.up) {
      const you = adminSentence(links, item.name);
      const connected = base.peers.filter(p => p.state === 'connected').length;
      if (you) warnings.push(`Disabling ${item.name} cuts your own connection. ${you} If this page cannot reach the router afterwards, the router puts the old settings back by itself within 30 seconds.`);
      else if (connected) warnings.push(`Disabling ${item.name} disconnects its ${connected} connected peer${connected === 1 ? '' : 's'}.`);
    }
  }
  return { errors, warnings };
}

//#endregion

//#region Writing

// The UCI operations that turn the router's config into the draft, as data (see core/ops.js). Only what changed is written; an
// emptied option is deleted rather than set to ''; options the page does not know are left alone, and so is a key that was not
// typed. A new peer is an anonymous section (rpcd names it), a new interface is named.
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
  // Queues the set and delete operations of an existing section; a delete is only queued for an option that exists.
  const emit = (section, { set, del }, raw) => {
    if (Object.keys(set).length) ops.push({ op: 'set', config: CONFIG, section, values: set });
    const existing = del.filter(o => raw[o] !== undefined);
    if (existing.length) ops.push({ op: 'delete', config: CONFIG, section, options: existing });
  };

  for (const item of ifaceList(data, draft)) {
    if (!item.editable) continue;
    const d = draft.interfaces[item.id];
    if (item.removed) {
      for (const p of item.data.peers.filter(x => x.section)) ops.push({ op: 'delete', config: CONFIG, section: p.section });
      ops.push({ op: 'delete', config: CONFIG, section: item.name });
      continue;
    }
    if (item.isNew) ops.push({ op: 'add', config: CONFIG, type: 'interface', name: item.name.trim(), values: { proto: 'wireguard', ...sectionChange(IFACE_FIELDS, {}, d.values).set } });
    else emit(item.name, sectionChange(IFACE_FIELDS, item.data.values, d.values), item.data.values);
    for (const pe of peerList(item, draft).filter(x => x.editable)) {
      if (pe.removed) ops.push({ op: 'delete', config: CONFIG, section: pe.id });
      else if (pe.isNew) ops.push({ op: 'add', config: CONFIG, type: peerType(item.name.trim()), values: sectionChange(PEER_FIELDS, {}, d.peers[pe.id]).set });
      else emit(pe.id, sectionChange(PEER_FIELDS, pe.p.values, d.peers[pe.id]), pe.p.values);
    }
  }
  return ops;
}

// The names of the interfaces that must be running after the save, and of the peers that must be loaded in the kernel. An interface
// must be up when the draft enables it, it has a key and it is new, was running, or is being enabled (one that was already down and
// stays down is not this save's doing). A peer must be loaded when it is enabled, has a key and is new, has a new key, is being
// enabled, or sits on a new interface.
export function expectations(base, draft) {
  const up = [], loaded = [];
  for (const item of ifaceList(base, draft).filter(i => i.editable && !i.removed)) {
    const d = draft.interfaces[item.id];
    const was = item.data;
    if (d.values.disabled || !hasPrivateKey(item, d)) continue;
    const enabling = Boolean(was) && uciBool(was.values.disabled, false);
    if (!(item.isNew || was.up || enabling)) continue;
    up.push(item.name.trim());
    for (const pe of peerList(item, draft).filter(x => x.editable && !x.removed)) {
      const v = d.peers[pe.id];
      if (v.disabled || !isKey(v.public_key.trim())) continue;
      const before = pe.p?.values;
      if (item.isNew || enabling || pe.isNew || before.public_key?.trim() !== v.public_key.trim() || uciBool(before.disabled, false)) loaded.push({ iface: item.name.trim(), key: v.public_key.trim() });
    }
  }
  return { up, loaded };
}

// What is not up or not loaded after the save, as texts (empty when all is well): the interfaces that must be running and the peers
// that must be in the kernel. The page asks again for a few seconds while this is not empty, because netifd takes a moment.
export function notRunning(base, draft, after) {
  const want = expectations(base, draft);
  const left = [];
  for (const name of want.up) {
    const i = after.interfaces.find(x => x.name === name);
    if (!i?.up) left.push(`${name} did not come up`);
  }
  for (const { iface, key } of want.loaded) {
    const i = after.interfaces.find(x => x.name === iface);
    if (!i?.up) continue;
    const p = i.peers.find(x => x.public_key === key);
    if (!p || p.state === 'down') left.push(`the peer ${shortKey(key)} was not loaded into ${iface}`);
  }
  return left;
}

// Throws unless the config `after` (read back through the plugin once the change is applied) holds what the draft asked for: every
// option of each interface and peer (a new one by its name or its public key, a removed one gone), that a key that was typed is
// now stored, and that what must be running is. `base` is what the page showed before.
export function checkApplied(after, draft, base) {
  const left = [];
  // Records every field whose applied value differs from the draft as "label: field".
  const compare = (fields, raw, values, label, secrets) => {
    for (const f of fields) {
      if (f.secret) { if (normalize(f, values[f.key]) !== '' && !secrets[f.key]) left.push(`${label}: ${f.label}`); continue; }
      if (differs(f, normalize(f, valueOf(f, raw[f.key])), normalize(f, values[f.key]))) left.push(`${label}: ${f.label}`);
    }
  };
  const items = ifaceList(base, draft).filter(i => i.editable);
  for (const item of items) {
    const found = after.interfaces.find(i => i.name === item.name.trim() && i.configured);
    if (item.removed) { if (found) left.push(`Interface ${item.name}`); continue; }
    if (!found) { left.push(`Interface ${item.name}`); continue; }
    const d = draft.interfaces[item.id];
    compare(IFACE_FIELDS, found.values, d.values, item.name, found.secrets);
    for (const pe of peerList(item, draft).filter(x => x.editable)) {
      const v = d.peers[pe.id];
      const key = v.public_key.trim();
      const peer = pe.isNew ? found.peers.find(p => p.configured && p.values.public_key === key) : found.peers.find(p => p.section === pe.id);
      const label = `${item.name} peer ${peerLabel(v, key)}`;
      if (pe.removed) { if (peer) left.push(label); continue; }
      if (!peer) left.push(label);
      else compare(PEER_FIELDS, peer.values, v, label, peer.secrets);
    }
  }
  if (left.length) throw new Error(`the router did not keep ${[...new Set(left)].join(', ')}.`);
  const down = notRunning(base, draft, after);
  if (down.length) throw new Error(`${down.join('; ')}. A tunnel that does not start usually has a wrong key, or WireGuard (the wireguard-tools package) is not installed.`);
}

//#endregion

//#region Adding a device

// The plan for adding a device (a client) to an interface: { error } when it cannot be done, else { addresses, tunnels, serverKey, port }.
// `addresses` holds the next free tunnel address of each family the interface has (host addresses: "10.8.0.2/32"), `tunnels` the
// tunnel networks ("10.8.0.0/24") the device should reach, `serverKey` the interface's public key, which the router reports once
// the interface runs, and `port` its listen port. The addresses skip everything the interface's peers (also the ones added in the form)
// already allow.
export function devicePlan(data, draft, ifId) {
  const item = ifaceList(data, draft).find(i => i.id === ifId);
  const d = draft.interfaces[ifId];
  if (!item || !d) return { error: 'This interface cannot be edited.' };
  if (item.isNew || !item.data.up || !item.data.public_key) return { error: `${item.name} is not running yet, so the router cannot tell the device its public key. Save the interface (and wait until it runs) before adding a device.` };
  if (normalize({ type: 'string' }, d.values.private_key) !== '') return { error: `You have typed or generated a new private key for ${item.name}. Save it first: the device must be given the public key the router really uses.` };
  const port = d.values.listen_port.trim() || (item.data.listen_port != null ? String(item.data.listen_port) : '');
  if (!port) return { error: `${item.name} has no listen port. Set one, save, and then add the device.` };
  const nets = parsedList(d.values.addresses, { bare: true, mask: true }).filter(n => n.prefix < n.bits);
  if (!nets.length) return { error: `${item.name} has no address with a prefix length (for example 10.8.0.1/24), so there is no tunnel network to give the device an address from.` };
  const taken = Object.values(d.peers).filter(v => !v.disabled).flatMap(v => parsedList(v.allowed_ips)).filter(c => c.prefix > 0);
  const addresses = [], tunnels = [], families = new Set();
  for (const n of nets) {
    tunnels.push(networkText(n));
    // A device gets one address per address family, from the first tunnel network of that family.
    if (families.has(n.family)) continue;
    families.add(n.family);
    const host = nextFreeHost(n, taken);
    if (host) { addresses.push(host); taken.push(parseCidr(host)); }
  }
  if (!addresses.length) return { error: `The tunnel network of ${item.name} has no free address left for a device.` };
  return { addresses, tunnels, serverKey: item.data.public_key, port };
}

// The allowed IPs a device routes into the tunnel, as a list: `mode` is 'tunnel' (the tunnel networks), 'all' (every address) or
// 'custom' (the comma or space separated `custom` text). Returns { list } or { error }.
export function deviceAllowedIps(mode, tunnels, custom) {
  if (mode === 'all') return { list: ['0.0.0.0/0', '::/0'] };
  if (mode === 'tunnel') return { list: [...tunnels] };
  const list = custom.split(/[\s,]+/).filter(Boolean);
  const bad = list.find(a => !parseCidr(a));
  if (!list.length) return { error: 'Enter at least one network.' };
  return bad ? { error: `"${bad}" is not an address with a prefix length such as 192.168.1.0/24.` } : { list };
}

// Where the device connects: the host and port as WireGuard's `Endpoint` line writes them (an IPv6 address in square brackets).
export const endpointText = (host, port) => `${parseAddress(host)?.family === 6 ? `[${host}]` : host}:${port}`;

// The WireGuard configuration text for a device (the file the WireGuard app or wg-quick reads).
export function deviceConfig({ privateKey, addresses, dns, serverKey, presharedKey, endpoint, allowedIps, keepalive }) {
  return [
    '[Interface]',
    `PrivateKey = ${privateKey}`,
    `Address = ${addresses.join(', ')}`,
    dns ? `DNS = ${dns}` : null,
    '',
    '[Peer]',
    `PublicKey = ${serverKey}`,
    presharedKey ? `PresharedKey = ${presharedKey}` : null,
    `Endpoint = ${endpoint}`,
    `AllowedIPs = ${allowedIps.join(', ')}`,
    keepalive ? `PersistentKeepalive = ${keepalive}` : null,
    '',
  ].filter(l => l != null).join('\n');
}

// A file name for a device's configuration: the interface and device names with anything but letters, digits, underscore and
// hyphen replaced, at most 15 characters before ".conf" (the length wg-quick allows for a tunnel name).
export const deviceFileName = (iface, device) => `${`${iface}-${device}`.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 15) || 'wireguard'}.conf`;

// The address of the first of an interface's own addresses, for suggesting a DNS server to the device ("10.8.0.1"), or ''.
export const ownAddress = values => {
  const c = parsedList(values.addresses, { bare: true, mask: true })[0];
  return c ? addressText(c) : '';
};

//#endregion
