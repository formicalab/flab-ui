// System settings page (route #settings, at the bottom of the navigation next to Sign out): shows and edits
// /etc/config/system, the `system` section and the `timeserver` (NTP) section. What can be edited is the table in
// schema.js, taken from the OpenWrt wiki; validation, the change list and the UCI operations are in model.js; the
// controls and the review banner are shared with the other editing pages (core/forms.js).
//
// It reads through rpcd's own `uci` object, so no plugin is needed, and writes through core/uci.js applyChange():
// stage, apply with the rollback countdown, read the settings back, confirm. The page redraws on every poll, so
// polling is suspended while there is something to lose: unsaved edits, a focused control or a save in progress.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { AuthError, can, optional, ubus } from '../../core/ubus.js';
import { badge, button, card, kv, mono, muted, tile, tiles } from '../../core/ui.js';
import { refreshControl } from '../../core/controls.js';
import { fieldRow, legend, note, reviewBanner } from '../../core/forms.js';
import { applyChange, uci } from '../../core/uci.js';
import { FIELDS, GROUPS } from './schema.js';
import { CONFIG, changesOf, checkApplied, currentValue, draftFrom, fmtDate, fmtOffset, fmtTime, isDirty, plan, problems, readSettings, ruleOf, stage, zoneGroups } from './model.js';

// What the form holds (`draft`) and the data it was made from (`base`), kept here so they survive the redraw on
// every poll. `message` is the outcome of the last save or discard ({ kind: ok | bad | info, text }).
const state = { base: null, draft: null, busy: false, message: null };

// The page's redraw and reload callbacks, set when the shell builds the page.
let redraw = () => {};
let reloadPage = () => {};

// The review banner in the command bar, created with the page's controls.
let bar = null;

// Whether the form has edits that are not saved yet.
const dirty = () => Boolean(state.base && state.draft && isDirty(state.base, state.draft));

// Reads the config, the clock and the NTP client state, plus how many changes are already staged in this
// session (applying would commit those too, so the page warns about them).
async function load() {
  const [cfg, info, svc] = await Promise.all([uci.get(CONFIG), ubus('system', 'info'), optional(ubus('service', 'list', { name: 'sysntpd' }))]);
  const data = readSettings(cfg, info, svc);
  data.staged = can('uci', 'set') ? (await optional(uci.pending(CONFIG))) ?? 0 : 0;
  return data;
}

//#region Actions

// Throws away the changes staged in this session (they would be applied together with this page's).
async function discardStaged() {
  try {
    await uci.revert(CONFIG);
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

// Saves the form: stage, apply with the rollback countdown, read the settings back to prove they were stored,
// then confirm. Any failure leaves the router on its previous settings and the edits in the form.
async function save() {
  const { base, draft } = state;
  const renamed = changesOf(base, draft).some(c => c.key === 'hostname');
  state.busy = true;
  state.message = { kind: 'info', text: 'Applying the change…' };
  redraw();
  try {
    await applyChange(uci, [CONFIG],
      ed => stage(ed, plan(base, draft)),
      async () => checkApplied(base, readSettings(await uci.get(CONFIG)), draft));
    state.message = { kind: 'ok', text: 'Saved: the router applied the change and it was confirmed.' };
    state.draft = null;
  } catch (e) {
    // An expired session needs a new sign-in: reloading lets the shell show the sign-in screen.
    if (e instanceof AuthError) return location.reload();
    state.message = { kind: 'bad', text: e.message };
  }
  state.busy = false;
  // A new hostname is shown in the navigation header, which the shell only reads when it routes.
  if (renamed) dispatchEvent(new Event('hashchange'));
  else await reloadPage();
}

//#endregion

//#region Pieces of the page

// The four summary tiles: the router's clock, its name, its time zone and the NTP client.
function summary(data) {
  const { clock, ntpd } = data;
  const v = data.system.values;
  const ntpOn = currentValue(FIELDS.find(f => f.key === 'enabled'), data);
  const ntpSub = !ntpOn ? 'switched off in the configuration' : ntpd ? (ntpd.running ? 'ntpd is running' : 'ntpd is not running') : 'state not available';
  return tiles(
    tile('Router time', clock ? fmtTime(clock.localtime) : '–', clock ? `${fmtDate(clock.localtime)} · ${fmtOffset(clock.offset)}` : 'the router did not report its clock'),
    tile('Hostname', v.hostname || 'OpenWrt', v.description || 'no description'),
    tile('Time zone', v.zonename || 'Custom rule', v.timezone || 'no rule set'),
    tile('NTP client', ntpOn ? 'On' : 'Off', ntpSub, ntpOn && ntpd && !ntpd.running ? 'text-warning' : ''));
}

// The control for one schema field, connected to the draft.
function control(ctx, f) {
  const values = state.draft.values;
  return fieldRow(f, {
    id: f.key,
    get: () => values[f.key],
    set: v => { values[f.key] = v; },
    disabled: !ctx.canEdit,
    // A change made to the form: forget the outcome of the last save (it no longer describes the form) and
    // refresh the banner.
    touched: () => { state.message = null; ctx.sync(); },
    redraw: () => redraw(),
    register: (el, index) => { if (index == null) ctx.inputs[f.key] = el; else (ctx.inputs[f.key] ??= [])[index] = el; },
  });
}

// The time zone control: a drop-down of every IANA zone plus "Custom rule", with the rule input shown for the latter.
function zoneRows(ctx) {
  const zone = state.draft.zone;
  const touched = () => { state.message = null; ctx.sync(); };
  const select = h('select', { className: 'form-select form-select-sm', disabled: !ctx.canEdit, title: 'Time zone',
    onchange: e => { zone.name = e.target.value; ruleRow.hidden = Boolean(zone.name); touched(); } });
  select.append(h('option', { value: '' }, 'Custom POSIX rule…'));
  for (const [region, names] of zoneGroups()) select.append(h('optgroup', { label: region }, names.map(n => h('option', { value: n }, n))));
  select.value = zone.name;

  const rule = h('input', { className: 'form-control form-control-sm', placeholder: 'e.g. CET-1CEST,M3.5.0,M10.5.0/3', value: zone.rule, disabled: !ctx.canEdit, spellcheck: false,
    oninput: e => { zone.rule = e.target.value; touched(); } });
  ctx.inputs.zone = rule;
  const ruleRow = h('div', { className: 'set-field', hidden: Boolean(zone.name) },
    h('label', { className: 'form-label' }, 'POSIX rule'), rule,
    h('div', { className: 'muted small set-hint' }, 'Standard name and offset, then optionally the daylight-saving name and when it starts and ends. The offset is hours west of UTC: CET-1 is one hour east.'));

  ctx.ruleAfter = mono('');
  return [
    h('div', { className: 'set-field' }, h('label', { className: 'form-label' }, 'Zone'), select), ruleRow,
    kv([
      ['On the router now', mono(ctx.data.system.values.zonename || 'no zone name')],
      ['Rule in effect', mono(ctx.data.system.values.timezone || 'none')],
      ['Rule after saving', ctx.ruleAfter],
    ]),
  ];
}

// What the NTP client is doing right now, under the NTP controls.
function ntpStatus(data) {
  const { ntpd } = data;
  return kv([
    ['NTP client', ntpd ? badge(ntpd.running ? 'running' : 'not running', ntpd.running ? 'success' : 'warning') : muted('not available')],
    ['Servers ntpd uses', ntpd?.servers.length ? mono(ntpd.servers.join(', ')) : muted('none')],
  ]);
}

// One card of the form, from its schema group: its legend on top, then either side-by-side columns (the time card:
// the zone, the NTP client, the NTP server) or its fields in a flowing grid.
function groupCard(ctx, g) {
  const fieldsOf = col => FIELDS.filter(f => f.group === g.id && (col == null || f.col === col)).map(f => control(ctx, f));
  const body = g.columns
    ? h('div', { className: 'card-body set-cols' }, g.columns.map(c => h('section', { className: 'set-col' },
      h('h3', { className: 'set-col-title' }, c.title),
      ...(c.id === 'zone' ? zoneRows(ctx) : fieldsOf(c.id)),
      c.id === 'client' ? ntpStatus(ctx.data) : null)))
    : h('div', { className: 'card-body set-fields' }, fieldsOf());
  return card([icon(g.icon), h('span', {}, g.title)], h('div', {}, legend(g.legend), body));
}

// Updates the review banner from the draft.
function renderBar(canEdit) {
  const ready = state.base && state.draft;
  const found = ready ? problems(state.base, state.draft) : { errors: [], warnings: [] };
  bar.render({
    changes: ready ? changesOf(state.base, state.draft) : [],
    errors: found.errors, warnings: found.warnings, message: state.message,
    busy: state.busy, canEdit, dirty: dirty(),
    dismiss: () => { state.message = null; renderBar(canEdit); },
  });
}

//#endregion

export default {
  id: 'settings',
  label: 'System settings',
  icon: 'gear',
  // Shown at the bottom of the navigation pane, next to Sign out.
  nav: 'bottom',
  interval: 10000,
  css: ['css/forms.css', 'css/settings.css'],
  isPaused: () => state.busy || dirty() || Boolean(document.activeElement?.closest?.('.settings-form')),

  load,

  controls({ reload }) {
    reloadPage = reload;
    bar = reviewBanner({ onSave: save, onDiscard: discardEdits });
    return { nodes: [refreshControl(reload), bar.node] };
  },

  view(data, rerender) {
    redraw = rerender;
    // Unsaved edits survive a refresh; otherwise the form restarts from what the router has.
    if (!state.draft || !dirty()) {
      state.base = data;
      state.draft = draftFrom(data);
    }
    const ctx = { data, canEdit: can('uci', 'set') && !state.busy, inputs: {}, ruleAfter: null, sync: () => {} };
    const cards = GROUPS.map(g => groupCard(ctx, g));
    const form = h('div', { className: 'settings-form' }, h('div', { className: 'settings-grid' }, cards));

    // Called after every edit: marks the controls that hold an error, shows the zone rule that will be written,
    // and refreshes the banner.
    ctx.sync = () => {
      for (const el of Object.values(ctx.inputs).flat()) el?.classList.remove('is-invalid');
      for (const e of problems(state.base, state.draft).errors) {
        const el = ctx.inputs[e.key];
        (Array.isArray(el) ? el[e.index] : el)?.classList.add('is-invalid');
      }
      if (ctx.ruleAfter) ctx.ruleAfter.textContent = (state.draft.zone.name ? ruleOf(state.draft.zone.name) : state.draft.zone.rule.trim()) || data.system.values.timezone || '';
      renderBar(ctx.canEdit);
    };
    ctx.sync();
    return [
      summary(data),
      can('uci', 'set') ? null : note('warn', 'This login is not allowed to change the configuration, so the settings are shown read-only.'),
      data.staged ? note('warn', `${data.staged} change(s) are already staged in this session (for example from an attempt that was rolled back); saving would apply them too.`, button('Discard them', 'x-lg', discardStaged)) : null,
      form,
    ].filter(Boolean);
  },
};
