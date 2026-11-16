// The live details of one Ethernet port for its drawer on the Devices and Interfaces board: the same facts as the port's row on the Ethernet
// ports view (link and its changes, negotiation, hardware, throughput with its graph, errors and drops with the breakdown behind Details, the
// bridge and spanning-tree state, VLAN devices, the optical module, the cable test), built from the same cells so the two never differ.
import { h } from '../../core/dom.js';
import { kv } from '../../core/ui.js';
import { ubus } from '../../core/ubus.js';
import { bridgeCell, errorsCell, expanded, hardwareCell, linkCell, negotiation, throughputBody, vlansCell } from './ports.js';
import { diagnosticsPanel } from './diagnostics.js';
import { cablePanel } from './cable.js';
import { record } from './util.js';

const ROLE = { conduit: 'the link between the CPU and the switch chip', nic: 'a network card' };

// What the port is: LAN or WAN on the board, the CPU link of a switch, or a network card; null when nothing is known.
const roleText = p => (p.board?.role ? p.board.role.toUpperCase() : ROLE[p.role] ?? (p.role ? `a ${p.role} port` : null));

// What the hosting page hands over: whether the user paused it (the Pause button), so the details stand still with the rest.
export const liveHooks = { paused: () => false };

const REFRESH_MS = 3000;
const blocks = new Map();
let timer = null;
let busy = false;

// The facts of the port `name` as the rows of a list and the panels under it, or null when the router reports no port of that name.
function content(net, name) {
  const p = (net?.ports ?? []).find(x => x.name === name);
  if (!p) return null;
  const role = roleText(p);
  // Four groups with a rule between them: what the port is, its link, its traffic, how it is wired. The breakdown of the errors opens under the
  // traffic and the cable test result under the link.
  return [
    kv([
      ['Hardware', hardwareCell(p)],
      role ? ['Role', role] : null,
      p.mac ? ['MAC', h('span', { className: 'mono' }, p.mac)] : null,
    ]),
    kv([
      ['Link', linkCell(p)],
      ['Negotiation', negotiation(p)],
    ]),
    cablePanel(p),
    kv([
      ['Throughput', h('div', { className: 'pl-rate' }, ...throughputBody(p))],
      ['Errors / drops', errorsCell(p)],
    ]),
    p.diagnostics && expanded.has(p.name) ? diagnosticsPanel(p) : null,
    kv([
      ['Bridge / STP', bridgeCell(p)],
      ['VLAN devices', h('div', {}, vlansCell(p))],
    ]),
  ].filter(Boolean);
}

// Reads the status again and redraws every block still on screen in place. A drawer with a form pauses the page's own poll, so the details
// poll for themselves: they replace nothing but their own content, and the form is left alone.
async function tick() {
  for (const root of [...blocks.keys()]) if (!root.isConnected) blocks.delete(root);
  if (!blocks.size) { clearInterval(timer); timer = null; return; }
  if (busy || document.hidden || liveHooks.paused()) return;
  busy = true;
  try {
    const net = await ubus('flab.network', 'status');
    record(net);
    for (const [root, name] of blocks) {
      const next = root.isConnected ? content(net, name) : null;
      if (next) root.replaceChildren(...next);
    }
  } catch { /* the next tick, or the page's own poll, reports a lost session */ } finally { busy = false; }
}

// The details of the port `name` from the flab.network status `net`, or null when the router reports no port of that name. The page that shows it
// binds the Details buttons to its own redraw first (ports.js bindRedraw). The block refreshes itself every few seconds while it is on screen.
export function portLive(net, name) {
  const nodes = content(net, name);
  if (!nodes) return null;
  const root = h('div', { className: 'pl' }, ...nodes);
  blocks.set(root, name);
  timer ??= setInterval(tick, REFRESH_MS);
  return root;
}
