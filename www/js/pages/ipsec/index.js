// IPsec page: strongSwan status from the flab.ipsec plugin. Summary tiles on top, then one card per
// connection (connection.js), the daemon card and the score explanation (daemon.js).
// Throughput is derived in the browser from successive counter samples (rates.js), which is why every
// poll goes through record() before the data is rendered. `compact` hides the per-connection details.
import { h } from '../../core/dom.js';
import { ubus } from '../../core/ubus.js';
import { tile, tiles, emptyState, GRADE_KIND, button } from '../../core/ui.js';
import { searchControl, selectControl, pauseControl, refreshControl, toggleControl } from '../../core/controls.js';
import { fmtBps, fmtBytes, fmtSpan } from '../../core/format.js';
import { record, series, latest } from './rates.js';
import { connectionCard } from './connection.js';
import { daemonCard, scoringCard } from './daemon.js';

// View state that must survive the redraw on every poll: filter text, state filter (all/up/down),
// compact mode and the paused flag.
const state = { q: '', filter: 'all', compact: false, paused: false };

// Summary tiles over all connections. Live throughput sums the latest browser-side rates of every child SA;
// total traffic sums each xfrm interface once (several SAs can share one interface) and so counts since the
// interface came up; "next rekey" is the soonest IKE or child SA rekey; replay failures are summed from
// the kernel's per-direction XFRM counters.
function summary(data) {
  const conns = data.connections;
  const up = conns.filter(c => c.state === 'ESTABLISHED').length;

  const worst = conns.reduce((a, c) => (!a || c.rating.score < a.rating.score ? c : a), null);

  let rx = 0, tx = 0, anyRate = false;
  const ifaces = new Map();
  let nextRekey = null;
  let failures = 0;
  for (const c of conns) {
    if (c.ike?.rekey_time != null && (!nextRekey || c.ike.rekey_time < nextRekey.s)) nextRekey = { s: c.ike.rekey_time, what: `${c.name} IKE SA` };
    for (const child of c.children) {
      const r = latest(series(c, child));
      if (r.rx != null) { rx += r.rx; tx += r.tx; anyRate = true; }
      for (const sa of child.sas) {
        if (sa.iface) ifaces.set(sa.iface.name, sa.iface);
        if (sa.rekey_time != null && (!nextRekey || sa.rekey_time < nextRekey.s)) nextRekey = { s: sa.rekey_time, what: `${child.name} child SA` };
        failures += (sa.kernel.inbound?.replay_failed ?? 0) + (sa.kernel.outbound?.replay_failed ?? 0);
      }
    }
  }
  const totalRx = [...ifaces.values()].reduce((n, i) => n + (i.rx_bytes ?? 0), 0);
  const totalTx = [...ifaces.values()].reduce((n, i) => n + (i.tx_bytes ?? 0), 0);

  return tiles(
    tile('Tunnels established', `${up} / ${conns.length}`, up === conns.length ? 'all connections up' : `${conns.length - up} down`, up === conns.length ? 'text-success' : 'text-danger'),
    tile('Weakest security grade', worst ? `${worst.rating.grade} (${worst.rating.score})` : '–', worst ? worst.name : '', worst ? `text-${GRADE_KIND[worst.rating.grade]}` : ''),
    tile('Live throughput', anyRate ? `↓ ${fmtBps(rx)}` : '–', anyRate ? `↑ ${fmtBps(tx)} · all tunnels` : 'measuring…'),
    tile('Total traffic', `↓ ${fmtBytes(totalRx)}`, `↑ ${fmtBytes(totalTx)} · since interface up`),
    tile('Next rekey', nextRekey ? fmtSpan(nextRekey.s) : '–', nextRekey ? nextRekey.what : ''),
    tile('Replay failures', failures, failures ? 'investigate' : 'anti-replay healthy', failures ? 'text-danger' : 'text-success'));
}

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'ipsec',
  label: 'IPsec VPN',
  title: 'IPsec VPN · strongSwan',
  icon: 'shield-lock',
  interval: 5000,
  css: 'css/ipsec.css',
  isPaused: () => state.paused,

  // Fetches the status and feeds the counters to the rate tracker before anything is rendered.
  load: async () => {
    const data = await ubus('flab.ipsec', 'status');
    record(data);
    return data;
  },

  // Command-bar controls, created once per visit: text filter, state filter, compact toggle, pause, refresh.
  controls({ rerender, reload }) {
    const filter = selectControl(state, 'filter', rerender, 'Connection state');
    filter.setOptions([['all', 'All connections'], ['up', 'Established'], ['down', 'Down']]);
    return {
      nodes: [searchControl(state, 'q', rerender, 'Filter connections…'), filter.node,
        toggleControl(state, 'compact', ['Compact view', 'Detailed view'], rerender), pauseControl(state), refreshControl(reload)],
    };
  },

  // Connections matching the state filter and every search term (name, state, remote addresses, remote
  // ID or child names) are shown; the scoring explanation sits above them, the daemon card below.
  view(data, rerender) {
    const q = state.q.toLowerCase();
    // Connections matching the state filter and every search term.
    const shown = data.connections.filter(c => {
      if (state.filter === 'up' && c.state !== 'ESTABLISHED') return false;
      if (state.filter === 'down' && c.state === 'ESTABLISHED') return false;
      if (!q) return true;
      const hay = [c.name, c.state, c.config.remote_addrs.join(' '), c.ike?.remote_host, c.ike?.remote_id, ...c.children.map(x => x.name)].join(' ').toLowerCase();
      return q.split(/\s+/).every(t => hay.includes(t));
    });

    return [
      summary(data),
      scoringCard(),
      shown.length
        ? h('div', { className: `vpn-grid ${state.compact ? 'compact' : ''}` }, shown.map(c => connectionCard(c, { compact: state.compact })))
        : emptyState(
          data.connections.length ? 'No connection matches the filter.' : 'No IPsec connections are configured.',
          data.connections.length && (state.q || state.filter !== 'all')
            ? button('Clear filters', 'x-lg', () => { state.q = ''; state.filter = 'all'; rerender(); })
            : null),
      daemonCard(data.daemon),
    ];
  },
};
