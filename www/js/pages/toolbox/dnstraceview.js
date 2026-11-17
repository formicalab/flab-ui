// The DNS trace's page: the path a lookup takes from the root servers down to the server that answers, drawn as a ladder
// with one card per query (who was asked, how long it took, the referral or the answer, the DNSSEC records that came with
// it), a bar that shows where the time went, and what the router's own resolver says at the end. The meaning of the output
// comes from dnstracemodel.js; the view is repainted every time new output arrives, so a trace that is still running shows
// the steps so far and a pulsing marker for the one being asked.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { disclosure } from '../../core/fold.js';
import { badge, mono, muted } from '../../core/ui.js';
import { fmtMs } from './diagmodel.js';
import { parseDnsTrace, stepVerdict, zoneLabel } from './dnstracemodel.js';
import { day, working } from './parts.js';

// The visual kind of a step (its color): referral, answer, alias, negative, failure or running.
const KIND_CLASS = { referral: 'ref', answer: 'ans', cname: 'alias', nxdomain: 'neg', nodata: 'neg', refused: 'bad', servfail: 'bad', timeout: 'bad', error: 'bad', running: 'run' };

// The records of an answer as a small table: type, time to live and data.
function recordsTable(records) {
  return h('table', { className: 'rt-records' }, h('tbody', {}, records.map(r => h('tr', {},
    h('td', {}, badge(r.type, '')), h('td', { className: 'muted mono' }, `${r.ttl} s`), h('td', { className: 'mono rt-rdata' }, r.data)))));
}

// The name servers of a referral as chips (a tick marks one whose address came with the referral), the first few shown and
// the rest behind a toggle.
function nameServers(list) {
  // The chip of one name server, marked when its address came from a glue record in the referral.
  const chipOf = ns => h('span', { className: `chip rt-ns${ns.glue.length ? ' glued' : ''}`, title: ns.glue.length ? `${ns.name} (address in the referral: ${ns.glue.join(', ')})` : `${ns.name} (no address in the referral)` }, ns.name.replace(/\.$/, ''), ns.glue.length ? h('span', { className: 'rt-tick' }, '✓') : null);
  const head = list.slice(0, 6), rest = list.slice(6);
  return h('div', { className: 'rt-nslist' }, head.map(chipOf), rest.length ? disclosure({ cls: 'rt-nsmore', summary: `+${rest.length} more`, body: rest.map(chipOf) }) : null);
}

// What a referral says about DNSSEC: a signed delegation (a DS record for the zone below), or an unsigned one.
function delegationSecurity(step) {
  if (step.signedDelegation) {
    const d = step.ds[0];
    return h('div', { className: 'rt-sec ok' }, icon('shield-check'), `Signed delegation: DS record for ${zoneLabel(step.delegatedTo)} (key tag ${d.tag}, ${d.algorithm}, ${d.digest}).`);
  }
  return h('div', { className: 'rt-sec none' }, icon('shield-lock'), `Unsigned delegation: no DS record for ${zoneLabel(step.delegatedTo)}, so the chain of trust ends here.`);
}

// What a final answer says about DNSSEC: the signatures that came with it.
function answerSecurity(step) {
  if (!step.signed) return h('div', { className: 'rt-sec none' }, icon('shield-lock'), 'The answer is not signed.');
  const s = step.signatures[0];
  return h('div', { className: 'rt-sec ok' }, icon('shield-check'), s ? `Signed by ${s.signer.replace(/\.$/, '')} (key tag ${s.tag}, ${s.algorithm}), valid until ${day(s.expires)}.` : 'The negative answer is signed.');
}

// The body of one step's card, by what the server answered.
function stepBody(step) {
  if (step.kind === 'running') return working('Waiting for the answer…');
  if (step.kind === 'referral') {
    return h('div', {},
      h('div', { className: 'rt-line' }, `Does not know the answer, but ${step.nameServers.length} name server${step.nameServers.length === 1 ? '' : 's'} for `, h('strong', {}, zoneLabel(step.delegatedTo)), ' do:'),
      nameServers(step.nameServers), delegationSecurity(step),
      step.lookup ? h('div', { className: 'rt-line muted' }, step.lookup.address ? `No address for ${step.server.replace(/\.$/, '')} came with the referral, so the router's resolver was asked for it${step.lookup.ms != null ? ` (${step.lookup.ms} ms)` : ''}: ${step.lookup.address}.` : 'Its address could not be found.') : null);
  }
  if (step.kind === 'answer' || step.kind === 'cname') {
    return h('div', {}, h('div', { className: 'rt-line' }, step.kind === 'cname' ? 'The name is an alias; the answer names the real one:' : step.authoritative ? 'The authoritative answer:' : 'The answer:'),
      recordsTable(step.answer), answerSecurity(step),
      step.lookup?.address ? h('div', { className: 'rt-line muted' }, `Its address came from a lookup through the router's resolver (${step.lookup.address}).`) : null);
  }
  if (step.kind === 'nxdomain' || step.kind === 'nodata') {
    return h('div', {}, h('div', { className: 'rt-line' }, step.kind === 'nxdomain' ? 'The authoritative server says this name does not exist.' : 'The name exists, but it has no record of this type.'),
      step.soa ? h('div', { className: 'rt-line muted' }, 'Zone ', mono(step.soa.name.replace(/\.$/, '')), ', managed by ', mono(step.soa.data.split(/\s+/)[0].replace(/\.$/, '')), '.') : null, answerSecurity(step));
  }
  const text = { refused: 'The server refused to answer.', servfail: 'The server reported a failure (SERVFAIL).', timeout: 'No reply from this server in time. The trace tried another server of the same zone.', error: 'The query failed.' }[step.kind];
  return h('div', { className: 'rt-line' }, text, step.problem ? h('span', { className: 'muted' }, ` (${step.problem})`) : null);
}

// One step of the ladder: a numbered node on the rail and a card for the query.
function stepCard(step, last) {
  const [kindBadge, verdictText] = stepVerdict(step);
  return h('div', { className: `rt-hop ${KIND_CLASS[step.kind] ?? ''}${last ? ' last' : ''}` },
    h('div', { className: 'rt-hop-rail' }, h('span', { className: `rt-hop-node${step.kind === 'running' ? ' live' : ''}` }, String(step.n))),
    h('div', { className: 'rt-hop-card' },
      h('div', { className: 'rt-hop-head' },
        h('span', { className: 'rt-zone', title: 'The zone this server is responsible for' }, zoneLabel(step.zone)),
        h('span', { className: 'rt-asked' }, 'asked ', h('strong', {}, step.server.replace(/\.$/, '')), ' ', mono(step.address)),
        step.rttMs == null ? null : h('span', { className: 'rt-rtt', title: `answered over ${step.proto}${step.bytes ? `, ${step.bytes} bytes` : ''}` }, fmtMs(step.rttMs)),
        badge(verdictText, kindBadge)),
      stepBody(step)));
}

// The bar that shows where the time went: one segment per query, as wide as the server took to answer.
function timingBar(steps, total) {
  if (!steps.length) return null;
  return h('div', { className: 'rt-tbar-wrap' }, h('div', { className: 'rt-tbar' }, steps.map(s => h('div', {
    className: `rt-tseg ${KIND_CLASS[s.kind] ?? ''}`, style: `flex:${Math.max(s.rttMs ?? 0, total * 0.04).toFixed(1)} 1 0`, title: `${s.n}. ${s.server.replace(/\.$/, '')}: ${s.rttMs == null ? 'no answer' : fmtMs(s.rttMs)}`,
  }, h('span', { className: 'rt-tlabel' }, zoneLabel(s.zone).replace(' (root)', '')), h('span', { className: 'rt-tms' }, s.rttMs == null ? '–' : fmtMs(s.rttMs))))));
}

// The card of the router's own resolver: its answer, whether it validated it, how fast, and whether it matches the
// authoritative one (addresses that differ are normal for names behind a CDN).
function resolverCard(r, trace) {
  const answered = trace.segments.flatMap(s => s.steps).find(s => s.kind === 'answer');
  const cached = r.ttl != null && answered?.answer?.length ? Math.max(0, Math.min(...answered.answer.map(x => x.ttl)) - r.ttl) : null;
  return h('div', { className: 'rt-resolver' },
    h('h3', {}, icon('router'), 'What the router\'s own resolver says'),
    r.running ? working('Asking…') : h('div', {},
      h('div', { className: 'rt-hop-head' },
        badge(r.rcode === 'NOERROR' ? (r.records.length ? 'Answers' : 'No data') : r.rcode ?? 'No reply', r.rcode === 'NOERROR' ? 'success' : 'danger'),
        r.rttMs == null ? null : h('span', { className: 'rt-rtt' }, fmtMs(r.rttMs)),
        r.ad ? badge('validated (DNSSEC)', 'success', 'The resolver checked the signatures of this answer (the AD flag)') : trace.dnssec.level === 'signed' ? badge('not validated', 'warning', 'The zone is signed but the resolver did not set the AD flag: DNSSEC validation may be off') : null),
      r.records.length ? recordsTable(r.records) : null,
      r.problem ? h('div', { className: 'rt-line muted' }, r.problem) : null,
      r.sameAnswer === true ? h('div', { className: 'rt-sec ok' }, icon('check-circle'), 'The same records as the authoritative server gave.') : null,
      r.sameAnswer === false ? h('div', { className: 'rt-sec none' }, icon('info-circle'), 'Different from what the authoritative server just gave. That is normal for names that hand out different addresses to different askers (CDNs) or when an older answer is still cached.') : null,
      cached ? h('div', { className: 'rt-line muted' }, `Served from the resolver's cache: about ${cached} s old.`) : null));
}

// The summary above the ladder: the question, the outcome, the network time and the DNSSEC state of the chain.
function summary(trace, job) {
  const steps = trace.segments.flatMap(s => s.steps);
  const aliases = trace.segments.length - 1;
  const final = steps.at(-1);
  const outcome = !final ? null : final.kind === 'answer' ? badge(`Answered by ${final.server.replace(/\.$/, '')}`, 'success')
    : final.kind === 'nxdomain' ? badge('Name does not exist', 'danger') : final.kind === 'nodata' ? badge('No record of this type', 'warning')
      : ['referral', 'cname', 'running'].includes(final.kind) ? null : badge(stepVerdict(final)[1], stepVerdict(final)[0]);
  const lvl = trace.dnssec.level;
  const secure = !trace.done || !lvl ? null
    : lvl === 'signed' ? badge('DNSSEC: chain of trust intact', 'success', 'Every delegation has a DS record and the answer is signed. This tool does not check the signatures; the resolver\'s own validation is shown below.')
      : lvl === 'partial' ? badge('DNSSEC: chain not complete', 'warning', 'Some delegations or the answer are signed, but the chain has a gap') : badge('DNSSEC: not signed', '', 'This name is in an unsigned zone');
  return h('div', { className: 'rt-tsummary' },
    h('div', { className: 'rt-tq' }, h('strong', {}, job.host), ' ', badge(job.dnsType ?? 'A', ''), outcome, secure),
    h('div', { className: 'muted small' }, steps.length ? `${steps.length} queries${aliases ? `, ${aliases} alias${aliases === 1 ? '' : 'es'} followed` : ''}, ${fmtMs(trace.networkMs)} spent waiting for the servers` : 'Starting…'));
}

// The DNS trace result for a job of the trace tool.
export function dnsTraceBody(job) {
  const trace = parseDnsTrace(job.text, { name: job.host, type: job.dnsType ?? 'A' });
  const steps = trace.segments.flatMap(s => s.steps);
  const ladder = [];
  for (const seg of trace.segments) {
    if (seg.aliasOf) ladder.push(h('div', { className: 'rt-alias' }, icon('signpost-split'), 'Alias: ', mono(seg.aliasOf.replace(/\.$/, '')), ' points to ', mono(seg.name.replace(/\.$/, '')), ', so the trace starts over from the root for that name.'));
    seg.steps.forEach((s, i) => ladder.push(stepCard(s, i === seg.steps.length - 1 && seg === trace.segments.at(-1))));
  }
  return h('div', { className: 'rt-trace-dns' },
    summary(trace, job), timingBar(steps, trace.networkMs),
    h('div', { className: 'rt-ladder' }, ladder.length ? ladder : working('Asking a root server…')),
    trace.resolver ? resolverCard(trace.resolver, trace) : null);
}
