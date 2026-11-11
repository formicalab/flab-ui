// Network page: every netifd interface (state, protocol, device, addresses, uptime) from the standard
// network.interface dump call, so it needs no plugin of its own.
import { ubus } from '../core/ubus.js';
import { badge, card, table } from '../core/ui.js';
import { fmtDur } from '../core/format.js';

export default {
  id: 'network',
  label: 'Network',
  icon: 'diagram-3',
  interval: 5000,
  load: () => ubus('network.interface', 'dump'),

  view({ interface: ifs }) {
    const rows = ifs.map(i => [
      i.interface, badge(i.up ? 'up' : 'down', i.up ? 'success' : 'danger'), i.proto, i.l3_device || i.device || '',
      [...(i['ipv4-address'] || []), ...(i['ipv6-address'] || [])].map(a => `${a.address}/${a.mask}`).join(', '),
      i.up ? fmtDur(i.uptime) : '',
    ]);
    return [card('Interfaces', table(['Name', 'State', 'Proto', 'Device', 'Addresses', 'Uptime'], rows))];
  },
};
