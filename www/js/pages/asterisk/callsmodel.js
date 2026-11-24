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

// How long ago, in words: "just now", "5 min ago", "3 h ago", "2 d ago".
export function ago(epoch, now) {
  const s = Math.max(0, Math.round(now - epoch));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
