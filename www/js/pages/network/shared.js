// Pieces shared by the three wired-network pages (Wired network, Bridges, Devices and Interfaces): the
// common data load and address helpers. All three read the same flab.network status plus netifd's
// network.interface dump, and feed the same rate tracker (util.js), so a counter sampled by one page is
// available to the others.
import { ubus } from '../../core/ubus.js';
import { record } from './util.js';

// Fetches both sources in parallel and feeds the counters to the rate tracker. Returns the flab.network
// status as `net` and netifd's interface list as `ifs`.
export async function loadWired() {
  const [net, ifaces] = await Promise.all([ubus('flab.network', 'status'), ubus('network.interface', 'dump')]);
  record(net);
  return { net, ifs: ifaces.interface };
}

// An interface's IPv4 and IPv6 addresses as "address/prefix" strings.
export const addressesOf = i => [...(i['ipv4-address'] ?? []), ...(i['ipv6-address'] ?? [])].map(a => `${a.address}/${a.mask}`);

// L3 addresses by device name, used to label bridges.
export function addressesByDevice(ifs) {
  const map = new Map();
  for (const i of ifs) {
    const dev = i.l3_device || i.device;
    if (dev) map.set(dev, [...(map.get(dev) ?? []), ...addressesOf(i)]);
  }
  return map;
}
