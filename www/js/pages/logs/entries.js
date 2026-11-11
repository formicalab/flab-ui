// Pure helpers of the Logs page: severity levels, filtering, summaries and text formatting. No DOM and no
// router access, so they are unit-tested on their own (tests/network/logs.test.mjs).
//
// An entry is what flab.logs returns: { t (epoch seconds or null), facility, severity (name or null),
// level (0 emerg … 7 debug, or null), program, pid, message, uptime? (kernel entries) }.

// Level filter choices: the highest level number that is still shown (lower numbers are more severe).
// `null` shows everything, including lines without a parsable severity.
export const LEVELS = [
  ['all', 'All levels', null],
  ['info', 'Info and above', 6],
  ['notice', 'Notice and above', 5],
  ['warning', 'Warnings and above', 4],
  ['err', 'Errors and above', 3],
];

// The highest level number to show for a level filter key ('all' → null: no limit).
export const levelLimit = key => LEVELS.find(([k]) => k === key)?.[2] ?? null;

// Badge kind for a severity level: errors red, warnings amber, notices blue, the rest plain.
export const levelKind = level => level == null ? '' : level <= 3 ? 'danger' : level === 4 ? 'warning' : level === 5 ? 'info' : '';

// Row tint class for a severity level.
export const levelClass = level => level == null ? 'lv-none' : level <= 3 ? 'lv-err' : level === 4 ? 'lv-warn' : level === 5 ? 'lv-notice' : level === 7 ? 'lv-debug' : 'lv-info';

// The sources (programs) present in a list of entries, sorted, for the source filter.
export const programsOf = entries => [...new Set(entries.map(e => e.program).filter(Boolean))].sort((a, b) => a.localeCompare(b));

// Entries matching the filter: at most `level` severity, from `program`, and containing every word of `q`
// (case-insensitive) in the origin or message. A line with no parsable severity only shows with no level limit.
export function filterEntries(entries, { q = '', level = 'all', program = 'all' } = {}) {
  const limit = levelLimit(level);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(e => {
    if (limit != null && (e.level == null || e.level > limit)) return false;
    if (program !== 'all' && e.program !== program) return false;
    if (!words.length) return true;
    const hay = `${e.facility ?? ''}.${e.severity ?? ''} ${e.program ?? ''}[${e.pid ?? ''}] ${e.message}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

// Counts for the summary tiles: errors (level 0-3), warnings, and the newest timestamp seen.
export function summarize(entries) {
  let errors = 0, warnings = 0, newest = null;
  for (const e of entries) {
    if (e.level != null && e.level <= 3) errors++;
    else if (e.level === 4) warnings++;
    if (e.t != null && (newest == null || e.t > newest)) newest = e.t;
  }
  return { errors, warnings, newest };
}

const pad = n => String(n).padStart(2, '0');

// "12 Nov 09:05:03" in the browser's time zone, or an en dash for an entry with no time.
export function fmtClock(t) {
  if (t == null) return '–';
  const d = new Date(t * 1000);
  return `${pad(d.getDate())} ${d.toLocaleString('en-GB', { month: 'short' })} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// "2026-11-12 09:05:03" (sortable, for the downloaded text).
export function fmtStamp(t) {
  if (t == null) return '';
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// "daemon.info" for an entry, or an empty string when its priority is unknown.
export const priorityOf = e => e.facility && e.severity ? `${e.facility}.${e.severity}` : '';

// "program[pid]" for an entry; an entry with no program shows an empty string.
export const originOf = e => e.program ? `${e.program}${e.pid != null ? `[${e.pid}]` : ''}` : '';

// The entries as plain text lines, the way logread prints them, for the Download button.
export const toText = entries => entries.map(e => [fmtStamp(e.t), priorityOf(e), originOf(e) ? `${originOf(e)}:` : '', e.message].filter(Boolean).join(' ')).join('\n') + '\n';
