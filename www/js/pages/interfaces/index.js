// Devices and Interfaces page (route #interfaces): the network board. How the network is built on one screen. The page has two views, chosen by the tabs
// in the command bar: the board (below) and the connected devices (connected/index.js). The ports and the radios are not edited here: their cards link to
// the Ethernet ports and the Wi-Fi radios pages, which read and change that hardware.
//
//   Ports and radios  ->  Devices (bridges, VLANs)  ->  Interfaces (protocol, addresses)  ->  Firewall zones and services
//
// boardmodel.js resolves the lanes and the connections between their cards from the flab.network devices, netifd's interface dump, the radios
// and the editor's draft; board.js draws them. A click on an interface, a device or a zone opens it in the drawer (core/drawer.js) on the right, with the
// editing panel from panels.js or a read-only recap (a firewall zone); a click on a port or a radio goes to its hardware page. Everything is edited through
// one shared draft (editor.js): the review banner in the command bar lists the changes and "Save and apply" applies them with the rollback countdown. The
// page redraws on every poll and after every edit; the open panel is rebuilt each time and keeps its scroll position and focus. Polling is paused
// while a panel for an editable item is open, so the form is never replaced under the user's hands.
import { h } from '../../core/dom.js';
import { tile, tiles, healthBanner, button, muted } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { ubus, optional } from '../../core/ubus.js';
import { pauseControl, refreshControl, tabsControl } from '../../core/controls.js';
import { openDrawer } from '../../core/drawer.js';
import { bridgeFindings } from '../network/util.js';
import { connected } from '../connected/index.js';
import { buildBoard, editSource } from './boardmodel.js';
import { boardView } from './board.js';
import { livePanel, zonePanel } from './livepanel.js';
import { editContext, editNotes, editor, loadNetworkEdit, safetyNote } from './editor.js';
import { addDevice } from './model.js';
import * as panels from './panels.js';
import { wizardOpen } from './wizard.js';

// Module-level so the Pause button state, the chosen view and the open panel survive the redraw on every poll. `tab` is the view ('board' or 'connected'),
// `open` is the id of the open board item (or 'globals'), `handle` the drawer, `editable` whether the open panel holds a form.
const state = { tab: 'board', paused: false, open: null, handle: null, editable: false };

// The views, as the tabs offer them.
const TABS = [['board', 'Board'], ['connected', 'Connected devices']];

// The tab strip of the command bar.
let tabs = null;
// What the current view was built from, for the handlers of the board and the drawer.
const cur = { board: null, ctx: null, data: null, node: null };

// The shell's redraw and reload functions, handed over by controls().
const shell = { rerender: () => {}, reload: () => {} };

// KPI tiles over the logical interfaces, devices and radios.
function summary(board) {
  const s = board.stats;
  return tiles(
    tile('Interfaces up', `${s.interfacesUp} / ${s.interfaces}`, s.interfaces - s.interfacesUp ? `${s.interfaces - s.interfacesUp} down or pending` : 'all configured interfaces', s.interfaces - s.interfacesUp ? 'text-warning' : 'text-success'),
    tile('Bridges', s.bridges, 'devices grouping ports'),
    tile('VLAN devices', s.vlans, s.vlanNames.join(', ') || 'none'),
    tile('Protocol devices', s.protocolDevices, 'PPPoE sessions and tunnels'),
    tile('Tunnels', s.tunnels, 'interfaces with a device of their own'),
    tile('Radios', `${s.radiosUp} / ${s.radios}`, s.bands.join(', ') || 'none'),
    tile('Wireless interfaces', s.wireless, `${s.wireless - s.mesh} Wi-Fi, ${s.mesh} mesh`));
}

// The icon of the drawer for an item.
const drawerIcon = item => icon(item?.kind === 'zone' ? 'shield-check' : item?.kind === 'interface' ? 'diagram-3' : item?.kind === 'device' && item.type === 'bridge' ? 'diagram-2' : item?.kind === 'device' ? 'ethernet' : 'gear', 20);

// The panel for the open item: { title, subtitle, body, footer, form, icon } (`form` is true when the panel holds editing controls), or null.
function panelFor(id) {
  const { board, ctx, data } = cur;
  if (id === 'globals') {
    const p = ctx ? panels.globalsPanel(ctx) : { title: 'Network-wide settings', subtitle: 'Not available', body: h('div', { className: 'nb-panel' }, muted('This router does not offer the global network options to this login.')), footer: [] };
    return { ...p, form: Boolean(ctx), icon: icon('gear', 20) };
  }
  const item = board.items.get(id);
  // Wi-Fi interfaces, ports and radios have no drawer: their cards link to the page that edits them.
  if (!item || item.kind === 'wifi' || item.kind === 'mesh' || item.kind === 'port' || item.kind === 'radio') return null;
  let p = null;
  if (ctx && item.kind === 'interface' && item.section && ctx.draft.ifaces[item.section]) p = panels.interfacePanel(ctx, item.section);
  else if (ctx && item.kind === 'device' && item.type !== 'unknown') p = panels.devicePanel(ctx, item.section ? { id: item.section } : { name: item.name });
  const form = Boolean(p);
  p ??= item.kind === 'zone' ? zonePanel(item) : livePanel(item, data);
  return { ...p, form, icon: drawerIcon(item) };
}

// The control the keyboard focus is on inside the drawer, as a key into the editing context's `inputs` (and, for a box that holds several controls,
// which one of them), so it can be focused again after a redraw replaced it.
function focusedInput(handle, inputs) {
  const a = document.activeElement;
  if (!a || !handle?.el.contains(a)) return null;
  for (const [key, v] of Object.entries(inputs)) {
    const list = [v].flat();
    for (let index = 0; index < list.length; index++) {
      const el = list[index];
      if (!el) continue;
      if (el === a) return { key, index, sub: null, from: a.selectionStart, to: a.selectionEnd };
      if (el.contains?.(a)) return { key, index, sub: [...el.querySelectorAll('input, select, textarea, button')].indexOf(a), from: null, to: null };
    }
  }
  return null;
}

// Puts the focus back on the control `at` (focusedInput's answer) in the rebuilt panel.
function restoreFocus(at, inputs) {
  if (!at) return;
  const el = [inputs[at.key]].flat()[at.index];
  const target = at.sub == null ? el : [...(el?.querySelectorAll?.('input, select, textarea, button') ?? [])][at.sub];
  if (!target) return;
  target.focus({ preventScroll: true });
  if (at.from != null && target.setSelectionRange) { try { target.setSelectionRange(at.from, at.to); } catch { /* an input type without a selection */ } }
}

// Shows the panel of the open item in the drawer: opens the drawer, or rebuilds the content of the open one keeping its scroll position and focus.
// `before` is the focus position of the previous view. A vanished item (saved, discarded, removed) closes the drawer.
function renderDrawer(before = null) {
  if (!state.open) return closeDrawer();
  const panel = panelFor(state.open);
  if (!panel) return closeDrawer();
  state.editable = panel.form && Boolean(cur.ctx?.canEdit);
  if (state.handle?.isOpen()) {
    state.handle.setTitle(panel.title, panel.subtitle);
    state.handle.setBody(panel.body);
    state.handle.setFooter(panel.footer);
  } else {
    const handle = openDrawer({
      title: panel.title, subtitle: panel.subtitle, icon: panel.icon, body: panel.body, footer: panel.footer,
      // Closing by any way forgets the open item and the highlight.
      onClose: () => { if (state.handle === handle) { state.handle = null; state.open = null; state.editable = false; cur.node?.select(null); } },
    });
    state.handle = handle;
  }
  if (before && cur.ctx) restoreFocus(before, cur.ctx.inputs);
}

// Closes the drawer, if open.
function closeDrawer() {
  const handle = state.handle;
  state.open = null;
  state.editable = false;
  state.handle = null;
  handle?.close();
  cur.node?.select(null);
}

// Opens the item `id` (a board item or 'globals') in the drawer and highlights its chain.
function openItem(id) {
  state.open = id;
  cur.node?.select(id === 'globals' ? null : id);
  renderDrawer();
}

// The editing actions of the board headers.
function actionsOf(ctx) {
  return {
    canEdit: ctx.canEdit,
    // Adds a device of a kind to the draft and opens it.
    addDevice(kind) {
      const id = addDevice(ctx.base, ctx.draft, kind);
      state.open = `dev:${id}`;
      ctx.touched();
      ctx.redraw();
    },
    // Opens the wizard; what it adds to the draft opens in the drawer.
    addNetwork() {
      panels.openWizard(ctx, done => {
        if (done?.iface) state.open = `if:${done.iface}`;
        ctx.touched();
        ctx.redraw();
      });
    },
  };
}

// The board node for a board model: a click opens the item in the drawer; the header actions exist when there is an editor.
const makeNode = (board, ctx) => boardView({ board, selected: state.open === 'globals' ? null : state.open, onOpen: item => openItem(item.id), actions: ctx ? actionsOf(ctx) : null });

// Rebuilds the board from the draft as it is now, in place, after an edit in the open panel (a typed name, a chosen device, a ticked port), so
// the cards and connectors follow the form at once; the panel itself is not touched.
function refreshBoard() {
  const { ctx, data, node } = cur;
  if (!ctx || !node?.isConnected) return;
  const board = buildBoard(data, editSource(ctx.base, ctx.draft));
  const next = makeNode(board, ctx);
  node.replaceWith(next);
  Object.assign(cur, { board, node: next });
}

export default {
  interval: 5000,
  css: ['css/forms.css', 'css/netedit.css', 'css/board.css', 'css/drawer.css', ...connected.css],
  // Board: no polling over unsaved edits, a focused control of the form, a save in progress, an open panel with a form or an open wizard (it adds to the
  // draft it was opened on, which a poll would replace).
  isPaused: () => state.paused || (state.tab === 'connected' ? connected.isPaused() : state.editable || wizardOpen() || editor.paused('.ne-form')),

  // The data of the chosen view. The flab.radio and flab.mesh calls of the board are optional: without them the page works with the wired layers only, and
  // bridges show no mesh peers; so is the editable config. The data says which view it is for, so a redraw between a tab click and its load shows nothing stale.
  load: async () => {
    if (state.tab === 'connected') return { tab: 'connected', ...(await connected.load()) };
    const [data, hw, mesh] = await Promise.all([loadNetworkEdit(), optional(ubus('flab.radio', 'status')), optional(ubus('flab.mesh', 'status'))]);
    return { tab: 'board', ...data, radios: hw?.radios ?? [], mesh };
  },

  controls({ rerender, reload }) {
    shell.rerender = rerender;
    shell.reload = reload;
    closeDrawer();
    tabs = tabsControl(state, 'tab', () => { closeDrawer(); reload(); });
    tabs.setOptions(TABS);
    const filters = connected.attach(rerender);
    connected.setActive(state.tab === 'connected');
    return {
      nodes: [tabs.node, filters, pauseControl(state), refreshControl(reload), editor.attach(reload)],
      // The filter box and the radio selector show on the Connected devices view only.
      update: data => { connected.setActive(data.tab === 'connected'); if (data.tab === 'connected') connected.update(data); },
    };
  },

  // The connected devices; or the board: summary tiles, the findings banner, the board and, over it, the drawer of the open item.
  view(data, rerender) {
    shell.rerender = rerender;
    if (data.tab !== state.tab) return [h('div', { className: 'text-center muted p-5' }, h('div', { className: 'spinner-border spinner-border-sm' }))];
    if (state.tab === 'connected') return connected.view(data, rerender);
    const before = focusedInput(state.handle, cur.ctx?.inputs ?? {});
    const ctx = editContext(data, rerender, shell);
    const board = buildBoard(data, ctx ? editSource(ctx.base, ctx.draft) : null);
    const node = makeNode(board, ctx);
    Object.assign(cur, { board, ctx, data, node });
    // The wizard asks for the page's latest context when it finishes (a redraw makes a new one).
    if (ctx) ctx.current = () => cur.ctx ?? ctx;
    ctx?.refresh(refreshBoard);
    const page = [
      summary(board),
      healthBanner([...board.findings, ...bridgeFindings(data.net)], 'All interfaces are up.'),
      ...editNotes(data),
      ctx ? h('div', { className: 'nb-toolbar' }, button('Network-wide settings', 'gear', () => openItem('globals')), muted('The ULA prefix, packet steering and other options that apply to the whole network configuration.')) : null,
      h('p', { className: 'muted small nb-legend' },
        h('b', {}, 'How to read the board: '), 'a network device (a port, a Wi-Fi interface, a bridge or a VLAN device) carries frames; an interface puts a protocol and addresses on one device; the firewall zone groups interfaces. ',
        'Click an interface, a device or a zone to see and change it; a port or a radio opens the page of that hardware. Hover a card to see what it is connected to.'),
      node,
      ctx ? safetyNote() : null,
    ];
    // The panel is rebuilt from the new draft (it registers its controls in ctx.inputs), then the errors are marked on them.
    renderDrawer(before);
    ctx?.sync();
    return page;
  },
};