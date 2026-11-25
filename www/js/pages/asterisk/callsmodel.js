// Pure model of the Calls tab: the call history of cdr_csv (reply of `flab.asterisk calls`), grouped into calls, classified as incoming,
// outgoing or internal, filtered and summed up. No DOM, no ubus.

// Disposition of a CDR -> [word, badge kind, group]. The group is what the summary counts: answered, missed (nobody picked up or it was busy)
// or failed (the network or the dialplan could not place it).
const RESULTS = {
  ANSWERED: ['Answered', 'success', 'answered'],
  'NO ANSWER': ['Missed', 'warning', 'missed'],
  BUSY: ['Busy', 'warning', 'missed'],
  FAILED: ['Failed', 'danger', 'failed'],
  CONGESTION: ['Congestion', 'danger', 'failed'],
};

export const DIRECTION_TEXT = { in: 'Incoming', out: 'Outgoing', internal: 'Internal' };

// The word, badge kind and group of a disposition; an unknown one is shown as it is.
export const resultOf = disposition => RESULTS[disposition] ?? [disposition || '–', '', 'failed'];

// "Name" <number> -> { name, number } (the name is empty for an unnamed caller: Asterisk writes `"" <>`).
export function splitClid(clid) {
  const m = /^"?(.*?)"?\s*<([^>]*)>$/.exec((clid ?? '').trim());
  return m ? { name: m[1].replace(/""/g, '"'), number: m[2] } : { name: '', number: (clid ?? '').trim() };
}

// The calls of the history: the legs that share a linked id are one call (a Local channel makes two); the leg that names the called
// channel stands for it, else the first. Newest first. `legs` says how many CDR lines it was.
export function groupCalls(entries) {
  const byLink = new Map();
  for (const e of entries ?? []) {
    const list = byLink.get(e.linked) ?? [];
    list.push(e);
    byLink.set(e.linked, list);
  }
  return [...byLink.values()]
    .map(list => ({ ...(list.find(e => e.dstchannel) ?? list[0]), did: list.find(e => e.did)?.did ?? null, legs: list.length }))
    .sort((a, b) => b.start - a.start);
}

// incoming | outgoing | internal for a call, from the names of the trunk endpoints (a Set); null when they are not known.
export function directionOf(call, trunks) {
  if (!trunks) return null;
  if (call.from_endpoint && trunks.has(call.from_endpoint)) return 'in';
  if (call.to_endpoint && trunks.has(call.to_endpoint)) return 'out';
  return 'internal';
}

// Who called and who was called, as short texts: the number (with the name when there is one) and the endpoint that carried it.
export function partiesOf(call) {
  const clid = splitClid(call.clid);
  const number = call.src || clid.number || call.from_endpoint || '–';
  return {
    from: number, fromName: clid.name && clid.name !== number ? clid.name : '', fromVia: call.from_endpoint && call.from_endpoint !== number ? call.from_endpoint : '',
    to: call.did || (call.dst && call.dst !== 's' ? call.dst : (call.to_endpoint ?? '–')), toVia: call.to_endpoint && call.to_endpoint !== (call.did || call.dst) ? call.to_endpoint : '',
  };
}

// The filter: `kind` is all | in | out | internal (see directionOf) | missed (the Missed group, in any direction), `q` words that must all appear
// in the numbers, name or endpoints. `trunks` as for directionOf().
export function filterCalls(calls, trunks, kind = 'all', q = '') {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return calls.filter(c => {
    if (kind === 'missed') { if (resultOf(c.disposition)[2] !== 'missed') return false; }
    else if (kind !== 'all' && directionOf(c, trunks) !== kind) return false;
    if (!words.length) return true;
    const hay = [c.src, c.dst, c.did, c.clid, c.from_endpoint, c.to_endpoint, c.disposition].filter(Boolean).join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

// Counts for the line over the table: calls, by group, and the total talk time (billable seconds) in seconds.
export function summarize(calls) {
  const s = { calls: calls.length, answered: 0, missed: 0, failed: 0, talk: 0 };
  for (const c of calls) {
    s[resultOf(c.disposition)[2]]++;
    s.talk += c.billsec ?? 0;
  }
  return s;
}

// The calls in progress (reply of `flab.asterisk active`): the channels that share a bridge id are the sides of one call, a channel in no bridge
// yet (dialing, ringing) is a call of its own. Longest running first; each call has `legs` (its channels, longest running first), `duration` and
// `bridge` (what `bridges` of the reply says about its bridge, or null).
export function groupActive(channels, bridges = []) {
  const calls = new Map();
  for (const c of channels ?? []) {
    const key = c.bridge || `channel:${c.uniqueid || c.channel}`;
    if (!calls.has(key)) calls.set(key, { id: key, legs: [] });
    calls.get(key).legs.push(c);
  }
  return [...calls.values()]
    .map(call => {
      const legs = call.legs.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
      return { ...call, legs, duration: legs[0]?.duration ?? null, bridge: (bridges ?? []).find(b => b.id === call.id) ?? null };
    })
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
}

// What a bridge technology means for the media of the call.
export const BRIDGE_TEXT = {
  simple_bridge: 'The audio passes through Asterisk, which can convert, mix or record it.',
  native_rtp: 'Asterisk is out of the media path: the two sides exchange the audio directly (RTP bridging), so there is no conversion.',
  holding_bridge: 'The channel is parked on hold.',
};

// The codec a channel carries, from what Asterisk reads from and writes to it: { text, differs }. The two are normally one codec ("ulaw"); when
// they differ the text says which direction is which. The RTP codec of the statistics is the fallback when the channel detail is missing.
export function codecOf(channel) {
  const read = channel.formats?.read ?? null, write = channel.formats?.write ?? null;
  if (read && write && read !== write) return { text: `in ${read} · out ${write}`, differs: true };
  const one = read ?? write ?? channel.rtp?.codec ?? null;
  return { text: one, differs: false };
}

// Whether Asterisk converts the audio of a channel between codecs (the call costs CPU and quality), and how ("alaw@8000->slin@8000" when it says).
export function transcodingOf(channel) {
  const f = channel.formats;
  const paths = [f?.read_transcode, f?.write_transcode].filter(x => x);
  return { active: paths.length > 0, detail: paths.filter(x => typeof x === 'string').join(' · ') };
}

// Loss of one RTP direction as text ("0 of 1259 lost (0.0%)"); null without numbers.
export function lossText(side) {
  return side ? `${side.lost} of ${side.packets} lost (${side.loss_pct}%)` : null;
}

// ── calls in progress: the far end, direction, quality, hold ──

// The names of the trunk endpoints (a Set), or null when PJSIP could not be read (then the direction is unknown).
export const trunkNames = pjsip => pjsip?.available ? new Set(pjsip.endpoints.filter(e => e.role === 'trunk').map(e => e.name)) : null;

// The host part of a SIP URI: "sip:1001@192.168.1.50:5060;ob" -> "192.168.1.50:5060" (the user part and the parameters are dropped); null when it is no URI.
export function uriHost(uri) {
  const m = /^sips?:(?:[^@]*@)?([^;>]+)/.exec(uri ?? '');
  return m ? m[1] : null;
}

// The PJSIP endpoint of a channel in the reply of `flab.asterisk pjsip` (null when PJSIP could not be read or the channel is not PJSIP).
export const endpointOf = (channel, pjsip) => pjsip?.available ? pjsip.endpoints.find(e => e.name === channel.endpoint) ?? null : null;

// Where the far end of a channel is, as far as the PJSIP reply knows: the hosts of the contacts of its endpoint (a phone's address, a provider's
// name) then the addresses that identify the endpoint (a provider's servers); no more than three, none for a channel that is not PJSIP.
export function peerAddresses(channel, pjsip) {
  const ep = endpointOf(channel, pjsip);
  if (!ep) return [];
  const hosts = (ep.contacts ?? []).map(c => uriHost(c.uri)).filter(Boolean);
  const matches = (ep.identifies ?? []).flatMap(i => i.matches ?? []);
  return [...new Set([...hosts, ...matches])].slice(0, 3);
}

// Whether the call of a channel is on hold: its endpoint reports "On Hold" and has this channel only (with more channels it cannot be told which).
export function onHold(channel, pjsip) {
  const ep = endpointOf(channel, pjsip);
  return ep?.state === 'On Hold' && ep.channels === 1;
}

// The channels of a call with the one that started it first: the caller runs the dialplan, the called side is shown as AppDial.
export const callerFirst = call => [...call.legs].sort((a, b) => (a.app === 'AppDial') - (b.app === 'AppDial'));

// incoming | outgoing | internal for a call in progress, from the names of the trunk endpoints (a Set; null when they are not known): a trunk channel that
// runs the dialplan received the call, one shown as AppDial was dialed by us.
export function directionOfActive(call, trunks) {
  if (!trunks) return null;
  const trunk = call.legs.find(l => trunks.has(l.endpoint));
  if (!trunk) return 'internal';
  return trunk.app === 'AppDial' ? 'out' : 'in';
}

// Lost packets of one RTP direction in percent (the integer of the CLI hides a loss below 1%).
export const lossPct = side => side && side.packets > 0 ? side.lost / side.packets * 100 : 0;

// The quality of a channel's RTP: { kind, loss, jitter, rtt } with loss in %, jitter and round trip in ms, and kind success | warning | danger by
// the worst of them (loss 1% / 5%, jitter 30 / 80 ms, round trip 150 / 300 ms). Null without statistics.
export function qualityOf(rtp) {
  if (!rtp) return null;
  const loss = Math.max(lossPct(rtp.rx), lossPct(rtp.tx));
  const jitter = Math.max(rtp.rx.jitter, rtp.tx.jitter) * 1000;
  const rtt = (rtp.rtt ?? 0) * 1000;
  const kind = loss >= 5 || jitter >= 80 || rtt >= 300 ? 'danger' : loss >= 1 || jitter >= 30 || rtt >= 150 ? 'warning' : 'success';
  return { kind, loss, jitter, rtt };
}

// Jitter history (ms) per channel, filled on every poll of the Calls tab; channels that are gone are dropped.
export function recordActive(history, active, max = 30) {
  const live = new Set();
  for (const c of active?.available ? active.channels : []) {
    const q = qualityOf(c.rtp);
    if (!q) continue;
    const key = c.uniqueid || c.channel;
    live.add(key);
    const list = history.get(key) ?? [];
    list.push(q.jitter);
    if (list.length > max) list.shift();
    history.set(key, list);
  }
  for (const key of [...history.keys()]) if (!live.has(key)) history.delete(key);
  return history;
}

// How urgent the automatic hangup of a call is, from the seconds left: danger within 15 s, warning within a minute, else null.
export const hangupKind = remaining => remaining == null ? null : remaining <= 15 ? 'danger' : remaining <= 60 ? 'warning' : null;

// The numbers of the tiles over the calls in progress: calls and channels, by direction, the channels that convert (and those of them between the
// two sides of a call), the worst loss and jitter over all channels and how many calls are on hold. `trunks` as for directionOf().
export function summarizeActive(calls, trunks, pjsip) {
  const s = { calls: calls.length, channels: 0, in: 0, out: 0, internal: 0, transcoding: 0, between: 0, held: 0, loss: 0, jitter: 0, worst: 'success' };
  const rank = { success: 0, warning: 1, danger: 2 };
  for (const call of calls) {
    const dir = directionOfActive(call, trunks);
    if (dir) s[dir]++;
    if (call.legs.some(l => onHold(l, pjsip))) s.held++;
    for (const ch of call.legs) {
      s.channels++;
      if (transcodingOf(ch).active) {
        s.transcoding++;
        if (ch.bridge) s.between++;
      }
      const q = qualityOf(ch.rtp);
      if (!q) continue;
      s.loss = Math.max(s.loss, q.loss);
      s.jitter = Math.max(s.jitter, q.jitter);
      if (rank[q.kind] > rank[s.worst]) s.worst = q.kind;
    }
  }
  return s;
}
const two = n => String(n).padStart(2, '0');

// A moment (epoch seconds) in the browser's time zone as "2026-11-25 13:02:10"; with `relativeTo` (epoch seconds) a moment on the same day is just
// "13:02:10". Empty for no moment.
export function stamp(epoch, relativeTo = null) {
  if (epoch == null) return '';
  const d = new Date(epoch * 1000), time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  const day = x => `${x.getFullYear()}-${two(x.getMonth() + 1)}-${two(x.getDate())}`;
  return relativeTo != null && day(d) === day(new Date(relativeTo * 1000)) ? time : `${day(d)} ${time}`;
}