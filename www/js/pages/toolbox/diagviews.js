// The result views of the Toolbox's richer tools: the connectivity check, the DNS comparison, the certificate check and
// Wake-on-LAN. Each takes the job (its text so far, whether it still runs) and returns the nodes to paint; the
// meaning of the text comes from diagmodel.js. The views are repainted every time new output arrives, so a view
// must show a partial result sensibly (a step still running, a server not asked yet).
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { copyButton } from '../../core/clipboard.js';
import { disclosure } from '../../core/fold.js';
import { badge, button, mono, muted, spinner } from '../../core/ui.js';
import { PUBLIC_RESOLVERS, fmtMs, hostOf, parseCheck, parseCompare, parseTls } from './diagmodel.js';
import { LEVEL_ICON, banner, day, timeBar, working } from './parts.js';
import { chainDiagram, expiryTimeline } from './tlsdiagram.js';

// The icon and color class of a check step's state.
const STATE_ICON = { ok: ['check-circle', 'ok'], warn: ['exclamation-triangle', 'warn'], bad: ['x-circle', 'bad'], skip: ['info-circle', 'skip'], pending: ['hourglass-split', 'pending'] };

// One figure of a summary row (the ping's sent, received and loss; an iperf3 test's rate): a large value over a small label,
// colored by `kind` ('ok', 'warn' or 'bad').
export const stat = (label, value, kind = '') => h('div', { className: `rt-stat ${kind}` }, h('div', { className: 'v' }, value), h('div', { className: 'l' }, label));

//#region Connectivity check

// One step of the check: its state icon, the title and what was found.
function stepRow(s) {
  const row = h('div', { className: `rt-step ${s.state}` });
  const [name, cls] = STATE_ICON[s.state] ?? [];
  row.append(
    s.state === 'running' ? spinner('Diagnostic step running', 'rt-step-icon') : h('span', { className: `rt-step-icon ${cls}` }, icon(name)),
    h('div', { className: 'rt-step-main' }, h('div', { className: 'rt-step-title' }, s.title), h('div', { className: 'rt-step-text' }, s.text || (s.state === 'pending' ? 'Waiting…' : s.state === 'running' ? 'Running…' : ''))));
  return row;
}

// The connectivity check: the verdict first (once there is one), then the steps with their findings.
export function checkBody(job) {
  const c = parseCheck(job.text, job.running, { name: job.host, port: job.port });
  const v = c.verdict;
  return h('div', { className: 'rt-checkbody' },
    v ? h('div', { className: `rt-verdict ${v.level}` },
      h('div', { className: 'rt-headline' }, icon(LEVEL_ICON[v.level]), v.text),
      ...v.notes.map(n => h('div', { className: 'rt-text' }, n))) : null,
    h('div', { className: 'rt-steps' }, c.steps.map(stepRow)));
}

//#endregion

//#region DNS comparison

// A name for a server of the comparison: "Router's resolver", or the address with who runs it.
function serverLabel(server, upstream) {
  if (server === 'router') return [h('strong', {}, 'The router\'s resolver'), muted('what the clients on this network use')];
  const named = PUBLIC_RESOLVERS.find(([a]) => a === server);
  const note = named ? named[1] : upstream.includes(server) ? 'upstream of the router' : null;
  return [mono(server), note ? muted(note) : null];
}

// The words and badge color of one server's result.
const REPLY = {
  ok: ['success', 'Answers'], empty: ['warning', 'No answer'], nxdomain: ['danger', 'NXDOMAIN'], servfail: ['danger', 'SERVFAIL'],
  refused: ['danger', 'Refused'], timeout: ['danger', 'No reply'],
};

// The words for a server in the response-time chart: the name of a public resolver with its address, "the router's
// resolver", or the address.
function chartLabel(server, upstream) {
  if (server === 'router') return 'The router\'s resolver';
  const named = PUBLIC_RESOLVERS.find(([a]) => a === server);
  return named ? `${named[1]} · ${server}` : upstream.includes(server) ? `${server} · upstream` : server;
}

// A horizontal bar for each server, fastest first, as long as the time the server took, with the fastest marked and the
// slower ones in step with the slowest. Servers that gave no answer are listed last without a bar. Null with fewer than two
// timed servers, where a comparison of times says nothing.
function responseChart(rows, fastest, upstream) {
  const timed = rows.filter(r => r.ms != null);
  if (timed.length < 2) return null;
  const max = Math.max(...timed.map(r => r.ms));
  const sorted = [...rows].sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
  return h('div', { className: 'rt-hchart', role: 'img', 'aria-label': 'Response time of each server' }, sorted.map(r => h('div', { className: 'rt-hrow' },
    h('div', { className: 'rt-hlabel', title: r.server }, chartLabel(r.server, upstream)),
    h('div', { className: 'rt-hbar-wrap' }, r.ms == null
      ? h('span', { className: 'muted' }, r.running ? 'asking…' : 'no reply')
      : [h('div', { className: `rt-hbar${r.server === fastest ? ' best' : ''}${r.verdict && r.verdict !== 'ok' ? ' bad' : ''}`, style: `width:${Math.max(2, r.ms / max * 85).toFixed(1)}%` }), h('span', { className: 'rt-hval' }, fmtMs(r.ms))]))));
}

// The DNS comparison: a chart of the response times, then a row per server with what it answered and how fast, and whether
// they agree.
export function compareBody(job, status) {
  const c = parseCompare(job.text, job.total);
  const upstream = status?.upstream ?? [];
  const max = Math.max(1, ...c.rows.map(r => r.ms ?? 0));
  const first = c.rows.find(r => r.verdict === 'ok');
  const rows = c.rows.map(r => {
    const differs = first && r.verdict === 'ok' && r.data.join('|') !== first.data.join('|');
    return h('tr', { className: r.verdict && r.verdict !== 'ok' ? 'rt-down' : '' },
      h('td', {}, h('div', { className: 'rt-server' }, serverLabel(r.server, upstream))),
      h('td', {}, r.running ? working('Asking…') : badge(REPLY[r.verdict][1], REPLY[r.verdict][0]),
        r.ad ? h('span', { className: 'ms-2' }, badge('DNSSEC', 'info', 'The resolver validated the answer with DNSSEC (the AD flag)')) : null),
      h('td', { className: differs ? 'rt-differs' : '' }, r.answers.length ? h('div', { className: 'rt-answers' }, r.answers.map(a => h('div', {}, mono(a.data), a.type && a.type !== 'A' ? muted(` ${a.type}`) : null))) : muted('–')),
      h('td', { className: 'num' }, r.ms == null ? muted('–') : timeBar(fmtMs(r.ms), r.ms, max)),
      h('td', {}, r.server === c.fastest ? badge('fastest', 'success') : null));
  });
  const summary = !c.done ? null
    : c.agree === true ? banner('Every server that answered gave the same addresses.', 'ok')
    : c.agree === false ? banner('The servers gave different answers. That is normal for names behind a CDN, which hands each resolver the addresses nearest to it; for a name that should be fixed, it can mean a stale cache or a tampered resolver.', 'warn')
    : null;
  return h('div', {},
    responseChart(c.rows, c.fastest, upstream),
    h('div', { className: 'table-responsive' }, h('table', { className: 'table table-hover rt-compare' },
      h('thead', {}, h('tr', {}, ['Server', 'Result', 'Answers', 'Time', ''].map((t, i) => h('th', { className: i === 3 ? 'num' : '' }, t)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 5, className: 'muted' }, 'Waiting for the first answer…'))))),
    summary);
}

//#endregion

//#region Wake-on-LAN

// The Wake-on-LAN result: that the magic packet went out (and how), what that does and does not prove, and a button to
// ping the host once it has had a moment. `openPing(ip)` fills the ping form in and runs it.
export function wolBody(job, status, openPing) {
  const r = job.wake;
  if (!r?.ok) return banner(job.error ?? 'The magic packet could not be sent.');
  const host = hostOf(status?.hosts, r.mac);
  const who = host?.name ? `${host.name} (${r.mac})` : r.mac;
  const how = r.method === 'etherwake' ? 'an Ethernet frame (etherwake)' : 'a UDP broadcast to port 9 (socat)';
  return h('div', { className: 'rt-wolbody' },
    h('div', { className: 'rt-verdict ok' },
      h('div', { className: 'rt-headline' }, icon('check-circle'), `Magic packet sent to ${who}.`),
      h('div', { className: 'rt-text' }, `It left the router on ${r.iface} as ${how}. That is all the router can tell: a host that is off does not answer, so whether it woke up has to be checked.`)),
    host?.ip ? h('div', { className: 'rt-actions' }, button(`Ping ${host.ip}`, 'activity', () => openPing(host.ip)), muted('Waking takes a few seconds; the first pings may get no reply.')) : muted('The router does not know this host\'s address, so it cannot ping it for you.'));
}

//#endregion

//#region Certificate check

// The "valid until" badge of a certificate: red when expired, amber when close, otherwise green.
function expiryBadge(c) {
  if (c.daysLeft == null) return null;
  if (c.daysLeft < 0) return badge(`expired ${-c.daysLeft} days ago`, 'danger');
  return badge(`${c.daysLeft} days left`, c.daysLeft <= 14 ? 'warning' : 'success');
}

// One certificate of the chain: who it is for and who issued it, its key, its dates, its names and fingerprint, and the
// PEM text to copy.
function certCard(c) {
  const copy = copyButton(c.pem, 'Copy PEM');
  // One label/value line of the certificate; null (no line) when the value is empty.
  const row = (label, value) => value == null || value === '' ? null : h('div', { className: 'rt-cert-row' }, h('span', { className: 'l' }, label), h('span', { className: 'v' }, value));
  return h('div', { className: `rt-cert ${c.n === 0 ? 'leaf' : ''}` },
    h('div', { className: 'rt-cert-head' }, badge(c.role, c.n === 0 ? 'info' : ''), h('strong', { className: 'rt-cert-name' }, c.subject), expiryBadge(c)),
    h('div', { className: 'rt-cert-body' },
      row('Issued by', c.selfSigned ? 'itself (self-signed)' : c.issuer),
      row('Key', [c.key, c.sigalg ? ` · signed with ${c.sigalg}` : ''].join('')),
      row('Valid', `${day(c.notBefore)} to ${day(c.notAfter)}`),
      c.sans.length ? row('Names', h('span', { className: 'chips' }, c.sans.map(s => h('span', { className: 'chip' }, s.replace(/^DNS:/, ''))))) : null,
      row('Certificate authority', c.ca == null ? null : c.ca ? 'yes' : 'no'),
      row('Serial', c.serial ? mono(c.serial) : null),
      row('SHA-256', c.sha256 ? h('span', { className: 'mono rt-fp' }, c.sha256) : null),
      c.pem ? disclosure({ cls: 'rt-raw', summary: 'PEM', body: [h('div', { className: 'rt-pem-actions' }, copy), h('pre', {}, c.pem)] }) : null));
}

// What the chain lacks, drawn where it lacks it: after a certificate that the next one did not issue (a gap), and at the
// end when the last certificate has no issuer in the chain and is not a root. A lone certificate gets the stronger text.
function missingNote(c, kind, count) {
  const text = kind === 'gap' ? ['Gap. ', `This certificate was issued by ${c.issuer}, but the server did not send that certificate next.`]
    : count === 1 ? ['Issuer not sent. ', `The server sent no certificate for ${c.issuer}.`]
      : ['End of the chain. ', `The server did not send the issuer of this certificate, ${c.issuer}. Servers usually leave out the root; a missing intermediate would show as a failed verification.`];
  return h('div', { className: 'rt-chain-missing' }, h('strong', {}, text[0]), text[1]);
}

// The certificate check: the verdicts first, then the session and the chain exactly as the server sent it.
export function tlsBody(job) {
  const t = parseTls(job.text, { name: job.name, target: job.target });
  if (t.running && !t.chain.length) return working('Connecting…');
  const session = [['Protocol', t.protocol], ['Cipher', t.cipher], ['Key exchange', t.group], ['Address', t.address]].filter(([, v]) => v);
  return h('div', { className: 'rt-tlsbody' },
    h('div', { className: 'rt-findings' }, t.findings.map(f => h('div', { className: `rt-finding ${f.level}` }, icon(LEVEL_ICON[f.level]), f.text))),
    session.length ? h('div', { className: 'rt-stats' }, session.map(([l, v]) => h('div', { className: 'rt-stat' }, h('div', { className: 'v rt-small' }, v), h('div', { className: 'l' }, l)))) : null,
    t.chain.length ? h('div', { className: 'rt-chain' },
      h('h3', {}, 'Chain and expiry'),
      h('div', { className: 'rt-tls-visual' }, chainDiagram(t), expiryTimeline(t))) : null,
    t.chain.length ? h('div', { className: 'rt-chain' },
      h('h3', {}, `Certificate chain sent by the server (${t.chain.length})`),
      h('p', { className: 'rt-chain-note' }, 'The certificates exactly as the server sent them, in order. The router\'s own certificate authorities are not used to add any.'),
      t.chain.flatMap((c, i) => [certCard(c), t.gaps.includes(i) ? missingNote(c, 'gap') : null]),
      t.chain.at(-1).selfSigned || (t.chain.length > 1 && t.verify?.code !== 20 && t.verify?.code !== 21) ? null : missingNote(t.chain.at(-1), 'end', t.chain.length)) : null);
}

//#endregion
