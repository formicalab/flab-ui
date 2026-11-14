// Wired network page (route #network): the Ethernet ports. The wiring diagram (SoC, MACs, switch chip,
// PHYs, jacks) and a port table with link, hardware, traffic and errors. Bridges and the layers built on
// the ports have their own pages. Data comes from the flab.network plugin; everything is rediscovered on
// every poll and counters are turned into rates in the browser (core/rates.js), so ports that appear,
// change or disappear are reflected without a reload.
import { tile, tiles, healthBanner } from '../../core/ui.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { fmtLine, fmtNum } from '../../core/format.js';
import { portsPanel } from './ports.js';
import { hooks } from './cable.js';
import { loadWired } from './shared.js';
import { traffic, portFindings, errorsOf, dropsOf, newFlaps } from './util.js';

// Module-level so the Pause button state survives the redraw on every poll.
const state = { paused: false };

// KPI tiles. Throughput sums the external ports only: a conduit (SoC MAC feeding a switch) carries the
// same frames as the switch ports and would be counted twice.
function summary(net) {
  const external = net.ports.filter(p => p.role !== 'conduit');
  const up = external.filter(p => p.carrier).length;
  let rx = 0, tx = 0;
  for (const p of external) { const t = traffic(p.name); rx += t.rxNow ?? 0; tx += t.txNow ?? 0; }
  const errors = net.ports.reduce((n, p) => n + errorsOf(p), 0);
  const drops = net.ports.reduce((n, p) => n + dropsOf(p), 0);
  const flaps = net.ports.reduce((n, p) => n + newFlaps(p), 0);
  const sw = net.switches?.[0];

  return tiles(
    tile('Ports linked', `${up} / ${external.length}`, `${external.filter(p => p.role === 'switch').length} switch · ${external.filter(p => p.role === 'nic').length} adapter`, up ? 'text-success' : 'text-danger'),
    tile('Live throughput', `↓ ${fmtLine(rx)}`, `↑ ${fmtLine(tx)} · external ports`),
    tile('Switch', sw ? sw.label ?? 'switch' : 'none', sw ? `${sw.ports.length} user ports · CPU port${sw.cpu_ports.length === 1 ? '' : 's'} ${sw.cpu_ports.map(c => c.port).join(', ') || '–'}` : 'ports connect straight to the SoC'),
    tile('Errors & drops', fmtNum(errors), `${fmtNum(drops)} drops`, errors ? 'text-warning' : 'text-success'),
    tile('Link changes', flaps, 'since this page was opened', flaps ? 'text-warning' : ''));
}

export default {
  id: 'network',
  label: 'Wired network',
  title: 'Wired network · ports',
  icon: 'ethernet',
  interval: 3000,
  css: 'css/network.css',
  isPaused: () => state.paused,

  load: loadWired,

  controls({ reload }) {
    hooks.reload = reload;
    return { nodes: [pauseControl(state), refreshControl(reload)] };
  },

  // Summary tiles, the findings banner, then the wiring diagram and port table (which redraw via `rerender`).
  view({ net }, rerender) {
    return [
      summary(net),
      healthBanner(portFindings(net), 'All ports look healthy.'),
      ...portsPanel(net, rerender),
    ];
  },
};
