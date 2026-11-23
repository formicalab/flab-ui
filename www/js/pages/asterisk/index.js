// Asterisk page (route #asterisk): the PBX of the router, read only. Data comes from the flab.asterisk plugin (rpcd/ucode/flab.asterisk.uc).
//   Overview       is the daemon up, key counts, what needs attention, the daemon card, recent warnings and errors   (flab.asterisk status)
//   PJSIP          outbound registrations, endpoints, contacts, transports, channels                                (flab.asterisk pjsip, endpoint)
//   Dialplan       the loaded dialplan: Browser, Routing map, Number tester                                         (flab.asterisk dialplan, resolve)
//   Configuration  the configuration files, secrets hidden                                                          (flab.asterisk config)
// Only the open tab is polled: Overview and PJSIP every 5 s, the Dialplan every 30 s, the Configuration not at all (Refresh reads it again).
// The view state lives in state.js so it survives the redraw on every poll.
import { ubus, optional } from '../../core/ubus.js';
import { emptyState } from '../../core/ui.js';
import { pauseControl, refreshControl, searchControl, selectControl, tabsControl } from '../../core/controls.js';
import { buildMap } from './dialplanmodel.js';
import { recordRtt } from './pjsipmodel.js';
import { overviewView } from './overview.js';
import { pjsipView } from './pjsip.js';
import { browseView, dialplanTiles } from './dialplan.js';
import { mapView } from './map.js';
import { sources, testerView } from './tester.js';
import { configView, loadConfig } from './config.js';
import { bind, rtt, state } from './state.js';

const TABS = [['overview', 'Overview'], ['pjsip', 'PJSIP'], ['dialplan', 'Dialplan'], ['config', 'Configuration']];
const DIALPLAN_VIEWS = [['browse', 'Browser'], ['map', 'Routing map'], ['test', 'Number tester']];

// Reads what the open tab shows.
async function load() {
  switch (state.tab) {
    case 'pjsip': {
      const p = await ubus('flab.asterisk', 'pjsip');
      recordRtt(rtt, p.available ? p : null);
      return { tab: 'pjsip', p };
    }
    case 'dialplan': {
      const [dp, pjsip] = await Promise.all([ubus('flab.asterisk', 'dialplan'), optional(ubus('flab.asterisk', 'pjsip'))]);
      return { tab: 'dialplan', dp, pjsip };
    }
    case 'config': return { tab: 'config', cfg: await loadConfig() };
    default: return { tab: 'overview', s: await ubus('flab.asterisk', 'status') };
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
  return [dialplanTiles(dp), browseView(dp, map)];
}

// Page object registered in pages/index.js (contract documented there).
export default {
  interval: () => state.tab === 'overview' || state.tab === 'pjsip' ? 5000 : 30000,
  css: ['css/drawer.css', 'css/asterisk.css'],
  // The Configuration tab is not polled; the number tester must not lose what is being typed.
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
    pjsipNodes.push(search, role.node);
    dialplanNodes.push(views.node);
    // Shows the controls of the open tab only; the extension filter belongs to the Browser view.
    function show() {
      pjsipNodes.forEach(n => { n.hidden = state.tab !== 'pjsip'; });
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
    return {
      nodes: [tabs.node, views.node, search, role.node, dsearch, pauseControl(state), refreshControl(reload)],
      update() {
        tabs.setOptions(TABS);
        views.setOptions(DIALPLAN_VIEWS);
        show();
      },
    };
  },

  view(data) {
    switch (data.tab) {
      case 'pjsip': return pjsipView(data.p);
      case 'dialplan': return dialplanTab(data);
      case 'config': return configView(data.cfg);
      default: return overviewView(data.s);
    }
  },
};
