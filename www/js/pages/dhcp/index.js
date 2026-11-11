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
import { optional, ubus } from '../../core/ubus.js';
import { tile, tiles } from '../../core/ui.js';
import { refreshControl, searchControl, selectControl } from '../../core/controls.js';
import { note } from '../../core/forms.js';
import { createEditor } from '../../core/editpage.js';
import { uci } from '../../core/uci.js';
import { announcedCard, leases4Card, leases6Card } from './leases.js';
import { daemonCard, poolCard } from './pools.js';
import { reservationsCard, reserveFrom } from './reservations.js';
import { CONFIG, changesOf, checkApplied, draftFrom, hostNorm, isDirty, plan, problems, readDhcp } from './model.js';

// The draft, the review banner, saving and discarding, shared with the other editing pages (core/editpage.js).
const editor = createEditor({
  config: CONFIG,
  readBack: cfg => readDhcp(cfg),
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: (base, draft, after) => checkApplied(after, draft),
});
const { state } = editor;

// The lease filter of the command bar.
const filter = { q: '', iface: 'all' };

// Reads the config, the leases and announcements, the interfaces and the daemon's state, plus how many changes
// are already staged in this session (applying would commit those too, so the page warns about them). The ubus
// replies are optional: a stopped odhcpd has no `dhcp` object, and the page still shows and edits the config.
async function load() {
  const [cfg, v4, v6, ra, dump, svc] = await Promise.all([
    uci.get(CONFIG),
    optional(ubus('dhcp', 'ipv4leases')), optional(ubus('dhcp', 'ipv6leases')), optional(ubus('dhcp', 'ipv6ra')),
    optional(ubus('network.interface', 'dump')), optional(ubus('service', 'list', { name: 'odhcpd' })),
  ]);
  return editor.withStaged(readDhcp(cfg, v4, v6, ra, dump, svc));
}

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

//#endregion

export default {
  id: 'dhcp',
  label: 'DHCP',
  title: 'DHCP and router advertisements · odhcpd',
  icon: 'signpost-split',
  interval: 10000,
  css: ['css/forms.css', 'css/dhcp.css'],
  isPaused: () => editor.paused('.dhcp-form'),

  load,

  controls({ rerender, reload }) {
    const iface = selectControl(filter, 'iface', rerender, 'Show one interface only');
    iface.setOptions([['all', 'All interfaces']]);
    return {
      nodes: [searchControl(filter, 'q', rerender, 'Filter leases…'), iface.node, refreshControl(reload), editor.attach(reload)],
      // The interfaces that have a pool or a lease.
      update(data) {
        const names = [...new Set([...data.pools.map(p => p.iface), ...data.leases4.map(l => l.iface), ...data.leases6.map(l => l.iface)])].sort();
        iface.setOptions([['all', 'All interfaces'], ...names.map(n => [n, n])]);
      },
    };
  },

  view(data, rerender) {
    const canEdit = editor.begin(data, rerender);
    const ctx = { data, draft: state.draft, canEdit, inputs: {}, redraw: () => editor.redraw(), touched: () => {}, sync: () => {} };
    ctx.touched = editor.touched(ctx);

    // Called after every edit: marks the controls that hold an error and refreshes the banner. A control with an
    // error must not stay hidden in a folded card or a closed group, so those are opened.
    ctx.sync = () => editor.markErrors(ctx.inputs, canEdit, bad => {
      const group = bad.closest('details');
      if (group && !group.open) group.open = true;
      if (bad.closest('.dhcp-folded')) bad.closest('.card').querySelector('.dhcp-fold-header').click();
    });

    // The MACs that already have a reservation (in the draft), so a lease is not offered for reserving twice.
    const reservedMacs = new Set(state.draft.hosts.filter(r => !r.removed).flatMap(r => hostNorm(r.values).mac.split(' ')).filter(Boolean));
    // The settings come first (daemon, pools, announced prefixes), then what the clients currently hold (leases) and
    // the reservations. Both editable groups are `.dhcp-form`, so neither is polled over while focused.
    const settings = h('div', { className: 'dhcp-form' },
      daemonCard(ctx),
      ...data.pools.map(p => poolCard(ctx, p)));
    const reservations = h('div', { className: 'dhcp-form' }, reservationsCard(ctx));
    const reserve = l => { reserveFrom(state.draft, l); state.message = null; editor.redraw(); };
    const page = [
      summary(data),
      ...editor.notes(data),
      data.daemonRunning === false ? note('bad', 'odhcpd is not running, so there are no leases and no clients are being served. The configuration can still be edited.') : null,
      settings,
      announcedCard(data, filter),
      leases4Card(data, filter, { reservedMacs, canReserve: canEdit, reserve }),
      leases6Card(data, filter),
      reservations,
    ];
    ctx.sync();
    return page.filter(Boolean);
  },
};
