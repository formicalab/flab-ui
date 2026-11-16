// The Ethernet ports page (route #network): the physical ports as hardware, to read and to change: a table with a row per port (link, hardware, negotiation,
// traffic graph, errors, bridge, VLAN devices, cable test), the port's own device settings under its row (MTU, MAC address, link speed, flow control and the
// rest of the `device` section of /etc/config/network), and the VLAN tables of the bridges and switches, which can be edited. The bridges and the layers built
// on the ports are on the Devices and Interfaces board. Data comes from the flab.network plugin; everything is rediscovered on every poll and counters are
// turned into rates in the browser (core/rates.js), so ports that appear, change or disappear are reflected without a reload. Two editors stage changes to
// the network config: the port settings (interfaces/editor.js, shared with the board) and the VLAN editor (vlanpage.js, vlanedit.js, vlanmodel.js); both
// review banners are in the command bar.
import { tile, tiles, healthBanner } from '../../core/ui.js';
import { fmtLine, fmtNum } from '../../core/format.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { portsPanel, settingsFormOpen } from './ports.js';
import { hooks } from './cable.js';
import { vlan } from './vlanpage.js';
import { traffic, portFindings, errorsOf, dropsOf, newFlaps } from './util.js';
import { editor, editContext, editNotes, loadNetworkEdit } from '../interfaces/editor.js';

// The paused flag lives at module level so it survives the redraw on every poll.
const state = { paused: false };

// The shell's reload function, handed over by controls().
const shell = { reload: () => {} };

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

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'network',
  label: 'Ethernet ports',
  title: 'Ethernet ports',
  icon: 'ethernet',
  // The ports' rates are counted between polls, so the page is read often.
  interval: 3000,
  css: ['css/forms.css', 'css/netedit.css', 'css/network.css'],

  // The wired data, the editable network config (optional: a login that may not read it gets the page without the settings forms) and, while the VLAN
  // editor is open, what it needs.
  load: async () => vlan.load(await loadNetworkEdit()),

  // No polling while a settings form holds unsaved input or the focus, or while the VLAN editor is open or busy.
  isPaused: () => state.paused || vlan.paused() || editor.paused('.ne-form'),

  controls({ reload }) {
    shell.reload = reload;
    hooks.reload = reload;
    return { nodes: [pauseControl(state), refreshControl(reload), editor.attach(reload), vlan.attach(reload)] };
  },

  // Summary tiles, the findings banner (only when there is something to report), then the port table (which redraws via `rerender`) and the VLAN cards.
  view(data, rerender) {
    const findings = portFindings(data.net);
    // The editing context (and with it the validation of the whole network config and the review banner) is made only while a settings form is open or edits
    // are pending: a page that only shows the ports raises no errors about a config nobody is editing.
    const available = Boolean(data.cfg?.available);
    const ctx = available && (settingsFormOpen() || editor.dirty()) ? editContext(data, rerender, shell) : null;
    const vlanCtx = vlan.view(data, rerender);
    const page = [
      summary(data.net),
      // The notes about staged leftovers are the VLAN editor's while it is open (it shows them itself): the two editors stage the same config.
      ...(vlanCtx?.edit || !ctx ? [] : editNotes(data)),
      ...(findings.length ? [healthBanner(findings, '')] : []),
      ...portsPanel(data.net, rerender, vlanCtx, { available, ctx, has: name => (data.cfg?.devices ?? []).some(d => !d.values?.type && String(d.values?.name ?? '').trim() === name) }),
    ];
    // The settings forms registered their controls in ctx.inputs while the table was built; the errors are marked on them now.
    ctx?.sync();
    return page;
  },
};
