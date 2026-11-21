// Pure model of how BIRD chose among the paths of one prefix. BIRD compares the candidates rule by rule (BIRD 3 documentation, "Route
// selection rules" of the BGP chapter), after the routes' own preference: the first rule that tells two paths apart decides. This
// explains the choice BIRD already made (the path flagged best) by finding, for every other path, the rule on which it lost.
// BIRD's "internal distance to a boundary router" rule is not reported by `show route`, so it is not shown.

// Rank of the origin attribute as BIRD prints it: lower wins.
const ORIGIN_RANK = { IGP: 0, EGP: 1, Incomplete: 2 };

// An IPv4 address as a number (for comparing router IDs), or null when it is not one.
function ipv4(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text ?? '');
  return m ? ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4] : null;
}

// The candidates for `prefix`: its BGP paths and the routes of other protocols (static, direct), each as
// { kind, peer, preference, best, localPref, asPathLength, origin, med, neighborAs, external, routerId, nextHop, inKernel, path }.
export function candidates(data, prefix) {
  const peers = new Map(data.peers.map(p => [p.name, p]));
  const bgp = data.paths.filter(r => r.prefix === prefix).map(r => {
    const peer = peers.get(r.peer);
    return {
      kind: 'bgp', peer: r.peer, preference: r.preference, best: r.best,
      localPref: r.local_pref ?? 100, asPathLength: r.as_path.length, origin: r.origin ?? null,
      med: r.med ?? 0, neighborAs: peer?.neighbor_as ?? r.as_path[0] ?? null,
      external: /\bexternal\b/.test(peer?.session ?? ''), routerId: peer?.router_id ?? null,
      nextHop: r.next_hop, inKernel: r.in_kernel, path: r,
    };
  });
  const local = (data.local ?? []).filter(r => r.prefix === prefix).map(r => ({
    kind: 'local', peer: r.protocol, preference: r.preference, best: r.best, nextHop: null, inKernel: r.in_kernel, path: r,
  }));
  return [...bgp, ...local];
}

// The rules in BIRD's order. Each has the text that names it, `differs(best, other)` returning null when the two tie on it or the
// words of the result ("1 hop against 3"), and the values in the table of the page.
const RULES = [
  { id: 'preference', label: 'route preference (highest wins)', differs: (a, b) => a.preference !== b.preference && a.preference != null && b.preference != null ? `${a.preference} against ${b.preference}` : null },
  { id: 'local_pref', label: 'local preference (highest wins)', bgp: true, differs: (a, b) => a.localPref !== b.localPref ? `${a.localPref} against ${b.localPref}` : null },
  { id: 'as_path', label: 'AS path length (shortest wins)', bgp: true, differs: (a, b) => a.asPathLength !== b.asPathLength ? `${a.asPathLength} against ${b.asPathLength}` : null },
  { id: 'origin', label: 'origin (IGP, then EGP, then incomplete)', bgp: true, differs: (a, b) => (ORIGIN_RANK[a.origin] ?? 3) !== (ORIGIN_RANK[b.origin] ?? 3) ? `${a.origin ?? 'unknown'} against ${b.origin ?? 'unknown'}` : null },
  // MED only compares paths that come from the same neighboring AS (BIRD's default; `med metric` would compare any two).
  { id: 'med', label: 'MED (lowest wins, only within the same neighboring AS)', bgp: true, differs: (a, b) => a.neighborAs === b.neighborAs && a.med !== b.med ? `${a.med} against ${b.med}` : null },
  { id: 'ebgp', label: 'learned over eBGP rather than iBGP', bgp: true, differs: (a, b) => a.external !== b.external ? (a.external ? 'eBGP against iBGP' : 'iBGP against eBGP') : null },
  { id: 'router_id', label: 'router ID of the advertising router (lowest wins)', bgp: true, differs: (a, b) => a.routerId !== b.routerId && ipv4(a.routerId) !== null && ipv4(b.routerId) !== null ? `${a.routerId} against ${b.routerId}` : null },
];

// The rules as text, in the order BIRD applies them, for the page to list.
export const RULE_LABELS = RULES.map(r => r.label);

// Whether `a` beats `b` on a rule that differs: higher is better for preference and local preference, lower for the others.
function wins(rule, a, b) {
  switch (rule.id) {
    case 'preference': return a.preference > b.preference;
    case 'local_pref': return a.localPref > b.localPref;
    case 'as_path': return a.asPathLength < b.asPathLength;
    case 'origin': return (ORIGIN_RANK[a.origin] ?? 3) < (ORIGIN_RANK[b.origin] ?? 3);
    case 'med': return a.med < b.med;
    case 'ebgp': return a.external;
    default: return ipv4(a.routerId) < ipv4(b.routerId);
  }
}

// Why `best` beat `other`: { rule, detail } for the first rule on which they differ, or null when they tie on every rule BIRD reports.
// A rule that only BGP paths have is skipped when one of the two is a route of another protocol.
export function decidedBy(best, other) {
  const bothBgp = best.kind === 'bgp' && other.kind === 'bgp';
  for (const rule of RULES) {
    if (rule.bgp && !bothBgp) continue;
    const detail = rule.differs(best, other);
    if (detail && wins(rule, best, other)) return { rule, detail };
    // A difference that favors the other path means BIRD did not follow these rules for this pair (a route kept for another reason).
    if (detail) return { rule: null, detail: `${rule.label}: ${detail}` };
  }
  return null;
}

// The explanation of the choice for `prefix`: { prefix, best, rows: [{ candidate, role, reason }] } with the best path first. `role` is
// best, ecmp (installed in the kernel next to the best path), backup (a valid path that waits) or other (a route of another protocol).
// `reason` is one sentence in plain words. `best` is null when no candidate is flagged.
export function explainPrefix(data, prefix) {
  const all = candidates(data, prefix);
  const best = all.find(c => c.best) ?? null;
  const rows = all.map(c => {
    if (c === best) {
      const rest = all.length - 1;
      return { candidate: c, role: 'best', reason: rest ? `BIRD's choice among ${all.length} routes for this prefix.` : 'The only route for this prefix.' };
    }
    const verdict = best ? decidedBy(best, c) : null;
    if (c.kind === 'local') return { candidate: c, role: 'other', reason: verdict?.rule ? `Not selected: the best route wins on ${verdict.rule.label}: ${verdict.detail}.` : 'A route of another protocol that is not selected.' };
    if (c.inKernel) {
      // The router ID only breaks ties for the single best path; BIRD merges paths for multipath without looking at it.
      const tie = !verdict?.rule || verdict.rule.id === 'router_id';
      return { candidate: c, role: 'ecmp', reason: tie
        ? 'Ties with the best path on every rule except the router ID, which does not matter for multipath, so it is installed in the kernel as an equal-cost next hop.'
        : `Installed in the kernel next to the best path although it differs on ${verdict.rule.label} (${verdict.detail}).` };
    }
    return { candidate: c, role: 'backup', reason: verdict?.rule
      ? `Lost on ${verdict.rule.label}: ${verdict.detail}.`
      : verdict ? `Not selected (${verdict.detail}).` : 'Ties with the best path on every rule that BIRD reports; kept as a backup.' };
  });
  rows.sort((a, b) => (b.role === 'best') - (a.role === 'best'));
  return { prefix, best, rows };
}
