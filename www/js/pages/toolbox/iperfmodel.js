// The iperf3 server's model: what the events of `iperf3 -s --json-stream` say, and how the page words them. Pure functions
// with no DOM and no network, so they are unit-tested directly (tests/toolbox/iperf.test.mjs). The plugin only streams the
// text; every figure shown is derived here.
//
// iperf3 prints one JSON object per line: `start` when a client has connected and agreed the test (who, which protocol,
// which direction), `interval` once a second while it runs (the bits per second of that second, with jitter and loss for
// UDP and retransmits for the sending side of TCP), `end` with the totals and the CPU use, and `error` when something went
// wrong. A client that goes away mid-test sends no `end`.

// A test the server ran or is running.
//   { n, client: { host, port }, protocol: 'TCP' | 'UDP', reverse, direction: 'upload' | 'download', streams, duration, target,
//     startedAt, intervals: [{ t0, t1, bps, retransmits, jitter, lost, packets, lostPct }], done, aborted, error,
//     summary: { seconds, bytes, bps, retransmits, jitter, lost, packets, lostPct, cpuServer, cpuClient } | null }
// `direction` is named from the client's side: an upload is the client sending to the router, which is the default
// (the router receives); a download (`iperf3 -R`) is the router sending. `target` is the rate a UDP client aims for (-b).

// A number, or null when the value is not a finite number.
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The shortest interval that counts as a second of the test: iperf3 closes a test with a sliver of a second whose rate is
// meaningless, so intervals below this are left out of the series.
const MIN_INTERVAL = 0.25;

// One `start` event as a new test.
function newTest(n, d) {
  const t = d.test_start ?? {};
  const conn = d.accepted_connection ?? {};
  return {
    n, client: { host: conn.host ?? d.connected?.[0]?.remote_host ?? '', port: num(+conn.port) ?? d.connected?.[0]?.remote_port ?? null },
    protocol: String(t.protocol ?? 'TCP').toUpperCase(), reverse: Boolean(t.reverse), direction: t.reverse ? 'download' : 'upload',
    streams: num(t.num_streams) ?? 1, duration: num(t.duration), target: num(t.target_bitrate) > 0 ? t.target_bitrate : null,
    startedAt: num(d.timestamp?.timesecs) == null ? null : d.timestamp.timesecs * 1000,
    intervals: [], done: false, aborted: false, error: null, summary: null,
  };
}

// One `interval` event as a point of the series, or null for the closing sliver.
function intervalOf(d) {
  const s = d.sum ?? d.streams?.[0];
  if (!s || !(s.seconds >= MIN_INTERVAL)) return null;
  return {
    t0: s.start, t1: s.end, bps: s.bits_per_second ?? 0, retransmits: num(s.retransmits), jitter: num(s.jitter_ms),
    lost: num(s.lost_packets), packets: num(s.packets), lostPct: num(s.lost_percent),
  };
}

// The totals of one `end` event. The rate is what the receiving side measured; retransmits are counted by the sender;
// jitter and loss are the receiver's, for UDP.
function summaryOf(d, test) {
  const recv = d.sum_received ?? d.sum ?? {};
  const sent = d.sum_sent ?? {};
  const udp = test.protocol === 'UDP';
  const u = d.sum ?? recv;
  return {
    seconds: num(recv.seconds), bytes: num(recv.bytes), bps: num(recv.bits_per_second) ?? 0,
    retransmits: udp ? null : num(sent.retransmits), jitter: udp ? num(u.jitter_ms) : null, lost: udp ? num(u.lost_packets) : null,
    packets: udp ? num(u.packets) : null, lostPct: udp ? num(u.lost_percent) : null,
    cpuServer: num(d.cpu_utilization_percent?.host_total), cpuClient: num(d.cpu_utilization_percent?.remote_total),
  };
}

// An iperf3 error text without its "iperf3: error - " prefix, which the page's own wording makes redundant.
const tidy = text => String(text).replace(/^iperf3?: /i, '').replace(/^error - /i, '');

// What the output of the server says: the tests so far (the last may still be running), the version, and any errors that
// belong to no test. A line that is not an event (an error printed in plain text, such as an unavailable port) is an error.
//   { tests, version, errors }
export function parseIperf(text) {
  const out = { tests: [], version: null, errors: [] };
  let cur = null;
  // Ends the current test as broken off (the client went away or a new one started before its `end`).
  const abort = () => { if (cur && !cur.done) cur.aborted = true; };
  for (const line of String(text ?? '').split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    let ev;
    try { ev = JSON.parse(raw); } catch { ev = null; }
    if (!ev || typeof ev !== 'object' || !ev.event) {
      // A half-written last line is not an error; a complete plain-text line is.
      if (/error|unable|cannot|denied|in use/i.test(raw) && !raw.startsWith('{')) out.errors.push(tidy(raw));
      continue;
    }
    const d = ev.data ?? {};
    if (ev.event === 'start') {
      abort();
      cur = newTest(out.tests.length + 1, d);
      out.tests.push(cur);
      if (typeof d.version === 'string') out.version = d.version;
    } else if (ev.event === 'interval' && cur && !cur.done) {
      // A client that goes away makes iperf3 print the last interval a second time, so an interval that repeats the
      // span of the one before it is not added.
      const p = intervalOf(d);
      const prev = cur.intervals.at(-1);
      if (p && !(prev && prev.t0 === p.t0 && prev.t1 === p.t1)) cur.intervals.push(p);
    } else if (ev.event === 'end' && cur) {
      cur.done = true;
      cur.summary = summaryOf(d, cur);
    } else if (ev.event === 'error') {
      const msg = tidy(typeof d === 'string' ? d : (d?.message ?? JSON.stringify(d)));
      if (cur && !cur.done) { cur.error = msg; cur.aborted = true; } else out.errors.push(msg);
    }
  }
  return out;
}

// A bit rate in the unit that keeps it readable ("941 Mbit/s", "6.65 Gbit/s", "812 kbit/s"), with three significant digits.
export function fmtBitrate(bps) {
  if (bps == null || !Number.isFinite(bps)) return '–';
  const units = [[1e9, 'Gbit/s'], [1e6, 'Mbit/s'], [1e3, 'kbit/s'], [0, 'bit/s']];
  const [div, name] = units.find(([d]) => bps >= d) ?? units.at(-1);
  const v = div ? bps / div : bps;
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${name}`;
}

// The test a client would start to get this one's result, as a command line for `address`: `iperf3 -c <address>` with the
// options that make it a download, a UDP test (with a rate to aim for) or several streams.
export function clientCommand(address, { reverse = false, udp = false, streams = 1, port = 5201, rate = '' } = {}) {
  const parts = ['iperf3', '-c', address];
  if (port !== 5201) parts.push('-p', String(port));
  if (reverse) parts.push('-R');
  if (udp) parts.push('-u', '-b', rate || '100M');
  if (streams > 1) parts.push('-P', String(streams));
  return parts.join(' ');
}

// A short sentence about a finished test for the history: "Upload, 3 streams, 941 Mbit/s, 0 retransmits".
export function describeTest(t) {
  const parts = [t.direction === 'download' ? 'Download' : 'Upload', t.protocol];
  if (t.streams > 1) parts.push(`${t.streams} streams`);
  return parts.join(' · ');
}

// The 0-to-100 position of a value on a scale that ends at `max` (a chart's vertical placement), clamped.
export const share = (v, max) => (max > 0 ? Math.min(100, Math.max(0, v / max * 100)) : 0);

// The seconds left of a server that was started for `limit` seconds, `elapsed` seconds ago (never below zero).
export const remaining = (limit, elapsed) => Math.max(0, Math.round(limit - elapsed));

// Seconds as "1:05" (minutes and seconds), for the countdown.
export function fmtClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
