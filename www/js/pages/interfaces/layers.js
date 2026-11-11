// The layers an OpenWrt network is built from, resolved into one row per logical interface:
//
//   physical port / Wi-Fi interface  ->  device (bridge, VLAN)  ->  interface (IP configuration)  ->  protocol device
//
// A bridge groups ports, an 802.1q VLAN device sits on a port or a bridge, a netifd interface binds to
// one device and carries the protocol and addresses, and some protocols (PPPoE, tunnels) create a device
// of their own on top. An interface can also ride on another interface's protocol device (wan6 on the
// PPPoE session of wan) or run over another interface (an XFRM or GRE tunnel over wan: `tunlink`).
// Pure data in, plain objects out, so it is unit-tested without a browser.

const PROTO_DEVICE = {
  pppoe: 'PPPoE session', pppoa: 'PPPoA session', wireguard: 'WireGuard tunnel', xfrm: 'IPsec (XFRM) interface',
  gre: 'GRE tunnel', gretap: 'GRE tunnel', vti: 'VTI tunnel', vxlan: 'VXLAN', '6in4': '6in4 tunnel', '6to4': '6to4 tunnel',
  '6rd': '6rd tunnel', openvpn: 'OpenVPN tunnel', l2tp: 'L2TP session', pptp: 'PPTP session', wwan: 'Mobile broadband', qmi: 'Mobile broadband',
};

export const protoDeviceLabel = proto => PROTO_DEVICE[proto] ?? null;

// A Wi-Fi or mesh interface as a node of a chain, with the radio it lives on.
const wirelessNode = (w, radio) => ({
  name: w.ifname ?? w.section, kind: w.mode === 'mesh' ? 'mesh' : 'wifi', up: !!(w.up && radio.up),
  mode: w.mode, ssid: w.ssid, radio: radio.name, band: radio.band, enabled: w.enabled,
});

// ports: net.ports, bridges: net.bridges, vlans: net.vlans (flab.network); ifs: network.interface dump;
// tunlinks: { interface: underlying interface } from UCI; radios: flab.radio `radios` (radio devices with their
// Wi-Fi and mesh interfaces, optional). Wireless interfaces that reach no netifd interface, and radios without
// any interface, get a row of their own (`orphan`, no `iface`) so nothing wireless is hidden.
export function buildLayers(net, ifs, tunlinks = {}, radios = []) {
  const ports = new Map(net.ports.map(p => [p.name, p]));
  const bridges = new Map(net.bridges.map(b => [b.name, b]));
  const vlans = new Map(net.vlans.map(v => [v.name, v]));
  const byName = new Map(ifs.map(i => [i.interface, i]));
  const wireless = new Map();
  const placed = new Set();
  for (const r of radios) for (const w of r.interfaces ?? []) if (w.ifname) wireless.set(w.ifname, wirelessNode(w, r));
  // Devices an interface's protocol creates (pppoe-wan, wg0, ...), by the interface that owns them.
  const owner = new Map();
  for (const i of ifs) if (i.l3_device && i.l3_device !== i.device) owner.set(i.l3_device, i);

  // Walks down from a device name to the physical layer: { roots (ports, Wi-Fi), devices (bottom-up), host }.
  function resolve(name, seen = new Set()) {
    if (!name || seen.has(name)) return { roots: [], devices: [], host: null };
    seen.add(name);
    const v = vlans.get(name);
    if (v) {
      const below = resolve(v.parent, seen);
      return { ...below, devices: [...below.devices, { name, kind: 'vlan', vid: v.vid, up: v.up && v.carrier !== false }] };
    }
    const b = bridges.get(name);
    if (b) {
      return {
        roots: b.members.map(m => wireless.get(m.name) ?? { name: m.name, kind: m.kind === 'wifi' ? 'wifi' : 'port', up: m.carrier }),
        devices: [{ name, kind: 'bridge', stp: b.stp, up: b.up }], host: null,
      };
    }
    const p = ports.get(name);
    if (p) return { roots: [{ name, kind: 'port', up: p.carrier }], devices: [], host: null };
    if (wireless.has(name)) return { roots: [wireless.get(name)], devices: [], host: null };
    const host = owner.get(name);
    if (host) return { ...resolve(host.device, seen), host: host.interface };
    return { roots: [], devices: [{ name, kind: 'device', up: null }], host: null };
  }

  const rows = ifs.filter(i => i.interface !== 'loopback').map(i => {
    const below = resolve(i.device);
    let over = below.host;
    // Tunnels have no device of their own below them; `tunlink` names the interface they run over.
    if (!i.device && tunlinks[i.interface]) over = tunlinks[i.interface];

    // The protocol's own device: pppoe-wan under wan, wg0 for WireGuard. An interface that merely rides on
    // such a device (wan6) shows it as shared.
    let protoDevice = null;
    if (i.l3_device && i.l3_device !== i.device) protoDevice = { name: i.l3_device, label: protoDeviceLabel(i.proto), shared: false };
    else if (i.l3_device && owner.has(i.l3_device)) protoDevice = { name: i.l3_device, label: protoDeviceLabel(owner.get(i.l3_device).proto), shared: true };

    return {
      iface: i, name: i.interface, proto: i.proto, up: i.up,
      roots: below.roots, devices: below.devices, over: over && byName.has(over) ? over : null, protoDevice,
    };
  });

  for (const r of rows) for (const x of r.roots) placed.add(x.name);

  // An interface that is configured but not running has no ifname yet; its `network` option still says where
  // it will join.
  for (const radio of radios) {
    for (const w of radio.interfaces ?? []) {
      if (w.ifname) continue;
      const node = wirelessNode(w, radio);
      const hosts = rows.filter(r => (w.networks ?? []).includes(r.name));
      for (const r of hosts) r.roots.push(node);
      if (hosts.length) placed.add(node.name);
    }
  }

  const extra = [];
  for (const radio of radios) {
    const own = radio.interfaces ?? [];
    if (!own.length) {
      extra.push({ iface: null, orphan: true, name: radio.name, up: !!radio.up, roots: [{ name: radio.name, kind: 'radio', up: !!radio.up, radio: radio.name, band: radio.band, enabled: radio.enabled }], devices: [], over: null, protoDevice: null });
    }
    for (const w of own) {
      const node = wirelessNode(w, radio);
      if (!placed.has(node.name)) extra.push({ iface: null, orphan: true, name: node.name, up: node.up, roots: [node], devices: [], over: null, protoDevice: null });
    }
  }

  // Chains on the front-panel ports first (in board order), then everything else by name; wireless that
  // belongs to no interface is last.
  const rank = r => Math.min(999, ...r.roots.map(x => ports.get(x.name)?.board?.index ?? 999));
  return [...rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)), ...extra.sort((a, b) => a.name.localeCompare(b.name))];
}
