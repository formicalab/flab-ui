// Toolbox page (route #toolbox): diagnostic tools that run on the router and stream their output.
//
// The tools (see diag.js): a connectivity check, ping, traceroute (with the network of each hop), mtr, DNS lookup, a DNS trace
// from the root servers, a DNS comparison, a TLS certificate check, an iperf3 server and Wake-on-LAN. They run through
// flab.diag (rpcd/ucode/flab.diag.uc) as detached jobs that the page reads every half second.
// The form and the job live in the page state below, so they survive the page's own redraws and leaving the page.
import { refreshControl } from '../../core/controls.js';
import { diagView, loadDiag, newDiag } from './diag.js';

const state = {
  diag: newDiag(),
  // Redraws from the cached data; set by the page on every view.
  rerender: () => {},
};

// Opens the Toolbox with `tool` and `host` filled in and starts it (the Routing page's lookup answer uses this).
export function openTool(tool, host) {
  const d = state.diag;
  Object.assign(d.form, { tool, host });
  d.job = null;
  d.formError = null;
  d.autorun = true;
  location.hash = '#toolbox';
}

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'toolbox',
  label: 'Toolbox',
  title: 'Toolbox',
  icon: 'tools',
  // The tools the router has hardly ever change; the page only needs to read them again now and then.
  interval: 60000,
  css: ['css/routing.css', 'css/toolbox.css'],
  // A redraw would take the focus away from the form being typed in.
  isPaused: () => Boolean(document.activeElement?.closest?.('.rt-diag')),

  load: loadDiag,

  // Refresh redraws the page (and re-reads what the router has) without disturbing a job that is running.
  controls: ({ reload }) => ({ nodes: [refreshControl(reload)] }),

  view(data, rerender) {
    state.rerender = rerender;
    return diagView(data, state);
  },
};
