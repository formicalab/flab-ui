// The DNS trace's model: what the output of the trace script (rpcd/ucode/flab.diag.uc) says. The script asks a root server,
// follows the referrals down to the server that answers and prints one block per query with the raw answer of kdig. This
// module reads those blocks into steps (who was asked, how long it took, what it answered), the delegations and DNSSEC data
// in them, the aliases the trace had to follow, and what the router's own resolver says at the end. Pure functions with no
// DOM and no network, so they are unit-tested directly (tests/toolbox/dnstrace.test.mjs).
//
// Blocks (see parseBlocks in diagmodel.js): `step <n> <address> <server name> <zone>` is one query, whose output is the
// kdig answer; `lookup <name> <zone>` is the address of a name server that came without one (asked of the router's
// resolver); `cname <target>` marks an alias the trace starts over for; `resolver <name>` is the router's own answer.
import { parseBlocks } from './diagmodel.js';

// DNSSEC algorithm numbers and DS digest types, for the labels.
const ALGORITHMS = { 5: 'RSASHA1', 7: 'RSASHA1-NSEC3', 8: 'RSASHA256', 10: 'RSASHA512', 13: 'ECDSAP256SHA256', 14: 'ECDSAP384SHA384', 15: 'ED25519', 16: 'ED448' };
const DIGESTS = { 1: 'SHA-1', 2: 'SHA-256', 3: 'GOST', 4: 'SHA-384' };

// A DNSSEC timestamp ("20261114074424", UTC) as milliseconds, or null.
function sigTime(text) {
  const m = String(text).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// One record line of a kdig section as { name, ttl, type, data }, or null for a line that is not a record.
function recordOf(line) {
  const m = line.match(/^(\S+)\s+(\d+)\s+IN\s+(\S+)\s*(.*)$/);
  return m ? { name: m[1], ttl: +m[2], type: m[3], data: m[4].trim() } : null;
}

// The output of one kdig query:
//   { rcode, flags: [...], answer, authority, additional (records), rttMs, from: { address, port, proto } | null, bytes,
//     problem } where `problem` is kdig's own ERROR/WARNING text (a timeout, an unresolvable name) or null.
export function parseKdig(output) {
  const out = { rcode: null, flags: [], answer: [], authority: [], additional: [], rttMs: null, from: null, bytes: null, problem: null };
  let section = null;
  for (const line of String(output ?? '').split('\n')) {
    let m;
    if ((m = line.match(/^;; ->>HEADER<<-.*status: (\w+)/))) out.rcode = m[1];
    else if ((m = line.match(/^;; Flags: ([a-z ]*);/))) out.flags = m[1].trim().split(/\s+/).filter(Boolean);
    else if (/^;; ANSWER SECTION:/.test(line)) section = 'answer';
    else if (/^;; AUTHORITY SECTION:/.test(line)) section = 'authority';
    else if (/^;; ADDITIONAL SECTION:/.test(line)) section = 'additional';
    else if (/^;;/.test(line)) {
      section = null;
      if ((m = line.match(/^;; Received (\d+) B/))) out.bytes = +m[1];
      else if ((m = line.match(/^;; From (\S+?)@(\d+)\((\w+)\) in ([\d.]+) ms/))) { out.from = { address: m[1], port: +m[2], proto: m[3] }; out.rttMs = +m[4]; }
      else if (/^;; (ERROR|WARNING):/.test(line)) out.problem = out.problem ?? line.replace(/^;; (ERROR|WARNING): /, '').trim();
    } else if (section) {
      const r = recordOf(line);
      if (r) out[section].push(r);
    }
  }
  return out;
}

// The DS records of a section as [{ tag, algorithm, digest }].
function dsOf(records) {
  return records.filter(r => r.type === 'DS').map(r => {
    const [tag, alg, dig] = r.data.split(/\s+/);
    return { tag: +tag, algorithm: ALGORITHMS[alg] ?? `algorithm ${alg}`, digest: DIGESTS[dig] ?? `digest ${dig}` };
  });
}

// The signatures over the records of `type` in a section, as [{ signer, tag, algorithm, expires }] (`expires` in ms).
function sigsOf(records, type) {
  return records.filter(r => r.type === 'RRSIG' && r.data.split(/\s+/)[0] === type).map(r => {
    const p = r.data.split(/\s+/);
    return { signer: p[7] ?? '', tag: +p[6], algorithm: ALGORITHMS[p[1]] ?? `algorithm ${p[1]}`, expires: sigTime(p[4]) };
  });
}

// What one answer of a server was: 'answer' (the records asked for), 'cname' (an alias), 'referral' (the next servers),
// 'nxdomain' (the name does not exist), 'nodata' (it exists but has no such record), or a failure ('refused', 'servfail',
// 'timeout', 'error').
function kindOf(k, type) {
  if (!k.rcode) return /timeout/i.test(k.problem ?? '') ? 'timeout' : 'error';
  if (k.rcode === 'REFUSED') return 'refused';
  if (k.rcode === 'SERVFAIL' || k.rcode === 'FORMERR' || k.rcode === 'NOTIMP') return 'servfail';
  if (k.rcode === 'NXDOMAIN') return 'nxdomain';
  if (k.answer.some(r => r.type === type)) return 'answer';
  if (k.answer.some(r => r.type === 'CNAME')) return 'cname';
  if (k.authority.some(r => r.type === 'NS')) return 'referral';
  // A signed zone may deny a name with NSEC saying NXNAME (compact denial): NOERROR on the wire, but the name is not there.
  if (k.authority.some(r => r.type === 'NSEC' && /\bNXNAME\b/.test(r.data))) return 'nxdomain';
  return 'nodata';
}

// The name servers of a referral with the addresses the answer carried for them (glue), in the order of the answer:
// [{ name, glue: [address, ...] }].
function nameServersOf(k) {
  const names = [...new Set(k.authority.filter(r => r.type === 'NS').map(r => r.data))];
  return names.map(name => ({ name, glue: k.additional.filter(r => (r.type === 'A' || r.type === 'AAAA') && r.name === name).map(r => r.data) }));
}

// One `step` block as a step of the trace. `signed` says the answer carried signatures (over the records asked for, or over
// the SOA or NSEC records of a negative answer).
function stepOf(block, type, lookups) {
  const [n, address = '', name = '', zone] = block.detail.split(/\s+/);
  const k = parseKdig(block.output);
  const kind = block.running ? 'running' : kindOf(k, type);
  const looked = lookups.find(l => l.name === name);
  const delegation = k.authority.find(r => r.type === 'NS');
  const signatures = sigsOf(k.answer, type);
  const negativeSigs = ['SOA', 'NSEC', 'NSEC3'].some(t => sigsOf(k.authority, t).length > 0);
  return {
    n: +n, address, server: name, zone, kind, running: block.running, rcode: k.rcode, flags: k.flags, authoritative: k.flags.includes('aa'),
    rttMs: k.rttMs, proto: k.from?.proto ?? 'UDP', bytes: k.bytes, problem: k.problem,
    delegatedTo: kind === 'referral' ? delegation?.name : null, nameServers: kind === 'referral' ? nameServersOf(k) : [],
    ds: dsOf(k.authority), signedDelegation: dsOf(k.authority).length > 0,
    answer: k.answer.filter(r => r.type !== 'RRSIG'), signatures, signed: signatures.length > 0 || negativeSigs,
    soa: k.authority.find(r => r.type === 'SOA') ?? null,
    lookup: looked ? { address: looked.address, ms: looked.ms } : null,
  };
}

// The router's own answer (the last block): its records, whether it validated them (AD), how long it took and whether its
// addresses are the ones the authoritative server gave (null when there is nothing to compare).
function resolverOf(block, final) {
  const k = parseKdig(block.output);
  const records = k.answer.filter(r => r.type !== 'RRSIG');
  const mine = new Set(records.map(r => `${r.type} ${r.data}`));
  const theirs = final?.answer?.length ? new Set(final.answer.map(r => `${r.type} ${r.data}`)) : null;
  return {
    running: block.running, rcode: k.rcode, flags: k.flags, ad: k.flags.includes('ad'), rttMs: k.rttMs, records, problem: k.problem,
    ttl: records.length ? Math.min(...records.map(r => r.ttl)) : null,
    sameAnswer: theirs && records.length ? [...theirs].every(x => mine.has(x)) && [...mine].every(x => theirs.has(x)) : null,
    signed: k.answer.some(r => r.type === 'RRSIG'),
  };
}

// What the whole output of a trace says.
//   { segments: [{ name, aliasOf, steps }], resolver, networkMs, done, outcome, dnssec }
// A segment is the walk down for one name: the name asked about, then one for each alias that was followed (`aliasOf` is the
// name whose alias it is). `networkMs` is the sum of the time the servers took to answer. `outcome` is the kind of the last
// answer ('answer', 'nxdomain', 'nodata', 'timeout', ...) once the trace has ended. `dnssec` summarizes the chain of the last
// segment: { signed, total, answerSigned, validatedByResolver, level } with `level` 'signed', 'partial', 'unsigned' or null
// while nothing is known yet.
export function parseDnsTrace(text, ctx = {}) {
  const blocks = parseBlocks(text);
  const segments = [{ name: ctx.name ?? '', aliasOf: null, steps: [] }];
  const lookups = [];
  let resolverBlock = null;
  for (const b of blocks) {
    if (b.id === 'lookup') {
      const [name] = b.detail.split(/\s+/);
      const address = b.output.split('\n').map(x => x.trim()).find(x => /^[0-9a-fA-F:.]+$/.test(x)) ?? null;
      lookups.push({ name, address, ms: b.secs == null ? null : Math.round(b.secs * 1000) });
    } else if (b.id === 'step') {
      segments.at(-1).steps.push(stepOf(b, ctx.type ?? 'A', lookups));
    } else if (b.id === 'cname') {
      const prev = segments.at(-1);
      segments.push({ name: b.detail.split(/\s+/)[0], aliasOf: prev.name, steps: [] });
    } else if (b.id === 'resolver') {
      resolverBlock = b;
    }
  }
  const all = segments.flatMap(s => s.steps);
  const last = all.at(-1) ?? null;
  const done = Boolean(resolverBlock) && !resolverBlock.running;
  const resolver = resolverBlock ? resolverOf(resolverBlock, [...all].reverse().find(s => s.kind === 'answer') ?? null) : null;

  // The chain of trust of the last segment: how many of its delegations carry a DS record, and whether the final answer is signed.
  const lastSteps = segments.at(-1).steps;
  const referrals = lastSteps.filter(s => s.kind === 'referral');
  const finalStep = lastSteps.at(-1);
  const ended = finalStep && ['answer', 'nxdomain', 'nodata'].includes(finalStep.kind);
  const answerSigned = Boolean(ended && finalStep.signed);
  const signed = referrals.filter(s => s.signedDelegation).length;
  const level = !finalStep ? null : signed === referrals.length && answerSigned ? 'signed' : signed > 0 || answerSigned ? 'partial' : 'unsigned';
  return {
    segments, resolver, networkMs: all.reduce((s, x) => s + (x.rttMs ?? 0), 0), done,
    outcome: last && !last.running && !['referral', 'cname'].includes(last.kind) ? last.kind : null,
    dnssec: { signed, total: referrals.length, answerSigned, validatedByResolver: resolver?.ad ?? null, level },
  };
}

// The words for a step's outcome, for its heading and its badge: [kind of badge, text].
export function stepVerdict(step) {
  switch (step.kind) {
    case 'running': return ['info', 'Asking…'];
    case 'referral': return ['info', 'Referral'];
    case 'answer': return ['success', step.authoritative ? 'Authoritative answer' : 'Answer'];
    case 'cname': return ['info', 'Alias (CNAME)'];
    case 'nxdomain': return ['danger', 'Name does not exist'];
    case 'nodata': return ['warning', 'No such record'];
    case 'refused': return ['danger', 'Refused'];
    case 'servfail': return ['danger', 'Server failure'];
    case 'timeout': return ['danger', 'No reply'];
    default: return ['danger', 'Failed'];
  }
}

// The zone of a step as the page shows it: "." is the root.
export const zoneLabel = zone => (!zone || zone === '.' ? '. (root)' : zone.replace(/\.$/, ''));
