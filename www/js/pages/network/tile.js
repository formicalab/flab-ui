// One physical port as a tile: jack, name, LAN/WAN role from the board, speed, live rate and chart, and
// bridge / STP / VLAN tags. Used by the topology diagram.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, sparkline } from '../../core/ui.js';
import { fmtLine } from '../../core/format.js';
import { fmtSpeed, traffic, newFlaps, newErrors, hwLines, STP_ROLE, stpKind } from './util.js';

// Tile color state: 'down' without carrier, 'warn' when downshifted, flapping/erroring since the page was opened or the
// optical module raises an alarm, else 'up'.
function portState(p) {
  if (!p.carrier) return 'down';
  return p.downshifted || newFlaps(p) || newErrors(p) || p.sfp?.alarms?.length ? 'warn' : 'up';
}

// The tile for one port; its tooltip lists the full hardware details (always including its MAC). The MAC is written on the tile only
// when `showMac` is true: a switch port that has the address of the SoC port feeding it says nothing new there.
export function portTile(p, showMac = true) {
  const t = traffic(p.name);
  // Whether the router counts this port's traffic (a swconfig port has no counters of its own).
  const counted = p.stats?.rx_bytes != null;
  const title = [`${p.name} · ${p.mac ?? ''}`, p.carrier ? `Link ${fmtSpeed(p.speed)} ${p.duplex ?? ''}` : 'No link', ...hwLines(p).map(([k, v]) => `${k}: ${v}`)].join('\n');
  return h('div', { className: `port ${portState(p)}`, title },
    h('div', { className: 'jack' }, icon('ethernet', 26)),
    h('div', { className: 'pname' }, p.name),
    showMac && p.mac ? h('div', { className: 'pmac' }, p.mac) : null,
    p.board?.role ? h('div', { className: 'prole' }, p.board.role.toUpperCase()) : null,
    h('div', { className: 'pspeed' }, p.carrier ? fmtSpeed(p.speed) : 'no link'),
    p.carrier && !counted
      ? h('div', { className: 'prate muted' }, 'no per-port counters')
      : p.carrier
        ? h('div', { className: 'prate' }, h('span', {}, icon('arrow-down', 12), fmtLine(t.rxNow)), h('span', {}, icon('arrow-up', 12), fmtLine(t.txNow)))
        : h('div', { className: 'prate muted' }, p.up ? 'cable unplugged' : 'disabled'),
    p.carrier && counted ? sparkline([{ values: t.rx, cls: 'rx' }, { values: t.tx, cls: 'tx' }], { width: 130, height: 26 }) : null,
    h('div', { className: 'ptags' },
      p.sfp?.present ? badge('SFP', p.sfp.alarms?.length ? 'danger' : 'info', [p.sfp.vendor, p.sfp.part].filter(Boolean).join(' ')) : null,
      p.bridge ? badge(p.bridge, 'info') : null,
      p.brport?.role ? badge(STP_ROLE[p.brport.role], stpKind(p.brport.state_name)) : null,
      ...(p.vlans ?? []).map(v => badge(`VLAN ${v.vid}`, '', v.name))));
}
