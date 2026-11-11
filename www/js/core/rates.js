// Client-side rate tracker. The router only reports cumulative counters (bytes, packets, airtime), so
// rates and ratios are derived in the browser from successive polls and kept in a short history.
//
// - A series restarts after `gapMs` without a sample (polling paused, background tab, device gone for a
//   while) so a gap is never averaged into one misleading value.
// - A counter that goes backwards (reset, channel change) yields 0 for rates and null for ratios.
// - keep() drops series whose key disappeared, so removed devices do not accumulate.

export function createTracker({ maxSamples = 60, gapMs = 15000 } = {}) {
  // One tracked series: `list` holds { t (ms), c: counters } samples, oldest first, capped at maxSamples.
  const history = new Map();

  // Pairs of consecutive samples as { dt (s), d: { name: delta | null } }.
  const steps = key => {
    const list = history.get(key) ?? [];
    const out = [];
    for (let i = 1; i < list.length; i++) {
      const dt = (list[i].t - list[i - 1].t) / 1000;
      if (dt <= 0) continue;
      const d = {};
      for (const name of Object.keys(list[i].c)) {
        const diff = list[i].c[name] - (list[i - 1].c[name] ?? NaN);
        d[name] = Number.isFinite(diff) && diff >= 0 ? diff : null;
      }
      out.push({ dt, d });
    }
    return out;
  };

  return {
    // counters: { name: number }; undefined or non-finite values are ignored. `t` is injectable for tests.
    record(key, counters, t = performance.now()) {
      const c = {};
      for (const [name, v] of Object.entries(counters)) if (Number.isFinite(v)) c[name] = v;
      if (!Object.keys(c).length) return;
      let list = history.get(key) ?? [];
      if (list.length && t - list.at(-1).t > gapMs) list = [];
      list.push({ t, c });
      if (list.length > maxSamples) list.shift();
      history.set(key, list);
    },

    // Forgets every series whose key is not in `keys`.
    keep(keys) {
      const wanted = new Set(keys);
      for (const key of history.keys()) if (!wanted.has(key)) history.delete(key);
    },

    // Per-second rate of one counter, oldest first.
    rates: (key, name) => steps(key).map(s => (s.d[name] == null ? 0 : s.d[name] / s.dt)),

    // Percentage Δnum / Δden per step (null when undefined), oldest first.
    ratios: (key, num, den) => steps(key).map(s => (s.d[num] == null || !s.d[den] ? null : Math.min(100, s.d[num] / s.d[den] * 100))),
  };
}

// Most recent value of a rates/ratios list, or null while it is empty.
export const latest = list => list.at(-1) ?? null;
