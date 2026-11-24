// Asterisk page (route #asterisk): the PBX of the router, read only apart from Reload. Data comes from the flab.asterisk plugin (rpcd/ucode/flab.asterisk.uc).
//   Overview       is the daemon up, key counts, what needs attention, the daemon card, recent warnings and errors   (flab.asterisk status)
//   PJSIP          outbound registrations, endpoints, contacts, transports, channels                                (flab.asterisk pjsip, endpoint)
//   Calls          the recent calls from the cdr_csv file: when, direction, who, result, duration                    (flab.asterisk calls, pjsip)
//   Dialplan       the loaded dialplan: Browser, Routing map, Number tester                                         (flab.asterisk dialplan, resolve)
//   Configuration  the configuration files, secrets hidden                                                          (flab.asterisk config)
// The only change the page makes to the PBX is the Reload buttons at the right of the tab strip (flab.asterisk reload).
// Only the open tab is polled: Overview and PJSIP every 5 s, Calls every 10 s, the Dialplan every 30 s, the Configuration not at all (Refresh reads it again).
// The view state lives in state.js so it survives the redraw on every poll.
import { ubus, optional } from '../../core/ubus.js';
import { emptyState } from '../../core/ui.js';
import { pauseControl, refreshControl, searchControl, selectControl, tabsControl } from '../../core/controls.js';
import { buildMap } from './dialplanmodel.js';
import { recordRtt } from './pjsipmodel.js';
import { overviewView, summaryTiles } from './overview.js';
import { pjsipView } from './pjsip.js';
import { callsView } from './calls.js';
import { browseView, dialplanStats } from './dialplan.js';
import { mapView } from './map.js';
import { sources, testerView } from './tester.js';
import { configView, loadConfig } from './config.js';
import { reloadControl } from './actions.js';
import { bind, rtt, state } from './state.js';

// The live views first, then (after a gap) what the PBX is made of.
const TABS = [['overview', 'Overview'], ['calls', 'Calls'], null, ['pjsip', 'PJSIP'], ['dialplan', 'Dialplan'], ['config', 'Configuration files']];
const DIALPLAN_VIEWS = [['browse', 'Browser'], ['map', 'Routing map'], ['test', 'Number tester']];

// Reads what the open tab shows.
async function load() {
  const status = ubus('flab.asterisk', 'status');
  switch (state.tab) {
    case 'pjsip': {
      const [p, s] = await Promise.all([ubus('flab.asterisk', 'pjsip'), status]);
      recordRtt(rtt, p.available ? p : null);
      return { tab: 'pjsip', p, s };
    }
    case 'calls': {
      const [c, pjsip, s] = await Promise.all([ubus('flab.asterisk', 'calls'), optional(ubus('flab.asterisk', 'pjsip')), status]);
      return { tab: 'calls', c, pjsip, s };
    }
    case 'dialplan': {
      const [dp, pjsip, s] = await Promise.all([ubus('flab.asterisk', 'dialplan'), optional(ubus('flab.asterisk', 'pjsip')), status]);
      return { tab: 'dialplan', dp, pjsip, s };
    }
    case 'config': {
      const [cfg, s] = await Promise.all([loadConfig(), status]);
      return { tab: 'config', cfg, s };
    }
    default: return { tab: 'overview', s: await status };
  }
}

// The Dialplan tab for its three views.
function dialplanTab(data) {
  const { dp, pjsip } = data;
  if (!dp.available) return [emptyState('Asterisk is not running or does not answer, so the dialplan cannot be read.')];
  const endpoints = new Map((pjsip?.available ? pjsip.endpoints : []).map(e => [e.name, e]));
  const map = buildMap(dp, pjsip);
  map.endpointByName = endpoints;
  if (state.dpView === 'map') return mapView(dp, map, endpoints);
  if (state.dpView === 'test') return testerView(dp, map, sources(dp, endpoints));
  return [dialplanStats(dp), browseView(dp, map)];
}

// Page object registered in pages/index.js (contract documented there).
export default {
  interval: () => state.tab === 'overview' || state.tab === 'pjsip' ? 5000 : state.tab === 'calls' ? 10000 : 30000,
  css: ['css/drawer.css', 'css/asterisk.css'],
  // The Configuration files tab is not polled; the number tester must not lose what is being typed.
  isPaused: () => state.paused || state.tab === 'config' || Boolean(document.activeElement?.closest?.('.ast-tester')),

  load,

  // Command-bar controls, created once per visit: the tab strip, then the controls of each tab (shown only on that tab).
  controls({ rerender, reload }) {
    const pjsipNodes = [], dialplanNodes = [];
    const tabs = tabsControl(state, 'tab', () => { show(); reload(); });
    const views = tabsControl(state, 'dpView', () => { show(); rerender(); });
    const search = searchControl(state, 'q', rerender, 'Filter endpoints…');
    const role = selectControl(state, 'role', rerender, 'Kind of endpoint');
    role.setOptions([['all', 'All endpoints'], ['trunk', 'Trunks'], ['phone', 'Phones']]);
    const dsearch = searchControl(state, 'dq', rerender, 'Filter extensions…');
    const csearch = searchControl(state, 'cq', rerender, 'Filter calls…');
    const ckind = selectControl(state, 'ckind', rerender, 'Kind of call');
    ckind.setOptions([['all', 'All calls'], ['in', 'Incoming'], ['out', 'Outgoing'], ['internal', 'Internal'], ['missed', 'Missed']]);
    pjsipNodes.push(search, role.node);
    dialplanNodes.push(views.node);
    const callsNodes = [csearch, ckind.node];
    // Shows the controls of the open tab only; the extension filter belongs to the Browser view.
    function show() {
      pjsipNodes.forEach(n => { n.hidden = state.tab !== 'pjsip'; });
      callsNodes.forEach(n => { n.hidden = state.tab !== 'calls'; });
      dialplanNodes.forEach(n => { n.hidden = state.tab !== 'dialplan'; });
      dsearch.hidden = !(state.tab === 'dialplan' && state.dpView === 'browse');
    }
    tabs.setOptions(TABS);
    views.setOptions(DIALPLAN_VIEWS);
    show();
    // Opens a tab from another one (a context chip, a source line) with some state set.
    bind({
      rerender, reload,
      go(tab, patch) {
        Object.assign(state, patch, { tab });
        if (tab === 'config') state.lineScrolled = false;
        tabs.setOptions(TABS);
        views.setOptions(DIALPLAN_VIEWS);
        show();
        reload();
      },
    });
    const reloads = reloadControl(reload);
    return {
      nodes: [tabs.node, views.node, search, role.node, csearch, ckind.node, dsearch, reloads?.node, pauseControl(state), refreshControl(reload)].filter(Boolean),
      update(data) {
        tabs.setOptions(TABS);
        views.setOptions(DIALPLAN_VIEWS);
        show();
        reloads?.update(data);
      },
    };
  },

  // The daemon's summary tiles are the same on every tab (the shell pins them above the tabs); the overview adds them itself.
  view(data) {
    switch (data.tab) {
      case 'pjsip': return [summaryTiles(data.s), pjsipView(data.p)];
      case 'calls': return [summaryTiles(data.s), callsView(data.c, data.pjsip)];
      case 'dialplan': return [summaryTiles(data.s), dialplanTab(data)];
      case 'config': return [summaryTiles(data.s), configView(data.cfg)];
      default: return overviewView(data.s);
    }
  },
};
