// Dynamic DNS page (route #ddns): the ddns-scripts client that keeps a DNS name pointing at the router's changing public address.
// It shows what each service is doing right now (the address the router has, the one the provider has registered, when the last
// update was sent and the next check, and a verdict in words), lets you restart a service's updater or force an update, shows
// its log, and edits the config behind it: every option of each service (services can be added and removed) and the global
// settings (the option tables are in schema.js, taken from the OpenWrt documentation; validation, the change list and the UCI
// operations in model.js).
//
// The config is read through the flab.ddns plugin, which leaves out the password or token: the browser never receives a secret,
// and the password field is write-only (empty keeps the stored value). Writes go through core/uci.js applyChange(): stage, apply
// with the rollback countdown, read the config back through the plugin, confirm. The controls and the review banner are shared
// with the other editing pages (core/forms.js, core/editpage.js). The page redraws on every poll, so polling is suspended while
// there is something to lose: unsaved edits, a focused control or a save.
import { h } from '../../core/dom.js';
import { optional, ubus } from '../../core/ubus.js';
import { tile, tiles } from '../../core/ui.js';
import { refreshControl } from '../../core/controls.js';
import { note } from '../../core/forms.js';
import { createEditor } from '../../core/editpage.js';
import { reveal } from '../../core/fold.js';
import { addServiceBar, fetchLog, globalCard, openLogs, serviceCard } from './cards.js';
import { CONFIG, ago, changesOf, checkApplied, draftFrom, isDirty, plan, problems, readDdns, serviceList, summarize } from './model.js';

// The draft, the review banner, saving and discarding, shared with the other editing pages (core/editpage.js). The check after
// a save reads the config through the plugin, which is also where the page gets its data.
const editor = createEditor({
  config: CONFIG,
  readAfter: async () => readDdns(await ubus('flab.ddns', 'status')),
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: (base, draft, after) => checkApplied(after, draft),
});
const { state } = editor;

// The shell's redraw and reload functions, handed over by controls().
const shell = { rerender: () => {}, reload: () => {} };

// Reads the status, the logs that are open, and how many changes are already staged in this session (applying would commit
// those too). A router without the plugin gives an empty page with a note.
async function load() {
  const status = await optional(ubus('flab.ddns', 'status'));
  if (!status) return { unavailable: true, ...readDdns(null), staged: 0 };
  const data = readDdns(status);
  await Promise.all(openLogs().map(name => optional(fetchLog(name))));
  return editor.withStaged(data);
}

//#region Pieces of the page

// The summary tiles: whether the updater runs, how many services are up to date, and when the last update and the next
// check are.
function summary(data) {
  const s = summarize(data, data.generated);
  // "1 service" or "N services".
  const noun = n => `${n} service${n === 1 ? '' : 's'}`;
  return tiles(
    tile('Updater', data.running ? 'Running' : 'Stopped', `${s.running} of ${noun(s.enabled)} enabled running · ${data.atBoot ? 'starts at boot' : 'does not start at boot'}`, !data.running && s.enabled ? 'text-danger' : ''),
    tile('Up to date', s.enabled ? `${s.upToDate} of ${s.enabled}` : '–', s.enabled ? (s.problems ? `${noun(s.problems)} with a problem` : 'the name points at the router') : 'no service is enabled', s.problems ? 'text-danger' : ''),
    tile('Last update', s.lastUpdate ? ago(s.lastUpdate, data.generated) : 'none', s.lastUpdateName ? `sent for ${s.lastUpdateName}` : 'no update sent since the updater started'),
    tile('Next check', s.nextCheck ? ago(s.nextCheck, data.generated) : '–', s.enabled ? `${noun(data.services.length)} configured` : `${noun(data.services.length)} configured, none enabled`),
  );
}

//#endregion

export default {
  id: 'ddns',
  label: 'Dynamic DNS',
  title: 'Dynamic DNS · ddns-scripts',
  icon: 'cloud',
  interval: 10000,
  css: ['css/forms.css', 'css/ddns.css'],
  isPaused: () => editor.paused('.ddns-form'),

  load,

  controls({ rerender, reload }) {
    shell.rerender = rerender;
    shell.reload = reload;
    return { nodes: [refreshControl(reload), editor.attach(reload)] };
  },

  view(data, rerender) {
    shell.rerender = rerender;
    if (data.unavailable) return [note('bad', 'The Dynamic DNS plugin (flab.ddns) is not available on the router, so this page cannot show or change anything. Install or reinstall the flab-ui package and reload rpcd.')];
    if (!data.installed) return [note('bad', 'ddns-scripts is not installed on the router. Install it (apk add ddns-scripts, and ddns-scripts-services or a provider package) and reload this page.')];
    const canEdit = editor.begin(data, rerender);
    const ctx = { data, draft: state.draft, canEdit, now: data.generated, inputs: {}, rerender, reload: () => shell.reload(), redraw: () => editor.redraw(), touched: () => {}, sync: () => {} };
    ctx.touched = editor.touched(ctx);

    // Called after every edit: marks the controls that hold an error and refreshes the banner. A control with an error must not
    // stay hidden in a folded card or a closed group, so those are opened.
    ctx.sync = () => editor.markErrors(ctx.inputs, canEdit, reveal);

    const page = [
      summary(data),
      ...editor.notes(data),
      !data.running && data.services.some(s => !['0', 'false', 'no', 'off'].includes(String(s.values.enabled ?? '0'))) ? note('bad', 'The ddns updater is not running although a service is enabled, so no address is being updated. Start it on the Services page, or save a change here to reload it.') : null,
      h('div', { className: 'ddns-form' },
        ...serviceList(data, state.draft).map(s => serviceCard(ctx, s)),
        addServiceBar(ctx),
        globalCard(ctx)),
    ];
    ctx.sync();
    return page.filter(Boolean);
  },
};
