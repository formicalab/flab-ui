// The harness of the netpanels browser test: mounts the real panels (interfacePanel, devicePanel, globalsPanel) in the real drawer (core/drawer.js) and
// opens the real wizard, against a stateful mock of the router's network configuration (fixture.mjs): the draft is the model's draft, "Save" turns it into
// the UCI operations of model.js plan(), applies them to the mock and runs the model's own check that the configuration read back holds what was asked
// for. It exposes `window.H` for the test to drive. No request is made to a router.
import { openDrawer } from '/www/js/core/drawer.js';
import { h } from '/www/js/core/dom.js';
import { reveal } from '/www/js/core/fold.js';
import { note } from '/www/js/core/forms.js';
import { mono } from '/www/js/core/ui.js';
import { interfacePanel, devicePanel, globalsPanel, openWizard } from '/www/js/pages/interfaces/panels.js';
import { wizardOpen } from '/www/js/pages/interfaces/wizard.js';
import { addDevice, changesOf, checkApplied, draftFrom, isDirty, plan, problems, readNetwork, risksOf } from '/www/js/pages/interfaces/model.js';
import { REPLY, applyOps, clone, dataOf } from './fixture.mjs';

// The state of the mock router and the form: the config reply, the data the draft was made from, the draft, whether the login may write, what was saved.
const S = { reply: null, base: null, draft: null, canEdit: true, shown: null, handle: null, saved: [], done: null };
// The review banner's content: what changes, the errors and the warnings.
const review = document.getElementById('review');

// Starts again from the router's own configuration.
function reset() {
  S.handle?.close();
  S.reply = clone(REPLY);
  S.base = dataOf(S.reply);
  S.draft = draftFrom(S.base);
  S.canEdit = true;
  S.shown = null;
  S.handle = null;
  S.saved = [];
  S.done = null;
  renderReview();
}

// Draws the review: the pending changes, the errors and the warnings, and enables Save the way the page's banner does.
function renderReview() {
  const changes = changesOf(S.base, S.draft);
  const { errors, warnings } = problems(S.base, S.draft);
  review.replaceChildren(
    h('div', { className: 'set-bar-summary' }, changes.length ? `${changes.length} unsaved change${changes.length > 1 ? 's' : ''}` : 'No unsaved changes'),
    h('ul', { className: 'set-changes' }, changes.map(c => h('li', {}, h('b', {}, c.label), ': ', mono(c.from), ' → ', mono(c.to)))),
    h('div', { className: 'set-notes' }, errors.map(e => note('bad', e.text)), warnings.map(t => note('warn', t))));
  document.getElementById('save').disabled = !changes.length || errors.length > 0 || !S.canEdit;
}

// An editing context like editor.js editContext makes, for the panel being drawn.
function makeCtx() {
  const ctx = { base: S.base, live: S.base, draft: S.draft, canEdit: S.canEdit, inputs: {}, refreshers: [], rerender: () => {}, reload: () => {} };
  ctx.redraw = () => show();
  ctx.refresh = fn => ctx.refreshers.push(fn);
  // Marks the controls that hold an error and shows the review, like the editor's markErrors; a control in a folded group is revealed.
  ctx.sync = () => {
    for (const el of Object.values(ctx.inputs).flat()) el?.classList.remove('is-invalid');
    for (const e of problems(S.base, S.draft).errors) {
      for (const key of [e.key, e.also]) {
        const el = key && ctx.inputs[key];
        const bad = Array.isArray(el) ? el[e.index] : el;
        bad?.classList.add('is-invalid');
        if (bad) reveal(bad);
      }
    }
    renderReview();
  };
  ctx.touched = () => { ctx.sync(); for (const fn of ctx.refreshers) fn(); };
  ctx.current = () => makeCtx();
  return ctx;
}

// Builds the panel of the item shown and puts it in the drawer (the drawer keeps its scroll position).
function show() {
  if (!S.shown) return;
  const ctx = makeCtx();
  const { kind, id, ref } = S.shown;
  const panel = kind === 'interface' ? interfacePanel(ctx, id) : kind === 'device' ? devicePanel(ctx, ref) : globalsPanel(ctx);
  if (!S.handle?.isOpen()) S.handle = openDrawer({ title: panel.title, subtitle: panel.subtitle, body: panel.body, footer: panel.footer, onClose: () => { S.shown = null; } });
  else { S.handle.setTitle(panel.title, panel.subtitle); S.handle.setBody(panel.body); S.handle.setFooter(panel.footer); }
  ctx.sync();
}

window.H = {
  reset,
  // Opens the panel of an interface (draft id) or a device ({ id } or { name }), or the network-wide settings.
  openInterface: id => { S.shown = { kind: 'interface', id }; show(); },
  openDevice: ref => { S.shown = { kind: 'device', ref }; show(); },
  openGlobals: () => { S.shown = { kind: 'globals' }; show(); },
  // What the board does for "+ Device": add a device to the draft and open its panel.
  addDevice: type => { const id = addDevice(S.base, S.draft, type); S.shown = { kind: 'device', ref: { id } }; show(); return id; },
  // Opens the wizard; when it finishes the board's job is done here too: open the panel of the new interface.
  openWizard: () => {
    S.done = null;
    openWizard(makeCtx(), ids => { S.done = ids; S.shown = { kind: 'interface', id: ids.iface }; show(); });
  },
  wizardOpen,
  setCanEdit: value => { S.canEdit = value; show(); renderReview(); },
  // Saves like the page: refused while there are errors; otherwise the plan is applied to the mock and read back through the model's own check.
  save: () => {
    const { errors } = problems(S.base, S.draft);
    if (errors.length) return { ok: false, error: errors[0].text };
    const ops = plan(S.base, S.draft);
    const reply = applyOps(S.reply, ops);
    try { checkApplied({ cfg: readNetwork(clone(reply)), ifs: [], down: [] }, S.draft, S.base); } catch (e) { return { ok: false, error: e.message }; }
    S.saved.push(ops);
    S.reply = reply;
    S.base = dataOf(reply);
    S.draft = draftFrom(S.base);
    renderReview();
    if (S.shown?.kind === 'interface' && !S.base.cfg.interfaces.some(s => s.section === S.shown.id)) S.handle?.close();
    else show();
    return { ok: true, ops };
  },
  // For the assertions.
  draft: () => clone(S.draft),
  ops: () => plan(S.base, S.draft),
  changes: () => changesOf(S.base, S.draft),
  problems: () => problems(S.base, S.draft),
  risks: () => risksOf(S.base, S.draft),
  dirty: () => isDirty(S.base, S.draft),
  reply: () => clone(S.reply),
  saved: () => clone(S.saved),
  done: () => S.done,
  ids: () => ({ interfaces: S.base.cfg.interfaces.map(s => s.section), devices: S.base.cfg.devices.map(s => s.section) }),
  // Sets an option of an interface in the draft directly (to set up a case) and redraws.
  poke: (id, key, value) => { S.draft.ifaces[id][key] = value; show(); renderReview(); },
  // Changes the data the page loaded (the function body gets `d`: { cfg, net, ifs }) and restarts the draft from it, to set up a case.
  tweak: src => { new Function('d', src)(S.base); S.draft = draftFrom(S.base); show(); renderReview(); },
  theme: value => document.documentElement.setAttribute('data-bs-theme', value),
};
document.getElementById('save').onclick = () => window.H.save();
reset();
window.H.ready = true;
