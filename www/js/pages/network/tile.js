// One physical port as a tile: jack, name, LAN/WAN role from the board, speed, live rate and chart, and
// bridge / STP / VLAN tags. Used by the topology diagram.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, sparkline } from '../../core/ui.js';
import { fmtLine, fmtSpeed, traffic, newFlaps, newErrors, hwLines, STP_ROLE, stpKind } from './util.js';

export function portState(p) {
  if (!p.carrier) return 'down';
  return p.downshifted || newFlaps(p) || newErrors(p) ? 'warn' : 'up';
}

export function portTile(p) {
  const t = traffic(p.name);
  const title = [`${p.name} · ${p.mac ?? ''}`, p.carrier ? `Link ${fmtSpeed(p.speed)} ${p.duplex ?? ''}` : 'No link', ...hwLines(p).map(([k, v]) => `${k}: ${v}`)].join('\n');
  return h('div', { className: `port ${portState(p)}`, title },
    h('div', { className: 'jack' }, icon('ethernet', 26)),
    h('div', { className: 'pname' }, p.name),
    p.board?.role ? h('div', { className: 'prole' }, p.board.role.toUpperCase()) : null,
    h('div', { className: 'pspeed' }, p.carrier ? fmtSpeed(p.speed) : 'no link'),
    p.carrier
      ? h('div', { className: 'prate' }, h('span', {}, icon('arrow-down', 12), fmtLine(t.rxNow)), h('span', {}, icon('arrow-up', 12), fmtLine(t.txNow)))
      : h('div', { className: 'prate muted' }, p.up ? 'cable unplugged' : 'disabled'),
    p.carrier ? sparkline([{ values: t.rx, cls: 'rx' }, { values: t.tx, cls: 'tx' }], { width: 130, height: 26 }) : null,
    h('div', { className: 'ptags' },
      p.bridge ? badge(p.bridge, 'info') : null,
      p.brport?.role ? badge(STP_ROLE[p.brport.role], stpKind(p.brport.state_name)) : null,
      ...(p.vlans ?? []).map(v => badge(`VLAN ${v.vid}`, '', v.name))));
}
