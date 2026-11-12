// Shared helpers of the Firewall page: live rates from the nft counters, human descriptions of rules, and the
// findings (what looks wrong). Pure data in, plain values out, apart from the rate tracker.
import { createTracker, latest } from '../../core/rates.js';
import { fmtNum } from '../../core/format.js';

// Module-level so rate history survives the redraw on every poll. Series keys: rule/<kind>/<key>,
// zone/<name>/from and zone/<name>/to (packets and bytes of the zone's reject/drop counters).
const tracker = createTracker();

// Stable key of a rule or port forward: the same one under which recordFirewall stores its counters.
export const ruleKey = r => `rule/${r.kind ?? 'rule'}/${r.key}`;

// Feeds one poll into the tracker and drops series of rules and zones that disappeared.
export function recordFirewall(fw) {
  const seen = new Set();
  // Records one counter sample and marks its key as still present.
  const put = (key, packets, bytes) => { seen.add(key); tracker.record(key, { packets, bytes }); };
  for (const r of [...fw.rules, ...fw.redirects]) if (r.hits) put(ruleKey(r), r.hits.packets, r.hits.bytes);
  for (const z of fw.zones) {
    if (z.blocked_from) put(`zone/${z.name}/from`, z.blocked_from.packets, z.blocked_from.bytes);
    if (z.blocked_to) put(`zone/${z.name}/to`, z.blocked_to.packets, z.blocked_to.bytes);
  }
  tracker.keep(seen);
}

// Latest packets/s of a series, or null while it has fewer than two samples.
export const packetsPerSec = key => latest(tracker.rates(key, 'packets'));

// "3.2 pkt/s" (one decimal below 10); null when idle (< 0.05 pkt/s) or unknown, so callers can hide it.
export const fmtPps = v => v == null || v < 0.05 ? null : `${v < 10 ? v.toFixed(1) : Math.round(v)} pkt/s`;

// Zones that face the Internet: the ones that masquerade (NAT) outgoing traffic.
export const wanZones = fw => fw.zones.filter(z => z.masq);

// Upper-cases a list of protocol names.
const upper = a => a.map(p => p.toUpperCase());

// "UDP 500, 4500", "ICMP echo-request, echo-reply", "ESP", "TCP 3128 from 192.168.100.0/24".
export function describeMatch(r) {
  const proto = r.proto.length ? r.proto : ['tcp', 'udp'];
  const isIcmp = proto.some(p => /^icmp/.test(p));
  let what = upper(proto).join('/');
  if (r.dest_port?.length) what += ` ${r.dest_port.join(', ')}`;
  if (isIcmp && r.icmp_type?.length) what += ` ${r.icmp_type.length > 3 ? `${r.icmp_type.length} message types` : r.icmp_type.join(', ')}`;
  if (r.src_ip?.length) what += ` from ${r.src_ip.join(', ')}`;
  if (r.dest_ip?.length) what += ` to ${[].concat(r.dest_ip).join(', ')}`;
  if (r.limit) what += ` (limited to ${r.limit})`;
  if (r.family && r.family !== 'any') what += ` · ${r.family.replace('ipv', 'IPv')} only`;
  return what;
}

// Whether a rule lets everything through (no protocol or port restriction beyond tcp/udp) from any address.
const isOpen = r => !r.src_ip.length && !r.dest_port.length && !r.icmp_type.length
  && (!r.proto.length || r.proto.includes('all') || r.proto.includes('tcp') || r.proto.includes('udp'));

// What looks wrong in the firewall, as { level, text }: not loaded, an Internet-facing zone accepting input
// or forwarding, rules open to the whole Internet, references to missing zones, empty or unzoned
// interfaces, SYN-flood protection off, disabled rules, and conntrack above 80 % of its limit.
export function findings(fw) {
  if (!fw.running) return [{ level: 'bad', text: 'The firewall is not loaded: nftables has no fw4 table, so nothing is being filtered.' }];
  const out = [];
  const names = new Set(fw.zones.map(z => z.name));

  for (const z of wanZones(fw)) {
    if (z.input === 'ACCEPT') out.push({ level: 'bad', text: `Zone ${z.name} faces the Internet (NAT) but accepts all traffic to the router.` });
    if (z.forward === 'ACCEPT') out.push({ level: 'warn', text: `Zone ${z.name} faces the Internet (NAT) and forwards traffic between its own interfaces.` });
  }
  for (const r of fw.rules) {
    if (!r.enabled) continue;
    for (const side of [r.src, r.dest]) if (side && side !== '*' && !names.has(side)) out.push({ level: 'warn', text: `Rule ${r.name ?? r.key} refers to zone "${side}", which does not exist.` });
    const from = fw.zones.find(z => z.name === r.src);
    if (from?.masq && r.target === 'ACCEPT' && isOpen(r)) out.push({ level: 'warn', text: `Rule ${r.name ?? r.key} accepts every TCP/UDP port from ${from.name}, the zone facing the Internet.` });
  }
  for (const r of fw.redirects) {
    if (!r.enabled) continue;
    for (const side of [r.src, r.dest]) if (side && side !== '*' && !names.has(side)) out.push({ level: 'warn', text: `Port forward ${r.name ?? r.key} refers to zone "${side}", which does not exist.` });
  }
  for (const z of fw.zones) if (z.enabled && !z.networks.length && !z.devices.length) out.push({ level: 'info', text: `Zone ${z.name} contains no interface.` });
  if (fw.unzoned.length) out.push({ level: 'warn', text: `Interface${fw.unzoned.length === 1 ? '' : 's'} ${fw.unzoned.join(', ')} ${fw.unzoned.length === 1 ? 'is' : 'are'} in no firewall zone, so its traffic is rejected.` });
  if (wanZones(fw).length && !fw.defaults.synflood_protect) out.push({ level: 'info', text: 'SYN-flood protection is off.' });
  const off = [...fw.rules, ...fw.redirects].filter(r => !r.enabled);
  if (off.length) out.push({ level: 'info', text: `${off.length} rule${off.length === 1 ? ' is' : 's are'} disabled: ${off.map(r => r.name ?? r.key).join(', ')}.` });
  const { count, max } = fw.conntrack;
  if (count != null && max && count / max > 0.8) out.push({ level: 'warn', text: `Connection tracking is ${Math.round(count / max * 100)} % full (${fmtNum(count)} of ${fmtNum(max)}); new connections are dropped when it is full.` });
  return out;
}
