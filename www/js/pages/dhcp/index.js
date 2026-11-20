// DHCP page (route #dhcp): odhcpd, the router's DHCPv6 and router-advertisement server, and its DHCPv4 server when it
// is the main one (otherwise dnsmasq serves DHCPv4 and the page shows dnsmasq's leases). It shows the leases
// handed out right now, the static leases and the IPv6 prefixes announced, and edits the config
// behind them: the static leases, the network boot entries, every option of each interface pool (pools can be added and
// removed) and of the daemon, and the server DUID (the option tables are in
// schema.js, taken from the odhcpd source; validation, the change list and the UCI operations in model.js).
//
// It reads through rpcd's `uci` and `file` objects (dnsmasq's lease file) and the daemons' own `dhcp` ubus object,
// so no plugin is needed, and writes
// through core/uci.js applyChange(): stage, apply with the rollback countdown, read the config back, confirm.
// The controls and the review banner are shared with System settings (core/forms.js). The page redraws on every
// poll, so polling is suspended while there is something to lose: unsaved edits, a focused control or a save.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { optional, ubus } from '../../core/ubus.js';
import { tile, tiles } from '../../core/ui.js';
import { refreshControl, searchControl, selectControl } from '../../core/controls.js';
import { note } from '../../core/forms.js';
import { createEditor } from '../../core/editpage.js';
import { reveal } from '../../core/fold.js';
import { uci } from '../../core/uci.js';
import { announcedCard } from './prefixes.js';
import { addPoolBar, daemonCard, poolCard } from './pools.js';
import { bootCard } from './boot6.js';
import { CLIENT_TYPES, clientsCard } from './clients.js';
import { CONFIG, changesOf, checkApplied, clientList, dhcpv4Server, dnsmasqLeaseFile, draftFrom, isDirty, plan, poolList, problems, readDhcp } from './model.js';
import { GLOBAL_CONFIG, GLOBAL_SECTION } from './schema.js';

// The draft, the review banner, saving and discarding, shared with the other editing pages (core/editpage.js). The
// page writes two configs: the pools and static leases in dhcp, the server DUID in network. Only that one section of
// the network config is ever read (the rest holds secrets), so the check after a save reads just what it needs.
const editor = createEditor({
  config: [CONFIG, GLOBAL_CONFIG],
  readBack: cfg => readDhcp(cfg),
  readAfter: async () => readDhcp(await uci.get(CONFIG), null, null, null, null, null, {}, await optional(uci.get(GLOBAL_CONFIG, GLOBAL_SECTION))),
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: (base, draft, after) => checkApplied(after, draft),
});
const { state } = editor;

// The filter of the clients list (text, interface and type). The controls survive redraws, and the state survives the page's
// polling.
const filter = { q: '', iface: 'all', type: 'all' };
let clientControls = null;

// Reads the config, the leases and announcements, the interfaces and the daemons' state, plus how many changes
// are already staged in this session (applying would commit those too, so the page warns about them). The ubus
// replies are optional: a stopped odhcpd has no `dhcp` object, and the page still shows and edits the config.
// dnsmasq's lease file is read only when dnsmasq is the DHCPv4 server.
async function load() {
  const [cfg, v4, v6, ra, dump, svc, dnsSvc, net] = await Promise.all([
    uci.get(CONFIG),
    optional(ubus('dhcp', 'ipv4leases')), optional(ubus('dhcp', 'ipv6leases')), optional(ubus('dhcp', 'ipv6ra')),
    optional(ubus('network.interface', 'dump')), optional(ubus('service', 'list', { name: 'odhcpd' })),
    optional(ubus('service', 'list', { name: 'dnsmasq' })),
    optional(uci.get(GLOBAL_CONFIG, GLOBAL_SECTION)),
  ]);
  const dns = { svc: dnsSvc, leases: null, now: Date.now() / 1000 };
  if (dhcpv4Server(cfg, dnsSvc) === 'dnsmasq') dns.leases = (await optional(ubus('file', 'read', { path: dnsmasqLeaseFile(cfg) })))?.data ?? null;
  return editor.withStaged(readDhcp(cfg, v4, v6, ra, dump, svc, dns, net));
}

//#region Pieces of the page

// The four summary tiles: the daemon, the two kinds of lease and the static leases.
function summary(data) {
  const running = data.daemonRunning;
  const static4 = data.leases4.filter(l => l.static).length;
  const static6 = data.leases6.filter(l => l.static).length;
  const prefixClients = data.leases6.filter(l => l.prefixes.length).length;
  const active = clientList(data, draftFrom(data)).filter(c => c.row && c.v4.length + c.v6.length > 0).length;
  const by = data.server === 'dnsmasq' ? ' · from dnsmasq' : '';
  return tiles(
    tile('odhcpd', running == null ? 'Unknown' : running ? 'Running' : 'Stopped',
      data.server === 'odhcpd' ? 'the main DHCPv4 server' : data.server === 'dnsmasq' ? 'DHCPv6 and router advertisements; dnsmasq serves DHCPv4' : 'DHCPv4 is left to another server', running === false ? 'text-danger' : ''),
    tile('DHCPv4 leases', String(data.leases4.length), `${static4} static · ${data.leases4.length - static4} dynamic${by}`),
    tile('DHCPv6 leases', String(data.leases6.length), `${static6} static · ${data.leases6.length - static6} dynamic · ${prefixClients} with IA_PD`),
    tile('Static leases', String(data.hosts.length), `${active} with a lease now`));
}

//#endregion

export default {
  interval: 10000,
  css: ['css/forms.css', 'css/dhcp.css'],
  isPaused: () => editor.paused('.dhcp-form'),

  load,

  controls({ rerender, reload }) {
    const iface = selectControl(filter, 'iface', rerender, 'Show the clients of one interface');
    iface.setOptions([['all', 'All interfaces']]);
    const type = selectControl(filter, 'type', rerender, 'Show static or dynamic leases');
    type.setOptions(CLIENT_TYPES);
    clientControls = { search: searchControl(filter, 'q', rerender, 'Filter clients…'), iface, type };
    return {
      nodes: [refreshControl(reload), editor.attach(reload)],
      update(data) {
        const names = [...new Set([...data.pools.map(p => p.iface), ...clientList(data, state.draft ?? draftFrom(data)).map(c => c.iface).filter(Boolean)])].sort();
        clientControls.iface.setOptions([['all', 'All interfaces'], ...names.map(n => [n, n])]);
      },
    };
  },

  view(data, rerender) {
    const canEdit = editor.begin(data, rerender);
    const ctx = { data, draft: state.draft, canEdit, inputs: {}, redraw: () => editor.redraw(), touched: () => {}, sync: () => {} };
    ctx.touched = editor.touched(ctx);

    // Called after every edit: marks the controls that hold an error and refreshes the banner. A control with an
    // error must not stay hidden in a folded card or a closed group, so those are opened.
    ctx.sync = () => editor.markErrors(ctx.inputs, canEdit, reveal);

    // Configuration first, from the widest to the narrowest (the daemon, interface pools, network boot), then the live lists.
    // Each editable group is `.dhcp-form`, so it is not polled over while focused.
    const clients = h('div', { className: 'dhcp-form' }, clientsCard(ctx, filter, { controls: clientControls }));
    const boot = h('div', { className: 'dhcp-form' }, bootCard(ctx));
    const pools = h('div', { className: 'dhcp-form' },
      ...poolList(data, state.draft).map(p => poolCard(ctx, p)), addPoolBar(ctx));
    const settings = h('div', { className: 'dhcp-form' }, daemonCard(ctx));
    const title = (name, text) => h('h2', { className: 'page-section-title' }, icon(name), text);
    const page = [
      summary(data),
      ...editor.notes(data),
      data.daemonRunning === false ? note('bad', data.server === 'dnsmasq'
        ? 'odhcpd is not running, so DHCPv6 and router advertisements are not served (DHCPv4 comes from dnsmasq). The configuration can still be edited.'
        : 'odhcpd is not running, so there are no leases and no clients are being served. The configuration can still be edited.') : null,
      data.leasesUnreadable ? note('bad', 'dnsmasq serves DHCPv4, but its lease file could not be read, so the DHCPv4 leases are not shown.') : null,
      title('cpu', 'Daemon settings'),
      settings,
      title('gear', 'Pool settings'),
      pools,
      title('hdd-network', 'Network boot'),
      boot,
      title('people', 'Leases'),
      clients,
      title('broadcast', 'Router advertisements'),
      announcedCard(data),
    ];
    ctx.sync();
    return page.filter(Boolean);
  },
};
