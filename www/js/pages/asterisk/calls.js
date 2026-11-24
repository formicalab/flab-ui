// Calls tab: the recent calls, from the CDR file cdr_csv writes (reply of `flab.asterisk calls`), newest first: when, direction, who called whom,
// how it ended and for how long. The direction needs to know which endpoints are trunks, so the PJSIP reply is read too.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, emptyState, mono, muted } from '../../core/ui.js';
import { fmtSpan } from '../../core/format.js';
import { DIRECTION_TEXT, ago, directionOf, filterCalls, groupCalls, partiesOf, resultOf, summarize } from './callsmodel.js';
import { state } from './state.js';

const DIRECTION_ICON = { in: 'arrow-down', out: 'arrow-up', internal: 'arrow-left-right' };

// The names of the trunk endpoints, or null when PJSIP could not be read (then the direction is unknown).
const trunkNames = pjsip => pjsip?.available ? new Set(pjsip.endpoints.filter(e => e.role === 'trunk').map(e => e.name)) : null;

// A number with, under it, the name and the endpoint that carried the call.
const party = (number, name, via) => h('div', {}, h('div', { className: 'mono' }, number), name || via ? h('div', { className: 'muted small' }, [name, via].filter(Boolean).join(' · ')) : null);

// Why nothing is listed, and what to do about it.
function nothingToShow(c) {
  if (!c.installed) return emptyState('Asterisk is not installed on this router.');
  if (!c.csv) {
    return emptyState('No call history: Asterisk has no CDR backend. Install the asterisk-cdr-csv package (it provides cdr_csv.so), set unanswered=yes in cdr.conf to keep missed calls, and reload Asterisk.');
  }
  return emptyState('No call has been logged yet. The history is kept in RAM, so it starts empty after every reboot.');
}

// The Calls tab's nodes for the replies of `flab.asterisk calls` and `flab.asterisk pjsip` (null when it cannot be read).
export function callsView(c, pjsip) {
  const all = groupCalls(c.entries);
  if (!all.length) return [nothingToShow(c)];
  const trunks = trunkNames(pjsip);
  const shown = filterCalls(all, trunks, state.ckind, state.cq);
  const s = summarize(shown);
  const now = Date.now() / 1000;
  const rows = shown.map(call => {
    const p = partiesOf(call);
    const dir = directionOf(call, trunks);
    const [word, kind] = resultOf(call.disposition);
    return h('tr', { title: call.legs > 1 ? `${call.legs} CDR lines make this call` : '' },
      h('td', { className: 'text-nowrap', title: new Date(call.start * 1000).toLocaleString() }, ago(call.start, now)),
      h('td', { className: 'text-nowrap' }, dir ? h('span', { className: `ast-dir ${dir}` }, icon(DIRECTION_ICON[dir]), ' ', DIRECTION_TEXT[dir]) : muted('–')),
      h('td', {}, party(p.from, p.fromName, p.fromVia)),
      h('td', {}, party(p.to, '', p.toVia)),
      h('td', {}, badge(word, kind, call.disposition)),
      h('td', { className: 'text-nowrap' }, call.duration != null ? fmtSpan(Math.max(0, call.duration - (call.billsec ?? 0))) : '–'),
      h('td', { className: 'text-nowrap' }, call.billsec ? fmtSpan(call.billsec) : muted('–')));
  });
  const line = h('div', { className: 'muted small mb-2' },
    `${s.calls} call${s.calls === 1 ? '' : 's'} · ${s.answered} answered · ${s.missed} missed · ${s.failed} failed · ${fmtSpan(s.talk)} talking`);
  const note = h('div', { className: 'muted small mb-1' }, 'The history is the file ', mono(c.file), ` (${c.entries.length} line${c.entries.length === 1 ? '' : 's'} read${c.truncated ? ', the oldest ones left out' : ''}). `,
    'It lives in RAM: it is emptied by a reboot and trimmed to the last 5000 lines every night.');
  return [
    card([icon('clock-history'), 'Recent calls'], h('div', { className: 'card-body' }, note, line,
      h('div', { className: 'table-responsive' }, h('table', { className: 'table table-hover ast-table' },
        h('thead', {}, h('tr', {}, ['When', 'Direction', 'From', 'To', 'Result', 'Ringing', 'Talking'].map(t => h('th', {}, t)))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 7, className: 'muted' }, 'No call matches the filter.'))))))),
  ];
}
