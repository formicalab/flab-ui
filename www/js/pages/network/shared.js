// The wired-data load shared by the pages that show the ports and interfaces (the Ethernet ports, the Devices and Interfaces board
// and the Traffic page's live view). They read the same flab.network status plus netifd's network.interface dump, and feed the same
// rate tracker (util.js), so a counter sampled by one page is available to the others.
import { ubus } from '../../core/ubus.js';
import { record } from './util.js';

// Fetches both sources in parallel and feeds the counters to the rate tracker. Returns the flab.network
// status as `net` and netifd's interface list as `ifs`.
export async function loadWired() {
  const [net, ifaces] = await Promise.all([ubus('flab.network', 'status'), ubus('network.interface', 'dump')]);
  record(net);
  return { net, ifs: ifaces?.interface ?? [] };
}
