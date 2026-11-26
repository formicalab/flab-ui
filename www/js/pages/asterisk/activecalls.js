// Calls in progress card of the Calls tab (reply of `flab.asterisk active`, with the PJSIP reply for the far ends): tiles over all calls, then for each call a
// diagram of its media path (far end, codec and quality of each side, the bridge) over the table of its channels. A channel row opens a side panel with
// everything known about it. The data is turned into facts by callsmodel.js; this file only draws.
import { h, onActivate } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { openDrawer } from '../../core/drawer.js';
import { badge, card, kv, mono, muted, section, sparkline, tile, tiles } from '../../core/ui.js';
import { fmtSpan } from '../../core/format.js';
import {
  BRIDGE_TEXT, DIRECTION_TEXT, callerFirst, codecOf, directionOfActive, endpointOf, groupActive, hangupKind, lossPct, lossText, onHold, peerAddresses, qualityOf,
  stamp, summarizeActive, transcodingOf, trunkNames,
} from './callsmodel.js';
import { qos } from './state.js';

export const DIRECTION_ICON = { in: 'arrow-down', out: 'arrow-up', internal: 'arrow-left-right' };

const dot = (kind, title = '') => h('span', { className: `ast-dot ${kind || 'neutral'}`, title });
const ms = seconds => `${(seconds * 1000).toFixed(seconds < 0.01 ? 2 : 1)} ms`;
const pct = v => v === 0 ? '0%' : v < 0.05 ? '<0.1%' : `${v.toFixed(v < 10 ? 1 : 0)}%`;
const HOLD_TEXT = 'Asterisk reports the endpoint On Hold: music on hold is played on this channel. Asterisk generates that music in its own format and converts it to the codec of the channel.';
const KIND_CLASS = { success: 'text-success', warning: 'text-warning', danger: 'text-danger' };

// Why a channel is converted. Music on hold and the prompts of a menu are audio of Asterisk's own (in its own format, converted to the channel's codec),
// which is normal. In a bridge it is a real conversion between the two sides of the call.
function transcodingBadge(ch, trans, held) {
  const path = trans.detail ? ` (${trans.detail})` : '';
  if (held) return badge('transcoding', 'info', `Music on hold is audio of Asterisk's own, converted to the codec of the channel${path}. This is normal.`);
  return ch.bridge
    ? badge('transcoding', 'warning', `The two sides of this call do not share a codec, or Asterisk is playing its own audio on it, so it converts the audio${path}.`)
    : badge('transcoding', 'info', `Asterisk plays audio of its own on this channel (a prompt, a menu, an announcement) in a different format than the codec of the channel, and converts it${path}. This is normal.`);
}

// The RTP statistics of a channel: the quality dot, loss, jitter and round trip, and the recent history of the jitter.
function rtpCell(ch) {
  const q = qualityOf(ch.rtp);
  if (!q) return muted('–');
  const { rx, tx, rtt } = ch.rtp;
  const line = [`loss in ${pct(lossPct(rx))} · out ${pct(lossPct(tx))}`, `jitter in ${ms(rx.jitter)} · out ${ms(tx.jitter)}`, rtt ? `RTT ${ms(rtt)}` : null].filter(Boolean).join(' · ');
  return h('div', { title: `Received: ${lossText(rx)}. Sent: ${lossText(tx)}.` }, h('div', {}, dot(q.kind), line),
    h('div', { title: 'Jitter over the last polls', className: 'ast-trend' }, sparkline([{ values: qos.get(ch.uniqueid || ch.channel) ?? [], cls: 'rx' }], { width: 110, height: 20 })));
}

// How the call of a channel is held, as the text of a badge: the audio stream turned off or one way, or the endpoint reporting On Hold.
const heldOf = (ch, pjsip) => ch.formats?.streams?.find(s => s.type === 'audio' && s.state && s.state !== 'sendrecv')?.state ?? (onHold(ch, pjsip) ? 'on hold' : null);

// One end of the diagram: the endpoint with what is known about it (who it is, where it is).
function endNode(leg, pjsip, trunks, lines) {
  const addr = peerAddresses(leg, pjsip);
  return h('div', { className: 'ast-cf-node' }, icon(trunks?.has(leg.endpoint) ? 'cloud' : 'telephone'),
    h('div', {}, h('div', { className: 'fw-semibold' }, leg.endpoint ?? leg.channel), lines.filter(Boolean).map(l => h('div', { className: 'small' }, l)),
      addr.length ? h('div', { className: 'muted small mono' }, addr.join(' · ')) : null));
}

// The media between an end and the bridge: the codec in use, a mark where Asterisk converts, and the quality.
function wire(leg, pjsip, live) {
  const codec = codecOf(leg), trans = transcodingOf(leg), q = qualityOf(leg.rtp), held = heldOf(leg, pjsip);
  return h('div', { className: 'ast-cf-wire' },
    h('div', { className: 'ast-cf-label' }, codec.text ? mono(codec.text) : muted('no codec'), trans.active ? [' ', transcodingBadge(leg, trans, Boolean(held))] : null),
    h('div', { className: `ast-wire ${held ? 'held' : live ? 'live' : ''}` }),
    h('div', { className: 'ast-cf-label muted small' }, q ? [dot(q.kind), `${q.jitter.toFixed(1)} ms jitter · ${pct(q.loss)} loss`] : 'no RTP statistics'));
}

// The middle of the diagram: the bridge, or for a channel in no bridge the application of Asterisk it talks to.
function middleNode(call, leg) {
  const bridge = call.bridge;
  if (call.legs.length > 1 || bridge) {
    return h('div', { className: 'ast-cf-node ast-cf-bridge', title: bridge ? BRIDGE_TEXT[bridge.technology] ?? '' : '' }, icon('diagram-2'),
      h('div', {}, h('div', { className: 'fw-semibold' }, 'Bridge'), bridge ? h('div', { className: 'small mono' }, bridge.technology) : null,
        bridge ? h('div', { className: 'muted small' }, `${bridge.channels} channel${bridge.channels === 1 ? '' : 's'} · up ${fmtSpan(bridge.duration)}`) : null));
  }
  const talking = leg.state === 'Up';
  return h('div', { className: 'ast-cf-node ast-cf-bridge', title: 'The channel is in no bridge: it is not connected to another party.' }, icon('router'),
    h('div', {}, h('div', { className: 'fw-semibold' }, 'Asterisk'), leg.app ? h('div', { className: 'small mono' }, leg.app) : null,
      h('div', { className: 'muted small' }, talking ? `${leg.exten ?? ''}@${leg.context ?? ''}` : 'not connected yet')));
}

// The line over a call's diagram and the diagram: direction, who calls whom, hold and a hangup that is near, then the path of the media.
function callBlock(call, pjsip, trunks, now) {
  const [a, b] = callerFirst(call);
  const dir = directionOfActive(call, trunks);
  const held = call.legs.some(l => heldOf(l, pjsip));
  const left = a.formats?.name ? `${a.formats.name} · ${a.callerid}` : a.callerid;
  const dialed = a.formats?.dnid;
  const remaining = Math.min(...call.legs.map(l => l.formats?.hangup_at != null && now != null ? l.formats.hangup_at - now : Infinity));
  const near = Number.isFinite(remaining) ? hangupKind(remaining) : null;
  const live = !held && call.legs.every(l => l.state === 'Up');
  const head = h('div', { className: 'ast-cf-head' },
    dir ? h('span', { className: `ast-dir ${dir}` }, icon(DIRECTION_ICON[dir]), ' ', DIRECTION_TEXT[dir]) : null,
    held ? badge('on hold', 'warning', HOLD_TEXT) : null,
    near ? badge(`hangs up in ${fmtSpan(Math.max(0, remaining))}`, near === 'danger' ? 'danger' : 'warning', 'The dialplan limits this call (TIMEOUT(absolute)): Asterisk hangs up by itself.') : null);
  const nodes = b
    ? [endNode(a, pjsip, trunks, [left && `from ${left}`]), wire(a, pjsip, live), middleNode(call, a), wire(b, pjsip, live), endNode(b, pjsip, trunks, [dialed && `dialed ${dialed}`])]
    : [endNode(a, pjsip, trunks, [left && `from ${left}`, dialed && `dialed ${dialed}`]), wire(a, pjsip, live), middleNode(call, a)];
  return h('tr', { className: 'ast-cf-row' }, h('td', { colSpan: 8 }, head, h('div', { className: 'ast-cf' }, nodes)));
}

// One channel of a call; the row opens the side panel.
function legRow(ch, call, pjsip, trunks, now) {
  const codec = codecOf(ch), trans = transcodingOf(ch), held = heldOf(ch, pjsip), f = ch.formats;
  const who = [f?.name, ch.callerid].filter(Boolean).join(' · ');
  // The negotiated codecs only when they say more than the codec in use: several of them, or one that is not the one in use (transcoding).
  const native = f?.native ?? [];
  const negotiated = native.length && !(native.length === 1 && native[0] === codec.text) ? native.join(', ') : null;
  const remaining = f?.hangup_at != null && now != null ? f.hangup_at - now : null;
  const open = () => openChannelDrawer(ch, call, pjsip, trunks, now);
  return h('tr', { className: 'ast-row', tabIndex: 0, title: 'Show everything about this channel', onclick: open, onkeydown: onActivate(open) },
    h('td', {}, h('div', { className: 'mono' }, ch.channel), who ? h('div', { className: 'muted small' }, who) : null, f?.dnid ? h('div', { className: 'muted small' }, `called ${f.dnid}`) : null),
    h('td', {}, badge(ch.state, ch.state === 'Up' ? 'success' : 'info'), held ? [' ', badge(held, 'warning', HOLD_TEXT)] : null),
    h('td', {}, ch.app ? h('span', { className: 'mono' }, ch.app) : muted('–'), ch.exten ? h('div', { className: 'muted small' }, `${ch.exten}@${ch.context}`) : null),
    h('td', { className: 'small' }, ch.allowed?.length ? ch.allowed.join(', ') : muted('–')),
    h('td', {}, codec.text ? h('span', { className: 'mono' }, codec.text) : muted('–'), ' ', trans.active ? transcodingBadge(ch, trans, Boolean(held)) : null,
      negotiated ? h('div', { className: 'muted small', title: 'The codecs both sides agreed on when the call was set up; the one in use is one of them, unless Asterisk converts.' }, `negotiated: ${negotiated}`) : null),
    h('td', { className: 'small' }, rtpCell(ch)),
    h('td', { className: 'text-nowrap' }, ch.duration != null && now != null ? stamp(now - ch.duration) : '–'),
    h('td', { className: 'text-nowrap' }, ch.duration != null ? fmtSpan(ch.duration) : '–',
      remaining != null ? h('div', { className: `small ${KIND_CLASS[hangupKind(remaining)] ?? 'muted'}`, title: 'The dialplan limits the call (TIMEOUT(absolute)): Asterisk hangs up by itself at that time.' },
        `hangs up ${stamp(f.hangup_at, now)} (in ${fmtSpan(Math.max(0, remaining))})`) : null));
}

// The tiles over all calls in progress.
function summaryTiles(calls, trunks, pjsip) {
  const s = summarizeActive(calls, trunks, pjsip);
  const dirs = [s.in && `${s.in} incoming`, s.out && `${s.out} outgoing`, s.internal && `${s.internal} internal`].filter(Boolean).join(' · ');
  const lossKind = s.loss >= 5 ? 'danger' : s.loss >= 1 ? 'warning' : 'success';
  const jitterKind = s.jitter >= 80 ? 'danger' : s.jitter >= 30 ? 'warning' : 'success';
  const measured = s.worst !== 'success' || s.loss > 0 || s.jitter > 0 || calls.some(c => c.legs.some(l => l.rtp));
  return tiles(
    tile('Calls now', String(s.calls), dirs || `${s.channels} channel${s.channels === 1 ? '' : 's'}`),
    tile('Transcoding', s.transcoding ? `${s.transcoding} channel${s.transcoding === 1 ? '' : 's'}` : 'none', s.between ? `${s.between} in a bridge` : s.transcoding ? 'menu or music on hold' : 'no conversion', s.between ? 'text-warning' : ''),
    tile('Worst loss', measured ? pct(s.loss) : '–', 'over all channels', measured ? KIND_CLASS[lossKind] : ''),
    tile('Worst jitter', measured ? `${s.jitter.toFixed(1)} ms` : '–', 'over all channels', measured ? KIND_CLASS[jitterKind] : ''),
    tile('On hold', String(s.held), s.held ? 'music on hold is playing' : 'none', s.held ? 'text-warning' : ''));
}

// The calls in progress (reply of `flab.asterisk active`), with the codecs of every channel. Null when it could not be read.
export function activeCard(a, pjsip) {
  if (!a) return null;
  const header = [icon('telephone'), 'Calls in progress'];
  if (!a.available) return card(header, h('div', { className: 'card-body muted' }, 'Asterisk is not running or does not answer, so its channels cannot be read.'));
  const calls = groupActive(a.channels, a.bridges);
  if (!calls.length) return card(header, h('div', { className: 'card-body muted' }, 'No call is in progress.'));
  const trunks = trunkNames(pjsip);
  const note = h('div', { className: 'muted small my-2' },
    `${calls.length} call${calls.length === 1 ? '' : 's'}, ${a.channels.length} channel${a.channels.length === 1 ? '' : 's'}. `,
    'Codecs, in the order they are decided: Our endpoint allows = what this router is configured to accept for the endpoint (its allow list, in our order of preference); Codec in use = the codec that is actually flowing, picked among those that both sides support (shown as negotiated under it when that adds something). The far side’s own list is not kept by Asterisk. Click a channel for everything known about it',
    a.truncated ? '; the codecs of the channels beyond the first ones are not read' : '', '.');
  return card(header, h('div', { className: 'card-body' }, summaryTiles(calls, trunks, pjsip), note,
    h('div', { className: 'table-responsive' }, h('table', { className: 'table ast-table ast-calls' },
      h('thead', {}, h('tr', {}, [['Channel'], ['State'], ['Doing'],
        ['Our endpoint allows', 'Step 1. The codecs the PJSIP endpoint of this channel is configured to accept (its allow option), in our order of preference. The far side can only pick from these; its own list is not shown because Asterisk does not keep it after negotiating.'],
        ['Codec in use', 'Step 2. What Asterisk reads from and writes to the channel at this moment, chosen among the codecs both sides support (agreed when the call was set up). The agreed codecs are listed under it when they say more than the codec in use. When the audio Asterisk has is in another format, it converts it (transcoding).'],
        ['RTP'], ['Started'], ['Duration']].map(([t, tip]) => h('th', { title: tip ?? '' }, t)))),
      calls.map(call => h('tbody', {}, callBlock(call, pjsip, trunks, a.now), callerFirst(call).map(ch => legRow(ch, call, pjsip, trunks, a.now))))))));
}

// The side panel of one channel: its identity, the parties, the far end, the codecs, the RTP numbers, the bridge and the timing.
function openChannelDrawer(ch, call, pjsip, trunks, now) {
  const f = ch.formats ?? {}, q = qualityOf(ch.rtp), bridge = call.bridge, ep = endpointOf(ch, pjsip), addr = peerAddresses(ch, pjsip);
  const dir = directionOfActive(call, trunks), held = heldOf(ch, pjsip), trans = transcodingOf(ch), codec = codecOf(ch);
  const list = xs => xs?.length ? mono(xs.join(', ')) : muted('–');
  const text = v => v ? mono(String(v)) : muted('–');
  const side = (label, s) => s ? [label, `${s.packets} packets · ${s.lost} lost (${pct(lossPct(s))}) · jitter ${ms(s.jitter)}`] : null;
  const remaining = f.hangup_at != null && now != null ? f.hangup_at - now : null;
  const body = h('div', { className: 'ast-drawer' },
    h('div', { className: 'mb-3 d-flex flex-wrap gap-2 align-items-center' }, badge(ch.state, ch.state === 'Up' ? 'success' : 'info'),
      dir ? h('span', { className: `ast-dir ${dir}` }, icon(DIRECTION_ICON[dir]), ' ', DIRECTION_TEXT[dir]) : null, held ? badge(held, 'warning', HOLD_TEXT) : null,
      trans.active ? transcodingBadge(ch, trans, Boolean(held)) : null, q ? badge(`quality ${q.kind === 'success' ? 'good' : q.kind === 'warning' ? 'fair' : 'poor'}`, q.kind) : null),
    section('Channel', kv([['Channel', text(ch.channel)], ['Unique id', text(ch.uniqueid)], ['Linked id', text(f.linked)], ['Call identifier', text(f.identifier)],
      ['Doing', ch.app ? text(ch.app) : muted('–')], ['Dialplan position', ch.context ? text(`${ch.context},${ch.exten || 's'},${ch.priority}`) : muted('–')]])),
    section('Parties', kv([['Caller', text([f.name, ch.callerid].filter(Boolean).join(' · '))], ['Number dialed', text(f.dnid)]])),
    section('Far end', kv([['Endpoint', text(ch.endpoint)], ['Kind', ep ? text(ep.role === 'trunk' ? 'trunk' : ep.role === 'phone' ? 'phone' : ep.role) : muted('–')],
      ['State', ep ? text(ep.state) : muted('–')], ['Address', addr.length ? text(addr.join(' · ')) : muted('not known')]])),
    section('Codecs', kv([['Our endpoint allows', list(ch.allowed)], ['Negotiated', list(f.native)], ['Read (from the far end)', text(f.read)], ['Write (to the far end)', text(f.write)],
      ['Converted on read', f.read_transcode ? text(f.read_transcode === true ? 'yes' : f.read_transcode) : text('no')], ['Converted on write', f.write_transcode ? text(f.write_transcode === true ? 'yes' : f.write_transcode) : text('no')],
      ['In use', text(codec.text)]].concat((f.streams ?? []).map(s => [`Stream ${s.name}`, text(`${s.type} · ${s.state}${s.formats?.length ? ` · ${s.formats.join(', ')}` : ''}`)])))),
    ch.rtp ? section('RTP', kv([['Codec', text(ch.rtp.codec)], ['Up for', text(ch.rtp.uptime)], side('Received', ch.rtp.rx), side('Sent', ch.rtp.tx),
      ['Round trip', ch.rtp.rtt ? text(ms(ch.rtp.rtt)) : muted('not reported by the far end (no RTCP)')]])) : null,
    section('Bridge', bridge ? kv([['Bridge', text(bridge.id)], ['Technology', text(bridge.technology)], ['Type', text(bridge.type)], ['Channels', text(bridge.channels)], ['Up for', text(fmtSpan(bridge.duration))],
      ['Media', h('span', { className: 'small' }, BRIDGE_TEXT[bridge.technology] ?? '–')]]) : h('div', { className: 'muted small' }, 'The channel is in no bridge: it is not connected to another party.')),
    section('Timing', kv([['Started', text(now != null && ch.duration != null ? stamp(now - ch.duration) : null)], ['Duration', text(ch.duration != null ? fmtSpan(ch.duration) : null)],
      f.hangup_at != null ? ['Hangs up by itself', text(`${stamp(f.hangup_at, now)}${remaining != null ? ` (in ${fmtSpan(Math.max(0, remaining))})` : ''}`)] : null])));
  openDrawer({ title: ch.channel, subtitle: `${DIRECTION_TEXT[dir] ?? 'Call'} · ${ch.app ?? ''}`.replace(/ · $/, ''), icon: icon('telephone'), body });
}
