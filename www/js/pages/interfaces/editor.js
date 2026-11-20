// The editor of the Devices and Interfaces page: it edits /etc/config/network through one draft, so unsaved
// edits survive a switch to another page and one Save applies them together. This module owns the editor (core/editpage.js), the load
// of the data the page needs, the check after a save (which also looks at whether the interfaces that were up still are) and the
// confirmation shown before a change that can cut the admin's connection. The editing panels are in panels.js, the rules in model.js.
//
// The config is read through the flab.network plugin (`config`), which leaves out the secrets (the PPPoE password): the browser never
// receives one and the password field is write-only. A network change gets a longer rollback countdown than the default (the network
// reloads, and the admin may have to reconnect), set per call, not globally.
import { h, sleep } from '../../core/dom.js';
import { AuthError, can, optional, ubus } from '../../core/ubus.js';
import { button, muted } from '../../core/ui.js';
import { note } from '../../core/forms.js';
import { createEditor } from '../../core/editpage.js';
import { openDialog } from '../../core/modal.js';
import { reveal } from '../../core/fold.js';
import { loadWired } from '../network/shared.js';
import { APPLY_SECONDS, CONFIG, SETTLE_MS, changesOf, checkApplied, downAfter, draftFrom, isDirty, plan, problems, readNetwork, risksOf } from './model.js';

// How often the router is asked after a save before the check gives up, and the pause between asks: the network may still be reloading, so a
// failed ask is not yet a failed save.
const RETRIES = 6;
const RETRY_MS = 2000;

// Reads what the router holds after a save: the config (through the plugin) and netifd's interfaces. An ask that fails, or a network that is
// not up yet, is repeated for a while; the last answer is the one that counts.
async function readAfter() {
  const { base, draft } = editor.state;
  for (let attempt = 1; ; attempt++) {
    const last = attempt === RETRIES;
    try {
      const [reply, dump] = await Promise.all([ubus('flab.network', 'config'), ubus('network.interface', 'dump')]);
      const cfg = readNetwork(reply);
      if (!cfg.available) throw new Error('the router did not return the network configuration');
      const after = { cfg, ifs: dump?.interface ?? [] };
      after.down = downAfter(base, draft, after.ifs);
      if (!after.down.length || last) return after;
    } catch (e) {
      if (e instanceof AuthError || last) throw e;
    }
    await sleep(RETRY_MS);
  }
}

// Asks before a change that can cut the admin's connection: lists the risks and what the router does about them, and resolves to whether
// the admin wants to go on. A change without such risks is saved without a question.
function confirmSave(base, draft) {
  const risks = risksOf(base, draft, location.hostname);
  if (!risks.length) return Promise.resolve(true);
  return new Promise(resolve => {
    let go = false;
    const apply = button('Apply the change', 'check2', () => { go = true; dialog.close(); }, 'btn-primary');
    const cancel = button('Cancel', 'x-lg', () => dialog.close());
    const dialog = openDialog({
      title: 'This change can cut your connection',
      subtitle: `${risks.length} risk${risks.length === 1 ? '' : 's'}`,
      staticBackdrop: true,
      body: h('div', { className: 'ne-risks' },
        h('ul', {}, risks.map(r => h('li', {}, r))),
        h('p', { className: 'muted small' }, `The router applies the change and this page then checks that it can still read the configuration and that the interfaces that were up still are. If it cannot, or if you close the page, the router restores the previous configuration by itself after ${APPLY_SECONDS} seconds. Keep a second way to reach the router (a console or another port) while you do this.`)),
      footer: [cancel, apply],
      onClose: () => resolve(go),
    });
  });
}

// The editor: the draft, the review banner, saving and discarding (core/editpage.js).
export const editor = createEditor({
  config: CONFIG,
  readAfter,
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: (base, draft, after) => checkApplied(after, draft, base),
  timeoutS: APPLY_SECONDS,
  settleMs: SETTLE_MS,
  confirmSave,
});

// Loads the wired-network data the page shows plus the editable config, and how many changes are already staged in this session. The config
// is optional: a router without the plugin method, or a login that may not call it, gets the page without the editor.
export async function loadNetworkEdit() {
  const [wired, reply] = await Promise.all([loadWired(), can('flab.network', 'config') ? optional(ubus('flab.network', 'config')) : null]);
  const data = { ...wired, cfg: readNetwork(reply) };
  return data.cfg.available ? editor.withStaged(data) : { ...data, staged: 0 };
}

// Starts the editing part of a page view and returns what the panels need (or null when the router gives no config to edit):
//   base      the data the draft was made from (what validation and the change list compare with)
//   live      this poll's data, for the state of things now
//   draft     the form's values
//   canEdit   whether the login may write and no save is running
//   inputs    the controls by name, so errors can mark them (filled in while the panel is built)
//   touched() after every edit; redraw() redraws the page; sync() marks the errors; refresh(fn) registers a function that runs after every edit
//   current() (set by the page) returns the page's latest context, for the wizard that outlives a redraw
export function editContext(data, rerender, shell) {
  if (!data.cfg?.available) return null;
  const canEdit = editor.begin(data, rerender);
  const ctx = { base: editor.state.base, live: data, draft: editor.state.draft, canEdit, inputs: {}, rerender, reload: () => shell.reload(), redraw: () => editor.redraw(), refreshers: [], touched: () => {}, sync: () => {} };
  ctx.refresh = fn => ctx.refreshers.push(fn);
  // Marks the controls that hold an error and refreshes the banner; a control with an error must not stay hidden in a closed Advanced block.
  ctx.sync = () => editor.markErrors(ctx.inputs, canEdit, reveal);
  const touched = editor.touched(ctx);
  ctx.touched = () => { touched(); for (const fn of ctx.refreshers) fn(); };
  return ctx;
}

// The notes above the board: a read-only login, staged leftovers, or why there is no editor.
export function editNotes(data) {
  if (!data.cfg?.available) {
    return [note('info', 'The network settings cannot be edited here: the router does not offer the configuration to this login (the flab.network plugin is out of date or this login may not read it), so only what the router is doing is shown.')];
  }
  return editor.notes(data).filter(Boolean);
}

// A muted line telling how a saved change is protected.
export const safetyNote = () => muted(`Saving applies the change with an automatic rollback after ${APPLY_SECONDS} seconds unless the page confirms that the router still works.`);
