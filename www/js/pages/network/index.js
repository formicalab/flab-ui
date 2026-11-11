// Network page: physical ports and bridges first (state, speed, spanning tree, learned MACs, live
// throughput), then the logical interfaces. Data comes from the flab.network plugin plus netifd's
// standard network.interface dump; everything is rediscovered on every poll, and counters are turned into
// rates in the browser (core/rates.js), so links, ports and bridges that appear, change or disappear are
// reflected without a reload.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { ubus } from '../../core/ubus.js';
import { card, tile, tiles } from '../../core/ui.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { fmtNum } from '../../core/format.js';
import { portsPanel } from './ports.js';
import { bridgeCard } from './bridges.js';
import { interfacesCard, addressesByDevice } from './interfaces.js';
import { record, traffic, findings, fmtLine, errorsOf, dropsOf, newFlaps } from './util.js';

const state = { paused: false };

function summary(net) {
  const external = net.ports.filter(p => p.role !== 'conduit');
  const up = external.filter(p => p.carrier).length;
  let rx = 0, tx = 0;
  for (const p of external) { const t = traffic(p.name); rx += t.rxNow ?? 0; tx += t.txNow ?? 0; }
  const errors = net.ports.reduce((n, p) => n + errorsOf(p), 0);
  const drops = net.ports.reduce((n, p) => n + dropsOf(p), 0);
  const flaps = net.ports.reduce((n, p) => n + newFlaps(p), 0);
  const stpBridges = net.bridges.filter(b => b.stp);
  const notRoot = stpBridges.find(b => !b.is_root);
  const macs = net.bridges.reduce((n, b) => n + b.macs, 0);

  return tiles(
    tile('Ports linked', `${up} / ${external.length}`, `${external.filter(p => p.role === 'switch').length} switch · ${external.filter(p => p.role === 'nic').length} adapter`, up ? 'text-success' : 'text-danger'),
    tile('Live throughput', `↓ ${fmtLine(rx)}`, `↑ ${fmtLine(tx)} · external ports`),
    tile('Bridges', net.bridges.length, net.bridges.map(b => b.name).join(', ') || 'none'),
    tile('Spanning tree', stpBridges.length ? (notRoot ? 'Not root' : 'Root') : 'Off', notRoot ? `${notRoot.name} via ${notRoot.root_port_name ?? notRoot.root_port} (cost ${notRoot.root_path_cost})` : `${stpBridges.length} / ${net.bridges.length} bridges`),
    tile('Learned MACs', fmtNum(macs), 'in the bridge tables'),
    tile('Errors & drops', fmtNum(errors), `${fmtNum(drops)} drops${flaps ? ` · ${flaps} new link changes` : ''}`, errors ? 'text-warning' : 'text-success'));
}

function healthCard(list) {
  if (!list.length) return h('div', { className: 'net-health ok' }, icon('check-circle'), 'All ports and bridges look healthy.');
  const worst = list.some(f => f.level === 'bad') ? 'bad' : list.some(f => f.level === 'warn') ? 'warn' : 'info';
  return h('div', { className: `net-health ${worst}` },
    h('ul', {}, list.map(f => h('li', { className: f.level }, icon(f.level === 'bad' ? 'shield-exclamation' : f.level === 'warn' ? 'exclamation-triangle' : 'info-circle'), f.text))));
}

export default {
  id: 'network',
  label: 'Network',
  title: 'Network · ports and bridges',
  icon: 'diagram-3',
  interval: 3000,
  css: 'css/network.css',
  isPaused: () => state.paused,

  load: async () => {
    const [net, ifaces] = await Promise.all([ubus('flab.network', 'status'), ubus('network.interface', 'dump')]);
    record(net);
    return { net, ifs: ifaces.interface };
  },

  controls({ reload }) {
    return { nodes: [pauseControl(state), refreshControl(reload)] };
  },

  view({ net, ifs }, rerender) {
    const addrs = addressesByDevice(ifs);
    return [
      summary(net),
      healthCard(findings(net)),
      ...portsPanel(net, rerender),
      ...net.bridges.map(b => bridgeCard(b, addrs.get(b.name) ?? [])),
      interfacesCard(ifs),
    ];
  },
};
