// Calls tab: the calls in progress with their codecs (reply of `flab.asterisk active`), then the recent calls, from the CDR file cdr_csv writes
// (reply of `flab.asterisk calls`), newest first: start, end, direction, who called whom,
// how it ended and for how long. The direction needs to know which endpoints are trunks, so the PJSIP reply is read too.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, emptyState, mono, muted } from '../../core/ui.js';
import { fmtSpan } from '../../core/format.js';
import { DIRECTION_TEXT, codecOf, directionOf, filterCalls, groupActive, groupCalls, lossText, partiesOf, resultOf, stamp, summarize, transcodingOf } from './callsmodel.js';
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

const ms = seconds => `${(seconds * 1000).toFixed(seconds < 0.01 ? 2 : 1)} ms`;

// What the RTP statistics of a channel say, as one line (the loss of both directions, jitter and round trip time); null without statistics.
function rtpLine(rtp) {
  if (!rtp) return null;
  const parts = [`loss in ${rtp.rx.loss_pct}% · out ${rtp.tx.loss_pct}%`, `jitter in ${ms(rtp.rx.jitter)} · out ${ms(rtp.tx.jitter)}`];
  if (rtp.rtt) parts.push(`RTT ${ms(rtp.rtt)}`);
  return parts.join(' · ');
}

// Why a channel is converted. Without a bridge Asterisk itself is the other side (a menu, a prompt, an announcement): it plays a file in its own
// format and converts it to the channel's codec, which is normal. In a bridge it is a real conversion between the two phones or trunks.
function transcodingBadge(ch, trans) {
  const path = trans.detail ? ` (${trans.detail})` : '';
  return ch.bridge
    ? badge('transcoding', 'warning', `The two sides of this call do not share a codec, so Asterisk converts the audio${path}.`)
    : badge('transcoding', 'info', `Asterisk plays audio of its own on this channel (a prompt, a menu, an announcement) in a different format than the codec of the channel, and converts it${path}. This is normal.`);
}

// One channel of a call in progress; `now` is the router's clock (epoch seconds), from which the start time follows.
function legRow(ch, now) {
  const codec = codecOf(ch), trans = transcodingOf(ch), rtp = rtpLine(ch.rtp);
  const lossTitle = ch.rtp ? `Received: ${lossText(ch.rtp.rx)}. Sent: ${lossText(ch.rtp.tx)}.` : '';
  return h('tr', {},
    h('td', {}, h('div', { className: 'mono' }, ch.channel), ch.callerid ? h('div', { className: 'muted small' }, ch.callerid) : null),
    h('td', {}, badge(ch.state, ch.state === 'Up' ? 'success' : 'info')),
    h('td', {}, ch.app ? h('span', { className: 'mono' }, ch.app) : muted('–'), ch.exten ? h('div', { className: 'muted small' }, `${ch.exten}@${ch.context}`) : null),
    h('td', {}, codec.text ? h('span', { className: 'mono' }, codec.text) : muted('–'), ' ', trans.active ? transcodingBadge(ch, trans) : null),
    h('td', { className: 'small' }, ch.formats?.native?.length ? ch.formats.native.join(', ') : muted('–')),
    h('td', { className: 'small', title: lossTitle }, rtp ?? muted('–')),
    h('td', { className: 'text-nowrap' }, ch.duration != null && now != null ? stamp(now - ch.duration) : '–'),
    h('td', { className: 'text-nowrap' }, ch.duration != null ? fmtSpan(ch.duration) : '–'));
}

// The calls in progress (reply of `flab.asterisk active`), with the codecs of every channel. Null when it could not be read.
function activeCard(a) {
  if (!a) return null;
  const header = [icon('telephone'), 'Calls in progress'];
  if (!a.available) return card(header, h('div', { className: 'card-body muted' }, 'Asterisk is not running or does not answer, so its channels cannot be read.'));
  const calls = groupActive(a.channels);
  if (!calls.length) return card(header, h('div', { className: 'card-body muted' }, 'No call is in progress.'));
  const note = h('div', { className: 'muted small mb-2' },
    `${calls.length} call${calls.length === 1 ? '' : 's'}, ${a.channels.length} channel${a.channels.length === 1 ? '' : 's'}. `,
    'Codec is what Asterisk reads from and writes to the channel; Offers are the codecs the channel could use. The two sides of a call are listed together',
    a.truncated ? '; the codecs of the channels beyond the first ones are not read' : '', '.');
  return card(header, h('div', { className: 'card-body' }, note,
    h('div', { className: 'table-responsive' }, h('table', { className: 'table ast-table' },
      h('thead', {}, h('tr', {}, ['Channel', 'State', 'Doing', 'Codec', 'Offers', 'RTP', 'Started', 'Duration'].map(t => h('th', {}, t)))),
      calls.map(call => h('tbody', { title: call.legs.length > 1 ? 'The channels of one call' : '' }, call.legs.map(ch => legRow(ch, a.now))))))));
}

// The Calls tab's nodes for the replies of `flab.asterisk calls`, `flab.asterisk pjsip` and `flab.asterisk active` (null when it cannot be read).
export function callsView(c, pjsip, active) {
  const live = activeCard(active);
  return [live, ...historyView(c, pjsip)].filter(Boolean);
}

// The recent calls card, or why there is none.
function historyView(c, pjsip) {
  const all = groupCalls(c.entries);
  if (!all.length) return [nothingToShow(c)];
  const trunks = trunkNames(pjsip);
  const shown = filterCalls(all, trunks, state.ckind, state.cq);
  const s = summarize(shown);
  const rows = shown.map(call => {
    const p = partiesOf(call);
    const dir = directionOf(call, trunks);
    const [word, kind] = resultOf(call.disposition);
    return h('tr', { title: call.legs > 1 ? `${call.legs} CDR lines make this call` : '' },
      h('td', { className: 'text-nowrap' }, stamp(call.start)),
      h('td', { className: 'text-nowrap' }, call.end != null ? stamp(call.end, call.start) : muted('–')),
      h('td', { className: 'text-nowrap' }, dir ? h('span', { className: `ast-dir ${dir}` }, icon(DIRECTION_ICON[dir]), ' ', DIRECTION_TEXT[dir]) : muted('–')),
      h('td', {}, party(p.from, p.fromName, p.fromVia)),
      h('td', {}, party(p.to, '', p.toVia)),
      h('td', {}, badge(word, kind, call.disposition)),
      h('td', { className: 'text-nowrap' }, call.duration != null ? fmtSpan(call.duration) : '–'),
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
        h('thead', {}, h('tr', {}, ['Start', 'End', 'Direction', 'From', 'To', 'Result', 'Duration', 'Ringing', 'Talking'].map(t => h('th', {}, t)))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 9, className: 'muted' }, 'No call matches the filter.'))))))),
  ];
}
