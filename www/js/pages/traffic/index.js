// The Traffic page (route #traffic): where the bandwidth goes. Four tabs share the page and its command bar:
//   Live         the rate of every interface with a short history, and the totals (flab.network, the counters the
//                Ethernet ports view uses, plus flab.traffic status for the connection count)
//   Connections  the connection tracking table: who talks to whom, NAT, state, size (flab.traffic connections)
//   Usage        the data each host moved in an nlbwmon accounting period (flab.traffic usage), offered only when the
//                router has nlbw
//   Settings     the accounting settings of nlbwmon (/etc/config/nlbwmon), editable through UCI (settings.js); offered
//                whenever the plugin answers, and says so when nlbwmon is not installed
// Only the open tab is polled, every 3 s. The connection table, the usage and the settings are heavier to compute, so those
// tabs reuse their last answer until it is 10 s (connections, settings) or 30 s (usage) old, unless the request changed or
// Refresh was pressed.
//
// The view state lives here so it survives the redraw on every poll: the open tab and each tab's filters and sorts.
import { optional, ubus } from '../../core/ubus.js';
import { pauseControl, refreshControl, searchControl, selectControl, tabsControl } from '../../core/controls.js';
import { loadWired } from '../network/shared.js';
import { liveView } from './live.js';
import { connectionsView } from './connections.js';
import { usageView } from './usage.js';
import { loadSettings, settingsEditor, settingsView } from './settings.js';
import { filterError, periodOptions, protocolOptions } from './model.js';

const state = {
  tab: 'live', paused: false,
  // Live tab: whether every interface row is drawn.
  liveAll: false,
  // Connections tab: filter text, protocol, scope (all, internet, internal), sort, rows to fetch (a string, as selects
  // hold strings) and whether every fetched row is drawn.
  q: '', proto: 'all', scope: 'all', sort: 'bytes', limit: '300', all: false,
  // Usage tab: accounting period, host filter, host sort and whether every host row is drawn.
  period: 'current', hq: '', hsort: { key: 'total', dir: -1 }, hall: false,
  // Set by the command-bar controls: filter the connection table to one host (the top lists call it).
  pick: () => {},
};

// How old the last answer of a tab may be before a poll asks the router again (Live always does).
const MIN_AGE = { connections: 10000, usage: 30000, settings: 10000 };
// The last answer of each tab with the request it answered and when it arrived.
const cache = new Map();
// Set by the Refresh button so the next poll skips the cache.
let forced = false;

// The Connections tab: the router's status (for the tab strip) and the connection table for the current filters. A
// filter the router would refuse is not sent; the answer then carries the reason.
async function loadConnections() {
  const bad = filterError(state.q.trim());
  const [status, conn] = await Promise.all([
    ubus('flab.traffic', 'status'),
    bad ? { ok: false, error: bad } : ubus('flab.traffic', 'connections', { q: state.q.trim(), limit: Number(state.limit), sort: state.sort, proto: state.proto, scope: state.scope }),
  ]);
  return { tab: 'connections', status, conn };
}

// The Usage tab: the status, the stored periods and, when nlbwmon runs, the hosts (by MAC and IP) and the protocols of
// the selected period. A period that is no longer stored falls back to the current one.
async function loadUsage() {
  const [status, periods] = await Promise.all([ubus('flab.traffic', 'status'), ubus('flab.traffic', 'usage_periods')]);
  if (!status.nlbw || !periods.running) return { tab: 'usage', status, periods };
  const period = state.period === 'current' || periods.periods.includes(state.period) ? state.period : 'current';
  state.period = period;
  const [hosts, l7] = await Promise.all([ubus('flab.traffic', 'usage', { period, group: 'mac,ip' }), ubus('flab.traffic', 'usage', { period, group: 'layer7' })]);
  return { tab: 'usage', status, periods, period, hosts, l7 };
}

// Reads what the open tab shows. Live: the interface counters and the status (optional, so the tab still works when the
// plugin is not installed). The others reuse a recent answer to the same request.
async function load() {
  const force = forced;
  forced = false;
  if (state.tab === 'live') {
    const [wired, status] = await Promise.all([loadWired(), optional(ubus('flab.traffic', 'status'))]);
    return { tab: 'live', wired, status };
  }
  const key = state.tab === 'connections' ? JSON.stringify([state.q, state.proto, state.scope, state.sort, state.limit]) : state.tab === 'usage' ? state.period : state.tab;
  const hit = cache.get(state.tab);
  if (!force && hit && hit.key === key && Date.now() - hit.at < MIN_AGE[state.tab]) return hit.data;
  const data = state.tab === 'connections' ? await loadConnections() : state.tab === 'usage' ? await loadUsage() : await loadSettings();
  cache.set(state.tab, { key, at: Date.now(), data });
  return data;
}

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'traffic',
  label: 'Traffic',
  title: 'Traffic',
  icon: 'activity',
  interval: 3000,
  css: ['css/forms.css', 'css/traffic.css'],
  isPaused: () => state.paused || (state.tab === 'settings' && settingsEditor.paused('.nlbw-form')),

  load,

  // Command-bar controls are created once per visit; `update` runs after every load so the tab strip and the selectors
  // follow what the router has. Each tab shows its own filters.
  controls({ rerender, reload }) {
    const nodes = { connections: [], usage: [] };
    // Shows the controls of the open tab and hides the others.
    const show = () => { for (const [tab, list] of Object.entries(nodes)) list.forEach(n => { n.hidden = state.tab !== tab; }); };
    const tabs = tabsControl(state, 'tab', () => { state.all = false; state.hall = false; show(); reload(); });
    tabs.setOptions([['live', 'Live']]);

    // A filter that changes what the router must compute waits for a pause in typing (`later`), then asks again; a
    // selector asks at once (`again`). A new request starts at the first rows.
    let timer = null;
    // Asks again after a pause in typing.
    const later = () => { clearTimeout(timer); timer = setTimeout(() => { state.all = false; reload(); }, 350); };
    // Asks again at once, starting at the first rows.
    const again = () => { state.all = false; reload(); };
    const search = searchControl(state, 'q', later, 'Filter: host, name, port, state…');
    const proto = selectControl(state, 'proto', again, 'Protocol');
    proto.setOptions([['all', 'All protocols']]);
    const scope = selectControl(state, 'scope', again, 'Which connections');
    scope.setOptions([['all', 'All traffic'], ['internet', 'Internet traffic'], ['internal', 'Internal only']]);
    const sort = selectControl(state, 'sort', again, 'Order');
    sort.setOptions([['bytes', 'Most traffic first'], ['packets', 'Most packets first'], ['timeout', 'Longest timeout first']]);
    const limit = selectControl(state, 'limit', again, 'Rows to fetch');
    limit.setOptions([['300', '300 rows'], ['1000', '1,000 rows'], ['2000', '2,000 rows']]);
    const period = selectControl(state, 'period', () => { state.hall = false; reload(); }, 'Accounting period');
    period.setOptions([['current', 'Current period']]);
    const hosts = searchControl(state, 'hq', rerender, 'Filter hosts…');

    // A click on a host in the top lists filters the table to it (`state.pick`).
    const input = search.querySelector('input');
    state.pick = addr => { state.q = addr; input.value = addr; again(); };

    nodes.connections.push(search, proto.node, scope.node, sort.node, limit.node);
    nodes.usage.push(period.node, hosts);
    show();
    // The review banner of the Settings tab; saving or discarding there must not be answered from the cache.
    const banner = settingsEditor.attach(() => { cache.delete('settings'); reload(); });
    return {
      nodes: [tabs.node, ...nodes.connections, ...nodes.usage, pauseControl(state), refreshControl(() => { forced = true; reload(); }), banner],
      // Offers the tabs the router supports and fills the selectors from the last answer.
      update(data) {
        const status = data.status;
        const options = [['live', 'Live']];
        if (status && status.conntrack !== false) options.push(['connections', 'Connections']);
        if (status?.nlbw) options.push(['usage', 'Usage']);
        if (status) options.push(['settings', 'Settings']);
        tabs.setOptions(options);
        if (data.tab === 'connections' && data.conn?.ok) proto.setOptions(protocolOptions(data.conn.aggregates));
        if (data.tab === 'usage' && data.periods?.running) period.setOptions(periodOptions(data.periods.periods, data.periods.current));
        show();
        // The open tab can disappear (nlbw removed): the strip fell back to another tab, so show that one.
        if (data.tab !== state.tab) reload();
      },
    };
  },

  // The nodes of the open tab for one poll; `rerender` redraws from the cached data (Show all, sorting).
  view(data, rerender) {
    if (data.tab === 'live') return liveView(data, state, rerender);
    if (data.tab === 'connections') return connectionsView(data.conn, state, rerender, state.pick);
    if (data.tab === 'settings') return settingsView(data, rerender);
    return usageView(data, state, rerender);
  },
};
