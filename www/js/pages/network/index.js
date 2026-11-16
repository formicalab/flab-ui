// The Ethernet ports view of the Devices and Interfaces page (it was the page #network; that route now opens this view): the Ethernet
// ports, as one table with a row per port (link, hardware, traffic graph, errors). The bridges and the layers built on
// the ports are the other view, the board. Data comes from the flab.network plugin; everything is rediscovered on
// every poll and counters are turned into rates in the browser (core/rates.js), so ports that appear,
// change or disappear are reflected without a reload. The VLAN cards under the port table can be edited
// (vlanpage.js, vlanedit.js, vlanmodel.js): the editor stages changes to the VLAN sections of the network config.
// This module is not a page of its own: pages/interfaces/index.js hosts it (its load, view, command-bar nodes and pause rule).
import { tile, tiles, healthBanner } from '../../core/ui.js';
import { fmtLine, fmtNum } from '../../core/format.js';
import { portsPanel } from './ports.js';
import { hooks } from './cable.js';
import { loadWired } from './shared.js';
import { vlan } from './vlanpage.js';
import { traffic, portFindings, errorsOf, dropsOf, newFlaps } from './util.js';
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

// The view the host page shows on its Ports tab.
export const ports = {
  css: ['css/network.css'],
  // The VLAN editor holds unsaved edits, a focused control or a save in progress (the host adds the Pause button).
  isPaused: () => vlan.paused(),

  // The wired data, plus what the VLAN editor needs while it is open.
  load: async () => vlan.load(await loadWired()),

  // The command-bar node of the view: the review banner of the VLAN editor.
  attach(reload) {
    hooks.reload = reload;
    return vlan.attach(reload);
  },

  // Summary tiles, the findings banner (only when there is something to report), then the port table (which redraws via `rerender`).
  view(data, rerender) {
    const findings = portFindings(data.net);
    return [
      summary(data.net),
      ...(findings.length ? [healthBanner(findings, '')] : []),
      ...portsPanel(data.net, rerender, vlan.view(data, rerender)),
    ];
  },
};
