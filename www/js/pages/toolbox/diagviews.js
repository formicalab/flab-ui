// The result views of the Diagnostics tab's three richer tools: the connectivity check, the DNS comparison and the
// certificate check. Each takes the job (its text so far, whether it still runs) and returns the nodes to paint; the
// meaning of the text comes from diagmodel.js. The views are repainted every time new output arrives, so a view
// must show a partial result sensibly (a step still running, a server not asked yet).
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, mono, muted } from '../../core/ui.js';
import { PUBLIC_RESOLVERS, fmtMs, parseCheck, parseCompare, parseTls } from './diagmodel.js';

// The icon and color class of a check step's state.
const STATE_ICON = { ok: ['check-circle', 'ok'], warn: ['exclamation-triangle', 'warn'], bad: ['x-circle', 'bad'], skip: ['info-circle', 'skip'], pending: ['hourglass-split', 'pending'] };

// A date (milliseconds) as "2026-12-25", or a dash.
const day = ms => (ms == null ? '–' : new Date(ms).toISOString().slice(0, 10));

// Copies `text` to the clipboard (the async API where the page may use it, a selected textarea otherwise). Resolves to
// whether it worked.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* no clipboard access at all */ }
    area.remove();
    return ok;
  }
}

//#region Connectivity check

// One step of the check: its state icon, the title and what was found.
function stepRow(s) {
  const row = h('div', { className: `rt-step ${s.state}` });
  const [name, cls] = STATE_ICON[s.state] ?? [];
  row.append(
    s.state === 'running' ? h('span', { className: 'spinner-border spinner-border-sm rt-step-icon' }) : h('span', { className: `rt-step-icon ${cls}` }, icon(name)),
    h('div', { className: 'rt-step-main' }, h('div', { className: 'rt-step-title' }, s.title), h('div', { className: 'rt-step-text' }, s.text || (s.state === 'pending' ? 'Waiting…' : s.state === 'running' ? 'Running…' : ''))));
  return row;
}

// The connectivity check: the verdict first (once there is one), then the steps with their findings.
export function checkBody(job) {
  const c = parseCheck(job.text, job.running, { name: job.host });
  const v = c.verdict;
  return h('div', { className: 'rt-checkbody' },
    v ? h('div', { className: `rt-verdict ${v.level}` },
      h('div', { className: 'rt-headline' }, icon({ ok: 'check-circle', warn: 'exclamation-triangle', bad: 'x-circle' }[v.level]), v.text),
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

// The DNS comparison: a row per server with what it answered and how fast, and whether they agree.
export function compareBody(job, status) {
  const c = parseCompare(job.text, job.total);
  const upstream = status?.upstream ?? [];
  const max = Math.max(1, ...c.rows.map(r => r.ms ?? 0));
  const first = c.rows.find(r => r.verdict === 'ok');
  const rows = c.rows.map(r => {
    const differs = first && r.verdict === 'ok' && r.data.join('|') !== first.data.join('|');
    return h('tr', { className: r.verdict && r.verdict !== 'ok' ? 'rt-down' : '' },
      h('td', {}, h('div', { className: 'rt-server' }, serverLabel(r.server, upstream))),
      h('td', {}, r.running ? h('span', { className: 'rt-running' }, h('span', { className: 'spinner-border spinner-border-sm' }), 'Asking…') : badge(REPLY[r.verdict][1], REPLY[r.verdict][0]),
        r.ad ? h('span', { className: 'ms-2' }, badge('DNSSEC', 'info', 'The resolver validated the answer with DNSSEC (the AD flag)')) : null),
      h('td', { className: differs ? 'rt-differs' : '' }, r.answers.length ? h('div', { className: 'rt-answers' }, r.answers.map(a => h('div', {}, mono(a.data), a.type && a.type !== 'A' ? muted(` ${a.type}`) : null))) : muted('–')),
      h('td', { className: 'num' }, r.ms == null ? muted('–') : h('span', { className: 'rt-avg' }, fmtMs(r.ms), h('span', { className: 'rt-bar' }, h('i', { style: `width:${Math.max(3, r.ms / max * 100).toFixed(0)}%` })))),
      h('td', {}, r.server === c.fastest ? badge('fastest', 'success') : null));
  });
  const summary = !c.done ? null
    : c.agree === true ? h('div', { className: 'rt-error ok' }, icon('check-circle'), 'Every server that answered gave the same addresses.')
    : c.agree === false ? h('div', { className: 'rt-error warn' }, icon('exclamation-triangle'), 'The servers gave different answers. That is normal for names behind a CDN, which hands each resolver the addresses nearest to it; for a name that should be fixed, it can mean a stale cache or a tampered resolver.')
    : null;
  return h('div', {},
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover rt-compare' },
      h('thead', {}, h('tr', {}, ['Server', 'Result', 'Answers', 'Time', ''].map((t, i) => h('th', { className: i === 3 ? 'num' : '' }, t)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 5, className: 'muted' }, 'Waiting for the first answer…'))))),
    summary);
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
  const copy = h('button', { type: 'button', className: 'btn btn-fl btn-sm', onclick: async e => {
    const btn = e.currentTarget;
    const ok = await copyText(c.pem);
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { btn.textContent = 'Copy PEM'; }, 1500);
  } }, 'Copy PEM');
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
      c.pem ? h('details', { className: 'rt-raw' }, h('summary', {}, 'PEM'), h('div', { className: 'rt-pem-actions' }, copy), h('pre', {}, c.pem)) : null));
}

// The certificate check: the verdicts first, then the session and the chain from the server's certificate to the root.
export function tlsBody(job) {
  const t = parseTls(job.text, { name: job.name, target: job.target });
  if (t.running && !t.chain.length) return h('div', { className: 'rt-running' }, h('span', { className: 'spinner-border spinner-border-sm' }), 'Connecting…');
  const kind = { ok: 'check-circle', warn: 'exclamation-triangle', bad: 'x-circle' };
  const session = [['Protocol', t.protocol], ['Cipher', t.cipher], ['Key exchange', t.group], ['Address', t.address]].filter(([, v]) => v);
  return h('div', { className: 'rt-tlsbody' },
    h('div', { className: 'rt-findings' }, t.findings.map(f => h('div', { className: `rt-finding ${f.level}` }, icon(kind[f.level]), f.text))),
    session.length ? h('div', { className: 'rt-stats' }, session.map(([l, v]) => h('div', { className: 'rt-stat' }, h('div', { className: 'v rt-small' }, v), h('div', { className: 'l' }, l)))) : null,
    t.chain.length ? h('div', { className: 'rt-chain' }, h('h3', {}, `Certificate chain (${t.chain.length})`), t.chain.map(certCard)) : null);
}

//#endregion
