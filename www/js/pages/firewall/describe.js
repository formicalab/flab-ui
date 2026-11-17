// What a zone, a rule, a port forward or a forwarding does, in plain words, for the tables, the dialogs and the review list. Pure functions of
// the form values (see edit.js), so they are unit-tested on their own.

// A zone reference in a sentence: "*" is any zone.
const zoneWord = z => (z === '*' ? 'any zone' : `zone ${z}`);

// A list of words as "a, b and c".
export function andList(words) {
  if (words.length < 2) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

// The protocols of a rule in words; an empty list means TCP and UDP (the firewall's default).
function protoWords(protos) {
  if (!protos.length) return 'TCP and UDP';
  if (protos.some(p => ['all', 'any', '*'].includes(p.toLowerCase()))) return 'every protocol';
  return andList(protos.map(p => ({ icmpv6: 'ICMPv6', 'ipv6-icmp': 'ICMPv6' })[p.toLowerCase()] ?? p.toUpperCase()));
}

// "port 22", "ports 80 and 443", "ports 6666-6670": the ports of a list or a single value with the words around them.
function portPhrase(ports) {
  const list = [].concat(ports).map(p => String(p).trim()).filter(Boolean).map(p => p.replace(':', '-'));
  return list.length ? `${list.length === 1 && !list[0].includes('-') ? 'port' : 'ports'} ${andList(list)}` : '';
}

// The address filter of a rule: "from 10.0.0.0/24", "to 192.168.1.10".
const addressPhrase = (word, list) => {
  const l = [].concat(list).map(a => String(a).trim()).filter(Boolean);
  return l.length ? `${word} ${l.map(a => (a.startsWith('!') ? `anything but ${a.slice(1).trim()}` : a)).join(', ')}` : '';
};

// The family restriction in words, or ''.
const familyWords = f => (f === 'ipv4' ? 'IPv4 only' : f === 'ipv6' ? 'IPv6 only' : '');

// The schedule of a rule in words, or ''.
export function scheduleWords(v) {
  const parts = [];
  if (v.weekdays?.trim()) {
    const inverted = v.weekdays.trim().startsWith('!');
    const days = v.weekdays.replace(/^\s*!/, '').trim().split(/\s+/).filter(Boolean);
    parts.push(inverted ? `every day except ${andList(days)}` : `on ${andList(days)}`);
  }
  if (v.start_time?.trim() || v.stop_time?.trim()) parts.push(`${v.start_time?.trim() ? `from ${v.start_time.trim()}` : ''}${v.start_time?.trim() && v.stop_time?.trim() ? ' ' : ''}${v.stop_time?.trim() ? `until ${v.stop_time.trim()}` : ''}`);
  if (v.start_date?.trim() || v.stop_date?.trim()) parts.push(`${v.start_date?.trim() ? `from ${v.start_date.trim()}` : ''}${v.start_date?.trim() && v.stop_date?.trim() ? ' ' : ''}${v.stop_date?.trim() ? `until ${v.stop_date.trim()}` : ''}`);
  return parts.length ? `${parts.join(', ')}${v.utc_time ? ' (UTC)' : ''}` : '';
}

// The verb of each rule target.
const VERBS = { ACCEPT: 'Allows', REJECT: 'Rejects', DROP: 'Silently drops', MARK: 'Marks', NOTRACK: 'Exempts from connection tracking' };

// One sentence about a traffic rule, from its form values: "Allows TCP port 22 from zone lan to the router itself, IPv4 only."
export function ruleWords(v) {
  const protos = v.proto ?? [];
  const icmp = protos.some(p => /^(icmp|icmpv6|ipv6-icmp)$/i.test(p));
  const icmpTypes = icmp && v.icmp_type?.length ? andList(v.icmp_type) : '';
  const ports = portPhrase(v.dest_port ?? []);
  const what = `${protoWords(protos)}${ports ? ` ${ports}` : icmpTypes ? ` ${icmpTypes}` : ' traffic'}`;
  const srcPorts = portPhrase(v.src_port ?? []);
  let where;
  if (v.src && v.dest) where = `from ${zoneWord(v.src)} to ${zoneWord(v.dest)} (forwarded through the router)`;
  else if (v.src) where = `from ${zoneWord(v.src)} to the router itself`;
  else if (v.dest) where = `from the router itself to ${zoneWord(v.dest)}`;
  else where = 'from the router itself';
  const extras = [
    addressPhrase('from', v.src_ip ?? []), srcPorts ? `from ${srcPorts}` : '', (v.src_mac ?? []).length ? `from MAC ${v.src_mac.join(', ')}` : '',
    addressPhrase('to', v.dest_ip ?? []),
    v.limit?.trim() ? `at most ${v.limit.trim()}` : '', scheduleWords(v), familyWords(v.family),
  ].filter(Boolean);
  const off = v.enabled === false ? ' (the rule is disabled)' : '';
  return `${VERBS[v.target] ?? `Applies ${v.target} to`} ${what} ${where}${extras.length ? `, ${extras.join(', ')}` : ''}.${off}`;
}

// One sentence about a port forward or a source NAT, from its form values.
export function redirectWords(v) {
  const protos = protoWords(v.proto ?? []);
  const off = v.enabled === false ? ' (disabled)' : '';
  if (v.target === 'SNAT') {
    const from = [addressPhrase('from', v.src_ip), v.src ? `in ${zoneWord(v.src)}` : ''].filter(Boolean).join(' ');
    const to = [addressPhrase('to', v.dest_ip), portPhrase(v.dest_port)].filter(Boolean).join(' ');
    return `Rewrites the source address of ${protos} traffic${from ? ` ${from}` : ''} leaving through ${zoneWord(v.dest || '?')}${to ? ` ${to}` : ''} to ${v.src_dip?.trim() || '?'}${v.src_dport?.trim() ? `, source ports ${v.src_dport.trim()}` : ''}.${off}`;
  }
  const arrives = [portPhrase(v.src_dport), v.src_dip?.trim() ? `at ${v.src_dip.trim()}` : '', v.src_ip?.trim() ? `from ${v.src_ip.trim()}` : ''].filter(Boolean).join(' ');
  const target = v.dest_ip?.trim() ? `${v.dest_ip.trim()}${v.dest_port?.trim() ? ` port ${v.dest_port.trim().replace(':', '-')}` : ''}${v.dest ? ` in ${zoneWord(v.dest)}` : ''}` : `port ${v.dest_port?.trim() || v.src_dport?.trim() || '?'} of the router itself`;
  return `Forwards ${protos} ${arrives || 'traffic'} arriving from ${zoneWord(v.src || '?')} to ${target}.${v.reflection === false ? '' : ' Hosts inside reach it through the router\'s address as well.'}${off}`;
}

// A forwarding in words: "Lets zone lan send traffic to zone wan".
export const forwardingWords = v => `Lets ${zoneWord(v.src || '?')} send traffic to ${zoneWord(v.dest || '?')}${familyWords(v.family) ? ` (${familyWords(v.family)})` : ''}`;

// A zone in one line for the review list: its policies and what it holds.
export function zoneLine(v) {
  const holds = [...v.network, ...v.device, ...v.subnet];
  return `input ${v.input || 'default'}, output ${v.output || 'default'}, forward ${v.forward || 'default'}${v.masq ? ', NAT' : ''}${holds.length ? ` · ${holds.join(', ')}` : ''}`;
}
