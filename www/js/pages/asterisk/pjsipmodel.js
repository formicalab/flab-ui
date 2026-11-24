// Pure model of the PJSIP tab and the Overview: state colors, the filter, contact round-trip history and countdown texts.
// The data is the reply of `flab.asterisk pjsip` ({ endpoints, registrations, transports, channels }) and `flab.asterisk status`.

// Badge kind of an endpoint's device state. An unreachable trunk is an error; an unreachable phone is only a warning (it may be switched off).
export function endpointKind(e) {
  switch (e.state) {
    case 'Not in use': return 'success';
    case 'In use': case 'Ringing': case 'Ring+Inuse': case 'On Hold': return 'info';
    case 'Busy': return 'warning';
    case 'Unavailable': return e.role === 'trunk' ? 'danger' : 'warning';
    case 'Invalid': return 'danger';
    default: return '';
  }
}

// Badge kind of an outbound registration's status (Registered, Unregistered, Rejected, Stopped, ...).
export function registrationKind(status) {
  if (status === 'Registered') return 'success';
  if (status === 'Rejected') return 'danger';
  if (status === 'Unregistered') return 'warning';
  return '';
}

// Badge kind of a contact's status (Avail, Unavail, Unknown, NonQual, Created, Removed).
export function contactKind(status) {
  if (status === 'Avail') return 'success';
  if (status === 'Unavail') return 'danger';
  return '';
}

// Words for a contact status.
export const CONTACT_TEXT = { Avail: 'reachable', Unavail: 'unreachable', Unknown: 'not checked', NonQual: 'not monitored', Created: 'new', Removed: 'removed' };

// Words for what an endpoint is.
export const ROLE_TEXT = { trunk: 'Trunk', phone: 'Phone', other: 'Endpoint' };

// Seconds as a short countdown: "in 12 min", "in 1 h 5 min", "in 45 s"; null for no value.
export function countdown(seconds) {
  if (seconds == null) return null;
  if (seconds < 60) return `in ${seconds} s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return m ? `in ${h} h ${m} min` : `in ${h} h`;
}

// Round-trip time in ms: "53 ms", "0.4 ms"; "–" for none.
export function fmtRtt(ms) {
  if (ms == null) return '–';
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

// The contacts of every endpoint as a flat list [{ endpoint, aor, uri, hash, status, rtt }].
export function allContacts(pjsip) {
  return (pjsip?.endpoints ?? []).flatMap(e => e.contacts.map(c => ({ endpoint: e.name, ...c })));
}

// Whether an endpoint matches the search text (every word, in the name, role, state, context, codecs, auths, contacts or identify
// criteria) and the role filter ('all' | 'trunk' | 'phone').
export function matchesEndpoint(e, q, role = 'all') {
  if (role !== 'all' && e.role !== role) return false;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [
    e.name, e.role, e.state, e.context, e.registration, ...(e.codecs ?? []), ...e.auths.map(a => a.username),
    ...e.contacts.map(c => c.uri), ...e.identifies.flatMap(i => i.matches), e.transport?.name,
  ].filter(Boolean).join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
}

// What to look at on an endpoint: [{ level: 'warn' | 'info', text }].
export function endpointNotes(e) {
  const notes = [];
  if (e.role === 'phone' && e.state === 'Unavailable') {
    notes.push({ level: 'warn', text: e.contacts.length
      ? 'The device registered, but none of its contacts answers the periodic check: calls to it fail until it is reachable again.'
      : 'No contact is registered: calls to this phone fail until a device registers.' });
  }
  if (e.role === 'trunk' && e.registration == null && !e.contacts.length) notes.push({ level: 'warn', text: 'No contact: the provider is not reachable.' });
  if (e.role === 'trunk' && e.contacts.some(c => c.status === 'Unavail')) notes.push({ level: 'warn', text: 'The provider’s contact does not answer the periodic check.' });
  if (!e.context) notes.push({ level: 'info', text: 'No context is known: the page did not read this endpoint’s settings.' });
  if (e.settings?.media_encryption === 'no' && e.role === 'trunk') notes.push({ level: 'info', text: 'Media is not encrypted (normal for an Italian VoIP line over UDP).' });
  return notes;
}

// Keeps the last `max` round-trip times of every contact between polls: `history` is a Map key -> number[] that the caller keeps, and a
// contact that is gone loses its history. Returns the same map.
export function recordRtt(history, pjsip, max = 30) {
  const live = new Set();
  for (const c of allContacts(pjsip)) {
    const key = `${c.endpoint}|${c.hash}`;
    live.add(key);
    if (c.rtt == null) continue;
    const list = history.get(key) ?? [];
    list.push(c.rtt);
    if (list.length > max) list.shift();
    history.set(key, list);
  }
  for (const key of [...history.keys()]) if (!live.has(key)) history.delete(key);
  return history;
}

// The settings of an endpoint that the drawer groups, as [group, [[label, key]]]: what the CLI calls them in pjsip.conf.
export const ENDPOINT_GROUPS = [
  ['Identity', [['Context', 'context'], ['AORs', 'aors'], ['Authentication', 'auth'], ['Outbound authentication', 'outbound_auth'], ['Identified by', 'identify_by'], ['Caller ID', 'callerid'], ['From user', 'from_user'], ['From domain', 'from_domain'], ['Contact user', 'contact_user']]],
  ['Media', [['Allowed codecs', 'allow'], ['Disallowed', 'disallow'], ['DTMF mode', 'dtmf_mode'], ['Direct media', 'direct_media'], ['RTP symmetric', 'rtp_symmetric'], ['Force rport', 'force_rport'], ['ICE', 'ice_support'], ['Encryption', 'media_encryption'], ['RTP timeout', 'rtp_timeout']]],
  ['Network', [['Transport', 'transport'], ['Outbound proxy', 'outbound_proxy'], ['Rewrite contact', 'rewrite_contact'], ['Session timers', 'timers']]],
  ['Access control', [['ACL', 'acl'], ['Contact ACL', 'contact_acl']]],
];
