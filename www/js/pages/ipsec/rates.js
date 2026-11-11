// Client-side throughput history. strongSwan only reports counters, so rates are derived from
// the difference between consecutive polls. Interface counters (xfrmN) are preferred because they
// keep counting across child SA rekeys; SA byte counters are the fallback.
// A poll gap (tunnel down, polling paused, tab in the background) would otherwise show up as one sample
// averaged over the whole gap, so a series restarts after GAP_MS without a sample. Series of connections
// that no longer exist are dropped on every poll.

const MAX_SAMPLES = 60;
export const GAP_MS = 15000;
const history = new Map();

const keyOf = (conn, child) => `${conn.key}/${child.name}`;

function counters(child) {
  const sa = child.sas[0];
  if (!sa) return null;
  if (sa.iface) return { rx: sa.iface.rx_bytes, tx: sa.iface.tx_bytes };
  return { rx: sa.bytes_in, tx: sa.bytes_out };
}

// `t` (ms, monotonic) is injectable for tests.
export function record(data, t = performance.now()) {
  const present = new Set();
  for (const conn of data.connections) {
    for (const child of conn.children) {
      const key = keyOf(conn, child);
      present.add(key);
      const c = counters(child);
      if (!c || c.rx == null) continue;
      let list = history.get(key) ?? [];
      if (list.length && t - list.at(-1).t > GAP_MS) list = [];
      list.push({ t, ...c });
      if (list.length > MAX_SAMPLES) list.shift();
      history.set(key, list);
    }
  }
  for (const key of history.keys()) if (!present.has(key)) history.delete(key);
}

// Returns { rx: number[], tx: number[] } in bytes/s (oldest first); a counter reset counts as zero.
export function series(conn, child) {
  const list = history.get(keyOf(conn, child)) ?? [];
  const rx = [], tx = [];
  for (let i = 1; i < list.length; i++) {
    const dt = (list[i].t - list[i - 1].t) / 1000;
    if (dt <= 0) continue;
    rx.push(Math.max(0, (list[i].rx - list[i - 1].rx) / dt));
    tx.push(Math.max(0, (list[i].tx - list[i - 1].tx) / dt));
  }
  return { rx, tx };
}

export const latest = s => ({ rx: s.rx.at(-1) ?? null, tx: s.tx.at(-1) ?? null });
