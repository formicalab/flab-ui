// DNS resolver tab: the state of the router's DNS resolver, Unbound or dnsmasq (or both), and its settings. It shows what
// the resolver is doing and how it is configured, and lets the user change the resolver's single-valued options (a yes/no
// option, a choice, a number, a name) and its zones: Unbound's `config zone` blocks (forward, stub and authoritative) or
// dnsmasq's `server` entries, added, edited and removed in a dialog. Lists of options are still read only.
//
// Top to bottom: summary tiles, the findings banner, then the cards, each full width: Configuration, Zones (with the resolvers
// from the WAN) and Activity. Everything comes from one call, flab.dns
// status (rpcd/ucode/flab.dns.uc), every 10 s; the model (model.js, zones.js) is pure and unit-tested. Changes go through the
// editing machinery the System settings and DHCP pages use (core/editpage.js, core/uci.js): stage, apply with the rollback
// countdown, read the status back to prove the change was kept and the resolver still runs, confirm. What a change is, whether
// it is valid and which UCI operations write it are in edit.js and zones.js.
import { ubus } from '../../core/ubus.js';
import { sleep } from '../../core/dom.js';
import { refreshControl } from '../../core/controls.js';
import { createEditor } from '../../core/editpage.js';
import { reveal } from '../../core/fold.js';
import { emptyState, healthBanner, tile, tiles } from '../../core/ui.js';
import { engineName, findings, subject, summary } from './model.js';
import { changesOf, checkApplied, draftFrom, engineRunning, isDirty, plan, problems, zonesReady } from './edit.js';
import { zonesCard } from './zonescard.js';
import { activityCard, resolverCard } from './cards.js';

// The view state that must survive the redraw on every poll: the zones' filter text, which folding cards are open (Zones and
// Activity start folded), which zones show all their domains, and the open dialog, if any.
const state = { fq: '', folds: {}, expanded: new Set(), dialog: null };

// The config being edited (the resolver's own: unbound or dhcp), known once the status has been read.
let editing = null;

// Reads the status again after a change, giving a resolver that was running a few seconds to come back from its restart, and
// Unbound a few seconds to list the zones it was told to forward.
async function readAfter() {
  const { base, draft } = editor.state;
  const wasRunning = engineRunning(base);
  let after = await ubus('flab.dns', 'status');
  for (let i = 0; i < 8 && ((wasRunning && !engineRunning(after)) || !zonesReady(base, after, draft)); i++) {
    await sleep(1000);
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

// The resolver tab of the combined DNS page. dns/index.js owns the route, label, icon, refresh period and stylesheets, and
// calls load(), controls(), view() and isPaused() of this object (the page contract is documented in pages/index.js).
export default {
  // A redraw would take the focus away from the filter box or a dialog's form, or throw away unsaved edits.
  isPaused: () => state.dialog != null || editor.paused('.dns-field, .dns-areas'),

  async load() {
    const data = await ubus('flab.dns', 'status');
    editing = data.config_section?.config ?? null;
    return editor.withStaged(data);
  },

  controls: ({ reload }) => ({ nodes: [refreshControl(reload), editor.attach(reload)] }),

  // The nodes of the page for one reply; `rerender` redraws from the cached reply (used by the editor).
  view(data, rerender) {
    const e = subject(data);
    const canEdit = editor.begin(data, rerender) && Boolean(data.config_section);
    const ctx = { canEdit, inputs: {}, sync: () => {} };
    ctx.sync = () => editor.markErrors(ctx.inputs, canEdit, reveal);
    const edit = { canEdit, draft: editor.state.draft, inputs: ctx.inputs, touched: editor.touched(ctx), redraw: () => editor.redraw() };
    // What the Zones card needs: the data the draft was made from and the draft as they are when it asks (a refresh can replace
    // them), and a call that updates the review banner and redraws after a zone was added, changed or removed.
    const zonesEdit = { canEdit, getBase: () => editor.state.base, getDraft: () => editor.state.draft, changed: () => { edit.touched(); editor.redraw(); } };
    const okText = data.engine ? `${engineName(data.engine)} is running and answering queries on port 53.` : 'Nothing to report.';
    const nodes = [
      ...editor.notes(data).filter(Boolean),
      tiles(...summary(data).map(t => tile(t.label, t.value, t.sub, t.cls))),
      healthBanner(findings(data), okText),
      resolverCard(data, edit),
      ...(e ? [zonesCard(data, state, zonesEdit)] : []),
      e ? activityCard(data, state) : emptyState('No resolver is installed, so there are no counters to show.'),
    ];
    ctx.sync();
    return nodes;
  },
};
