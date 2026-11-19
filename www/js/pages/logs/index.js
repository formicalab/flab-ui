// Logs page (route #logs): the system log (logd, `logread`) and the kernel log (`dmesg`), read through the
// flab.logs plugin, which parses the lines and redacts values that look like secrets. The newest entries are
// at the bottom; the view follows new entries while it is scrolled to the bottom and stays put when the
// user scrolls up. Filtering (text, severity, source) is done in the browser on the loaded tail; the number
// of lines and the log to read are requested from the router.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { ubus } from '../../core/ubus.js';
import { saveFile } from '../../core/download.js';
import { badge, button, card, emptyState, muted, tile, tiles } from '../../core/ui.js';
import { searchControl, selectControl, pauseControl, refreshControl } from '../../core/controls.js';
import { fmtNum, fmtSpan } from '../../core/format.js';
import { LEVELS, filterEntries, fmtClock, levelClass, levelKind, originOf, priorityOf, programsOf, summarize, toText } from './entries.js';

// Filters and the paused flag live here so they survive the redraw on every poll. Select values are strings,
// so `lines` is one too.
const state = { source: 'system', q: '', level: 'all', program: 'all', lines: '500', paused: false };

// Where the log pane is scrolled, kept at module level because the pane is rebuilt on every poll. `stick`
// means "show the newest entry": it is on while the user is at the bottom and off after scrolling up.
const scroll = { top: 0, stick: true };

// The pane element of the current render and the entries it was built from (for Newest / Download).
let pane = null;
let loaded = [];

// What each log is, shown above the entries.
const SOURCE_TEXT = {
  system: ['System log (logread)', 'Messages from every daemon and from the kernel, kept by logd in a ring buffer in RAM; the oldest lines are overwritten when it is full.'],
  kernel: ['Kernel log (dmesg)', 'The kernel ring buffer: drivers, network devices, Wi-Fi and hardware events. Times are seconds since boot converted to clock time.'],
};

// Reads the log selected in the command bar; the router returns the last `lines` entries.
async function load() {
  // Read the selection once: the filters can change while the request is on its way.
  const { source, lines } = state;
  const data = await ubus('flab.logs', 'read', { source, lines: +lines });
  return { entries: Array.isArray(data[source]) ? data[source] : [], source, limit: data.limit, generated: data.generated };
}

// Scrolls the pane to the newest entry and resumes following.
function jumpToNewest() {
  scroll.stick = true;
  if (pane) pane.scrollTop = pane.scrollHeight;
}

// Saves the entries matching the current filter as a text file (nothing is uploaded anywhere).
function download() {
  saveFile(`${state.source}-log.txt`, toText(filterEntries(loaded, state)));
}

// The four summary tiles: entries shown, errors, warnings, and how recent the newest entry is.
function summary({ entries, limit, generated }, shown) {
  const sum = summarize(entries);
  const filtered = shown.length !== entries.length;
  return tiles(
    tile('Entries shown', `${fmtNum(shown.length)} / ${fmtNum(entries.length)}`, filtered ? 'matching the filter' : `the newest ${fmtNum(limit)} lines at most`),
    tile('Errors', fmtNum(sum.errors), 'severity err or worse in this tail', sum.errors ? 'text-danger' : ''),
    tile('Warnings', fmtNum(sum.warnings), 'severity warning in this tail', sum.warnings ? 'text-warning' : ''),
    tile('Newest entry', sum.newest != null ? `${fmtSpan(Math.max(0, generated - sum.newest))} ago` : '–', sum.newest != null ? fmtClock(sum.newest) : 'no timestamped entry'));
}

// One log line as a table row, tinted by severity.
function row(e) {
  return h('tr', { className: levelClass(e.level) },
    h('td', { className: 'log-time', title: e.uptime != null ? `${e.uptime.toFixed(3)} s after boot` : '' }, fmtClock(e.t)),
    h('td', {}, e.severity ? badge(e.severity, levelKind(e.level), priorityOf(e)) : ''),
    h('td', { className: 'log-origin', title: originOf(e) }, originOf(e) || muted('–')),
    h('td', { className: 'log-msg' }, e.message));
}

// The scrollable table of entries; remembers the scroll position and keeps following the newest entry.
function logPane(shown) {
  const table = h('table', { className: 'log-table' },
    h('thead', {}, h('tr', {}, ['Time', 'Level', 'Source', 'Message'].map(c => h('th', {}, c)))),
    h('tbody', {}, shown.map(row)));
  pane = h('div', { className: 'log-pane', onscroll: () => {
    scroll.top = pane.scrollTop;
    scroll.stick = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24;
  } }, table);
  // The pane is attached after view() returns, so its height is only known on the next frame.
  requestAnimationFrame(() => { pane.scrollTop = scroll.stick ? pane.scrollHeight : scroll.top; });
  return pane;
}

// The legend above the entries: what this log is and how to read the view.
function legend(source) {
  const [title, text] = SOURCE_TEXT[source];
  return h('div', { className: 'muted small log-legend' },
    h('p', {}, h('b', {}, `${title}: `), text),
    h('p', {}, h('b', {}, 'Levels: '), 'emerg, alert, crit and err are errors; warning, notice, info and debug follow in decreasing urgency. Use the level filter to hide the noise.'),
    h('p', {}, 'The newest entry is at the bottom and the view follows it while you stay there; scroll up to read older entries (Newest jumps back). Values that look like passwords or keys are replaced with <redacted> before they leave the router.'));
}

export default {
  interval: 5000,
  css: 'css/logs.css',
  isPaused: () => state.paused,

  load,

  controls({ rerender, reload }) {
    const source = selectControl(state, 'source', () => { scroll.stick = true; reload(); }, 'Which log to read');
    source.setOptions([['system', 'System log'], ['kernel', 'Kernel log']]);
    const level = selectControl(state, 'level', rerender, 'Hide entries below this severity');
    level.setOptions(LEVELS.map(([key, label]) => [key, label]));
    const program = selectControl(state, 'program', rerender, 'Show one source only');
    program.setOptions([['all', 'All sources']]);
    const lines = selectControl(state, 'lines', () => { scroll.stick = true; reload(); }, 'How many of the newest lines to load');
    lines.setOptions(['200', '500', '1000', '2000'].map(n => [n, `${n} lines`]));
    return {
      nodes: [source.node, searchControl(state, 'q', rerender, 'Filter log…'), level.node, program.node, lines.node,
        button('Newest', 'arrow-down', jumpToNewest), button('Download', 'download', download), pauseControl(state), refreshControl(reload)],
      // The source filter lists the programs present in the loaded tail; it resets when the selection disappears.
      update(data) { program.setOptions([['all', 'All sources'], ...programsOf(data.entries).map(p => [p, p])]); },
    };
  },

  view(data) {
    loaded = data.entries;
    const shown = filterEntries(data.entries, state);
    const [title] = SOURCE_TEXT[data.source];
    if (!data.entries.length) return [summary(data, shown), emptyState('The log is empty.')];
    return [
      summary(data, shown),
      card([icon('journal-text'), h('span', {}, title), h('span', { className: 'sub' }, `${fmtNum(shown.length)} of ${fmtNum(data.entries.length)} entries · oldest first`)],
        h('div', {}, legend(data.source),
          shown.length ? logPane(shown) : h('div', { className: 'card-body muted' }, 'No entries match the filter.'))),
    ];
  },
};
