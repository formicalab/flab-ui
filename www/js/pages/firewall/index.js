// Firewall page (route #firewall): the zones and what may flow between them, the traffic rules and port forwards, each with the live hit counters
// nftables keeps, and the editor of /etc/config/firewall (firewall4) behind them. The live state comes from
// `nft -j list ruleset` through the flab.firewall plugin and is rediscovered on every poll; the configuration is read with rpcd's `uci` object (it
// holds no secrets), so every section is known by its own name.
//
// Editing: a zone, a traffic rule or a port forward is added or edited in a dialog (itemdialog.js; the zone's dialog also holds its forwardings), a
// forwarding can also be switched by clicking a cell of the matrix, rules and port forwards are enabled, disabled, moved and removed in their tables,
// and the global defaults are edited in their card. All of it goes
// into a draft (the cards show the draft laid over the live state, see view.js) that the review banner saves: stage, apply with the rollback countdown,
// read the config back and check that nftables still has the ruleset loaded, confirm. The model is in edit.js (draft), validate.js, plan.js and
// view.js; this file wires them to the cards. A login that may not read or write the config, or a reply of the plugin that does not match the config,
// gets the read-only page.
import { tile, tiles, emptyState, healthBanner, button } from '../../core/ui.js';
import { h, sleep } from '../../core/dom.js';
import { can, optional, ubus } from '../../core/ubus.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { fmtNum } from '../../core/format.js';
import { createEditor } from '../../core/editpage.js';
import { reveal } from '../../core/fold.js';
import { openDialog } from '../../core/modal.js';
import { note } from '../../core/forms.js';
import { uci } from '../../core/uci.js';
import { matrixCard } from './matrix.js';
import { zonesCard } from './zones.js';
import { rulesCard, redirectsCard } from './rules.js';
import { defaultsCard } from './defaults.js';
import { openItemDialog } from './itemdialog.js';
import { findings, recordFirewall, packetsPerSec, fmtPps, wanZones } from './util.js';
import { CONFIG, adminNetworks, commitItem, draftFrom, findItem, moveItem, readFirewall, removeItem, removeZone, restoreItem, restoreZone, setForwardLinks, toggleForwarding, zoneName, live } from './edit.js';
import { lockoutWarnings, problems } from './validate.js';
import { changesOf, checkApplied, isDirty, notLoaded, plan } from './plan.js';
import { consistent, effectiveView } from './view.js';

// What has to survive the redraw on every poll besides the draft: the paused flag, and whether a dialog is open (nothing is redrawn under it).
const state = { paused: false, dialog: false };

// Where the administrator is reaching the router from, to recognize the interface whose zone must not lose access: the host name of the address
// the page was opened with, and the port of the web interface.
const adminContext = data => ({
  host: location.hostname,
  port: Number(location.port) || (location.protocol === 'https:' ? 443 : 80),
  admin: adminNetworks(data, location.hostname),
});

// How long to wait for the firewall to load the new configuration after an apply, and how often to look.
const LOAD_WAIT_S = 12;

// Reads the config and the live state again after an apply, waiting while nftables still has the previous ruleset (the firewall reloads a moment
// after the configuration is committed).
async function readAfter() {
  const { base } = editor.state;
  let after = null;
  for (let attempt = 0; attempt < LOAD_WAIT_S; attempt++) {
    const [status, cfg] = await Promise.all([ubus('flab.firewall', 'status'), uci.get(CONFIG)]);
    after = readFirewall(status, cfg);
    if (!notLoaded(base, after)) break;
    await sleep(1000);
  }
  return after;
}

// Asks before a save that could cut the administrator off: lists the risks and resolves to true only when the user insists.
function confirmRisks(risks) {
  return new Promise(resolve => {
    let answer = false;
    const apply = button('Apply anyway', 'check2', () => { answer = true; shown.close(); }, 'btn-primary');
    const shown = openDialog({
      title: 'This change may cut you off',
      subtitle: 'Review the warnings before the router applies it',
      body: h('div', {}, h('p', {}, 'The change you are about to save may stop this page from reaching the router:'),
        h('ul', {}, risks.map(r => h('li', {}, r))),
        h('p', { className: 'muted small' }, 'If this page cannot confirm the change within 30 seconds the router puts the previous configuration back by itself. Cancel to go on editing.')),
      footer: [button('Cancel', 'x-lg', () => shown.close()), apply],
      staticBackdrop: true,
      onClose: () => resolve(answer),
    });
  });
}

// The draft, the review banner, saving and discarding, shared with the other editing pages (core/editpage.js). The check after a save reads the
// config and the live state again (readAfter), and a change that could cut the administrator off is confirmed first.
const editor = createEditor({
  config: CONFIG,
  readAfter,
  model: { draftFrom, changesOf, isDirty, problems: (data, draft) => problems(data, draft, adminContext(data)), plan },
  verify: (base, draft, after) => checkApplied(base, draft, after),
  confirmSave: async (base, draft) => {
    const risks = lockoutWarnings(base, draft, adminContext(base));
    return risks.length ? confirmRisks(risks) : true;
  },
});

// Flow-offloading mode from the firewall defaults: software flowtable, or hardware when it is also enabled.
const offloadLabel = fw => !fw.defaults.flow_offloading ? 'Off' : fw.defaults.flow_offloading_hw ? 'Hardware' : 'Software';

// Summary tiles. "Turned away from outside" sums the packets that the reject/drop chains of Internet-facing
// zones (those with NAT) refused from the zone; conntrack turns amber above 80 % of the table limit.
function summary(fw) {
  const rules = fw.rules, on = rules.filter(r => r.enabled);
  const wan = wanZones(fw);
  const blocked = wan.reduce((t, z) => t + (z.blocked_from?.packets ?? 0), 0);
  const pps = wan.reduce((t, z) => t + (packetsPerSec(`zone/${z.name}/from`) ?? 0), 0);
  const { count, max } = fw.conntrack;
  return tiles(
    tile('Zones', fw.zones.length, fw.zones.map(z => z.name).join(', ') || 'none'),
    tile('Traffic rules', `${on.length} / ${rules.length}`, on.length === rules.length ? 'all enabled' : `${rules.length - on.length} disabled`),
    tile('Port forwards', fw.redirects.filter(r => r.enabled).length, fw.redirects.length ? 'configured' : 'none configured'),
    tile('Turned away from outside', fmtNum(blocked), wan.length ? (fmtPps(pps) ?? 'packets rejected from the Internet') : 'no zone faces the Internet'),
    tile('Connections', count != null ? fmtNum(count) : '–', max ? `${Math.round(count / max * 100)} % of ${fmtNum(max)} tracked` : '', max && count / max > 0.8 ? 'text-warning' : ''),
    tile('Flow offloading', offloadLabel(fw), fw.flowtable ? `${fw.flowtable.devices.length} devices` : 'no flowtable loaded', fw.defaults.flow_offloading ? 'text-success' : ''));
}

// The actions of the editing controls on the draft. Each changes the draft, forgets the outcome of the last save and redraws the page.
function actionsFor(canEdit) {
  const { draft } = editor.state;
  // Redraws after a change to the draft.
  const changed = () => { editor.state.message = null; editor.redraw(); };
  return {
    canEdit,
    // Opens the dialog of a zone, rule or port forward (id null: a new one).
    edit(kind, id) {
      state.dialog = true;
      openItemDialog({
        key: kind, id, data: editor.state.base, getDraft: () => editor.state.draft,
        onSave: (values, links) => {
          const at = commitItem(editor.state.draft, kind, id, values);
          // A zone's forwardings are edited in its dialog: they follow the boxes ticked there.
          if (kind === 'zones') {
            const name = zoneName(findItem(editor.state.draft, 'zones', at));
            setForwardLinks(editor.state.draft, name, links, live(editor.state.draft.zones).map(zoneName).filter(n => n && n !== name));
          }
          changed();
        },
        onClose: () => { state.dialog = false; },
      });
    },
    // Marks an item for removal (a zone takes the forwardings that name it along).
    remove(kind, id) { if (kind === 'zones') removeZone(draft, id); else removeItem(draft, kind, id); changed(); },
    // Takes an item back from removal.
    restore(kind, id) { if (kind === 'zones') restoreZone(draft, id); else restoreItem(draft, kind, id); changed(); },
    // Moves a rule or port forward one place up (-1) or down (1).
    move(kind, id, delta) { moveItem(draft, kind, id, delta); changed(); },
    // Enables or disables an item.
    setEnabled(kind, id, on) { findItem(draft, kind, id).values.enabled = on; changed(); },
    // Switches the forwarding from one zone to another.
    toggleForwarding(src, dest) { toggleForwarding(draft, src, dest); changed(); },
  };
}

// The read-only page: what the plugin reports, as before editing existed (a login that may not read the config, or a reply that does not match it).
function readOnlyView(fw) {
  return [
    summary(fw),
    healthBanner(findings(fw), 'The firewall is running and nothing needs attention.'),
    matrixCard(fw),
    zonesCard(fw),
    rulesCard(fw),
    redirectsCard(fw),
  ];
}

// Page object registered in pages/index.js (contract documented there).
export default {
  interval: 5000,
  css: ['css/forms.css', 'css/firewall.css'],
  isPaused: () => state.paused || state.dialog || editor.paused('.fw-defaults'),

  // Counters are fed to the rate tracker before rendering so hit rates are live. The config is read when the login may (null otherwise).
  load: async () => {
    const [fw, cfg] = await Promise.all([ubus('flab.firewall', 'status'), can('uci', 'get') ? optional(uci.get(CONFIG)) : null]);
    recordFirewall(fw);
    return editor.withStaged(readFirewall(fw, cfg));
  },

  controls({ reload }) {
    return { nodes: [pauseControl(state), refreshControl(reload), editor.attach(reload)] };
  },

  // When there is no firewall configuration at all, only the findings and an explanation are shown.
  view(data, rerender) {
    const status = data.status;
    if (!status.zones.length && !status.running) return [healthBanner(findings(status), ''), emptyState('No firewall configuration was found.')];
    if (!data.editable || !consistent(data)) return readOnlyView(status);

    const canEdit = editor.begin(data, rerender);
    const fw = effectiveView(data, editor.state.draft);
    const ctx = actionsFor(canEdit);
    const inputs = {};
    const defaults = {
      draft: editor.state.draft, canEdit, inputs,
      touched: () => { editor.state.message = null; editor.markErrors(inputs, canEdit, reveal); },
      redraw: () => editor.redraw(),
    };
    const page = [
      summary(fw),
      ...editor.notes(data),
      status.running ? null : note('warn', 'The firewall is not loaded, so changes saved here are applied to the configuration but cannot be checked against the ruleset.'),
      healthBanner(findings(fw), 'The firewall is running and nothing needs attention.'),
      matrixCard(fw, ctx),
      zonesCard(fw, ctx),
      rulesCard(fw, ctx),
      redirectsCard(fw, ctx),
      h('div', { className: 'fw-defaults' }, defaultsCard(defaults)),
    ];
    editor.markErrors(inputs, canEdit, null);
    return page.filter(Boolean);
  },
};
