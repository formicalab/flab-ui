// Pure interpretation of network.interface dump for the Overview page.

const isGlobalV6 = address => {
  const a = address.toLowerCase();
  return !a.startsWith('::') && !a.startsWith('fe80:') && !a.startsWith('fc') && !a.startsWith('fd');
};

const isGlobalV4 = address => {
  const [a, b] = address.split('.').map(Number);
  return !(a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127);
};

const routeOf = (iface, family) => {
  const route = (iface.route ?? []).find(r =>
    family === 4 ? r.target === '0.0.0.0' && Number(r.mask) === 0 :
      r.target === '::' && Number(r.mask) === 0);
  return route ? { target: route.target, gateway: route.nexthop, metric: Number(route.metric ?? 0) } : null;
};

const addressOf = (iface, key, predicate) => (iface[key] ?? []).find(a => predicate(a.address));

function wanOf(ifaces, family) {
  const candidates = ifaces
    .filter(i => i.up && !['loopback', 'lo'].includes(i.interface))
    .map(i => {
      const route = routeOf(i, family);
      const key = family === 4 ? 'ipv4-address' : 'ipv6-address';
      // IPv4: prefer a public address, but accept a private one (router behind a modem, CGNAT): the link is still
      // the path to the Internet. IPv6 needs a global address; link-local and ULA do not reach it.
      const address = addressOf(i, key, family === 4 ? isGlobalV4 : isGlobalV6) ?? (family === 4 ? (i[key] ?? [])[0] : null);
      return route ? {
        name: i.interface,
        device: i.l3_device || i.device,
        proto: i.proto,
        uptime: i.uptime,
        address: address?.address ?? null,
        mask: address?.mask ?? null,
        private: Boolean(address) && family === 4 && !isGlobalV4(address.address),
        static: i.proto === 'static',
        gateway: route.gateway,
        metric: route.metric,
        dns: i['dns-server'] ?? [],
        inactiveDns: i.inactive?.['dns-server'] ?? [],
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.metric - b.metric || a.name.localeCompare(b.name));
  return candidates[0] ?? null;
}

function prefixStatus(ifaces) {
  const prefixes = ifaces.flatMap(i =>
    (i['ipv6-prefix'] ?? [])
      .filter(p => isGlobalV6(p.address))
      .map(p => ({
        address: p.address,
        mask: p.mask,
        source: i.interface,
        preferred: p.preferred,
        valid: p.valid,
        assigned: Object.entries(p.assigned ?? {}).map(([name, a]) => ({
          name,
          address: a.address,
          mask: a.mask,
        })).sort((a, b) => a.name.localeCompare(b.name)),
      })));
  const unique = prefixes.filter((p, i) => prefixes.findIndex(x => x.address === p.address && x.mask === p.mask) === i);
  return unique.sort((a, b) => a.mask - b.mask)[0] ?? null;
}

export function readOverviewNetwork(dump) {
  // No dump at all (call failed or not permitted) is not the same as "no WAN": say so instead of claiming Offline.
  const unavailable = !Array.isArray(dump?.interface);
  const ifaces = unavailable ? [] : dump.interface;
  const ipv4 = wanOf(ifaces, 4);
  const ipv6 = wanOf(ifaces, 6);
  const prefix = prefixStatus(ifaces);
  const sources = [...new Set([ipv4, ipv6].filter(Boolean).map(w => w.name))];
  const online = Boolean(ipv4?.address || ipv6?.address);

  return {
    unavailable,
    // A statically addressed private uplink (repeater, access point or router behind another one): there is no
    // provider here, only an upstream router that supplies the Internet.
    upstream: Boolean(ipv4?.static && ipv4.private),
    online,
    state: unavailable ? 'Unavailable' : online ? 'Online' : sources.length ? 'WAN up' : 'Offline',
    ipv4,
    ipv6,
    prefix,
    sources,
    dns4: ipv4?.dns ?? [],
    inactiveDns4: ipv4?.inactiveDns ?? [],
    dns6: ipv6?.dns ?? [],
    inactiveDns6: ipv6?.inactiveDns ?? [],
  };
}
