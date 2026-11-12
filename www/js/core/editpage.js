// The part every page that edits a config has in common (System settings, DHCP): the draft of the form and the data
// it was made from, whether there are unsaved edits, the review banner, saving (stage, apply with the rollback
// countdown, read back, confirm), discarding edits or leftovers staged in the session, and the notes about a
// read-only login and about leftovers. The page keeps what is specific to it: its schema, its model, its controls.
//
// createEditor(spec) returns the editor; spec is
//   config      the uci config being edited, or a function that returns it (null: nothing to edit)
//   readBack    (cfg) => data       reads a fresh `uci get` reply into the page's data shape, for the check after a save
//   readAfter   optional async () => data    reads the data for that check some other way (a page that must not
//               load the whole config, for example because it holds secrets, reads just the sections it edits)
//   model       { draftFrom(data), changesOf(base, draft), isDirty(base, draft), problems(base, draft), plan(base, draft) }
//   verify      (base, draft, after) => void    throws when the data read back does not hold what was saved
//   afterSave   optional (base, draft) => boolean    true when the page took over the refresh (otherwise it reloads)
import { AuthError, can, optional } from './ubus.js';
import { button } from './ui.js';
import { note, reviewBanner } from './forms.js';
import { stageOps } from './ops.js';
import { applyChange, uci } from './uci.js';

// Creates the editor for one page; see the description of `spec` above.
export function createEditor(spec) {
  const { model } = spec;
  // The config being edited: a name, or a function for a page whose config depends on what it found (the DNS page edits
  // /etc/config/unbound or /etc/config/dhcp, whichever resolver the router uses); null means there is nothing to edit.
  const configName = () => (typeof spec.config === 'function' ? spec.config() : spec.config);
  // What the form holds (`draft`) and the data it was made from (`base`), kept here so they survive the redraw on
  // every poll. `message` is the outcome of the last save or discard ({ kind: ok | bad | info, text }).
  const state = { base: null, draft: null, busy: false, message: null };
  // The page's redraw and reload callbacks, set when the shell builds the page, and the review banner, created
  // with the page's controls.
  let redraw = () => {};
  let reloadPage = () => {};
  let bar = null;

  // Whether the form has edits that are not saved yet.
  const dirty = () => Boolean(state.base && state.draft && model.isDirty(state.base, state.draft));

  // Updates the review banner from the draft.
  const renderBar = canEdit => {
    const ready = state.base && state.draft;
    const found = ready ? model.problems(state.base, state.draft) : { errors: [], warnings: [] };
    bar.render({
      changes: ready ? model.changesOf(state.base, state.draft) : [],
      errors: found.errors, warnings: found.warnings, message: state.message,
      busy: state.busy, canEdit, dirty: dirty(),
      dismiss: () => { state.message = null; renderBar(canEdit); },
    });
  };

  // Throws away the changes staged in this session (they would be applied together with this page's).
  async function discardStaged() {
    try {
      await uci.revert(configName());
      state.message = { kind: 'ok', text: 'The staged changes were discarded.' };
    } catch (e) {
      state.message = { kind: 'bad', text: e.message };
    }
    await reloadPage();
  }

  // Forgets the edits and shows what the router has.
  async function discardEdits() {
    state.draft = null;
    state.message = null;
    await reloadPage();
  }

  // Saves the form: stage, apply with the rollback countdown, read the config back to prove it was stored, then
  // confirm. Any failure leaves the router on its previous config and the edits in the form.
  async function save() {
    const { base, draft } = state;
    const config = configName();
    state.busy = true;
    state.message = { kind: 'info', text: 'Applying the change…' };
    redraw();
    try {
      await applyChange(uci, [config],
        ed => stageOps(ed, model.plan(base, draft)),
        async () => spec.verify(base, draft, spec.readAfter ? await spec.readAfter() : spec.readBack(await uci.get(config))));
      state.message = { kind: 'ok', text: 'Saved: the router applied the change and it was confirmed.' };
      state.draft = null;
    } catch (e) {
      // An expired session needs a new sign-in: reloading lets the shell show the sign-in screen.
      if (e instanceof AuthError) return location.reload();
      state.message = { kind: 'bad', text: e.message };
    }
    state.busy = false;
    if (!spec.afterSave?.(base, draft)) await reloadPage();
  }

  return {
    state,
    dirty,
    renderBar,

    // Creates the review banner and remembers the shell's reload callback; call it from the page's `controls()`
    // and put the returned node among the command-bar controls.
    attach(reload) {
      reloadPage = reload;
      bar = reviewBanner({ onSave: save, onDiscard: discardEdits });
      return bar.node;
    },

    // Starts a view: unsaved edits survive a refresh, otherwise the form restarts from what the router has. Returns
    // whether the controls may be used (the login may write and no save is running).
    begin(data, rerender) {
      redraw = rerender;
      if (!state.draft || !dirty()) {
        state.base = data;
        state.draft = spec.model.draftFrom(data);
      }
      return can('uci', 'set') && !state.busy;
    },

    // The page's own redraw, for controls that change the shape of the form (a list row added or removed).
    redraw: () => redraw(),

    // Adds how many changes are already staged in this session to the loaded data (applying would commit those too).
    async withStaged(data) {
      const config = configName();
      data.staged = config && can('uci', 'set') ? (await optional(uci.pending(config))) ?? 0 : 0;
      return data;
    },

    // For the page's `isPaused`: no polling over unsaved edits, a save in progress or a focused control of the form.
    paused: selector => state.busy || dirty() || Boolean(document.activeElement?.closest?.(selector)),

    // The notes above the form: a read-only login, and changes already staged in this session.
    notes: data => [
      can('uci', 'set') ? null : note('warn', 'This login is not allowed to change the configuration, so the settings are shown read-only.'),
      data.staged ? note('warn', `${data.staged} change(s) are already staged in this session (for example from an attempt that was rolled back); saving would apply them too.`, button('Discard them', 'x-lg', discardStaged)) : null,
    ],

    // Called after every edit to a control: forgets the outcome of the last save (it no longer describes the form),
    // then runs the page's own `sync`.
    touched: ctx => () => { state.message = null; ctx.sync(); },

    // Marks the controls that hold an error (`inputs` maps a control name to its element, or to the elements of a
    // list), calls `reveal(element)` for each so the page can unhide it, and refreshes the banner.
    markErrors(inputs, canEdit, reveal) {
      for (const el of Object.values(inputs).flat()) el?.classList.remove('is-invalid');
      for (const e of model.problems(state.base, state.draft).errors) {
        for (const key of [e.key, e.also]) {
          const el = key && inputs[key];
          const bad = Array.isArray(el) ? el[e.index] : el;
          bad?.classList.add('is-invalid');
          if (bad) reveal?.(bad);
        }
      }
      renderBar(canEdit);
    },
  };
}
