// The Settings tab of the Traffic page: every option of /etc/config/nlbwmon with its value, the default when it is not set, the
// hint, and what the value does (the effect line under each option, from the live router: the storage the database directory is on,
// the periods stored against the number to keep, the accounting window, ...). What can be edited is the table in
// settings-schema.js; validation, the effects, the change list and the UCI operations are in settings-model.js; the controls and
// the review banner are shared with the other editing pages (core/forms.js, core/editpage.js).
//
// It reads the config through rpcd's own `uci` object (the config holds no secrets) and writes through core/uci.js applyChange():
// stage, apply with the rollback countdown, read the config back, wait until nlbwmon (which the apply reloads) runs with the saved
// settings, confirm. A router where nlbwmon runs differently or not at all after the change goes back to its previous settings by
// itself. The page redraws on every poll, so polling is suspended while there is something to lose: unsaved edits, a focused
// control or a save in progress (the Traffic page's isPaused asks `settingsEditor.paused`).
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { AuthError, optional, ubus } from '../../core/ubus.js';
import { card, tile, tiles } from '../../core/ui.js';
import { fieldRow, legend, note } from '../../core/forms.js';
import { createEditor } from '../../core/editpage.js';
import { uci } from '../../core/uci.js';
import { FIELDS, GROUPS } from './settings-schema.js';
import { CONFIG, changesOf, checkApplied, configDiffs, confirmDaemon, draftFrom, draftPath, effective, effects, fmtAgo, infoFor, isDirty, plan, problems, readNlbw, windowOf } from './settings-model.js';

// The draft, the review banner, saving and discarding, shared with the other editing pages (core/editpage.js). After the config
// is read back, the daemon must run with the saved settings if it ran before the change.
export const settingsEditor = createEditor({
  config: CONFIG,
  readAfter: async () => readNlbw(await uci.get(CONFIG)),
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: async (base, draft, after) => {
    checkApplied(after, draft);
    if (base.daemon.running) await confirmDaemon(() => ubus('service', 'list', { name: 'nlbwmon' }), after.values);
  },
});
const editor = settingsEditor;
const { state } = editor;

//#region Loading

// Reads what the tab shows: the config (null on a router without nlbwmon), the plugin's status and stored periods, procd's view of
// the daemon, the interface names, the RAM size and what the plugin says about the two paths the config names; each of those but
// the config is optional, so a missing plugin only removes what depends on it. The result is the model's data (readNlbw) plus
// how many changes are already staged in this session.
export async function loadSettings() {
  const [cfg, status, svc, periods, dump, info] = await Promise.all([
    optional(uci.get(CONFIG)),
    optional(ubus('flab.traffic', 'status')),
    optional(ubus('service', 'list', { name: 'nlbwmon' })),
    optional(ubus('flab.traffic', 'usage_periods')),
    optional(ubus('network.interface', 'dump')),
    optional(ubus('system', 'info')),
  ]);
  const data = readNlbw(cfg, { status, svc, periods, dump, memTotal: info?.memory?.total ?? null });
  if (cfg && status) {
    const e = effective(data.values);
    data.paths = await optional(ubus('flab.traffic', 'nlbwmon_paths', { dir: e.database_directory, protocols: e.protocol_database }));
    if (data.paths) for (const k of ['dir', 'protocols']) if (data.paths[k]) data.paths[k].generated = data.paths.generated;
  }
  data.tab = 'settings';
  return editor.withStaged(data);
}

//#endregion

//#region The summary

// The kinds of storage in one word for the tile.
const KIND_WORD = { volatile: 'RAM', flash: 'Flash', storage: 'External', readonly: 'Read only' };

// The four summary tiles: the daemon, the accounting period now, the periods held and where the database is.
function summary(data) {
  const e = effective(data.values);
  const d = data.daemon;
  const diffs = d.running ? configDiffs(data.values, d.command) : [];
  const w = data.periods?.today ? windowOf(e.database_interval, data.periods.today) : null;
  const stored = data.periods?.running ? data.periods.list.length : null;
  const dir = data.paths?.dir;
  const last = dir?.ok && dir.files?.[0]?.mtime != null && dir.generated != null ? fmtAgo(dir.files[0].mtime, dir.generated) : null;
  return tiles(
    tile('nlbwmon', !d.known ? '–' : d.running ? 'Running' : 'Stopped',
      !d.known ? 'its state is not available' : d.running ? `${d.pid ? `process ${d.pid} · ` : ''}${diffs.length ? `runs with other settings than the file (${diffs.map(x => x.label).join(', ')})` : 'runs with the saved settings'}` : 'nothing is being counted',
      d.known && !d.running ? 'text-danger' : diffs.length ? 'text-warning' : ''),
    tile('Accounting period', w ? `Day ${w.day} of ${w.length}` : '–', w ? `${w.start} to ${w.end} · the next one starts ${w.next}` : 'not available'),
    tile('Periods held', stored == null ? '–' : `${stored + 1}${e.database_generations === '0' ? '' : ` of ${e.database_generations}`}`,
      stored == null ? 'nlbwmon is not running' : `${stored} finished and the running one${e.database_generations === '0' ? ' · none is ever deleted' : ''}`),
    tile('Database', dir?.ok ? (KIND_WORD[dir.kind] ?? '–') : '–',
      dir?.ok ? `${dir.resolved}${dir.fstype ? ` on ${dir.fstype}` : ''}${last ? ` · last written ${last}` : dir.total ? '' : ' · no file yet'}` : 'not available',
      dir?.ok && dir.kind === 'readonly' ? 'text-danger' : ''));
}

//#endregion

//#region Path probes

// The control (the form's ctx) that is on screen, the debounce timers per kind of path and the questions in flight.
let current = null;
const timers = {};
const pending = new Set();

// Asks the plugin about a path that was typed and not saved, stores the answer where the model finds it and refreshes the
// page. A router whose plugin cannot answer leaves the path unknown (`ok: false`), which the model ignores.
async function ask(ctx, kind, path) {
  const id = `${kind}:${path}`;
  if (pending.has(id)) return;
  pending.add(id);
  let info = { ok: false, path };
  try {
    const r = await ubus('flab.traffic', 'nlbwmon_paths', kind === 'dir' ? { dir: path } : { protocols: path });
    info = { ...(r[kind === 'dir' ? 'dir' : 'protocols'] ?? info), generated: r.generated };
  } catch (e) {
    if (e instanceof AuthError) { location.reload(); return; }
  }
  pending.delete(id);
  ctx.base.probes[kind][path] = info;
  if (current === ctx) ctx.sync();
}

// Starts asking about the directory and the protocol file the draft names, once typing has paused, unless the path has an error
// or the answer is already known.
function probePaths(ctx) {
  if (!ctx.data.paths || !ctx.canEdit) return;
  const wrong = new Set(problems(ctx.base, state.draft).errors.map(e => e.key));
  for (const [kind, key] of [['dir', 'database_directory'], ['file', 'protocol_database']]) {
    const path = draftPath(state.draft, key);
    if (wrong.has(key) || infoFor(ctx.base, kind, path)) continue;
    clearTimeout(timers[kind]);
    timers[kind] = setTimeout(() => ask(ctx, kind, path), 400);
  }
}

//#endregion

//#region The form

// The control for one schema field, connected to the draft, with the line that says what its value does under it.
function control(ctx, f) {
  const values = state.draft.values;
  const node = fieldRow(f, {
    id: f.key,
    get: () => values[f.key],
    set: v => { values[f.key] = v; },
    disabled: !ctx.canEdit,
    touched: ctx.touched,
    redraw: () => editor.redraw(),
    register: (el, index) => { if (index == null) ctx.inputs[f.key] = el; else (ctx.inputs[f.key] ??= [])[index] = el; },
  });
  if (f.type === 'list') node.classList.add('wide');
  if (f.type !== 'bool') {
    const fx = h('div', { className: 'set-hint small nlbw-effect', hidden: true });
    ctx.effects[f.key] = fx;
    node.append(fx);
  }
  return node;
}

// One card of the form, from its schema group: its legend on top, then its fields in a flowing grid.
function groupCard(ctx, g) {
  return card([icon(g.icon), h('span', {}, g.title)],
    h('div', {}, legend(g.legend), h('div', { className: 'card-body set-fields' }, FIELDS.filter(f => f.group === g.id).map(f => control(ctx, f)))));
}

// Shows each option's effect line from the draft (see effects() in the model).
function showEffects(ctx) {
  const now = effects(ctx.base, state.draft);
  for (const [key, node] of Object.entries(ctx.effects)) {
    const e = now[key];
    node.hidden = !e;
    if (e) {
      node.textContent = e.text;
      node.className = `set-hint small nlbw-effect ${e.kind}`;
    }
  }
}

//#endregion

// The nodes of the Settings tab for one poll. `data` is what loadSettings returned.
export function settingsView(data, rerender) {
  if (!data.installed) {
    return [data.status?.nlbw
      ? note('bad', 'The nlbwmon configuration (/etc/config/nlbwmon) cannot be read: the file is missing, or this login may not read it.')
      : note('info', 'nlbwmon is not installed on this router, so there is nothing to set here. Install it (apk add nlbwmon, or opkg install nlbwmon on older releases) to count the traffic of each host; its usage then shows on the Usage tab.')];
  }
  const canEdit = editor.begin(data, rerender);
  // Probe answers are kept with the data the draft was made from, which a refresh while editing does not replace.
  const ctx = { data, base: state.base, canEdit, inputs: {}, effects: {}, sync: () => {}, touched: () => {} };
  ctx.touched = editor.touched(ctx);
  // Called after every edit: marks the controls that hold an error, refreshes the banner and the effect lines, and asks about
  // a path that was typed.
  ctx.sync = () => {
    editor.markErrors(ctx.inputs, canEdit);
    showEffects(ctx);
    probePaths(ctx);
  };
  current = ctx;

  const diffs = data.daemon.running ? configDiffs(data.values, data.daemon.command) : [];
  const page = [
    summary(data),
    ...editor.notes(data),
    data.status ? null : note('warn', 'The Traffic plugin (flab.traffic) is not available, so the page cannot check the paths or show what is stored. The settings can still be changed.'),
    data.section ? null : note('warn', 'The nlbwmon config has no nlbwmon section; saving creates one.'),
    diffs.length ? note('warn', `nlbwmon is running with settings that differ from the saved ones (${diffs.map(x => `${x.label}: running ${x.running}, saved ${x.configured}`).join('; ')}). Saving a change reloads it with the saved settings.`) : null,
    note('info', 'Nothing is changed until you press Save and apply. Saving reloads nlbwmon, which writes its counts to disk first; the page then checks that the config was kept and that nlbwmon runs with the new settings, and puts the old settings back if it does not.'),
    h('div', { className: 'nlbw-form' }, GROUPS.map(g => groupCard(ctx, g))),
  ];
  ctx.sync();
  return page.filter(Boolean);
}
