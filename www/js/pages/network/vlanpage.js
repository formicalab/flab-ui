// The VLAN editor of the Ethernet ports view: the editor (core/editpage.js: draft, review banner, save with the rollback countdown,
// discard) and its connection to the page. The network config holds secrets (keys and passwords in its interface sections), so
// the editor reads only the section types it needs (bridge-vlan, device, switch, switch_vlan, switch_port) with `uci get` filtered
// by type, and only while the editor is open; the read-only cards need none of it.
import { can, optional, ubus } from '../../core/ubus.js';
import { createEditor } from '../../core/editpage.js';
import { uci } from '../../core/uci.js';
import { CONFIG, TYPES, changesOf, checkApplied, dataOf, draftFrom, isDirty, plan, problems } from './vlanmodel.js';
import { syncDone } from './vlanedit.js';

// Whether the editor is open. Module-level so it survives the redraw on every poll.
const state = { editing: false };

// Reads the section types the editor needs, as { type: sections }.
async function readRaw() {
  return Object.fromEntries(await Promise.all(TYPES.map(async type => [type, await uci.getByType(CONFIG, type)])));
}

// The draft, the review banner, saving and discarding (core/editpage.js). After a save the config is read back by type; netifd's
// interface list (and the plugin, where it is installed) must still answer, which proves the router is still reachable.
const editor = createEditor({
  config: CONFIG,
  readAfter: async () => {
    const [raw] = await Promise.all([readRaw(), ubus('network.interface', 'dump'), optional(ubus('flab.network', 'status'))]);
    return raw;
  },
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: (base, draft, after) => checkApplied(base, draft, after),
});

// The shell's reload function, handed over by controls().
let reloadPage = () => {};

export const vlan = {
  // Creates the review banner (put the returned node among the command-bar controls) and remembers the shell's reload callback. The
  // editor starts closed each time the page is opened, unless edits are still unsaved.
  attach(reload) {
    reloadPage = reload;
    if (!editor.dirty()) state.editing = false;
    return editor.attach(reload);
  },

  // No polling while the editor is open: a redraw would drop what the user is doing and the config is read on every load.
  paused: () => state.editing || editor.paused('.vlan-edit'),

  // Adds `vlan` to the page's data: the editable tables (only while the editor is open) and how many changes are staged already.
  async load(data) {
    let raw = null;
    if (state.editing && can('uci', 'get')) raw = await optional(readRaw());
    data.vlan = dataOf(data.net, raw, data.ifs, location.hostname);
    data.vlanFailed = state.editing && !raw;
    return state.editing ? editor.withStaged(data) : data;
  },

  // The context the cards are built with, or null when this login may not read and change the network config (the cards stay
  // read-only and show no edit controls). `edit` is whether the editor is open.
  view(data, rerender) {
    if (!can('uci', 'get') || !can('uci', 'set')) return null;
    const ctx = {
      edit: state.editing, data, notes: [], inputs: {},
      // Opens the editor: the next load reads the config.
      open: () => { state.editing = true; reloadPage(); },
      // Closes the editor and forgets the draft and the outcome of the last save.
      close: () => {
        state.editing = false;
        editor.state.draft = null;
        editor.state.message = null;
        editor.renderBar(false);
        reloadPage();
      },
      // Whether there are unsaved edits, and whether a save is running.
      dirty: () => editor.dirty(), busy: () => editor.state.busy,
    };
    if (!state.editing) return ctx;
    ctx.canEdit = editor.begin(data, rerender);
    ctx.draft = editor.state.draft;
    ctx.notes = editor.notes(data);
    ctx.redraw = () => editor.redraw();
    ctx.touched = editor.touched(ctx);
    ctx.dones = [];
    // Marks the controls that hold an error, refreshes the review banner and the state of the Done buttons.
    ctx.sync = () => {
      editor.markErrors(ctx.inputs, ctx.canEdit);
      for (const done of ctx.dones) syncDone(ctx, done);
    };
    return ctx;
  },
};
