// Daemon status and scoring-model cards shown below the connection cards.

import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, chip, kv, meter } from '../../core/ui.js';

// Plugin name -> what it does, shown as a tooltip on the loaded-plugin chips.
const PLUGIN_ROLE = {
  charon: 'IKE daemon core', vici: 'management interface (swanctl)',
  'kernel-netlink': 'kernel IPsec (XFRM) interface', 'socket-default': 'UDP sockets',
  aes: 'AES cipher', gcm: 'AES-GCM AEAD', sha1: 'SHA-1', sha2: 'SHA-2 family', hmac: 'HMAC', xcbc: 'AES-XCBC',
  kdf: 'key derivation', openssl: 'OpenSSL crypto backend', gmp: 'big-number DH backend',
  random: 'random source', nonce: 'nonce generator',
};

// The security-score model as [category, maximum points, rule]; the maxima sum to 100 and must match the
// weights in rpcd/ucode/flab.ipsec.uc.
const SCORE_MODEL = [
  ['IKE encryption', 20, 'AEAD ciphers (AES-GCM, ChaCha20-Poly1305) with 256-bit keys score highest; CBC modes, short ICVs and legacy ciphers score lower.'],
  ['IKE PRF / integrity', 10, 'SHA-2 (384/512) best, SHA-256 slightly lower, SHA-1 and MD5 are weak.'],
  ['IKE key exchange', 20, 'P-521/P-384, Curve448, large MODP groups and ML-KEM score highest; MODP-2048 and below are penalized.'],
  ['Authentication', 10, 'Certificates 10, EAP 8, pre-shared key 6 (key entropy is invisible to the router).'],
  ['ESP encryption', 20, 'Same scale as IKE encryption, applied to the negotiated child SA cipher.'],
  ['Perfect forward secrecy', 15, 'A child-SA key exchange group scaled like the IKE key exchange; none scores 0.'],
  ['Rekeying & liveness', 5, 'Dead-peer detection (2), child lifetime ≤ 8 h (2), IKE lifetime ≤ 24 h or reauthentication (1).'],
];

// charon status: version, uptime, IKE SA counts, worker-thread usage and loaded plugins. When charon is
// not running the backend reports `running: false` and only an error message is shown.
export function daemonCard(daemon) {
  if (!daemon.running) {
    return card([icon('shield-exclamation'), 'strongSwan daemon'], h('div', { className: 'card-body text-danger' },
      'charon is not running or its VICI socket is unreachable.'));
  }
  const w = daemon.workers;
  const active = Object.entries(w.active ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ');

  const body = h('div', { className: 'card-body vpn-daemon' },
    kv([
      ['Status', badge('running', 'success')],
      ['Version', `strongSwan ${daemon.version ?? '?'}`],
      ['Daemon uptime', `${daemon.uptime ?? '–'} (since ${daemon.since ?? '–'})`],
      ['IKE SAs', `${daemon.ike_sas.total} total · ${daemon.ike_sas.half_open} half-open`],
      ['Worker threads', h('div', {}, meter(w.total - w.idle, w.total, 'good'),
        h('div', { className: 'muted small' }, `${w.idle} idle of ${w.total} · active: ${active}`))],
      ['Scheduled jobs', String(daemon.scheduled ?? '–')],
    ]),
    h('div', {}, h('div', { className: 'fw-semibold mb-2' }, 'Loaded plugins'),
      h('div', { className: 'chips' }, daemon.plugins.map(p => chip(p, 'info', PLUGIN_ROLE[p] ?? '')))));
  return card([icon('cpu'), 'strongSwan daemon'], body);
}

// Collapsible explanation of how the security score and grade are computed (static text, SCORE_MODEL).
export function scoringCard() {
  return h('details', { className: 'legend card card-body' }, h('summary', {}, 'How the security score is calculated (100 points)'),
    h('div', { className: 'mt-2' }, SCORE_MODEL.map(([name, max, text]) => h('div', { className: 'score-model' },
      h('b', {}, `${name} · ${max}`), h('span', { className: 'muted' }, text)))),
    h('div', { className: 'mt-2 muted' }, 'Grades: A+ ≥ 95, A ≥ 85, B ≥ 70, C ≥ 50, otherwise D. The negotiated algorithms are rated; weaker algorithms that the configuration also offers are listed as warnings.'));
}
