// DNS page (route #dns): the state of the router's DNS resolver, Unbound or dnsmasq (or both), and its settings. It shows what
// the resolver is doing and how it is configured, and lets the user change the resolver's single-valued options (a yes/no
// option, a choice, a number, a name); lists and the forwarders are still read only.
//
// Top to bottom: summary tiles, the findings banner, then the cards: Listening and configuration, Forwarding and Activity
// (each full width), then Upstream from the WAN beside Try it (which hands a name to the Toolbox). Everything comes from one call, flab.dns
// status (rpcd/ucode/flab.dns.uc), every 10 s; the model (model.js) is pure and unit-tested. Changes go through the editing
// machinery the System settings and DHCP pages use (core/editpage.js, core/uci.js): stage, apply with the rollback countdown,
// read the status back to prove the change was kept and the resolver still runs, confirm. What a change is, whether it is
// valid and which UCI operations write it are in edit.js.
import { h } from '../../core/dom.js';
import { ubus } from '../../core/ubus.js';
import { refreshControl } from '../../core/controls.js';
import { createEditor } from '../../core/editpage.js';
import { emptyState, healthBanner, tile, tiles } from '../../core/ui.js';
import { engineName, findings, subject, summary } from './model.js';
import { changesOf, checkApplied, draftFrom, engineRunning, isDirty, plan, problems } from './edit.js';
import { forwardingCard } from './forwarding.js';
import { activityCard, resolverCard, tryCard, upstreamCard } from './cards.js';

// The view state that must survive the redraw on every poll: the forwarders' filter text, whether every row is
// drawn, whether the zones are grouped by server set, which groups are open, and the name typed into Try it.
const state = { fq: '', fall: false, grouped: true, open: new Set(), host: '' };

// The config being edited (the resolver's own: unbound or dhcp), known once the status has been read.
let editing = null;

// Reads the status again after a change, giving a resolver that was running a few seconds to come back from its restart.
async function readAfter() {
  const wasRunning = engineRunning(editor.state.base);
  let after = await ubus('flab.dns', 'status');
  for (let i = 0; i < 5 && wasRunning && !engineRunning(after); i++) {
    await new Promise(r => setTimeout(r, 1000));
    after = await ubus('flab.dns', 'status');
  }
  return after;
}

const editor = createEditor({
  config: () => editing,
  readAfter,
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: (base, draft, after) => checkApplied(base, after, draft),
});

// Opens the collapsed area that holds a control with an error, so the error is not hidden.
const reveal = el => { const area = el.closest('details'); if (area) area.open = true; };

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'dns',
  label: 'DNS',
  title: 'DNS',
  icon: 'hdd-network',
  interval: 10000,
  css: ['css/forms.css', 'css/dns.css'],
  // A redraw would take the focus away from the filter box or the name being typed, or throw away unsaved edits.
  isPaused: () => editor.paused('.dns-field, .dns-areas'),

  async load() {
    const data = await ubus('flab.dns', 'status');
    editing = data.config_section?.config ?? null;
    return editor.withStaged(data);
  },

  controls: ({ reload }) => ({ nodes: [refreshControl(reload), editor.attach(reload)] }),

  // The nodes of the page for one reply; `rerender` redraws from the cached reply (Show all, the grouping toggle).
  view(data, rerender) {
    const e = subject(data);
    const canEdit = editor.begin(data, rerender) && Boolean(data.config_section);
    const ctx = { canEdit, inputs: {}, sync: () => {} };
    ctx.sync = () => editor.markErrors(ctx.inputs, canEdit, reveal);
    const edit = { canEdit, draft: editor.state.draft, inputs: ctx.inputs, touched: editor.touched(ctx), redraw: () => editor.redraw() };
    const okText = data.engine ? `${engineName(data.engine)} is running and answering queries on port 53.` : 'Nothing to report.';
    const nodes = [
      ...editor.notes(data).filter(Boolean),
      tiles(...summary(data).map(t => tile(t.label, t.value, t.sub, t.cls))),
      healthBanner(findings(data), okText),
      resolverCard(data, edit),
      ...(e ? [forwardingCard(data, state, rerender)] : []),
      e ? activityCard(data) : emptyState('No resolver is installed, so there are no counters to show.'),
      h('div', { className: 'row g-3' },
        h('div', { className: 'col-12 col-xl-5' }, upstreamCard(data)),
        h('div', { className: 'col-12 col-xl-7' }, tryCard(state))),
    ];
    ctx.sync();
    return nodes;
  },
};
