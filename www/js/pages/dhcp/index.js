// DHCP page (route #dhcp): odhcpd, the router's DHCPv4, DHCPv6 and router-advertisement server. It shows the leases
// handed out right now, the reservations (static leases) and the IPv6 prefixes announced, and edits the config
// behind them: the reservations, every option of each interface pool and of the daemon (the option tables are in
// schema.js, taken from the odhcpd documentation; validation, the change list and the UCI operations in model.js).
//
// It reads through rpcd's `uci` object and the daemon's own `dhcp` ubus object, so no plugin is needed, and writes
// through core/uci.js applyChange(): stage, apply with the rollback countdown, read the config back, confirm.
// The controls and the review banner are shared with System settings (core/forms.js). The page redraws on every
// poll, so polling is suspended while there is something to lose: unsaved edits, a focused control or a save.
import { h } from '../../core/dom.js';
import { AuthError, can, optional, ubus } from '../../core/ubus.js';
import { button, tile, tiles } from '../../core/ui.js';
import { refreshControl, searchControl, selectControl } from '../../core/controls.js';
import { note, reviewBanner } from '../../core/forms.js';
import { stageOps } from '../../core/ops.js';
import { applyChange, uci } from '../../core/uci.js';
import { announcedCard, leases4Card, leases6Card } from './leases.js';
import { daemonCard, poolCard } from './pools.js';
import { reservationsCard, reserveFrom } from './reservations.js';
import { CONFIG, changesOf, checkApplied, draftFrom, hostNorm, isDirty, plan, problems, readDhcp } from './model.js';

// What the forms hold (`draft`) and the data they were made from (`base`), kept here so they survive the redraw
// on every poll; `filter` is the lease filter of the command bar; `message` is the outcome of the last save.
const state = { base: null, draft: null, busy: false, message: null, filter: { q: '', iface: 'all' } };

// The page's redraw and reload callbacks, set when the shell builds the page; the review banner is created with
// the page's controls.
let redraw = () => {};
let reloadPage = () => {};
let bar = null;

// Whether the forms have edits that are not saved yet.
const dirty = () => Boolean(state.base && state.draft && isDirty(state.base, state.draft));

// Reads the config, the leases and announcements, the interfaces and the daemon's state, plus how many changes
// are already staged in this session (applying would commit those too, so the page warns about them). The ubus
// replies are optional: a stopped odhcpd has no `dhcp` object, and the page still shows and edits the config.
async function load() {
  const [cfg, v4, v6, ra, dump, svc] = await Promise.all([
    uci.get(CONFIG),
    optional(ubus('dhcp', 'ipv4leases')), optional(ubus('dhcp', 'ipv6leases')), optional(ubus('dhcp', 'ipv6ra')),
    optional(ubus('network.interface', 'dump')), optional(ubus('service', 'list', { name: 'odhcpd' })),
  ]);
  const data = readDhcp(cfg, v4, v6, ra, dump, svc);
  data.staged = can('uci', 'set') ? (await optional(uci.pending(CONFIG))) ?? 0 : 0;
  return data;
}

//#region Actions

// Throws away the changes staged in this session (they would be applied together with this page's).
async function discardStaged() {
  try {
    await uci.revert(CONFIG);
    state.message = { kind: 'ok', text: 'The staged changes were discarded.' };
  } catch (e) {
    state.message = { kind: 'bad', text: e.message };
  }
  await reloadPage();
}

// Forgets the edits and shows what the router has.
async function discardEdits() {
  state.draft = null;
  state.message = null;
  await reloadPage();
}

// Saves the forms: stage, apply with the rollback countdown (odhcpd reloads), read the config back to prove it was
// stored, then confirm. Any failure leaves the router on its previous config and the edits in the forms.
async function save() {
  const { base, draft } = state;
  state.busy = true;
  state.message = { kind: 'info', text: 'Applying the change…' };
  redraw();
  try {
    await applyChange(uci, [CONFIG],
      ed => stageOps(ed, plan(base, draft)),
      async () => checkApplied(readDhcp(await uci.get(CONFIG)), draft));
    state.message = { kind: 'ok', text: 'Saved: the router applied the change and it was confirmed.' };
    state.draft = null;
  } catch (e) {
    // An expired session needs a new sign-in: reloading lets the shell show the sign-in screen.
    if (e instanceof AuthError) return location.reload();
    state.message = { kind: 'bad', text: e.message };
  }
  state.busy = false;
  await reloadPage();
}

//#endregion

//#region Pieces of the page

// The four summary tiles: the daemon, the two kinds of lease and the reservations.
function summary(data) {
  const running = data.daemonRunning;
  const main = data.daemon.values.maindhcp;
  const reserved4 = data.leases4.filter(l => l.static).length;
  const reserved6 = data.leases6.filter(l => l.static).length;
  return tiles(
    tile('odhcpd', running == null ? 'Unknown' : running ? 'Running' : 'Stopped',
      !main || ['0', 'false', 'off', 'no'].includes(String(main).toLowerCase()) ? 'DHCPv4 is left to another server' : 'the main DHCPv4 server', running === false ? 'text-danger' : ''),
    tile('DHCPv4 leases', String(data.leases4.length), `${reserved4} reserved · ${data.leases4.length - reserved4} dynamic`),
    tile('DHCPv6 leases', String(data.leases6.length), `${reserved6} reserved · ${data.leases6.length - reserved6} dynamic`),
    tile('Reservations', String(data.hosts.length), `${reserved4} with a lease now`));
}

// Updates the review banner from the draft.
function renderBar(canEdit) {
  const ready = state.base && state.draft;
  const found = ready ? problems(state.base, state.draft) : { errors: [], warnings: [] };
  bar.render({
    changes: ready ? changesOf(state.base, state.draft) : [],
    errors: found.errors, warnings: found.warnings, message: state.message,
    busy: state.busy, canEdit, dirty: dirty(),
    dismiss: () => { state.message = null; renderBar(canEdit); },
  });
}

//#endregion

export default {
  id: 'dhcp',
  label: 'DHCP',
  title: 'DHCP and router advertisements · odhcpd',
  icon: 'signpost-split',
  interval: 10000,
  css: ['css/forms.css', 'css/dhcp.css'],
  isPaused: () => state.busy || dirty() || Boolean(document.activeElement?.closest?.('.dhcp-form')),

  load,

  controls({ rerender, reload }) {
    reloadPage = reload;
    bar = reviewBanner({ onSave: save, onDiscard: discardEdits });
    const iface = selectControl(state.filter, 'iface', rerender, 'Show one interface only');
    iface.setOptions([['all', 'All interfaces']]);
    return {
      nodes: [searchControl(state.filter, 'q', rerender, 'Filter leases…'), iface.node, refreshControl(reload), bar.node],
      // The interfaces that have a pool or a lease.
      update(data) {
        const names = [...new Set([...data.pools.map(p => p.iface), ...data.leases4.map(l => l.iface), ...data.leases6.map(l => l.iface)])].sort();
        iface.setOptions([['all', 'All interfaces'], ...names.map(n => [n, n])]);
      },
    };
  },

  view(data, rerender) {
    redraw = rerender;
    // Unsaved edits survive a refresh; otherwise the forms restart from what the router has.
    if (!state.draft || !dirty()) {
      state.base = data;
      state.draft = draftFrom(data);
    }
    const canEdit = can('uci', 'set') && !state.busy;
    const ctx = {
      data, draft: state.draft, canEdit, inputs: {}, redraw: () => redraw(),
      touched: () => { state.message = null; ctx.sync(); },
      sync: () => {},
    };

    // Called after every edit: marks the controls that hold an error and refreshes the banner.
    ctx.sync = () => {
      for (const el of Object.values(ctx.inputs).flat()) el?.classList.remove('is-invalid');
      for (const e of problems(state.base, state.draft).errors) {
        for (const key of [e.key, e.also]) {
          const el = key && ctx.inputs[key];
          (Array.isArray(el) ? el[e.index] : el)?.classList.add('is-invalid');
        }
      }
      renderBar(canEdit);
    };

    // The MACs that already have a reservation (in the draft), so a lease is not offered for reserving twice.
    const reservedMacs = new Set(state.draft.hosts.filter(r => !r.removed).flatMap(r => hostNorm(r.values).mac.split(' ')).filter(Boolean));
    // The settings come first (daemon, pools, announced prefixes), then what the clients currently hold (leases) and
    // the reservations. Both editable groups are `.dhcp-form`, so neither is polled over while focused.
    const settings = h('div', { className: 'dhcp-form' },
      daemonCard(ctx),
      ...data.pools.map(p => poolCard(ctx, p)));
    const reservations = h('div', { className: 'dhcp-form' }, reservationsCard(ctx));
    const page = [
      summary(data),
      can('uci', 'set') ? null : note('warn', 'This login is not allowed to change the configuration, so the settings are shown read-only.'),
      data.staged ? note('warn', `${data.staged} change(s) are already staged in this session (for example from an attempt that was rolled back); saving would apply them too.`, button('Discard them', 'x-lg', discardStaged)) : null,
      data.daemonRunning === false ? note('bad', 'odhcpd is not running, so there are no leases and no clients are being served. The configuration can still be edited.') : null,
      settings,
      announcedCard(data, state.filter),
      leases4Card(data, state.filter, { reservedMacs, canReserve: canEdit, reserve: l => { reserveFrom(state.draft, l); state.message = null; redraw(); } }),
      leases6Card(data, state.filter),
      reservations,
    ];
    ctx.sync();
    return page.filter(Boolean);
  },
};
