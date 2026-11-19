// The Zones card: the blocks that decide where the resolver sends the queries it cannot answer itself, as UCI
// keeps them, listed in the order of the configuration (see forwarderItems in zones.js). For Unbound a zone is a `config zone`
// section of /etc/config/unbound (forward, stub or authoritative): one set of
// servers and settings for a list of domains, so a router with ninety Azure domains has one zone, not ninety. For dnsmasq a zone
// is one entry of the `server` list. The card is folded until its header is clicked, shows the WAN resolvers and whether they are
// used, and one table of the zones, each with Edit and Remove; Add zone opens the same dialog (see zoneform.js). Changes go into
// the draft of the page and are saved with the review banner (see edit.js and zones.js).
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, muted, section } from '../../core/ui.js';
import { fmtNum } from '../../core/format.js';
import { legend } from '../../core/forms.js';
import { foldCard } from './fold.js';
import { clearTextHint, defaultForwarders, engineName, FLAG_HINTS, flagWords, isPublicIp, serverAddress, subject, wanNote, wanResolvers } from './model.js';
import { canEditForwarders, forwarderCounts, forwarderItems, matchItem, removeForwarder, restoreForwarder, saveForwarder, typeLabel } from './zones.js';
import { ZONE_TYPES } from './schema.js';
import { openZoneDialog } from './zoneform.js';

// The domains drawn in a row before "+N more".
const DOMAIN_LIMIT = 6;

// A server address in mono type, with a TLS or clear-text badge when that is known.
function serverChip(addr, tls, engine) {
  const clear = isPublicIp(serverAddress(addr)) && (engine === 'dnsmasq' || tls === false);
  return h('span', { className: 'dns-server' }, h('span', { className: 'mono' }, addr),
    tls === true ? badge('TLS', 'success', 'Queries to this server are encrypted (DNS over TLS).') : null,
    clear ? badge('clear text', 'warning', clearTextHint(engine)) : null);
}

// The flags of one row as badges (the tooltip says what the flag means).
const flagBadges = flags => flags.map(f => badge(flagWords([f])[0], 'info', FLAG_HINTS[f] ?? ''));

// What the badges of the table mean, one line each, for the engine in use: always visible, in the header of the card, so it can be
// read without hovering.
function labelsLegend(engine) {
  // One legend entry: a term (the badge) and its explanation.
  const row = (badgeNode, text) => [h('dt', {}, badgeNode), h('dd', {}, text)];
  const unbound = engine === 'unbound';
  return h('div', { className: 'dns-labels' },
    h('div', { className: 'dns-labels-title' }, 'What the labels mean'),
    h('dl', {},
      row(badge('clear text', 'warning'), clearTextHint(engine)),
      row(badge('TLS', 'success'), unbound ? 'The zone sends its queries to the server over DNS over TLS, so nobody on the path can read them (option tls_upstream).' : 'Queries to this server are encrypted (DNS over TLS).'),
      ...(unbound ? row(badge(flagWords(['i'])[0], 'info'), FLAG_HINTS.i) : [...row(badge(flagWords(['local-only'])[0], 'info'), FLAG_HINTS['local-only']), ...row(badge(flagWords(['default-servers'])[0], 'info'), FLAG_HINTS['default-servers'])]),
      row(badge('disabled', ''), 'Switched off: the zone stays in the configuration but is not used.'),
      row(badge('new', 'success'), 'Added in this page and not saved yet; likewise edited and removed.')));
}

// What happens to a query when no default forwarder is set; null when the root zone has servers.
function noDefaultNote(data, engine) {
  if (defaultForwarders(data).length) return null;
  return engine === 'unbound'
    ? 'No default forwarders: Unbound resolves names itself, starting from the root servers.'
    : 'No default forwarders: dnsmasq asks the resolvers learned from the WAN (see Resolvers from the WAN).';
}

// The resolvers the WAN connection handed to the router, each marked as in use or not, and a sentence that says whether the
// resolver really asks them.
function wanBlock(data) {
  const w = wanResolvers(data);
  const chips = w.servers.map(s => h('span', { className: 'dns-server' }, h('span', { className: 'mono' }, s.addr),
    s.used ? badge('in use', 'success', 'The resolver asks this server.') : badge('not used', '', 'The resolver does not ask this server.')));
  return section('Resolvers from the WAN',
    h('p', { className: 'muted small dns-area-legend' }, wanNote(data)),
    chips.length ? h('div', { className: 'dns-servers' }, chips) : null);
}

// The words for the header: whether the WAN resolvers are really asked.
const wanWords = { used: 'WAN resolvers in use', partly: 'some WAN resolvers in use', unused: 'WAN resolvers not used' };

// The header of the card: what a zone is and how many there are, then what the labels of the table mean.
function editBar(data, engine, items, edit) {
  const { forwarders, domains, file } = forwarderCounts(data, edit.getDraft());
  const text = engine === 'dnsmasq'
    ? `Each entry of the server list of dnsmasq in /etc/config/dhcp is a zone: ${fmtNum(forwarders)} here, for ${fmtNum(domains)} domain${domains === 1 ? '' : 's'}. They are listed in the order of the list; the entry with the longest matching domain answers a query. Edit, remove or add one; the review bar at the top saves the changes.`
    : `A zone is a block of /etc/config/unbound with the servers and settings for a list of domains: ${fmtNum(forwarders)} here, for ${fmtNum(domains)} domain${domains === 1 ? '' : 's'}. They are listed in the order of the configuration; the zone with the longest matching domain answers a query, whatever its position. Edit, remove or add one; the review bar at the top saves the changes.${file ? ` ${fmtNum(file)} more only exist in /etc/unbound/unbound_ext.conf, which is read last, and stay read only here.` : ''}`;
  return h('div', { className: 'muted small set-legend dns-fwd-bar' }, h('p', {}, text), items.length ? labelsLegend(engine) : null);
}

// The buttons and badges of the "Defined in" cell of one row.
function sourceNodes(item, engine, edit, act) {
  if (item.kind === 'file') {
    return [h('span', { className: 'dns-src-file', title: 'Defined in /etc/unbound/unbound_ext.conf. This page cannot change it: edit that file.' }, icon('lock'), 'unbound_ext.conf')];
  }
  const where = engine === 'dnsmasq' ? 'A server entry of the dnsmasq section in /etc/config/dhcp.' : `The zone section ${item.name} of /etc/config/unbound.`;
  const can = edit.canEdit && canEditForwarders(edit.getBase());
  // A small icon button for one row action.
  const act1 = (name, label, onclick, disabled) => button('', name, onclick, 'btn-fl dns-act-btn', { title: label, ariaLabel: label, disabled });
  if (item.pending === 'removed') return [badge('UCI', 'info', where), act1('arrow-counterclockwise', 'Keep this zone (undo the removal)', () => act.restore(item.key), !can)];
  const why = item.locked ? ' This zone cannot be changed here: its lists are too long to read completely, or its type is unknown.' : '';
  return [badge('UCI', 'info', where + why), act1('pencil', 'Edit', () => act.edit(item.key), !can || item.locked), act1('x-lg', 'Remove', () => act.remove(item.key), !can || item.locked)];
}

// The first column: the name of the block (Unbound) or the text of the entry (dnsmasq), what kind of zone it is, and its state.
function nameCell(item, engine) {
  const states = [
    !item.enabled && item.kind === 'uci' ? badge('disabled', '', 'Switched off: Unbound does not use it.') : null,
    item.pending === 'new' ? badge('new', 'success', 'Not saved yet.') : null,
    item.pending === 'edited' ? badge('edited', 'warning', 'Changed, not saved yet.') : null,
    item.pending === 'removed' ? badge('removed', 'danger', 'Will be deleted when the changes are saved.') : null,
  ];
  const kind = engine === 'unbound' && item.kind === 'uci' ? badge(typeLabel(item.type), '', ZONE_TYPES[item.type]?.words ?? 'A zone type this page does not know.') : null;
  return h('td', {}, h('div', { className: 'dns-zone-name mono' }, item.name), h('div', { className: 'dns-zone-badges' }, kind, ...states));
}

// The domains of a block: the first few, then a button for the rest; "." says what it stands for.
function domainsCell(item, state, draw) {
  const open = state.expanded.has(item.key);
  const shown = open ? item.zones : item.zones.slice(0, DOMAIN_LIMIT);
  // One domain as a chip.
  const chip = z => h('span', { className: 'dns-domain mono' }, z === '.' ? [z, ' ', h('span', { className: 'muted' }, '(every other name)')] : z);
  const more = item.zones.length > DOMAIN_LIMIT
    ? button(open ? 'Show fewer' : `${fmtNum(item.zones.length - DOMAIN_LIMIT)} more`, open ? 'chevron-up' : 'chevron-down',
      () => { if (open) state.expanded.delete(item.key); else state.expanded.add(item.key); draw(); }, 'btn-fl dns-toggle', { ariaExpanded: String(open) })
    : null;
  return h('td', {}, h('div', { className: 'dns-domains' }, shown.map(chip), more), item.zones.length > 1 ? h('div', { className: 'dns-count muted small' }, `${fmtNum(item.zones.length)} domains`) : null);
}

// The table body for the current filter.
function zoneRows(items, state, engine, edit, act, draw) {
  const filtered = items.filter(i => matchItem(i, state.fq));
  if (!filtered.length) return h('div', { className: 'muted dns-pad' }, state.fq ? 'No zone matches the filter.' : 'No zones.');
  const body = filtered.map(item => h('tr', { className: item.pending === 'removed' ? 'dns-row-removed' : '' },
    h('td', { className: 'dns-order muted', title: item.kind === 'file' ? 'unbound_ext.conf is read after every block of /etc/config/unbound' : 'Position in the configuration, the order the clauses are written' }, String(item.order)),
    nameCell(item, engine), domainsCell(item, state, draw),
    h('td', {}, h('div', { className: 'dns-servers' }, item.servers.map(s => serverChip(s, item.tls, engine))), item.url ? h('div', { className: 'muted small mono' }, item.url) : null),
    h('td', {}, flagBadges(item.flags)),
    h('td', { className: 'dns-src' }, sourceNodes(item, engine, edit, act))));
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover dns-table' },
    h('thead', {}, h('tr', {}, h('th', { title: 'The order of the configuration. Which zone answers a query does not depend on it: the zone with the longest matching domain wins.' }, '#'), h('th', {}, engine === 'dnsmasq' ? 'Server entry' : 'Zone'), h('th', {}, 'Domains'), h('th', {}, 'Servers'), h('th', {}, 'Flags'), h('th', {}, 'Defined in'))),
    h('tbody', {}, body)));
}

// The filter box and the table. The filter redraws only the table, so the text box keeps its focus while typing. The Add zone
// button is on the toolbar, at the end of the line of the filter box. `items` are the rows (forwarderItems of the draft).
function zoneList(data, state, engine, items, edit, act, add) {
  const note = noDefaultNote(data, engine);
  const holder = h('div', {});
  // Redraws the table rows for the current filter.
  const draw = () => holder.replaceChildren(zoneRows(items, state, engine, edit, act, draw));
  const input = h('input', {
    className: 'form-control form-control-sm', type: 'search', placeholder: 'Filter zones, domains or servers…', value: state.fq,
    oninput: e => { state.fq = e.target.value; draw(); },
  });
  draw();
  const can = edit.canEdit && canEditForwarders(edit.getBase());
  const addButton = button('Add zone', 'plus-lg', add, 'btn-fl', { disabled: !can, title: can ? 'Add a zone' : 'Zones cannot be changed with this login' });
  return h('div', { className: 'dns-pad' },
    h('div', { className: 'dns-toolbar dns-field' }, items.length ? h('div', { className: 'search' }, icon('search'), input) : null, addButton),
    note ? h('p', { className: 'muted small' }, note) : null, items.length ? holder : muted('No zones.'));
}

// The Zones card: folded until the user opens it (see fold.js). `edit` is { canEdit, getBase(), getDraft(), changed() } from the
// page: the data the draft was made from, the draft, and a call that refreshes the review banner and redraws after a change.
export function zonesCard(data, state, edit) {
  const engine = subject(data);
  const draft = edit.getDraft();
  const items = forwarderItems(data, draft);
  const domains = items.reduce((n, i) => n + i.zones.length, 0);
  const wan = wanWords[wanResolvers(data).verdict];
  // Opens the dialog for a zone (key null: a new one); it works on a copy and hands the form back when accepted.
  const dialogFor = key => {
    if (state.dialog) return;
    state.dialog = openZoneDialog({
      data: edit.getBase(), getDraft: edit.getDraft, key,
      onSave: form => { saveForwarder(edit.getBase(), edit.getDraft(), key, form); edit.changed(); },
      onClose: () => { state.dialog = null; },
    });
  };
  const act = {
    edit: key => dialogFor(key),
    remove: key => { removeForwarder(edit.getDraft(), key); edit.changed(); },
    restore: key => { restoreForwarder(edit.getDraft(), key); edit.changed(); },
  };
  const body = [
    editBar(data, engine, items, edit),
    data.engine === 'unbound' && data.engines?.unbound?.control === false
      ? legend(['unbound-control is not available, so the running forwarders come from Unbound\'s generated configuration and may not be what the running process uses.']) : null,
    h('div', { className: 'dns-pad' }, wanBlock(data)),
    h('div', { className: 'dns-top' }, zoneList(data, state, engine, items, edit, act, () => dialogFor(null))),
  ];
  const sub = `${engineName(engine)} · ${fmtNum(items.length)} zone${items.length === 1 ? '' : 's'} · ${fmtNum(domains)} domain${domains === 1 ? '' : 's'}${data.truncated?.forwards ? ' (cut)' : ''}${wan ? ` · ${wan}` : ''}`;
  return foldCard(state, 'zones', [icon('list-ul'), 'Zones', h('span', { className: 'sub' }, sub)], h('div', {}, body));
}
