// Routing page (route #routing): the kernel's routing state and, when BIRD is installed, BGP.
//
// Routes combines live routing and static-route editing; BGP has its own optional tab.
//   Routes       the next-hop lookup, the policy rules and routing tables, and the route list (flab.routing, see
//                rpcd/ucode/flab.routing.uc; the logical interface names come from `network.interface dump`)
//   BGP          the BIRD state (flab.bgp; the sections are in bgp/): sessions, learned and announced routes
// Only the open tab is polled. The BGP tab is offered only when the router has birdc. A forwarded lookup answer offers
// Ping and Traceroute buttons that open the Toolbox page with the destination filled in.
//
// The view state lives here so it survives the redraw on every poll: the open tab, the filters and sorts of the
// tabs, the lookup form and the lookup that is currently shown (once a query is set, every poll repeats it).
import { AuthError, ubus, optional } from '../../core/ubus.js';
import { tile, tiles, healthBanner } from '../../core/ui.js';
import { searchControl, selectControl, pauseControl, refreshControl, toggleControl, tabsControl } from '../../core/controls.js';
import { loadBgp, peerOptions, bgpView } from './bgp/tab.js';
import { lookupCard } from './lookup.js';
import { loadStatic, staticEditor, staticTiles, staticView } from './static.js';
import { routeInventory } from './static-model.js';
import { routesCard, rulesCard, tablesCard, howCard } from './tables.js';
import { defaultRoutes, findings, interfaceNames, isKernelRule, routeKey, tableLabel, tablesOf } from './model.js';

const state = {
  tab: 'routes', paused: false,
  // BGP tab: routes filter text, selected peer, best paths only, routes table sort, whether every path is drawn.
  q: '', peer: 'all', best: false, sort: { key: 'prefix', dir: 1 }, bgpAll: false,
  // BGP configuration card: folded, scroll position of the file box, the block to jump to and the one highlighted, the last
  // syntax check, and which source folds of the peer cards are open.
  cfgFolded: true, cfgScroll: 0, cfgJump: null, cfgBlock: null, cfgCheck: null, cfgOpen: new Set(),
  // BIRD protocols card: which protocols have their own routes shown or hidden (protocol name -> open); absent = the default.
  protoOpen: new Map(),
  // The groups of BGP sessions that the protocols diagram shows one by one (a set of group keys); absent = one lane for the group.
  flowOpen: new Set(),
  // Routes tab: route filter text, address family ('all', '4', '6'), table ('all' or a name), route list sort,
  // whether the whole list is drawn, the lookup form, the active lookup query and the form's error.
  rq: '', family: 'all', table: 'all', rsort: { key: 'prefix', dir: 1 }, all: false,
  form: { dst: '', src: '', iif: '' }, query: null, formError: null,
  // Whether the "How the kernel picks a route" card is folded (kept across the redraws of the poll); folded at first, since
  // it is a reference rather than something to read on every visit.
  howFolded: true,
  // Whether the "What the kernel said" fold of the lookup answer is open (kept across the redraws of the poll).
  rawOpen: false,
  // Set by the command-bar controls: redraw from the cached data, poll again (used by the lookup form).
  rerender: () => {}, reload: () => {},
};

// Whether BIRD is installed, from the last Routes poll (it decides whether the BGP tab is offered).
let hasBird = false;

// Asks the kernel about a query. A failure (an ACL that was not granted, an old plugin) becomes an answer the
// card shows instead of failing the whole page; an expired session is still raised.
const ask = query => ubus('flab.routing', 'lookup', query).catch(e => {
  if (e instanceof AuthError) throw e;
  return { ok: false, error: e.message, dst: query.dst };
});

// Reads what the open tab shows: the routing state, the interface dump (for logical names) and the lookup on the
// Routes tab, the BIRD state on the BGP tab.
async function load() {
  if (state.tab === 'bgp') return { tab: 'bgp', bgp: await loadBgp() };
  const [status, dump, lookup] = await Promise.all([
    ubus('flab.routing', 'status'),
    optional(ubus('network.interface', 'dump')),
    state.query ? ask(state.query) : null,
  ]);
  hasBird = Boolean(status.bird);
  const configured = await loadStatic({ status, dump });
  return { tab: 'routes', status, dump, lookup, configured, inventory: routeInventory(status, configured) };
}

//#region The Routes tab

// A tile for the default route of one family: its interface (or device) as the value, the next hop underneath.
function defaultTile(s, family, names) {
  const routes = defaultRoutes(s, family);
  const label = `IPv${family} default route`;
  if (!routes.length) return tile(label, 'none', family === 4 ? 'nothing leads to unknown addresses' : 'no IPv6 connectivity beyond the LAN', family === 4 ? 'text-danger' : '');
  const r = routes[0];
  const hop = r.nexthops[0];
  const dev = hop?.dev ?? null;
  const more = routes.length > 1 ? ` · ${routes.length - 1} more` : '';
  if (!hop) return tile(label, r.type, `matches everything${more}`, 'text-danger');
  return tile(label, names.get(dev) ?? dev ?? '–', `${hop.via ? `via ${hop.via}` : 'directly'}${dev && names.get(dev) && names.get(dev) !== dev ? ` · ${dev}` : ''}${more}`);
}

// The summary tiles of the Routes tab: the kernel's, then the static routes' (`extra`, from static.js).
function routeTiles(s, names, extra) {
  const main = s.routes.filter(r => r.table === 'main');
  const tables = tablesOf(s);
  const multipath = main.filter(r => r.nexthops.length > 1).length;
  const custom = s.rules.filter(r => !isKernelRule(r)).length;
  return tiles(
    defaultTile(s, 4, names),
    defaultTile(s, 6, names),
    tile('Routes in the main table', String(main.length), `${main.filter(r => r.family === 4).length} IPv4 · ${main.filter(r => r.family === 6).length} IPv6`),
    tile('Routing tables', String(tables.length), tables.map(t => t.name).join(', ')),
    tile('Policy rules', String(s.rules.length), custom ? `${custom} added beyond the kernel's own` : 'only the kernel\'s own'),
    tile('Multipath routes', String(multipath), 'load-shared over several next hops'),
    ...extra);
}

// The nodes of the Routes tab. `rerender` redraws from the cached data and also syncs the command-bar selectors
// with the state the cards change.
function routesView(data) {
  const rerender = state.rerender;
  const s = data.status;
  const names = interfaceNames(data.dump);
  const banner = healthBanner(findings(s), 'The routing tables look healthy.');
  const staticTop = staticTiles(data.configured);
  if (!s.available) return [...(staticTop.length ? [tiles(...staticTop)] : []), banner, ...staticView(data.configured, rerender), routesCard(data.inventory, state, rerender, names, null)];
  const devices = [...new Set([...names.keys(), ...s.routes.flatMap(r => r.nexthops.map(n => n.dev))].filter(Boolean))].sort();
  const hit = state.query && data.lookup?.match ? routeKey(data.lookup.match) : null;
  return [
    routeTiles(s, names, staticTop),
    banner,
    lookupCard(data, state, devices, names),
    howCard(state.howFolded, folded => { state.howFolded = folded; }),
    // In lookup order: the rules, then the static routes (entries of the tables the rules consult), then the tables overview.
    rulesCard(s),
    ...staticView(data.configured, rerender),
    tablesCard(data.inventory, state, rerender),
    routesCard(data.inventory, state, rerender, names, hit),
  ];
}

//#endregion

// Page object registered in pages/index.js (contract documented there).
export default {
  interval: 5000,
  css: ['css/forms.css', 'css/bgp.css', 'css/routing.css', 'css/drawer.css'],
  // Polling stops while the lookup form is being typed in, because the redraw would take the focus away, and while the
  // Static-route editor holds unsaved edits, a focused control or a save in progress.
  isPaused: () => state.paused || Boolean(document.activeElement?.closest?.('.rt-lookup')) || (state.tab === 'routes' && staticEditor.paused('.rt-static')),

  load,

  // Command-bar controls are created once per visit; `update` runs after every load so the tab strip, the table
  // selector and the peer selector follow what the router has. Each tab shows its own filters.
  controls({ rerender, reload }) {
    const routesNodes = [], bgpNodes = [];
    // Shows the controls of the active tab and hides those of the other.
    const show = () => { routesNodes.forEach(n => { n.hidden = state.tab !== 'routes'; }); bgpNodes.forEach(n => { n.hidden = state.tab !== 'bgp'; }); };
    const tabs = tabsControl(state, 'tab', () => { state.all = false; state.bgpAll = false; show(); reload(); });
    const family = selectControl(state, 'family', rerender, 'Address family');
    family.setOptions([['all', 'IPv4 and IPv6'], ['4', 'IPv4 only'], ['6', 'IPv6 only']]);
    const table = selectControl(state, 'table', rerender, 'Routing table');
    table.setOptions([['all', 'All tables'], ['main', 'main table']]);
    // The cards also change the table (a click on one of the tables, "Show this table"); the selector follows.
    state.rerender = () => { table.node.value = state.table; family.node.value = state.family; rerender(); };
    state.reload = reload;
    const peer = selectControl(state, 'peer', rerender, 'Peer');
    const rsearch = searchControl(state, 'rq', rerender, 'Filter routes…');
    const bsearch = searchControl(state, 'q', rerender, 'Filter paths…');
    const best = toggleControl(state, 'best', ['Best paths only', 'All paths'], rerender);
    routesNodes.push(rsearch, family.node, table.node);
    bgpNodes.push(bsearch, peer.node, best);
    show();
    // The tabs offered: BGP only on a router with BIRD.
    const tabOptions = () => [['routes', 'Routes'], ...(hasBird ? [['bgp', 'BGP']] : [])];
    // The review banner for static-route edits.
    const banner = staticEditor.attach(reload);
    return {
      nodes: [tabs.node, rsearch, family.node, table.node, bsearch, peer.node, best, pauseControl(state), refreshControl(reload), banner],
      update(data) {
        tabs.setOptions(tabOptions());
        if (data.tab === 'routes') {
          table.setOptions([['all', 'All tables'], ...tablesOf(data.inventory).map(t => [t.name, tableLabel(t.name, data.status.table_ids)])]);
        } else if (data.tab === 'bgp') {
          peer.setOptions(peerOptions(data.bgp));
        }
        show();
      },
    };
  },

  view(data, rerender) {
    if (data.tab === 'bgp') return bgpView(data.bgp, state, rerender);
    return routesView(data);
  },
};
