// The zone matrix as data: for every source (a zone or the router itself) and destination, whether traffic
// flows by default, and which rules or port forwards change that. Pure data in, plain objects out, so it is
// unit-tested without a browser.
//
// firewall4 semantics this follows:
//   zone -> router     the zone's `input` policy          (rule with a `src` and no `dest`)
//   router -> zone     the zone's `output` policy         (rule with a `dest` and no `src`)
//   zone -> same zone  the zone's `forward` policy
//   zone -> other zone allowed only by a `forwarding` section (or a rule / port forward); otherwise blocked
// A rule or port forward can open a blocked path ("partial") or close part of an open one.

export const ROUTER = 'router';

export function buildMatrix(fw) {
  const zones = fw.zones.filter(z => z.enabled);
  const names = zones.map(z => z.name);
  const ends = [ROUTER, ...names];
  const byName = new Map(zones.map(z => [z.name, z]));

  // Expands "*" and a missing side into the matching ends of the matrix.
  const sources = r => r.src === '*' ? names : r.src ? [r.src] : [ROUTER];
  const dests = r => r.dest === '*' ? names : r.dest ? [r.dest] : [ROUTER];

  const accepts = new Map(), blocks = new Map();
  const note = (map, src, dest, label) => {
    const k = `${src}>${dest}`;
    map.set(k, [...(map.get(k) ?? []), label]);
  };
  const apply = (r, label, open) => {
    // A rule with neither side set is invalid and is ignored by the firewall.
    if (!r.src && !r.dest) return;
    for (const s of sources(r)) for (const d of dests(r)) {
      if (s === d && s === ROUTER) continue;
      if (s !== ROUTER && !byName.has(s)) continue;
      if (d !== ROUTER && !byName.has(d)) continue;
      note(open ? accepts : blocks, s, d, label);
    }
  };
  for (const r of fw.rules) if (r.enabled) apply(r, r.name ?? r.key, r.target === 'ACCEPT');
  // A port forward lets traffic from the zone reach the destination zone (or the router, with no dest).
  for (const r of fw.redirects) if (r.enabled && r.kind !== 'nat' && r.target === 'DNAT') apply({ src: r.src, dest: r.dest }, `${r.name ?? r.key} (port forward)`, true);

  const policy = (src, dest) => {
    if (src === ROUTER) return byName.get(dest).output;
    if (dest === ROUTER) return byName.get(src).input;
    if (src === dest) return byName.get(src).forward;
    return byName.get(src).forwards.includes(dest) ? 'ACCEPT' : 'BLOCKED';
  };

  const rows = ends.map(src => ({
    src,
    cells: ends.map(dest => {
      if (src === ROUTER && dest === ROUTER) return null;
      const pol = policy(src, dest);
      const a = accepts.get(`${src}>${dest}`) ?? [], b = blocks.get(`${src}>${dest}`) ?? [];
      const state = pol === 'ACCEPT' ? 'open' : a.length ? 'partial' : 'closed';
      return { src, dest, policy: pol, state, accepts: a, blocks: b };
    }),
  }));
  return { ends, rows };
}
