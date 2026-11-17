// WireGuard page (route #wireguard): every WireGuard interface and its peers, from the flab.wireguard plugin (UCI network + `wg show`),
// and the editor of the configuration behind them: interface settings, peers, keys (generated in the browser), and the "add a client"
// helper. Interfaces and peers are rediscovered on every poll, so a new one appears without a reload.
//
// The config is read through the plugin, which leaves out the private and pre-shared keys: the browser never receives a secret, and the key
// fields are write-only (empty keeps the stored key). Writes go through core/uci.js applyChange(): stage, apply with the rollback
// countdown, read the config back through the plugin and check that what must run runs, confirm. The controls and the review banner are
// shared with the other editing pages (core/forms.js, core/editpage.js). The page redraws on every poll, so polling is suspended while
// there is something to lose: unsaved edits, a focused control, an open dialog or a save.
import { h, sleep } from '../../core/dom.js';
import { tile, tiles, emptyState, healthBanner, button } from '../../core/ui.js';
import { optional, ubus } from '../../core/ubus.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { fmtLine, fmtSpan } from '../../core/format.js';
import { note } from '../../core/forms.js';
import { createEditor } from '../../core/editpage.js';
import { reveal } from '../../core/fold.js';
import { interfaceCard, findings, recordWireguard, rateNow } from './iface.js';
import { opened } from './edit.js';
import { generateKeyPair } from './keys.js';
import { CONFIG, addInterface, changesOf, checkApplied, draftFrom, ifaceList, isDirty, notRunning, plan, problems, readWireguard } from './model.js';

// The paused flag and whether a dialog is open; the page has no filters, so nothing else needs to survive the redraw on every poll.
const state = { paused: false, dialog: false };

// How many times, one second apart, the read-back after a save waits for what must run to run: netifd takes a moment to bring a
// tunnel up after the configuration is applied.
const SETTLE_TRIES = 8;

// Reads the status through the plugin.
const readStatus = async () => readWireguard(await ubus('flab.wireguard', 'status'));

// The draft, the review banner, saving and discarding, shared with the other editing pages (core/editpage.js). The check after a save
// reads the config through the plugin (which is also where the page gets its data), and gives a tunnel that is still starting a few
// seconds before it counts as failed, so that a configuration that really does not start is rolled back.
const editor = createEditor({
  config: CONFIG,
  readAfter: async () => {
    let after = await readStatus();
    for (let n = 1; n < SETTLE_TRIES && notRunning(editor.state.base, editor.state.draft, after).length; n++) {
      await sleep(1000);
      after = await readStatus();
    }
    return after;
  },
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: (base, draft, after) => checkApplied(after, draft, base),
});

// Summary tiles over the enabled peers of all interfaces; traffic is the sum of the live rx and tx rates.
function summary(list) {
  const peers = list.flatMap(i => i.peers.filter(p => p.enabled).map(p => ({ i, p })));
  const connected = peers.filter(({ p }) => p.state === 'connected');
  const ages = peers.map(({ p }) => p.handshake_age).filter(a => a != null);
  // Total live rate over all enabled peers in one direction (rx or tx).
  const sum = dir => peers.reduce((t, { i, p }) => t + (rateNow(i, p, dir) ?? 0), 0);
  return tiles(
    tile('Interfaces up', `${list.filter(i => i.up).length} / ${list.length}`, list.map(i => i.name).join(', ') || 'none', list.every(i => i.up || !i.enabled) ? 'text-success' : 'text-warning'),
    tile('Peers connected', `${connected.length} / ${peers.length}`, 'handshake within 3 minutes', connected.length ? 'text-success' : peers.length ? 'text-warning' : ''),
    tile('Latest handshake', ages.length ? `${fmtSpan(Math.min(...ages))} ago` : '–', ages.length ? 'most recent peer contact' : 'no peer has connected'),
    tile('Traffic now', fmtLine(sum('rx') + sum('tx')), `↓ ${fmtLine(sum('rx'))}  ↑ ${fmtLine(sum('tx'))}`));
}

// The button that adds an interface to the form, with the explanation. A new interface starts with a key made in the browser.
function addBar(ctx) {
  const add = button('Add WireGuard interface', 'plus-lg', async () => {
    const id = addInterface(ctx.data, ctx.draft);
    opened.add(`if:${id}`);
    ctx.touched();
    ctx.redraw();
    try {
      ctx.draft.interfaces[id].values.private_key = (await generateKeyPair()).privateKey;
      ctx.touched();
      ctx.redraw();
    } catch { /* the form says that a key must be pasted */ }
  }, 'btn-brand', { disabled: !ctx.canEdit });
  return h('div', { className: 'wg-addbar' }, add,
    h('span', { className: 'muted small' }, 'A new interface gets a key made in this browser. Add its address and port, then peers, and save; put the interface in a firewall zone on the Firewall page afterwards.'));
}

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'wireguard',
  label: 'WireGuard',
  title: 'WireGuard · VPN',
  icon: 'key',
  interval: 5000,
  css: ['css/forms.css', 'css/wireguard.css'],
  isPaused: () => state.paused || state.dialog || editor.paused('.wg-form'),

  // Peer counters are fed to the rate tracker before rendering; the number of changes already staged in the session is added. A router
  // without the plugin gives a page with a note.
  load: async () => {
    const raw = await optional(ubus('flab.wireguard', 'status'));
    if (!raw) return { unavailable: true, ...readWireguard(null), staged: 0 };
    const data = readWireguard(raw);
    recordWireguard(data);
    return editor.withStaged(data);
  },

  controls({ reload }) {
    return { nodes: [pauseControl(state), refreshControl(reload), editor.attach(reload)] };
  },

  view(data, rerender) {
    if (data.unavailable) return [note('bad', 'The WireGuard plugin (flab.wireguard) is not available on the router, so this page cannot show or change anything. Install or reinstall the flab-ui package and reload rpcd.')];
    const canEdit = editor.begin(data, rerender);
    const ctx = { data, draft: editor.state.draft, canEdit, inputs: {}, rerender, redraw: () => editor.redraw(), touched: () => {}, sync: () => {} };
    ctx.touched = editor.touched(ctx);
    // Called after every edit: marks the controls that hold an error and refreshes the banner. A control with an error must not stay
    // hidden in a closed panel, so those are opened.
    ctx.sync = () => editor.markErrors(ctx.inputs, canEdit, reveal);

    const items = ifaceList(data, editor.state.draft);
    const list = data.interfaces;
    const page = [
      list.length ? summary(list) : null,
      ...editor.notes(data),
      data.protoInstalled ? null : note('bad', 'The WireGuard protocol handler of netifd (the wireguard-tools package) is not installed on the router, so WireGuard interfaces cannot start. Install it (apk add wireguard-tools) before adding one.'),
      list.length ? healthBanner(list.flatMap(findings), 'All WireGuard interfaces and peers look healthy.') : null,
      items.length ? null : emptyState('No WireGuard interface is configured. Add one below, or add a network interface with protocol "wireguard".'),
      h('div', { className: 'wg-form' },
        ...items.map(item => interfaceCard(ctx, item, open => { state.dialog = open; })),
        addBar(ctx)),
    ];
    ctx.sync();
    return page.filter(Boolean);
  },
};
