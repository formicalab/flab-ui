// System settings page (route #settings, at the bottom of the navigation next to Sign out): shows and edits
// /etc/config/system, the `system` section and the `timeserver` (NTP) section. What can be edited is the table in
// schema.js, taken from the OpenWrt wiki; validation, the change list and the UCI operations are in model.js; the
// controls and the review banner are shared with the other editing pages (core/forms.js).
//
// It reads through rpcd's own `uci` object and writes through core/uci.js applyChange():
// stage, apply with the rollback countdown, read the settings back, confirm. The page redraws on every poll, so
// polling is suspended while there is something to lose: unsaved edits, a focused control, a save, a backup transfer, or Pause.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { disclosure } from '../../core/fold.js';
import { can, optional, ubus } from '../../core/ubus.js';
import { badge, button, closeButton, kv, mono, muted, spinner, tile, tiles } from '../../core/ui.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { fieldRow, legend } from '../../core/forms.js';
import { createEditor } from '../../core/editpage.js';
import { uci } from '../../core/uci.js';
import { FIELDS, GROUPS } from './schema.js';
import { backupCard, busy as backupBusy } from './backup.js';
import { CONFIG, changesOf, checkApplied, currentValue, draftFrom, fmtDate, fmtOffset, fmtTime, isDirty, plan, problems, readSettings, ruleOf, zoneGroups } from './model.js';

// The draft, the review banner, saving and discarding, shared with the other editing pages (core/editpage.js).
// `afterSave`: a new hostname is shown in the navigation header, which the shell only reads when it routes.
const editor = createEditor({
  config: CONFIG,
  readBack: cfg => readSettings(cfg),
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: (base, draft, after) => checkApplied(base, after, draft),
  afterSave: (base, draft) => {
    if (!changesOf(base, draft).some(c => c.key === 'hostname')) return false;
    dispatchEvent(new Event('hashchange'));
    return true;
  },
});
const { state } = editor;
// The cards (by group id) the user has opened; the page redraws on every poll and keeps them open.
const openCards = new Set();
// The Pause button's flag (the editor's state is separate).
const live = { paused: false };
const ntpAction = { busy: false, message: null };
let reloadPage = () => {};

// Reads the config, the clock and the NTP client state, plus how many changes are already staged in this
// session (applying would commit those too, so the page warns about them).
async function load() {
  const [cfg, info, svc, dump] = await Promise.all([
    uci.get(CONFIG),
    ubus('system', 'info'),
    optional(ubus('service', 'list', { name: 'sysntpd' })),
    optional(ubus('network.interface', 'dump')),
  ]);
  const data = readSettings(cfg, info, svc);
  data.interfaces = (dump?.interface ?? [])
    .map(i => i.interface)
    .filter(name => typeof name === 'string' && name)
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort((a, b) => a.localeCompare(b));
  return editor.withStaged(data);
}

//#region Pieces of the page

// The four summary tiles: the router's clock, its name, its time zone and the NTP client.
function summary(data) {
  const { clock } = data;
  const v = data.system.values;
  return tiles(
    tile('Hostname', v.hostname || 'OpenWrt', v.description || 'no description'),
    tile('Router time', clock ? fmtTime(clock.localtime) : '–', clock ? `${fmtDate(clock.localtime)} · ${fmtOffset(clock.offset)}` : 'the router did not report its clock'),
    tile('Time zone', v.zonename || 'Custom rule', v.timezone || 'no rule set'));
}

// The control for one schema field, connected to the draft.
function control(ctx, f) {
  const values = state.draft.values;
  const dynamic = f.key === 'interface'
    ? {
      ...f,
      type: 'enum',
      options: ctx.data.interfaces,
      blank: 'Every interface',
    }
    : f;
  return fieldRow(dynamic, {
    id: f.key,
    get: () => values[f.key],
    set: v => { values[f.key] = v; },
    disabled: !ctx.canEdit,
    // A change made to the form: forget the outcome of the last save (it no longer describes the form) and
    // refresh the banner.
    touched: editor.touched(ctx),
    redraw: () => editor.redraw(),
    register: (el, index) => { if (index == null) ctx.inputs[f.key] = el; else (ctx.inputs[f.key] ??= [])[index] = el; },
  });
}

// The time zone control: a drop-down of every IANA zone plus "Custom rule", with the rule input shown for the latter.
function zoneRows(ctx) {
  const zone = state.draft.zone;
  const touched = editor.touched(ctx);
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
async function syncNtp(ctx) {
  ntpAction.busy = true;
  ntpAction.message = null;
  ctx.rerender();
  try {
    const reply = await ubus('flab.system', 'ntp_sync', {});
    if (!reply?.ok) throw new Error(reply?.error || 'The NTP sync could not be requested.');
    ntpAction.message = { kind: 'success', text: 'NTP sync requested. sysntpd was restarted with the configured sources.' };
    await ctx.reload();
  } catch (err) {
    ntpAction.message = { kind: 'danger', text: err.message };
  } finally {
    ntpAction.busy = false;
    ctx.rerender();
  }
}

// What the NTP client is doing right now, plus a one-click new synchronization attempt.
function ntpStatus(ctx) {
  const { data } = ctx;
  const { ntpd } = data;
  const enabled = currentValue(FIELDS.find(f => f.key === 'enabled'), data);
  const allowed = can('flab.system', 'ntp_sync');
  return h('div', {},
    kv([
      ['NTP client', ntpd ? badge(ntpd.running ? 'running' : 'not running', ntpd.running ? 'success' : 'warning') : muted('not available')],
      ['Servers ntpd uses', ntpd?.servers.length ? mono(ntpd.servers.join(', ')) : muted('none')],
    ]),
    h('div', { className: 'ntp-actions' },
      button(ntpAction.busy ? 'Syncing…' : 'Sync now', 'arrow-clockwise',
        () => syncNtp(ctx), 'btn-outline-secondary', { disabled: ntpAction.busy || !enabled || !allowed,
          title: !enabled ? 'Enable the NTP client first.' : !allowed ? 'This login cannot control the NTP service.' : 'Restart sysntpd to start a new synchronization attempt.' }),
      ntpAction.busy ? spinner('Synchronizing the router clock') : null),
    ntpAction.message ? h('div', { className: `alert alert-${ntpAction.message.kind} alert-dismissible mt-3 mb-0`, role: 'alert' },
      ntpAction.message.text,
      closeButton(() => { ntpAction.message = null; ctx.rerender(); }, 'Dismiss')) : null);
}

// One card of the form, from its schema group: its legend on top, then either side-by-side columns (the time card:
// the zone, the NTP client, the NTP server) or its fields in a flowing grid.
function groupCard(ctx, g) {
  // Controls of this group's fields, restricted to one column when `col` is given.
  const fieldsOf = col => FIELDS.filter(f => f.group === g.id && (col == null || f.col === col)).map(f => control(ctx, f));
  const body = g.columns
    ? h('div', { className: 'card-body set-cols' }, g.columns.map(c => h('section', { className: 'set-col' },
      h('h3', { className: 'set-col-title' }, c.title),
      ...(c.id === 'zone' ? zoneRows(ctx) : fieldsOf(c.id)),
      c.id === 'client' ? ntpStatus(ctx) : null)))
    : h('div', { className: 'card-body set-fields' }, fieldsOf());
  const ntpOn = g.id === 'time' ? currentValue(FIELDS.find(f => f.key === 'enabled'), ctx.data) : null;
  const ntp = ctx.data.ntpd;
  const extra = g.id === 'time'
    ? h('span', { className: 'sub' },
      'NTP client ',
      badge(!ntpOn ? 'off' : ntp ? (ntp.running ? 'running' : 'not running') : 'state unknown',
        !ntpOn ? '' : ntp?.running ? 'success' : 'warning'))
    : null;
  return disclosure({
    cls: 'card settings-disclosure',
    summaryCls: 'card-header',
    summary: [icon(g.icon), h('span', {}, g.title), extra],
    body: h('div', {}, legend(g.legend), body),
    open: openCards.has(g.id),
    onToggle: open => {
      if (open) openCards.add(g.id);
      else openCards.delete(g.id);
    },
  });
}

//#endregion

export default {
  // Shown at the bottom of the navigation pane, next to Sign out.
  nav: 'bottom',
  interval: 10000,
  css: ['css/forms.css', 'css/settings.css'],
  isPaused: () => live.paused || backupBusy() || editor.paused('.settings-form'),

  load,

  controls({ reload }) {
    reloadPage = reload;
    return { nodes: [pauseControl(live), refreshControl(reload), editor.attach(reload)] };
  },

  view(data, rerender) {
    const canEdit = editor.begin(data, rerender);
    const ctx = { data, canEdit, inputs: {}, ruleAfter: null, sync: () => {}, rerender, reload: reloadPage };
    const cards = GROUPS.map(g => groupCard(ctx, g));
    const form = h('div', { className: 'settings-form' }, h('div', { className: 'settings-grid' }, cards));

    // Called after every edit: marks the controls that hold an error, shows the zone rule that will be written,
    // and refreshes the banner.
    ctx.sync = () => {
      if (ctx.ruleAfter) ctx.ruleAfter.textContent = (state.draft.zone.name ? ruleOf(state.draft.zone.name) : state.draft.zone.rule.trim()) || data.system.values.timezone || '';
      editor.markErrors(ctx.inputs, canEdit);
    };
    ctx.sync();
    return [summary(data), ...editor.notes(data), form, backupCard(rerender)].filter(Boolean);
  },
};
