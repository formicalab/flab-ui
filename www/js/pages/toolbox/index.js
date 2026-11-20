// Toolbox page (route #toolbox): diagnostic tools that run on the router and stream their output.
//
// The tools, in the order the page offers them (see diag.js): a connectivity check, ping, traceroute / MTR (traceroute with the network of
// each hop, or mtr), DNS (a lookup of one server, or of several to compare, or a trace from the root servers), a TLS certificate
// check, a packet capture, an iperf3 server and Wake-on-LAN. They run through flab.diag (rpcd/ucode/flab.diag.uc) as
// detached jobs that the page reads every half second.
// The form and the job live in the page state below, so they survive the page's own redraws and leaving the page.
import { diagView, loadDiag, newDiag } from './diag.js';

const state = {
  diag: newDiag(),
  // Redraws from the cached data; set by the page on every view.
  rerender: () => {},
};

// Opens the Toolbox with `tool` and `host` filled in and starts it (the Routing page's lookup answer and the DHCP clients use this,
// through openTool in pages/index.js, which only offers it when the Toolbox is installed).
export function openTool(tool, host) {
  const d = state.diag;
  Object.assign(d.form, { tool, host, wolOther: false });
  d.job = null;
  d.formError = null;
  d.autorun = true;
  location.hash = '#toolbox';
}

// Page object registered in pages/index.js (contract documented there).
export default {
  // The tools the router has hardly ever change; the page only needs to read them again now and then.
  interval: 60000,
  css: ['css/routing.css', 'css/toolbox.css'],
  // A redraw would take the focus away from the form being typed in.
  isPaused: () => Boolean(document.activeElement?.closest?.('.rt-diag')),

  load: loadDiag,

  view(data, rerender) {
    state.rerender = rerender;
    return diagView(data, state);
  },
};
