// One card per bridge: spanning-tree position (root bridge, root port, path cost), settings, VLAN
// devices and a member table with live link state, STP role and learned MAC addresses.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, kv, section, muted, mono } from '../../core/ui.js';
import { fmtLine, fmtNum, fmtSpan } from '../../core/format.js';
import { fmtSpeed, traffic, newFlaps, STP_ROLE, stpKind } from '../network/util.js';

// A switch with the given labels, used for settings the bridge has on or off.
const onOff = (on, yes = 'on', no = 'off') => badge(on ? yes : no, on ? 'success' : '');

// Card title row: state dot (up and carrier), name, status badges (STP role, VLAN filtering, topology change)
// and the bridge's L3 addresses.
function header(b, addrs) {
  return h('div', { className: 'br-head' },
    h('span', { className: `dot ${b.up && b.carrier ? 'up' : 'down'}` }),
    icon('diagram-2', 20),
    h('strong', { className: 'name' }, b.name),
    badge(b.up ? 'up' : 'down', b.up ? 'success' : 'danger'),
    b.stp ? badge(b.is_root ? 'STP root' : 'STP: not root', b.is_root ? 'success' : 'info') : badge('STP off', 'warning'),
    b.vlan_filtering ? badge('VLAN filtering', 'info') : null,
    b.topology_change ? badge('topology change', 'warning') : null,
    h('span', { className: 'br-addrs' }, addrs.length ? addrs.map(a => mono(a)) : muted('no L3 address')));
}

// Where this bridge sits in the spanning tree: the root bridge, the port leading to it and its cost.
function stpDiagram(b) {
  if (!b.stp) return h('div', { className: 'br-stp off muted' }, 'Spanning tree is disabled: the bridge forwards on every linked port and cannot detect loops.');
  const me = h('div', { className: 'br-node me' }, icon('diagram-2', 22), h('div', { className: 'node-title' }, b.name), h('div', { className: 'mono small' }, b.bridge_id));
  if (b.is_root) return h('div', { className: 'br-stp root' }, me, h('div', { className: 'muted' }, 'This bridge is the spanning-tree root: all other bridges reach the network through it.'));
  return h('div', { className: 'br-stp' },
    h('div', { className: 'br-node' }, icon('router', 22), h('div', { className: 'node-title' }, 'Root bridge'), h('div', { className: 'mono small' }, b.root_id)),
    h('div', { className: 'br-link' }, h('div', { className: 'line' }), h('div', { className: 'muted small' }, `via ${b.root_port_name ?? `port ${b.root_port}`} · path cost ${b.root_path_cost}`)),
    me);
}

// Key/value list of the bridge's configuration and live traffic; the STP rows only appear when STP is on.
function settings(b) {
  const t = traffic(b.name);
  return kv([
    ['Bridge ID', mono(b.bridge_id ?? '–')],
    b.stp ? ['Priority', `${b.priority} (lower wins)`] : null,
    b.stp ? ['Timers', `hello ${fmtSpan(b.hello_time)} · forward delay ${fmtSpan(b.forward_delay)} · max age ${fmtSpan(b.max_age)}`] : null,
    ['MAC ageing', fmtSpan(b.ageing_time)],
    ['Learned MACs', fmtNum(b.macs)],
    ['VLAN filtering', b.vlan_filtering ? h('span', {}, onOff(true), ` default PVID ${b.default_pvid ?? '–'}`) : onOff(false)],
    ['IGMP snooping', h('span', {}, onOff(b.igmp_snooping), b.igmp_snooping ? h('span', {}, ' querier ', onOff(b.multicast_querier)) : null)],
    ['VLAN devices', b.vlans.length ? h('span', {}, b.vlans.map(v => badge(`${v.name} (${v.vid})`, v.up ? 'success' : 'danger'))) : muted('none')],
    ['MAC · MTU', `${b.mac ?? '–'} · ${b.mtu ?? '–'}`],
    ['Throughput', h('span', {}, icon('arrow-down', 12), fmtLine(t.rxNow), '  ', icon('arrow-up', 12), fmtLine(t.txNow))],
  ]);
}

// Type badge of a member: Wi-Fi members also show their SSID (or radio) and radio.
function kindLabel(m) {
  if (m.kind === 'wifi') return h('span', {}, badge('Wi-Fi'), ' ', m.ssid ?? m.phy ?? '', m.ssid ? muted(` · ${m.phy}`) : null);
  if (m.kind === 'ethernet') return badge('Ethernet');
  return badge(m.kind);
}

// One member port: link, STP state/role/cost (brport), learned MACs, live rate and link flaps since open.
function memberRow(m) {
  const t = traffic(m.name);
  const bp = m.brport;
  return h('tr', {},
    h('td', {}, h('span', { className: `dot ${m.carrier ? 'up' : 'idle'}` }), h('strong', {}, ' ' + m.name)),
    h('td', {}, kindLabel(m)),
    h('td', {}, m.carrier ? badge(m.speed ? fmtSpeed(m.speed) : 'link up', 'success') : badge('no link', '')),
    h('td', {}, bp ? badge(bp.state_name, stpKind(bp.state_name)) : muted('–')),
    h('td', {}, bp?.role ? STP_ROLE[bp.role] : muted('–')),
    h('td', { className: 'num' }, bp ? bp.path_cost : '–'),
    h('td', { className: 'num' }, fmtNum(m.macs)),
    h('td', { className: 'num' }, m.carrier ? h('div', {}, h('div', {}, icon('arrow-down', 12), fmtLine(t.rxNow)), h('div', {}, icon('arrow-up', 12), fmtLine(t.txNow))) : '–'),
    h('td', { className: 'num' }, newFlaps(m) ? badge(`+${newFlaps(m)} flaps`, 'warning') : null));
}

// The member-port table of one bridge.
function members(b) {
  const cols = ['Port', 'Type', 'Link', 'STP state', 'STP role', 'Cost', 'MACs', 'Throughput', ''];
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover' },
    h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
    h('tbody', {}, b.members.length ? b.members.map(memberRow) : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'No member ports')))));
}

// `addrs` are the L3 addresses of the logical interfaces that sit on this bridge.
export function bridgeCard(b, addrs) {
  return h('div', { className: `card br-card ${b.up ? 'is-up' : 'is-down'}` },
    header(b, addrs),
    stpDiagram(b),
    h('div', { className: 'br-cols' }, section('Settings', settings(b)), section(`Member ports (${b.members.length})`, members(b))));
}
