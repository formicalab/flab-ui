// The packet capture's model: what tcpdump's one-line-per-packet text and the capture script's blocks say. Pure functions
// with no DOM and no network, so they are unit-tested directly (tests/toolbox/tools.test.mjs).
//
// The job's output is two blocks (see capture_script in rpcd/ucode/flab.diag.uc): `capture`, with the packets as tcpdump
// prints them with -nn -tt (the first lines only: a final `### MORE <n>` line counts the ones left out), and `stats`, with
// what the capturing tcpdump said on its error output when it ended ("listening on ...", "N packets captured", ...).
import { parseBlocks } from './diagmodel.js';

// An endpoint as tcpdump prints it, "192.168.1.5.443" or "fe80::1.443" (the port follows the last dot; a bare address has
// none), as { addr, port }.
function endpoint(text, v6) {
  const m = v6 ? text.match(/^([0-9a-fA-F:]+?)(?:\.(\d+))?$/) : text.match(/^(\d+\.\d+\.\d+\.\d+)(?:\.(\d+))?$/);
  return m ? { addr: m[1], port: m[2] ? +m[2] : null } : { addr: text, port: null };
}

// The protocol of a packet from what tcpdump wrote after the addresses, and the ports for the names that need them.
function protocolOf(info, ports) {
  if (/^Flags \[/.test(info)) return 'TCP';
  if (/^UDP,/.test(info)) return 'UDP';
  if (/^ICMP6/.test(info)) return 'ICMPv6';
  if (/^ICMP/.test(info)) return 'ICMP';
  const named = info.match(/^(ESP|AH|GRE|IGMP|OSPF|VRRP|PIM|IPIP|SCTP)/i);
  if (named) return named[1].toUpperCase();
  const other = info.match(/^ip-proto-(\d+)/);
  if (other) return `IP proto ${other[1]}`;
  if (ports.some(p => p === 5353 || p === 5355)) return 'mDNS';
  if (ports.some(p => p === 53) && /^\d+/.test(info)) return 'DNS';
  if (ports.some(p => p != null) && /\(\d+\)\s*$/.test(info)) return 'UDP';
  return 'IP';
}

// One packet line as { time, iface, dir, proto, src, sport, dst, dport, len, info }, or null for a line that is not a packet.
// `time` is the epoch time in seconds. `iface` and `dir` ("In", "Out", ...) are there when the capture covered every
// interface. ARP has no ports, and a line this does not understand keeps its text as `info` with the protocol "?".
export function parsePacket(line) {
  const m = String(line ?? '').match(/^(\d+\.\d+) (?:(\S+)\s+(In|Out|B|M|P)\s+)?(.*)$/);
  if (!m) return null;
  const p = { time: +m[1], iface: m[2] ?? null, dir: m[3] ?? null, proto: '?', src: null, sport: null, dst: null, dport: null, len: null, info: m[4].trim() };
  let q;
  if ((q = m[4].match(/^(IP6?) (\S+) > (\S+): (.*)$/))) {
    const a = endpoint(q[2], q[1] === 'IP6'), b = endpoint(q[3], q[1] === 'IP6');
    Object.assign(p, { src: a.addr, sport: a.port, dst: b.addr, dport: b.port, info: q[4].trim() });
    p.proto = protocolOf(p.info, [a.port, b.port]);
  } else if ((q = m[4].match(/^ARP, (.*)$/))) {
    p.proto = 'ARP';
    p.info = q[1].trim();
    const ask = p.info.match(/^Request who-has (\S+) tell (\S+?),/), reply = p.info.match(/^Reply (\S+) is-at (\S+?),/);
    if (ask) Object.assign(p, { src: ask[2], dst: ask[1] });
    else if (reply) Object.assign(p, { src: reply[1], dst: null });
  }
  const len = p.info.match(/length (\d+)\s*$/) ?? p.info.match(/\((\d+)\)\s*$/);
  p.len = len ? +len[1] : null;
  return p;
}

// What a capture says, from the job's output so far.
//   { packets, more, captured, received, dropped, snaplen, listening, error, done, protocols: [[name, count]],
//     conversations: [{ a, b, packets, bytes }], syn, rst, tcp, span }
// `packets` are the lines the page got (parsePacket's, plus `rel`, the seconds since the first one), `more` how many further
// packets the plugin counted but did not send. `captured`, `received` (by the filter) and `dropped` (by the kernel) come from
// tcpdump's summary at the end and are null while it runs; `listening` is the interface line. `done` is true once the summary
// is there. `error` is tcpdump's complaint when it could not capture (an interface that went away, a filter it did not accept).
// `protocols` and `conversations` (the five busiest address pairs, by packets) are counted over the packets in `packets`;
// `syn` counts connection attempts (SYN without ACK), `rst` resets, `tcp` TCP packets; `span` is the seconds from the first
// to the last packet.
export function parseCapture(text) {
  const blocks = parseBlocks(text);
  const cap = blocks.find(b => b.id === 'capture');
  const stats = blocks.find(b => b.id === 'stats');
  const packets = [];
  let more = 0;
  for (const line of (cap?.output ?? '').split('\n')) {
    const left = line.match(/^### MORE (\d+)/);
    if (left) { more = +left[1]; continue; }
    const p = parsePacket(line);
    if (p) packets.push(p);
  }
  const t0 = packets[0]?.time ?? 0;
  for (const p of packets) p.rel = p.time - t0;
  const protocols = new Map(), pairs = new Map();
  let syn = 0, rst = 0, tcp = 0;
  for (const p of packets) {
    protocols.set(p.proto, (protocols.get(p.proto) ?? 0) + 1);
    if (p.proto === 'TCP') { tcp++; if (/^Flags \[S\]/.test(p.info)) syn++; if (/^Flags \[R/.test(p.info)) rst++; }
    if (p.src && p.dst) {
      const [a, b] = [p.src, p.dst].sort();
      const key = `${a}|${b}`;
      const c = pairs.get(key) ?? { a, b, packets: 0, bytes: 0 };
      c.packets++;
      c.bytes += p.len ?? 0;
      pairs.set(key, c);
    }
  }
  const out = {
    packets, more, captured: null, received: null, dropped: null, snaplen: null, listening: null, error: null, done: Boolean(stats && !stats.running),
    protocols: [...protocols.entries()].sort((x, y) => y[1] - x[1]),
    conversations: [...pairs.values()].sort((x, y) => y.packets - x.packets || y.bytes - x.bytes).slice(0, 5),
    syn, rst, tcp, span: packets.length ? packets.at(-1).time - t0 : 0,
  };
  for (const line of (stats?.output ?? '').split('\n')) {
    let m;
    if ((m = line.match(/^(\d+) packets? captured/))) out.captured = +m[1];
    else if ((m = line.match(/^(\d+) packets? received by filter/))) out.received = +m[1];
    else if ((m = line.match(/^(\d+) packets? dropped by kernel/))) out.dropped = +m[1];
    else if ((m = line.match(/^tcpdump: listening on (\S+?),.*snapshot length (\d+)/))) { out.listening = m[1]; out.snaplen = +m[2]; }
    else if (/^tcpdump: /.test(line) && !/^tcpdump: (verbose output|data link type)/.test(line)) out.error = line.replace(/^tcpdump: /, '').trim();
  }
  return out;
}

// What a capture's numbers mean, in words: [{ level: 'ok' | 'warn' | 'bad', text }]. `cap` is the request ({ packets,
// seconds }) so that the way it ended can be named. Said only when the capture has ended.
export function captureNotes(c, cap) {
  const notes = [];
  if (!c.done) return notes;
  if (c.error && !c.captured) return [{ level: 'bad', text: `The capture failed: ${c.error}.` }];
  if (!c.captured) return [{ level: 'warn', text: 'No packet matched. Check the interface and the filter, and that the traffic crosses this router (traffic between two devices on the same switch port never does).' }];
  if (c.dropped > 0) notes.push({ level: 'warn', text: `The kernel dropped ${c.dropped} packet${c.dropped === 1 ? '' : 's'} before they could be captured. Narrow the filter or keep less of each packet.` });
  if (cap?.packets && c.captured >= cap.packets) notes.push({ level: 'ok', text: `The capture ended at its limit of ${cap.packets} packets, so it covers the first part of the period only.` });
  if (c.tcp >= 20 && c.rst / c.tcp >= 0.1) notes.push({ level: 'warn', text: `${c.rst} of ${c.tcp} TCP packets are resets (RST): connections are being refused or torn down.` });
  if (c.more > 0) notes.push({ level: 'ok', text: `The table and the figures cover the first ${c.packets.length} packets; the file has all ${c.captured}.` });
  return notes;
}
