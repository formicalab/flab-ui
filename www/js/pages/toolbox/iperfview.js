// The iperf3 server's page: the state of the server with its countdown, the addresses and commands a client uses, the test
// that is running or ran last with a live throughput chart, and the history of the tests before it. The meaning of the
// output comes from iperfmodel.js; the page repaints it every time new output arrives (twice a second), so the countdown
// and the chart move while a test runs.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { copyButton } from '../../core/clipboard.js';
import { disclosure } from '../../core/fold.js';
import { fmtBytes } from '../../core/format.js';
import { badge, mono, muted, sparkline, spinner } from '../../core/ui.js';
import { stat } from './diagviews.js';
import { throughputChart } from './charts.js';
import { clientCommand, describeTest, fmtBitrate, fmtClock, parseIperf, remaining } from './iperfmodel.js';
import { banner } from './parts.js';

// A command line with its Copy button.
const commandLine = (text, note) => h('div', { className: 'rt-cmd' }, h('code', {}, text), note ? h('span', { className: 'muted small' }, note) : null, copyButton(text));

// The rate of a test: the one iperf3 reported for the whole run, or the mean of the seconds seen so far; null with no second yet.
const averageBps = t => t.summary?.bps ?? (t.intervals.length ? t.intervals.reduce((a, i) => a + i.bps, 0) / t.intervals.length : null);

// The state line of the server: a pulsing dot and the countdown while it listens, or how it ended.
function serverState(job, parsed, port, bind) {
  const elapsed = Math.max(0, ((job.t1 ?? Date.now()) - job.t0) / 1000);
  if (job.running) {
    const left = remaining(job.limit, elapsed);
    return h('div', { className: 'rt-iperf-state' },
      h('div', { className: 'rt-iperf-head' }, h('span', { className: 'rt-live-dot' }), h('strong', {}, `Listening on port ${port}`),
        muted(bind ? ` at ${bind} only` : ' on every address'), h('span', { className: 'rt-iperf-left' }, `${fmtClock(left)} left`)),
      h('div', { className: 'rt-countdown', title: 'Time until the server stops by itself' }, h('i', { style: `width:${Math.min(100, elapsed / job.limit * 100).toFixed(1)}%` })));
  }
  const why = job.stopRequested || job.stopped ? 'Stopped.' : job.timedOut ? 'The time was up, so the server stopped by itself.' : parsed.errors.length ? 'The server could not run.' : parsed.terminated ? 'The server was stopped.' : 'The server stopped.';
  return h('div', { className: 'rt-iperf-state ended' }, h('div', { className: 'rt-iperf-head' }, icon('check-circle'), h('strong', {}, why)));
}

// The addresses clients connect to and the commands that start a test, from the router's addresses (`info.addresses`, with
// the firewall zone and what it does with traffic addressed to the router). Addresses whose zone refuses it are listed apart.
function connectPanel(info, port, bind) {
  const all = (info?.addresses ?? []).filter(a => !bind || a.ip === bind);
  const open = all.filter(a => a.input === 'ACCEPT');
  const blocked = all.filter(a => a.input !== 'ACCEPT');
  const first = open.find(a => a.family === 4) ?? open[0];
  // One address the iperf3 server can be reached at, with the zone and whether its firewall zone accepts input.
  const row = a => h('div', { className: 'rt-addr' }, badge(a.iface, '', `${a.device ?? ''} · zone ${a.zone ?? 'none'}`), mono(a.ip), a.input === 'ACCEPT' ? null : badge(`zone ${a.zone ?? 'none'}: ${a.input.toLowerCase()}`, 'warning', 'The firewall does not accept traffic for the router from this zone'));
  return h('div', { className: 'rt-connect' },
    h('h3', {}, 'Connect from a computer'),
    open.length ? h('div', { className: 'rt-addrs' }, open.map(row)) : banner('No address of the router is in a zone that accepts traffic for it, so no client can connect. Add a firewall rule for this port, or choose another zone.', 'warn'),
    first ? h('div', { className: 'rt-cmds' },
      commandLine(clientCommand(first.ip, { port }), 'upload: the computer sends, the router receives'),
      commandLine(clientCommand(first.ip, { port, reverse: true }), 'download: the router sends'),
      commandLine(clientCommand(first.ip, { port, streams: 4 }), 'four parallel streams'),
      commandLine(clientCommand(first.ip, { port, udp: true, rate: '500M' }), 'UDP at 500 Mbit/s, with jitter and loss')) : null,
    blocked.length ? disclosure({ cls: 'rt-raw', summary: `Addresses the firewall blocks (${blocked.length})`, body: h('div', { className: 'rt-addrs' }, blocked.map(row)) }) : null);
}

// The figures of a test: the rate (now, or the average of a finished one), the peak, what moved, and the extras of the
// protocol (retransmits for TCP, jitter and loss for UDP) and of the router (its CPU use).
function testStats(t, live) {
  const peak = Math.max(0, ...t.intervals.map(i => i.bps));
  const now = t.intervals.at(-1)?.bps ?? null;
  const s = t.summary;
  const bytes = s?.bytes ?? null;
  const lossKind = s?.lostPct > 5 ? 'bad' : s?.lostPct > 0 ? 'warn' : '';
  const stats = [stat(live ? 'Now' : 'Average', fmtBitrate(live ? now : averageBps(t)), 'ok'), stat('Peak', fmtBitrate(peak || null))];
  if (bytes != null) stats.push(stat('Transferred', fmtBytes(bytes)));
  if (t.protocol === 'UDP') {
    const last = t.intervals.at(-1);
    stats.push(stat('Jitter', (s?.jitter ?? last?.jitter) == null ? '–' : `${(s?.jitter ?? last.jitter).toFixed(3)} ms`));
    stats.push(stat('Lost', s?.lost == null ? (last?.lost == null ? '–' : `${last.lost}`) : `${s.lost} of ${s.packets} (${s.lostPct.toFixed(1)}%)`, lossKind));
  } else if (s?.retransmits != null) stats.push(stat('Retransmits', String(s.retransmits), s.retransmits > 100 ? 'warn' : ''));
  if (s?.cpuServer != null) stats.push(stat('Router CPU', `${Math.round(s.cpuServer)}%`, s.cpuServer > 90 ? 'warn' : ''));
  return h('div', { className: 'rt-stats' }, stats);
}

// The card of the latest test: who, what kind, the figures and the chart.
function latestTest(t, running) {
  const live = !t.done && !t.aborted && running;
  const state = t.aborted ? badge('interrupted', 'warning', t.error ?? 'The client went away before the test ended') : t.done ? badge('finished', 'success') : badge('running', 'info');
  return h('div', { className: 'rt-iperf-test' },
    h('div', { className: 'rt-iperf-testhead' },
      h('span', { className: 'rt-dir' }, icon(t.direction === 'download' ? 'arrow-down' : 'arrow-up'), h('strong', {}, describeTest(t))),
      h('span', { className: 'muted' }, ['from ', mono(t.client.host)]), t.startedAt ? muted(new Date(t.startedAt).toLocaleTimeString()) : null, state),
    testStats(t, live),
    t.intervals.length || live ? throughputChart(t.intervals, { duration: t.duration, target: t.target, live }) : null);
}

// The earlier tests, newest first: a row with the test, the client, the average rate with a small chart, and the details.
function history(tests) {
  if (!tests.length) return null;
  const rows = [...tests].reverse().map(t => {
    const s = t.summary;
    const extra = t.protocol === 'UDP' ? (s?.lost == null ? '' : `${s.jitter?.toFixed(3) ?? '–'} ms jitter · ${s.lostPct.toFixed(1)}% lost`) : s?.retransmits != null ? `${s.retransmits} retransmits` : '';
    return h('tr', { className: t.aborted ? 'rt-down' : '' },
      h('td', { className: 'num mono' }, String(t.n)), h('td', {}, t.startedAt ? new Date(t.startedAt).toLocaleTimeString() : '–'),
      h('td', {}, mono(t.client.host)), h('td', {}, describeTest(t), t.aborted ? [' ', badge('interrupted', 'warning')] : null),
      h('td', { className: 'num' }, fmtBitrate(averageBps(t))),
      h('td', {}, t.intervals.length > 2 ? sparkline([{ values: t.intervals.map(i => i.bps), cls: 'rx' }], { width: 90, height: 22 }) : null),
      h('td', { className: 'muted' }, extra));
  });
  return h('div', { className: 'rt-iperf-history' }, h('h3', {}, 'Earlier tests'),
    h('div', { className: 'table-responsive' }, h('table', { className: 'table table-hover rt-compare' },
      h('thead', {}, h('tr', {}, ['#', 'Time', 'Client', 'Test', 'Rate', '', 'Details'].map((c, i) => h('th', { className: i === 0 || i === 4 ? 'num' : '' }, c)))),
      h('tbody', {}, rows))));
}

// The iperf3 server's result: the state and countdown, the exposure warning, how to connect, the latest test and the history.
// `status` is the plugin's answer (it carries the router's addresses and the zones that would expose the server).
export function iperfBody(job, status) {
  const parsed = parseIperf(job.text);
  const info = status?.iperf;
  const port = job.iperf?.port ?? info?.port ?? 5201;
  const bind = job.iperf?.bind ?? null;
  const exposed = !bind && (info?.exposed ?? []).length ? info.exposed : [];
  const latest = parsed.tests.at(-1) ?? null;
  return h('div', { className: 'rt-iperf' },
    serverState(job, parsed, port, bind),
    exposed.length && job.running ? banner(`The zone ${exposed.join(', ')} accepts traffic for the router, so while this server runs on every address it can be reached from the internet. Stop it when you are done, or listen on one LAN address only.`, 'warn') : null,
    parsed.errors.map(e => banner(e)),
    job.running ? (job.connectEl ??= connectPanel(info, port, bind)) : null,
    latest ? latestTest(latest, job.running) : job.running ? h('div', { className: 'rt-text muted rt-waiting' }, spinner('Waiting for client'), 'Waiting for a client to connect…') : h('div', { className: 'rt-text muted' }, 'No client connected while the server was running.'),
    history(parsed.tests.slice(0, -1)));
}
