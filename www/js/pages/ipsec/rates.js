// IPsec throughput history. strongSwan only reports byte counters, so rates come from the shared rate
// tracker (core/rates.js) fed once per poll. This module only decides which counters to use: the xfrmN
// interface counters are preferred because they keep counting across child SA rekeys; the SA's own byte
// counters are the fallback. The tracker restarts a series after a gap (tunnel down, polling paused, tab in
// the background) and drops series of connections that are gone.
import { createTracker } from '../../core/rates.js';

// A sample arriving more than this long after the previous one restarts the series (the tunnel was down or
// the page not polling), so a stale counter delta is never turned into a rate. Exported for the tests.
export const GAP_MS = 15000;
// Module-level so history survives the page redraw on every poll: up to 60 samples (5 minutes at 5 s).
const tracker = createTracker({ maxSamples: 60, gapMs: GAP_MS });

// One series per child SA of a connection.
const keyOf = (conn, child) => `${conn.key}/${child.name}`;

// The byte counters to follow for a child SA: its interface's, else the SA's own; null with no SA.
function counters(child) {
  const sa = child.sas[0];
  if (!sa) return null;
  if (sa.iface) return { rx: sa.iface.rx_bytes, tx: sa.iface.tx_bytes };
  return { rx: sa.bytes_in, tx: sa.bytes_out };
}

// Feeds one poll into the tracker. `t` (ms, monotonic) is injectable for tests.
export function record(data, t = performance.now()) {
  const present = [];
  for (const conn of data.connections) {
    for (const child of conn.children) {
      const key = keyOf(conn, child);
      present.push(key);
      const c = counters(child);
      if (c && c.rx != null) tracker.record(key, c, t);
    }
  }
  tracker.keep(present);
}

// { rx: number[], tx: number[] } in bytes/s, oldest first; a counter reset counts as zero.
export function series(conn, child) {
  const key = keyOf(conn, child);
  return { rx: tracker.rates(key, 'rx'), tx: tracker.rates(key, 'tx') };
}

// { rx, tx } with the most recent rate of a series (bytes/s); each is null while there is none yet.
export const latest = s => ({ rx: s.rx.at(-1) ?? null, tx: s.tx.at(-1) ?? null });
