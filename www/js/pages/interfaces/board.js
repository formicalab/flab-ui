// The network board: four lanes of compact cards, left to right, with curved connectors between the cards that are connected.
//
//   Ports and radios (physical)  ->  Devices (bridges, VLANs)  ->  Interfaces (protocol and addresses)  ->  Firewall zones and services
//
// The lanes and their edges come from boardmodel.js. A click on a card asks the page to open it in the drawer (onOpen); hovering a card, or
// opening one, highlights everything connected to it (the cards it is built on and the cards built on it) and dims the rest, which works even
// where the connectors are not drawn (narrow screens stack the lanes). The connectors are an SVG laid over the lanes, drawn after layout and
// again whenever the board or a lane changes size. Every card wraps its text: nothing may overlap its neighbours at any width.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button } from '../../core/ui.js';
import { disclosure } from '../../core/fold.js';
import { fmtSpeed } from '../network/util.js';
import { related } from './boardmodel.js';
import { poolText } from './panelmodel.js';

// Which "details" blocks of the interface cards are open, kept across the redraw of every poll.
const openDetails = new Set();

const SVG = 'http://www.w3.org/2000/svg';
// An SVG element with attributes.
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// A Wi-Fi band as the name people use for it.
const BAND = { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz', '60g': '60 GHz' };
const bandText = band => BAND[band] ?? band ?? '';

// What a firewall policy means in words.
const POLICY = { ACCEPT: 'accepted', REJECT: 'rejected', DROP: 'dropped' };

//#region Cards

// The state badge of an item that can be new, removed, up, down or not running.
function stateBadge(item) {
  if (item.removed) return badge('to be removed', 'danger');
  if (item.isNew) return badge('new', 'info', 'Not saved yet');
  if (item.kind === 'interface') return item.running ? (item.up ? badge('up', 'success') : badge(item.pending ? 'pending' : 'down', item.pending ? 'warning' : 'danger')) : badge('not running', '', 'netifd has no running interface of this name');
  if (item.up === true) return badge('up', 'success');
  if (item.up === false) return badge('down', 'danger');
  return badge('not present', '', 'The router has no device of this name at the moment');
}

// The card of a port: the Ethernet icon (green with a link), name, speed and the position on the board (LAN or WAN), a mark when it has device settings,
// and its hardware under them.
function portCard(item) {
  const s = item.settings;
  return [
    h('div', { className: 'nb-line' },
      h('span', { className: `nb-pico ${item.up ? 'up' : 'idle'}`, title: item.up ? 'Link up' : 'No link' }, icon('ethernet', 14)), h('strong', { className: 'nb-name' }, item.name),
      h('span', { className: 'muted small' }, item.up ? (item.speed ? fmtSpeed(item.speed) : 'link') : 'no link'),
      item.role ? h('span', { className: 'muted small' }, item.role.toUpperCase()) : null,
      s ? badge(s.removed ? 'settings removed' : s.isNew ? 'new settings' : 'settings', s.removed ? 'danger' : 'info', 'This port has device settings (MTU, MAC address, speed, flow control)') : null),
    ...(item.hw ?? []).map(line => h('div', { className: 'muted small nb-sub nb-hw' }, line)),
  ];
}

// The chip of a Wi-Fi or mesh interface inside its radio: a link to the Wi-Fi radios page, where it is configured.
function wifiChip(item) {
  const href = '#radios';
  const what = [item.kind === 'mesh' ? 'mesh' : item.mode, item.ssid && item.ssid !== item.name ? item.name : null].filter(Boolean).join(' · ');
  const title = [`${item.name} on ${item.radio ?? 'a radio'}`, item.enabled === false ? 'disabled' : null, 'opens the Wi-Fi radios page'].filter(Boolean).join(' · ');
  return h('a', { className: 'nb-chip', href, title },
    h('span', { className: `dot ${item.up ? 'up' : 'idle'}` }),
    h('span', { className: 'nb-chip-text' }, h('strong', {}, item.ssid ?? item.name),
      h('span', { className: 'muted small' }, what), item.enabled === false ? badge('disabled') : null));
}

// The card of a radio, a container of its wireless interfaces: the Wi-Fi icon (green when it is up), name, band and state, its hardware, and under them the
// chips of the interfaces on it. `chips` are those nodes.
function radioCard(item, chips) {
  const state = !item.enabled ? badge('disabled') : item.up ? null : badge('down', 'danger');
  return [
    h('div', { className: 'nb-line' },
      h('span', { className: `nb-pico ${item.up && item.enabled ? 'up' : 'idle'}`, title: item.up ? 'Radio up' : 'Radio down' }, icon('wifi', 14)), h('strong', { className: 'nb-name' }, item.name),
      item.band ? h('span', { className: 'muted small' }, bandText(item.band)) : null, item.phy ? h('span', { className: 'muted small' }, item.phy) : null, state),
    ...(item.hw ?? []).map(line => h('div', { className: 'muted small nb-sub nb-hw' }, line)),
    h('div', { className: 'nb-radio-ifs' }, chips.length ? chips : h('div', { className: 'muted small' }, 'no interface configured')),
  ];
}

// The card of a device: icon, name, type, state and a line saying what it is.
function deviceCard(item) {
  const type = item.type === 'bridge' ? 'bridge' : item.type === 'vlan' ? `VLAN ${item.vid || '?'}` : item.type === 'unknown' ? 'device' : (item.sectionType === 'plain' ? 'settings' : item.sectionType ?? 'device');
  const line = item.type === 'bridge'
    ? [`${item.members.length} port${item.members.length === 1 ? '' : 's'}`, item.stp ? 'STP' : null, item.vlanFiltering ? 'VLAN filtering' : null].filter(Boolean).join(' · ')
    : item.type === 'vlan' ? `VLAN ${item.vid || '?'} on ${item.parent || '?'}`
      : item.type === 'unknown' ? 'The router does not describe this device' : item.settingsOnly ? `settings of ${item.name || 'a device'}` : `${item.sectionType} device`;
  return [
    h('div', { className: 'nb-line' }, icon(item.type === 'bridge' ? 'diagram-2' : 'ethernet', 14),
      h('strong', { className: 'nb-name' }, item.name || (item.type === 'bridge' ? 'New bridge' : item.type === 'vlan' ? 'New VLAN device' : 'New device')), badge(type, 'info'), stateBadge(item)),
    h('div', { className: 'muted small nb-sub' }, line),
  ];
}

// An address, a gateway or a list of them as text that may break after a colon (an IPv6 address) and, as a last resort, anywhere; the prefix length
// stays attached to the last group.
const breakable = text => String(text).split(/(?<=:)/).flatMap((part, i) => (i ? [h('wbr'), part] : [part]));

// The addresses block and details of an interface card: addresses and gateway always, the rest behind "details" when there is any.
function addressLines(item) {
  const all = [...item.v4, ...item.v6];
  const dnsText = item.dns.join(', ');
  const inline = dnsText && dnsText.length <= 40;
  const more = [dnsText && !inline ? ['DNS', dnsText] : null, ...item.routes.map(r => ['route', r]), ...item.prefixes.map(p => ['prefix', p])].filter(Boolean);
  const line = (label, v) => h('div', { className: 'muted small nb-sub' }, `${label} `, h('span', { className: 'mono' }, breakable(v)));
  const details = more.length ? disclosure({
    cls: 'nb-details', summaryCls: 'small muted', summary: `details (${more.length})`, open: openDetails.has(item.id),
    onToggle: open => { if (open) openDetails.add(item.id); else openDetails.delete(item.id); },
    body: more.map(([k, v]) => line(k, v)),
  }) : null;
  return [
    all.length ? h('div', { className: 'nb-addrs' }, all.map(a => h('div', { className: 'mono small' }, breakable(a)))) : null,
    item.gateway ? line('gateway', item.gateway) : null,
    inline ? line('DNS', dnsText) : null,
    details,
  ];
}

// The card of an interface: name, protocol and state, what it sits on, its protocol device, addresses.
function interfaceCard(item) {
  return [
    h('div', { className: 'nb-line' }, icon('diagram-3', 14), h('strong', { className: 'nb-name' }, item.name),
      badge(item.protoText, 'info'), stateBadge(item), item.noProto ? badge('no protocol', 'warning', 'netifd ignores all settings of an interface without a protocol and its device stays down') : null),
    item.deviceText ? h('div', { className: 'muted small nb-sub' }, item.deviceText) : h('div', { className: 'muted small nb-sub' }, item.protoDevice ? 'no device below it' : 'no device'),
    item.protoDevice ? h('div', { className: 'nb-proto small' }, h('span', { className: 'nb-pdev mono' }, item.protoDevice.name),
      h('span', { className: 'muted' }, item.protoDevice.label ? `${item.protoDevice.label}${item.protoDevice.shared ? ' (shared)' : ''}` : item.protoDevice.shared ? 'shared' : 'protocol device')) : null,
    addressLines(item),
  ];
}

// The card of a firewall zone: its policies in words, NAT, the zones it may forward to and its networks with the services they run.
function zoneCard(item) {
  const z = item.zone;
  const nets = item.networks.map(n => {
    const d = item.services[n];
    const chips = d ? [
      d.v4 && d.v4 !== 'disabled' ? badge(`DHCP${poolText(d) ? ` ${poolText(d)}` : ''}`, '', `DHCPv4 ${d.v4}${d.leasetime ? `, lease ${d.leasetime}` : ''}`) : null,
      d.v6 && d.v6 !== 'disabled' ? badge(`DHCPv6 ${d.v6}`) : null,
      d.ra && d.ra !== 'disabled' ? badge(`RA ${d.ra}`) : null,
    ] : [];
    return h('div', { className: 'nb-net' }, h('span', { className: 'mono small' }, n), chips);
  });
  return [
    h('div', { className: 'nb-line' }, icon('shield-check', 14), h('strong', { className: 'nb-name' }, item.name),
      z ? badge(z.input === 'ACCEPT' ? 'open to the router' : 'closed to the router', z.input === 'ACCEPT' ? 'success' : 'info') : null, z?.masq ? badge('NAT', 'info', 'Masquerading: the zone\'s traffic leaves with the router\'s address') : null),
    z ? h('div', { className: 'muted small nb-sub' }, `to the router ${POLICY[z.input] ?? z.input} · from it ${POLICY[z.output] ?? z.output} · between its networks ${POLICY[z.forward] ?? z.forward}`) : h('div', { className: 'muted small nb-sub' }, 'These interfaces are in no firewall zone.'),
    z ? h('div', { className: 'muted small nb-sub' }, z.forwards?.length ? `may forward to ${z.forwards.join(', ')}` : 'forwards to no other zone') : null,
    h('div', { className: 'nb-nets' }, nets),
  ];
}

//#endregion

// A menu button: a button that shows `entries` ([{ label, hint, onclick }]) in a small list under it; the list closes after a choice, on a click
// elsewhere and on Escape.
function menuButton(label, iconName, entries, disabled) {
  const list = h('div', { className: 'nb-menu', role: 'menu', hidden: true });
  const toggle = h('button', { type: 'button', className: 'btn btn-sm btn-fl', disabled, ariaHasPopup: 'menu' }, icon(iconName), label, icon('chevron-down', 12));
  // Closes the list and removes the document listeners.
  const close = () => { list.hidden = true; document.removeEventListener('click', outside, true); document.removeEventListener('keydown', onKey, true); };
  // A click outside the menu closes it; once the board has been redrawn, the stale listener removes itself.
  const outside = e => { if (!wrap.isConnected) close(); else if (!wrap.contains(e.target)) close(); };
  // Escape closes the menu and keeps the drawer open.
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); close(); toggle.focus(); } };
  for (const e of entries) {
    list.append(h('button', { type: 'button', className: 'nb-menu-item', role: 'menuitem', onclick: () => { close(); e.onclick(); } },
      h('strong', {}, e.label), h('span', { className: 'muted small' }, e.hint)));
  }
  toggle.addEventListener('click', () => {
    if (!list.hidden) return close();
    list.hidden = false;
    document.addEventListener('click', outside, true);
    document.addEventListener('keydown', onKey, true);
  });
  const wrap = h('div', { className: 'nb-menu-wrap' }, toggle, list);
  return wrap;
}

// The header of a lane: its title, one line saying what it holds, and an optional action.
const laneHead = (title, sub, action) => h('div', { className: 'nb-lane-head' }, h('div', {}, h('h2', {}, title), h('div', { className: 'muted small' }, sub)), action ?? null);

// An empty lane says so.
const none = text => h('div', { className: 'muted small nb-none' }, text);

// Builds the board node. `opts`: board (boardmodel.js), selected (the id of the open item or null), onOpen(item), and for an editable page
// `actions` { canEdit, addDevice(kind), addNetwork() }. The node has a `select(id)` method that changes the selection without a redraw.
export function boardView({ board, selected = null, onOpen, actions = null }) {
  const els = new Map();
  let chosen = selected;
  let hovered = null;
  // Opens a card: an interface, a device or a zone in the drawer, a port or a radio on the page of that hardware.
  const open = item => { if (item.kind === 'port') location.hash = '#network'; else if (item.kind === 'radio') location.hash = '#radios'; else onOpen(item); };

  // Makes a card of `item` with `kids`; a click or Enter opens it (unless it is a link or a control inside the card). A card that holds other cards (a radio)
  // takes the focus only for itself, not for what is inside it.
  const card = (item, kind, ...kids) => {
    const el = h('div', { className: `nb-card nb-${kind}${item.removed ? ' nb-removed' : ''}${item.isNew ? ' nb-new' : ''}`, tabIndex: 0, role: 'button' }, kids);
    const own = e => kind !== 'radio' || e.target === el;
    el.dataset.id = item.id;
    if (item.kind === 'port') el.title = 'Opens the Ethernet ports page';
    else if (item.kind === 'radio') el.title = 'Opens the Wi-Fi radios page';
    els.set(item.id, el);
    el.addEventListener('click', e => { if (!e.target.closest('a, button, summary, input')) open(item); });
    el.addEventListener('keydown', e => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(item); } });
    el.addEventListener('mouseenter', () => { hovered = item.id; paint(); });
    el.addEventListener('mouseleave', () => { hovered = null; paint(); });
    el.addEventListener('focusin', e => { if (own(e)) { hovered = item.id; paint(); } });
    el.addEventListener('focusout', e => { if (own(e)) { hovered = null; paint(); } });
    return el;
  };
  // A chip (Wi-Fi) is a link: it takes part in the highlighting like a card. Leaving it for its radio highlights the radio again.
  const chip = (item, parent = null) => {
    const el = wifiChip(item);
    el.classList.add('nb-card');
    el.dataset.id = item.id;
    els.set(item.id, el);
    el.addEventListener('mouseenter', () => { hovered = item.id; paint(); });
    el.addEventListener('mouseleave', () => { hovered = parent; paint(); });
    return el;
  };

  // Lane 1: the Ethernet ports, then the radios, each a container of its Wi-Fi interfaces.
  const groups = board.lanes.ports.map(g => (g.radio
    ? h('div', { className: 'nb-group' }, card(g.radio, 'radio', radioCard(g.radio, g.items.map(i => chip(i, g.radio.id)))))
    : h('div', { className: 'nb-group' },
      h('div', { className: 'nb-group-head' }, h('strong', {}, g.title), g.band ? h('span', { className: 'muted small' }, bandText(g.band)) : null,
        g.up === false ? h('span', { className: 'muted small' }, 'down') : null, g.enabled === false ? badge('disabled') : null),
      g.items.map(i => (i.kind === 'port' ? card(i, 'port', portCard(i)) : chip(i))))));
  const lanePorts = h('section', { className: 'nb-lane nb-lane-ports' },
    laneHead('Ports and radios', 'Network devices: Ethernet ports and Wi-Fi'), h('div', { className: 'nb-cards' }, groups.length ? groups : none('No ports reported.')));

  // Lane 2: bridge and VLAN devices.
  const deviceAction = actions ? menuButton('Device', 'plus-lg', [
    { label: 'Bridge', hint: 'Joins ports into one Layer 2 network.', onclick: () => actions.addDevice('bridge') },
    { label: 'VLAN device', hint: 'The frames of one VLAN tag of a port or bridge.', onclick: () => actions.addDevice('8021q') },
  ], !actions.canEdit) : null;
  const laneDevices = h('section', { className: 'nb-lane nb-lane-devices' },
    laneHead('Devices', 'Bridge and VLAN devices carry frames', deviceAction),
    h('div', { className: 'nb-cards' }, board.lanes.devices.length ? board.lanes.devices.map(d => card(d, 'device', deviceCard(d))) : none('No bridge or VLAN devices: an interface can sit on a port directly.')));

  // Lane 3: interfaces.
  const netAction = actions ? button('Network', 'plus-lg', () => actions.addNetwork(), 'btn-fl', { disabled: !actions.canEdit }) : null;
  const laneInterfaces = h('section', { className: 'nb-lane nb-lane-interfaces' },
    laneHead('Interfaces', 'IP configuration: a protocol and addresses on one device', netAction),
    h('div', { className: 'nb-cards' }, board.lanes.interfaces.length ? board.lanes.interfaces.map(i => card(i, 'interface', interfaceCard(i))) : none('No interfaces.')));

  // Lane 4: zones and services (read only).
  const laneZones = h('section', { className: 'nb-lane nb-lane-zones' },
    laneHead('Zones and services', 'Firewall zones, DHCP and router advertisements (read only)',
      h('div', { className: 'nb-links small' }, h('a', { href: '#firewall' }, 'Firewall'), h('a', { href: '#dhcp' }, 'DHCP'))),
    h('div', { className: 'nb-cards' }, board.lanes.zones.length ? board.lanes.zones.map(z => card(z, 'zone', zoneCard(z))) : none('No firewall zones.')));

  const lanes = h('div', { className: 'nb-lanes' }, lanePorts, laneDevices, laneInterfaces, laneZones);
  const svg = svgEl('svg', { class: 'nb-svg', 'aria-hidden': 'true' });
  const root = h('div', { className: 'nb' }, svg, lanes);

  // Marks the cards and connectors related to the hovered (else the selected) item, and dims the others.
  function paint() {
    const focus = hovered ?? chosen;
    const rel = focus && els.has(focus) ? related(board, focus) : null;
    root.classList.toggle('nb-focus', Boolean(rel));
    for (const [id, el] of els) {
      // A radio is related when it or one of its interfaces is.
      el.classList.toggle('nb-rel', Boolean(rel?.ids.has(id) || board.items.get(id)?.children?.some(c => rel?.ids.has(c))));
      el.classList.toggle('nb-self', id === focus);
      el.classList.toggle('nb-sel', id === chosen);
    }
    for (const p of svg.querySelectorAll('[data-edge]')) p.classList.toggle('nb-hl', Boolean(rel?.edges.has(p.dataset.edge)));
  }

  // A point of a card's edge, relative to the board: the middle of its right or left side.
  const anchor = (el, side, box) => {
    const r = el.getBoundingClientRect();
    return [(side === 'right' ? r.right : r.left) - box.left, r.top + r.height / 2 - box.top];
  };
  // Draws every connector: a curve from the right side of the card on the left to the left side of the other; two cards of one lane (an interface on
  // another interface's device) are joined by a curve that bulges into the gap on their left.
  function draw() {
    if (!root.isConnected) return false;
    svg.replaceChildren();
    if (getComputedStyle(svg).display === 'none') return true;
    const box = root.getBoundingClientRect();
    svg.setAttribute('width', String(box.width));
    svg.setAttribute('height', String(box.height));
    for (const e of board.edges) {
      const a = els.get(e.from), b = els.get(e.to);
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      let d, p1, p2;
      if (rb.left > ra.right - 4) {
        p1 = anchor(a, 'right', box);
        p2 = anchor(b, 'left', box);
        const dx = Math.max(18, (p2[0] - p1[0]) / 2);
        d = `M${p1[0]},${p1[1]} C${p1[0] + dx},${p1[1]} ${p2[0] - dx},${p2[1]} ${p2[0]},${p2[1]}`;
      } else {
        p1 = anchor(a, 'left', box);
        p2 = anchor(b, 'left', box);
        const bulge = 26;
        d = `M${p1[0]},${p1[1]} C${p1[0] - bulge},${p1[1]} ${p2[0] - bulge},${p2[1]} ${p2[0]},${p2[1]}`;
      }
      const path = svgEl('path', { d, class: `nb-edge nb-edge-${e.kind}`, 'data-edge': e.id });
      svg.append(path, svgEl('circle', { cx: p1[0], cy: p1[1], r: 3, class: 'nb-end', 'data-edge': e.id }), svgEl('circle', { cx: p2[0], cy: p2[1], r: 3, class: 'nb-end', 'data-edge': e.id }));
    }
    paint();
    return true;
  }

  let queued = false;
  // Draws once per frame however many size changes arrive.
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; draw(); }); };
  let seen = false;
  const observer = new ResizeObserver(() => {
    if (root.isConnected) seen = true;
    else if (seen) { observer.disconnect(); return; }
    schedule();
  });
  observer.observe(root);
  for (const lane of lanes.children) observer.observe(lane);
  document.fonts?.ready.then(schedule);
  schedule();
  paint();

  // Changes the open item (null for none): highlights its chain without redrawing the board.
  root.select = id => { chosen = id; paint(); };
  return root;
}
