// The cards of the Dynamic DNS page: one per service (what it is doing, the actions, the log and every option in collapsible
// groups) and one for the global settings. The controls come from the option tables in schema.js through core/forms.js; the
// values, the rules and the status verdicts are in model.js.
import { h, sleep } from '../../core/dom.js';
import { chevron, disclosure, foldable } from '../../core/fold.js';
import { icon } from '../../core/icons.js';
import { AuthError, can, ubus } from '../../core/ubus.js';
import { badge, button, card, kv, mono, muted } from '../../core/ui.js';
import { fieldRow, legend } from '../../core/forms.js';
import { GLOBAL_FIELDS, SERVICE_FIELDS, SERVICE_GROUPS } from './schema.js';
import { addService, ago, currentIp, effective, isNoteworthy, isShown, parseLog, providerLabel, removeService, restoreService, spanWords, timing, verdictOf } from './model.js';

//#region State that survives a redraw

// Which option groups are expanded, kept across redraws: id `<service>:<group>` to open or closed.
const opened = new Map();
// Which cards are folded down to their header: a service id or 'global' to true or false. A service starts open, the global card
// folded.
const folds = new Map();
// The log panels: service name to { open, all, loading, exists, text, error }. An open panel is read again on every poll.
const logs = new Map();
// The call that is running ({ section, action }) and the outcome of the last one per service ({ kind, text }).
let busy = null;
const outcomes = new Map();

// The sections whose log panel is open, for the page to read their logs along with the status.
export const openLogs = () => [...logs].filter(([, s]) => s.open).map(([name]) => name);

// Reads the log of one service into its panel's state. An expired session is raised as AuthError (the page's load handles it).
export async function fetchLog(section) {
  const state = logs.get(section) ?? {};
  logs.set(section, state);
  try {
    const r = await ubus('flab.ddns', 'log', { section });
    Object.assign(state, r?.ok ? { exists: r.exists, text: r.text, truncated: Boolean(r.truncated), error: null } : { error: r?.error ?? 'The log could not be read.' });
  } catch (e) {
    if (e instanceof AuthError) throw e;
    state.error = e.message;
  }
  state.loading = false;
}

// Reads a log for a click handler: an expired session sends the user back to the sign-in screen (through a reload) instead of
// leaving a rejected promise behind.
async function readLog(ctx, section) {
  try { await fetchLog(section); } catch { await ctx.reload(); }
}

//#endregion

//#region Helpers

// Makes the card of `key` foldable (core/fold.js) and remembers whether the user folded it.
const foldCard = (el, key) => foldable(el, folds.get(key) ?? key === 'global', folded => folds.set(key, folded));

// The option keys whose value changes which other controls are shown, so changing one redraws the form.
const REDRAWS = new Set(['service_name', 'ip_source', 'use_https', 'use_ipv6']);

// The field `f` of a service with its drop-down options filled in from what the router reported, and the texts that depend
// on the other values.
function fieldFor(ctx, svc, f, values) {
  let g = f;
  if (f.dynamic === 'providers') g = { ...f, options: ctx.data.providers.map(p => p.name), labels: Object.fromEntries(ctx.data.providers.map(p => [p.name, providerLabel(p)])) };
  else if (f.dynamic === 'networks') g = { ...f, options: ctx.data.networks };
  else if (f.dynamic === 'devices') g = { ...f, options: ctx.data.devices };
  if (f.key === 'ip_network') g = { ...g, blank: `Default (${values.use_ipv6 ? 'wan6' : 'wan'})` };
  if (f.secret) g = { ...g, placeholder: svc.secrets?.[f.key] ? 'stored; leave empty to keep it' : 'not set' };
  return g;
}

// Connects the control of one field to the draft, under the control name `id` (also used to mark errors).
function controlFor(ctx, f, id, values, off, svc = null) {
  const field = svc ? fieldFor(ctx, svc, f, values) : f;
  return fieldRow(field, {
    id,
    get: () => values[f.key],
    set: v => { values[f.key] = v; if (svc && REDRAWS.has(f.key)) queueMicrotask(() => ctx.redraw()); },
    disabled: !ctx.canEdit || off,
    touched: ctx.touched,
    redraw: ctx.redraw,
    register: (el, index) => { if (index == null) ctx.inputs[id] = el; else (ctx.inputs[id] ??= [])[index] = el; },
  });
}

// What the badge and the icon of a verdict look like.
const VERDICT = {
  ok: ['success', 'check-circle'], pending: ['warning', 'hourglass-split'], error: ['danger', 'x-circle'],
  stopped: ['danger', 'exclamation-triangle'], disabled: ['', 'toggle-off'], unknown: ['info', 'hourglass-split'],
};

//#endregion

//#region Status and actions

// Runs a control action on one service and reads the status again after the updater has had a moment to start.
async function perform(ctx, section, action) {
  busy = { section, action };
  outcomes.delete(section);
  ctx.rerender();
  let reply = null, error = null;
  try {
    reply = await ubus('flab.ddns', 'control', { section, action });
  } catch (e) {
    if (e instanceof AuthError) { busy = null; return ctx.reload(); }
    error = e.message;
  }
  outcomes.set(section, reply?.ok
    ? { kind: 'ok', text: action === 'force' ? 'The updater was restarted and is sending the address now.' : 'The updater was restarted and is checking the address now.' }
    : { kind: 'bad', text: `${error ?? reply?.error ?? 'It failed.'}${reply?.output ? ` ${reply.output}` : ''}` });
  await sleep(2500);
  busy = null;
  await ctx.reload();
}

// Where the service reads the address from, in words.
function sourceWords(v) {
  const s = v.ip_source || 'network';
  if (s === 'network') return `network ${v.ip_network || (v.use_ipv6 === '1' ? 'wan6' : 'wan')}`;
  if (s === 'interface') return `device ${v.ip_interface || 'eth1'}`;
  if (s === 'web') return `web page ${v.ip_url || 'checkip.dyndns.com'}`;
  return 'a script';
}

// The status part of a service card: the verdict in words, the addresses and times, and the buttons that act on the updater.
function statusBlock(ctx, svc) {
  const rt = svc.runtime ?? {};
  const verdict = verdictOf(svc);
  const [, verdictIcon] = VERDICT[verdict.kind];
  const t = timing(svc.values);
  const enabled = verdict.kind !== 'disabled';
  const allowed = can('flab.ddns', 'control');
  const mine = busy?.section === svc.section;
  const out = outcomes.get(svc.section);
  const log = logs.get(svc.section);
  const asked = t.requested !== t.check ? ` (${spanWords(t.requested)} was asked for; see Intervals)` : '';
  // A control button: disabled for a login that may not run actions, a disabled service or a call in progress.
  const act = (label, iconName, action, title) => button(label, iconName, () => perform(ctx, svc.section, action), 'btn-fl', {
    disabled: !allowed || !enabled || Boolean(busy),
    title: !allowed ? 'This login is not allowed to run actions on the updater.' : !enabled ? 'The service is disabled.' : title,
  });
  const toggleLog = button(log?.open ? 'Hide log' : 'Log', 'journal-text', async () => {
    const s = logs.get(svc.section) ?? {};
    logs.set(svc.section, s);
    s.open = !s.open;
    if (s.open) { s.loading = true; ctx.rerender(); await readLog(ctx, svc.section); }
    ctx.rerender();
  }, 'btn-fl', { title: 'The updater\'s own log for this service' });
  return h('div', { className: 'ddns-status' },
    h('div', { className: `ddns-verdict ${verdict.kind}` }, icon(verdictIcon),
      h('div', {}, h('strong', {}, verdict.text), h('div', { className: 'small' }, verdict.detail))),
    kv([
      ['Router address', rt.local_ip || rt.detected_ip ? h('span', {}, mono(currentIp(rt)), h('span', { className: 'muted small' }, ` from ${sourceWords(svc.values)}`)) : muted(`not read from ${sourceWords(svc.values)}`)],
      ['At the provider', rt.registered_ip ? mono(rt.registered_ip) : muted('not looked up yet')],
      ['Last update sent', rt.last_update ? h('span', {}, ago(rt.last_update, ctx.now), h('span', { className: 'muted small' }, ` · ${new Date(rt.last_update * 1000).toLocaleString()}`)) : muted('not since the updater started')],
      ['Next check', enabled && rt.running ? ago(rt.next_check, ctx.now) : muted('–')],
      ['Checks every', `${spanWords(t.check)}${asked}`],
      ['Forced update every', t.force ? spanWords(t.force) : 'never (the updater stops after the first update)'],
      ['Updater', rt.running ? `running, process ${rt.pid}` : muted('not running')],
    ]),
    h('div', { className: 'ddns-actions' },
      act('Check now', 'arrow-clockwise', 'check', 'Restart the updater: it reads the address and updates the provider if it differs from the registered one.'),
      act('Force update', 'upload', 'force', 'Restart the updater and send the address to the provider even if it has not changed.'),
      toggleLog,
      mine ? h('span', { className: 'ddns-busy' }, h('span', { className: 'spinner-border spinner-border-sm' }), busy.action === 'force' ? 'Sending the update…' : 'Restarting the updater…') : null),
    out ? h('div', { className: `ddns-outcome ${out.kind}` }, icon(out.kind === 'ok' ? 'check-circle' : 'x-circle'), out.text) : null,
    log?.open ? logPanel(ctx, svc.section, log) : null);
}

// The log panel of a service: the lines that matter (warnings, errors, notes and information other than the routine check
// line) with their times, or every line. The box starts scrolled to the newest line, at the bottom.
function logPanel(ctx, section, log) {
  const lines = parseLog(log.text);
  const important = lines.filter(isNoteworthy);
  const shown = log.all ? lines : important;
  // Reads the log again and redraws the panel.
  const reload = async () => { log.loading = true; ctx.rerender(); await readLog(ctx, section); ctx.rerender(); };
  const box = h('div', { className: 'ddns-logbox', tabindex: 0 }, shown.map(l => h('div', { className: `ddns-logline ${l.level}` }, h('span', { className: 'ddns-logtime' }, l.time), h('span', { className: 'ddns-logtext' }, l.text))));
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  const body = log.loading && !log.text ? muted('Reading the log…')
    : log.error ? h('div', { className: 'ddns-outcome bad' }, icon('x-circle'), log.error)
      : !log.exists ? muted('There is no log file. It is written when "Keep a log file" is on and the updater has run.')
        : !shown.length ? muted('Nothing noteworthy in the log. Show every line to see the updater\'s steps.')
          : box;
  const all = h('input', { className: 'form-check-input', type: 'checkbox', checked: Boolean(log.all), onchange: e => { log.all = e.target.checked; ctx.rerender(); } });
  return h('div', { className: 'ddns-log' },
    h('div', { className: 'ddns-log-head' },
      h('strong', {}, `Log of ${section}`),
      h('label', { className: 'form-check ddns-log-all' }, all, h('span', {}, `Show every line (${lines.length})`)),
      button('Refresh', 'arrow-clockwise', reload)),
    body);
}

//#endregion

//#region The service card

// The one-line description of a service in its header: provider, name and address family.
function describe(ctx, svc) {
  const v = effective(ctx.draft.services[svc.id]);
  return [v.service_name || 'custom provider', v.lookup_host || v.domain, v.use_ipv6 ? 'IPv6' : 'IPv4'].filter(Boolean).join(' · ');
}

// The options of a section that the option tables do not describe, read only. A secret among them is hidden.
function extraOptions(svc) {
  const known = new Set(SERVICE_FIELDS.map(f => f.key));
  const rows = [
    ...Object.entries(svc.values).filter(([k]) => !known.has(k)).map(([k, v]) => [k, String(v)]),
    ...Object.keys(svc.secrets ?? {}).filter(k => !known.has(k)).map(k => [k, 'hidden (a secret)']),
  ];
  if (!rows.length) return null;
  return h('div', { className: 'ddns-extra' },
    h('p', { className: 'muted small' }, 'Other options in this section of /etc/config/ddns. This page has no control for them; change them in the file.'),
    h('dl', { className: 'kv' }, rows.flatMap(([k, v]) => [h('dt', { className: 'mono' }, k), h('dd', { className: 'mono' }, v)])));
}

// The name field of a service that is not saved yet.
function nameControl(ctx, svc) {
  const added = ctx.draft.added.find(a => a.id === svc.id);
  const input = h('input', { className: 'form-control form-control-sm', value: added.name, placeholder: 'myddns', spellcheck: false, autocomplete: 'off', disabled: !ctx.canEdit,
    oninput: e => { added.name = e.target.value; ctx.touched(); } });
  ctx.inputs[`svc:${svc.id}:name`] = input;
  return h('div', { className: 'set-field' }, h('label', { className: 'form-label' }, 'Section name'), input,
    h('div', { className: 'muted small set-hint' }, 'How this service is called in /etc/config/ddns, and the name of its log. Letters, digits and underscores; it cannot be changed once saved.'));
}

// The card of one service. Clicking its header folds the card; the choice survives redraws. A service can be removed (until
// saved it can be restored).
export function serviceCard(ctx, svc) {
  const off = svc.removed;
  const values = ctx.draft.services[svc.id];
  const verdict = svc.isNew ? null : verdictOf(svc);
  const groups = SERVICE_GROUPS.map(g => {
    const fields = SERVICE_FIELDS.filter(f => f.group === g.id && isShown(f, values));
    if (!fields.length) return null;
    const id = `${svc.id}:${g.id}`;
    return disclosure({
      cls: 'ddns-group fl-disclosure-bar', summary: g.title, open: opened.get(id) ?? Boolean(g.open), onToggle: open => opened.set(id, open),
      body: h('div', { className: 'ddns-group-body' }, h('p', { className: 'muted small' }, g.legend),
        h('div', { className: 'set-fields' }, fields.map(f => controlFor(ctx, f, `svc:${svc.id}:${f.key}`, values, off, svc)))),
    });
  });
  const actions = off
    ? h('div', { className: 'ddns-service-actions' }, muted(`Service ${svc.name} is removed when you save.`), button('Undo', 'arrow-counterclockwise', () => { restoreService(ctx.draft, svc.id); ctx.touched(); ctx.redraw(); }))
    : h('div', { className: 'ddns-service-actions' },
      muted(svc.isNew ? 'Not saved yet.' : `The ddns section "${svc.section}".`),
      button(svc.isNew ? 'Discard service' : 'Remove service', 'trash', () => { removeService(ctx.draft, svc.id); ctx.touched(); ctx.redraw(); }, 'btn-fl',
        { disabled: !ctx.canEdit, title: `Stop updating ${svc.name} and delete this service` }));
  const state = svc.isNew ? badge('new', 'info', 'not saved yet') : off ? badge('to be removed', 'danger') : badge(verdict.text, VERDICT[verdict.kind][0], verdict.detail);
  const el = card(
    [chevron(), icon('gear'), h('span', {}, svc.name || 'New service'), state, h('span', { className: 'sub' }, describe(ctx, svc))],
    h('div', { className: `card-body ddns-groups${off ? ' ddns-removed' : ''}` },
      svc.isNew ? nameControl(ctx, svc) : null,
      !svc.isNew && !off ? statusBlock(ctx, svc) : null,
      actions, groups, extraOptions(svc)),
    svc.isNew ? 'ddns-new' : '');
  return foldCard(el, svc.id);
}

// The row below the services for adding one.
export function addServiceBar(ctx) {
  const add = button('Add service', 'plus-lg', () => { folds.delete(addService(ctx.data, ctx.draft)); ctx.touched(); ctx.redraw(); }, 'btn-fl', { disabled: !ctx.canEdit });
  return h('div', { className: 'ddns-addbar' }, add,
    h('span', { className: 'muted small' }, 'One service updates one name at one provider, for IPv4 or for IPv6. To update both families, or several names, add a service for each.'));
}

//#endregion

//#region The global card

// The card of the global settings (the `ddns` section named global), folded until opened: the documentation advises casual users
// not to change them. Its header says whether the updater runs and starts at boot.
export function globalCard(ctx) {
  const d = ctx.data;
  const fields = GLOBAL_FIELDS.map(f => controlFor(ctx, f, `global:${f.key}`, ctx.draft.global, false));
  const el = card(
    [chevron(), icon('gear'), h('span', {}, 'Global settings'),
      badge(d.running ? 'updater running' : 'updater not running', d.running ? 'success' : 'warning'),
      h('span', { className: 'sub' }, `ddns-scripts ${d.version ?? ''} · ${d.atBoot ? 'starts at boot' : 'does not start at boot'} · run files in ${d.rundir}`)],
    h('div', { className: 'card-body' },
      legend(['These apply to every service. The documentation advises casual users to leave them as they are. The updater itself is started and stopped on the Services page (the "ddns" service).']),
      h('div', { className: 'set-fields' }, fields)));
  return foldCard(el, 'global');
}

//#endregion
