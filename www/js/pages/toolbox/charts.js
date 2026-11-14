// The Toolbox's inline SVG charts: the latency line chart of a ping and the throughput chart of an iperf3 test. They are
// built from the parsed data (diagmodel.js, iperfmodel.js) and redrawn whenever new output arrives, so they show a partial
// run sensibly. The styling is in css/toolbox.css (the `rt-ch-*` classes), so the charts follow the light and dark theme.
import { fmtMs } from './diagmodel.js';
import { fmtBitrate } from './iperfmodel.js';

const NS = 'http://www.w3.org/2000/svg';

// An SVG element with attributes (set as attributes, not properties) and children (text becomes a text node).
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return el;
}

// The smallest "round" number (1, 2, 2.5, 5 or 10 times a power of ten) that is at least `value`: the top of a chart's scale.
function niceMax(value) {
  if (!(value > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(v => v >= value) ?? 10 * p;
}

// The frame every chart shares: the SVG with its viewBox, the horizontal grid lines at 0, 1/2 and the top of the scale with
// their labels (`label(value)` words a value of the scale), and the plot area's geometry for the caller.
function frame(width, height, pad, max, label) {
  const plot = { x0: pad.l, x1: width - pad.r, y0: height - pad.b, y1: pad.t };
  // The vertical position of a value in the plot.
  const y = v => plot.y0 - (v / max) * (plot.y0 - plot.y1);
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'rt-chart', role: 'img', preserveAspectRatio: 'xMidYMid meet' });
  for (const f of [0, 0.5, 1]) {
    const gy = y(max * f);
    root.append(svg('line', { class: 'rt-ch-grid', x1: plot.x0, x2: plot.x1, y1: gy, y2: gy }), svg('text', { class: 'rt-ch-label', x: plot.x0 - 6, y: gy + 3.5, 'text-anchor': 'end' }, label(max * f)));
  }
  return { root, plot, y };
}

// The latency chart of a ping, from parsePing's result: one point per reply (hover for the time), a line through the
// replies (broken where pings were lost), the band between the fastest and the slowest reply, a dashed line at the
// average, and a red cross for each lost ping. While the ping still runs the chart reaches only as far as the last reply;
// once it has ended (`ended`) the summary's count fills in a lost tail. Null when there is nothing to draw yet.
export function pingChart(p, ended) {
  const bySeq = new Map(p.replies.map(r => [r.seq, r]));
  const total = Math.max(ended ? p.sent : 0, p.replies.length ? Math.max(...p.replies.map(r => r.seq)) + 1 : 0);
  if (!total || !p.replies.length) return null;
  const W = 640, H = 190;
  const max = niceMax(Math.max(...p.replies.map(r => r.rtt)) * 1.1);
  const { root, plot, y } = frame(W, H, { l: 52, r: 12, t: 12, b: 26 }, max, v => (v === 0 ? '0' : fmtMs(v)));
  // The horizontal position of reply number `i` (a single reply sits in the middle).
  const x = i => (total === 1 ? (plot.x0 + plot.x1) / 2 : plot.x0 + (i / (total - 1)) * (plot.x1 - plot.x0));
  const { min, avg, max: slowest } = p.stats;
  root.append(
    svg('rect', { class: 'rt-ch-band', x: plot.x0, width: plot.x1 - plot.x0, y: y(slowest), height: Math.max(1, y(min) - y(slowest)) }),
    svg('line', { class: 'rt-ch-avg', x1: plot.x0, x2: plot.x1, y1: y(avg), y2: y(avg) }, svg('title', {}, `average ${fmtMs(avg)}`)));
  // A path through each run of consecutive replies; a lost ping breaks the line.
  let run = [];
  // Draws the run of replies collected so far as one line and starts a new run.
  const flush = () => { if (run.length > 1) root.append(svg('polyline', { class: 'rt-ch-line', points: run.join(' ') })); run = []; };
  for (let i = 0; i < total; i++) {
    const r = bySeq.get(i);
    if (r) run.push(`${x(i).toFixed(1)},${y(r.rtt).toFixed(1)}`); else flush();
  }
  flush();
  for (let i = 0; i < total; i++) {
    const r = bySeq.get(i);
    if (r) root.append(svg('circle', { class: 'rt-pt', cx: x(i).toFixed(1), cy: y(r.rtt).toFixed(1), r: 3.2 }, svg('title', {}, `#${i + 1}: ${fmtMs(r.rtt)}`)));
    else {
      const cx = x(i), cy = plot.y0 - 8;
      root.append(svg('g', { class: 'rt-pt-lost' }, svg('title', {}, `#${i + 1}: no reply`),
        svg('line', { class: 'rt-ch-lostline', x1: cx, x2: cx, y1: plot.y1, y2: plot.y0 }),
        svg('path', { d: `M${cx - 4},${cy - 4} l8,8 M${cx - 4},${cy + 4} l8,-8` })));
    }
  }
  root.append(svg('text', { class: 'rt-ch-label', x: plot.x0, y: H - 6 }, 'ping 1'), svg('text', { class: 'rt-ch-label', x: plot.x1, y: H - 6, 'text-anchor': 'end' }, `ping ${total}`));
  return root;
}

// The throughput chart of one iperf3 test: an area under the line of the bit rate of each second, with a dot on the latest
// point, and (for a UDP test with a target) a dashed line at the rate the client aims for. `duration` is the planned length
// in seconds (the time axis reaches it, so a running test fills the chart from the left); `max` fixes the top of the scale
// (to compare tests); `live` draws the pulsing dot of a test that is still running.
export function throughputChart(intervals, { duration = null, max = null, target = null, live = false, width = 560, height = 150 } = {}) {
  const top = niceMax(Math.max(max ?? 0, target ?? 0, ...intervals.map(i => i.bps)) * 1.08);
  const span = Math.max(5, duration ?? 0, intervals.at(-1)?.t1 ?? 0);
  const { root, plot, y } = frame(width, height, { l: 78, r: 14, t: 12, b: 24 }, top, v => (v === 0 ? '0' : fmtBitrate(v)));
  // The horizontal position of a time (seconds from the start of the test).
  const x = t => plot.x0 + (t / span) * (plot.x1 - plot.x0);
  if (target) root.append(svg('line', { class: 'rt-ch-avg', x1: plot.x0, x2: plot.x1, y1: y(target), y2: y(target) }, svg('title', {}, `target ${fmtBitrate(target)}`)));
  if (intervals.length) {
    const pts = intervals.map(i => [x(i.t1), y(i.bps)]);
    const line = pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`);
    root.append(
      svg('polygon', { class: 'rt-ch-area', points: [`${x(intervals[0].t0).toFixed(1)},${plot.y0}`, ...line, `${pts.at(-1)[0].toFixed(1)},${plot.y0}`].join(' ') }),
      svg('polyline', { class: 'rt-ch-line', points: line.join(' ') }));
    for (const [i, [px, py]] of pts.entries()) root.append(svg('circle', { class: 'rt-ch-hit', cx: px.toFixed(1), cy: py.toFixed(1), r: 7 }, svg('title', {}, `${intervals[i].t0.toFixed(0)}–${intervals[i].t1.toFixed(0)} s: ${fmtBitrate(intervals[i].bps)}`)));
    const [lx, ly] = pts.at(-1);
    root.append(svg('circle', { class: `rt-ch-dot${live ? ' live' : ''}`, cx: lx.toFixed(1), cy: ly.toFixed(1), r: 4 }));
  }
  root.append(svg('text', { class: 'rt-ch-label', x: plot.x0, y: height - 6 }, '0 s'), svg('text', { class: 'rt-ch-label', x: plot.x1, y: height - 6, 'text-anchor': 'end' }, `${Math.round(span)} s`));
  return root;
}
