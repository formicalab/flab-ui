// The drawn views of a TLS certificate check: the chain as a diagram (each certificate a box, joined by "signed by"
// arrows, with a dashed box where the server did not send an issuer) and an expiry timeline (every certificate's validity
// on one date axis with a marker for today). Both are built from parseTls's result (diagmodel.js) and say nothing the
// certificate cards below them do not, but show it at a glance.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge } from '../../core/ui.js';

const DAY = 86400000;

// The common name of a subject or issuer line ("CN = example.com", "C = US, O = Let's Encrypt, CN = R3" or "/CN=example.com"),
// otherwise the whole text.
const cn = text => (String(text ?? '').match(/CN\s*=\s*([^,/]+)/)?.[1] ?? String(text ?? '')).trim();

// The state of a certificate's dates: 'bad' when expired, 'warn' within 14 days of the end, 'soon' within 60 days, else 'ok'.
function dateState(c, now) {
  if (c.notAfter == null) return 'ok';
  if (c.notAfter < now) return 'bad';
  if (c.notBefore != null && c.notBefore > now) return 'bad';
  const left = (c.notAfter - now) / DAY;
  return left <= 14 ? 'warn' : left <= 60 ? 'soon' : 'ok';
}

// A date as "2026-12-25".
const day = ms => (ms == null ? '–' : new Date(ms).toISOString().slice(0, 10));

// The words under a certificate's name: how long it is still valid, or since when it has not been.
function validity(c, now) {
  if (c.notAfter == null) return 'validity unknown';
  if (c.notBefore != null && c.notBefore > now) return `not valid until ${day(c.notBefore)}`;
  if (c.notAfter < now) return `expired ${Math.floor((now - c.notAfter) / DAY)} days ago`;
  return `${Math.floor((c.notAfter - now) / DAY)} days left`;
}

// One certificate as a box of the diagram.
function node(c, now) {
  return h('div', { className: `rt-cd-node ${c.n === 0 ? 'leaf' : ''} ${dateState(c, now)}` },
    h('div', { className: 'rt-cd-title' }, badge(c.role, c.n === 0 ? 'info' : ''), h('strong', {}, cn(c.subject))),
    h('div', { className: 'rt-cd-sub' }, c.selfSigned ? 'signs itself' : `issued by ${cn(c.issuer)}`, ' · ', validity(c, now)),
    h('div', { className: 'rt-cd-sub muted' }, [c.key, c.sigalg ? `signed with ${c.sigalg}` : null].filter(Boolean).join(' · ')));
}

// The arrow between two boxes: the certificate above is signed by the one below.
const arrow = () => h('div', { className: 'rt-cd-arrow' }, icon('arrow-down'), h('span', {}, 'signed by'));

// A dashed box for an issuer the server did not send. `trusted` says the router's CA store knows it (the usual case for a
// root, which servers leave out), otherwise it is a missing link.
const missing = (issuer, trusted) => h('div', { className: `rt-cd-node missing ${trusted ? 'trusted' : 'warn'}` },
  h('div', { className: 'rt-cd-title' }, badge(trusted ? 'Root, not sent' : 'Not sent', trusted ? '' : 'warning'), h('strong', {}, cn(issuer))),
  h('div', { className: 'rt-cd-sub muted' }, trusted ? 'The router knows this authority, so the server does not need to send it.' : 'The server did not send this certificate, so a client may not be able to build the chain.'));

// The chain as a diagram, top to bottom: the server's certificate, then each issuer. A gap in the chain (a certificate that
// the next one did not issue) and an end that does not reach a root are drawn as dashed boxes. `t` is parseTls's result.
export function chainDiagram(t, now = Date.now()) {
  if (!t.chain.length) return null;
  const parts = [];
  t.chain.forEach((c, i) => {
    parts.push(node(c, now));
    if (t.gaps.includes(i)) parts.push(arrow(), missing(c.issuer, false));
    else if (i + 1 < t.chain.length) parts.push(arrow());
  });
  const last = t.chain.at(-1);
  if (!last.selfSigned && !t.gaps.includes(t.chain.length - 1)) parts.push(arrow(), missing(last.issuer, t.verify?.code === 0));
  return h('div', { className: 'rt-cdiagram' }, parts);
}

// The expiry timeline: a row for each certificate with a bar from the day it became valid to the day it ends, on one date
// axis that also holds today (a vertical marker). The bar's color follows the state of the dates (dateState).
export function expiryTimeline(t, now = Date.now()) {
  const certs = t.chain.filter(c => c.notBefore != null && c.notAfter != null);
  if (!certs.length) return null;
  const lo0 = Math.min(now, ...certs.map(c => c.notBefore)), hi0 = Math.max(now, ...certs.map(c => c.notAfter));
  const pad = Math.max(DAY, (hi0 - lo0) * 0.03);
  const lo = lo0 - pad, hi = hi0 + pad;
  // The position of a time on the timeline, in percent.
  const pos = ms => ((ms - lo) / (hi - lo)) * 100;
  const rows = certs.map(c => h('div', { className: 'rt-tl-row' },
    h('div', { className: 'rt-tl-label', title: c.subject }, h('strong', {}, cn(c.subject)), h('span', { className: 'muted' }, c.role)),
    h('div', { className: 'rt-tl-track' },
      h('div', { className: `rt-tl-bar ${dateState(c, now)}`, style: `left:${pos(c.notBefore).toFixed(2)}%;width:${(pos(c.notAfter) - pos(c.notBefore)).toFixed(2)}%`, title: `${day(c.notBefore)} to ${day(c.notAfter)}` },
        h('span', { className: 'rt-tl-end' }, validity(c, now))),
      h('div', { className: 'rt-tl-now', style: `left:${pos(now).toFixed(2)}%` }))));
  // The word "today" is left out where it would sit on top of an end date (which is then today itself).
  const todayAt = pos(now);
  return h('div', { className: 'rt-timeline' },
    h('div', { className: 'rt-tl-axis' }, h('span', {}, day(lo0)), todayAt > 12 && todayAt < 88 ? h('span', { className: 'rt-tl-today', style: `left:${todayAt.toFixed(2)}%` }, 'today') : null, h('span', {}, day(hi0))),
    rows);
}
