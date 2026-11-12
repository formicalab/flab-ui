// One card per IPsec connection: header, flow diagram, IKE SA, tunnel (child SA), traffic and
// the security-score breakdown. All numbers come from the flab.ipsec backend; nothing is computed
// here except presentation (names, units, throughput).

import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, chip, kv, section, lifebar, meter, sparkline, muted, mono, GRADE_KIND } from '../../core/ui.js';
import { fmtBytes, fmtBps, fmtSpan, fmtNum } from '../../core/format.js';
import { encName, hashName, keName, authName, isAead, stateKind } from './names.js';
import { series, latest } from './rates.js';

// Helpers over the backend's security rating: the scored part with a given key (ike_enc, esp_pfs, ...),
// its level (good/fair/weak/...) used as a chip color, and a "0xhex (decimal)" number format.
const partOf = (conn, key) => conn.rating.parts.find(p => p.key === key);
// Rating level of one scored part, or '' when the part is absent.
const lvl = (conn, key) => partOf(conn, key)?.level ?? '';
// A number as "0xhex (decimal)", or a dash when missing.
const hex = n => n == null ? '–' : `0x${n.toString(16)} (${n})`;

//#region header and flow diagram
// Card header: state dot, name, IKE version, state and warnings (NAT, orphan) and the security grade.
function header(conn) {
  const up = conn.state === 'ESTABLISHED';
  const r = conn.rating;
  return h('div', { className: 'vpn-head' },
    h('span', { className: `dot ${up ? 'up' : 'down'}`, title: conn.state }),
    h('strong', { className: 'name' }, conn.name),
    conn.instance != null ? badge(`IKE SA #${conn.instance}`, '', 'This connection has several IKE SAs; each is shown separately') : null,
    conn.version ? badge(conn.version, 'info') : null,
    badge(conn.state, stateKind(conn.state)),
    conn.orphan ? badge('Not in configuration', 'warning', 'The SA is still up but its connection is no longer loaded') : null,
    conn.ike?.nat ? badge('NAT detected', 'warning', 'A NAT device was detected between the peers') : null,
    conn.ike?.floated ? badge('IKE on UDP/4500', '', 'IKE moved to the NAT-T port') : null,
    h('span', { className: `grade ${GRADE_KIND[r.grade]}`, title: `Security score ${r.score}/100` },
      h('b', {}, r.grade), h('small', {}, ` ${r.score}/100`)));
}

// One end of the flow diagram: icon, title, "host:port" and the IKE identity when known.
function node(iconName, title, addr, id) {
  return h('div', { className: 'vpn-node' }, icon(iconName, 28),
    h('div', { className: 'node-title' }, title),
    h('div', { className: 'mono' }, addr),
    id ? h('div', { className: 'muted small' }, `ID ${id}`) : null);
}

// This router <-> remote gateway diagram with the negotiated ESP cipher and PFS group on the link. Without
// a live IKE SA the endpoints come from the configuration (500 is the default IKE port); without an
// installed child SA the cipher shown is the one the rating took from the configuration.
function flow(conn) {
  const ike = conn.ike, cfg = conn.config;
  const sa = conn.children.find(c => c.sas.length)?.sas[0];
  const up = conn.state === 'ESTABLISHED';
  const local = ike ? `${ike.local_host}:${ike.local_port}` : `${cfg.local_addrs[0] ?? '%any'}:${cfg.local_port ?? 500}`;
  const remote = ike ? `${ike.remote_host}:${ike.remote_port}` : `${cfg.remote_addrs[0] ?? '%any'}:${cfg.remote_port ?? 500}`;
  const enc = sa ?? { encr: partOf(conn, 'esp_enc')?.value };

  return h('div', { className: 'vpn-flow' },
    node('router', 'This router', local, ike?.local_id),
    h('div', { className: `vpn-link ${up ? 'up' : 'down'}` },
      h('div', { className: 'chips' },
        chip(`ESP · ${encName(enc.encr, enc.keysize)}`, lvl(conn, 'esp_enc')),
        sa?.ke ? chip(`PFS · ${keName(sa.ke)}`, lvl(conn, 'esp_pfs')) : chip('No PFS', 'weak'),
        sa?.kernel?.inbound?.encap ? chip(`UDP-encapsulated ${sa.kernel.inbound.encap.sport}→${sa.kernel.inbound.encap.dport}`, 'info') : null),
      h('div', { className: 'line' }),
      h('div', { className: 'muted small' }, up ? `${conn.version} tunnel · ${sa?.mode ?? ''}`.trim() : 'Tunnel is not established')),
    node('cloud', 'Remote gateway', remote, ike?.remote_id));
}
//#endregion

//#region IKE SA
// IKE SA section: the negotiated parameters when the SA exists, else the configured proposals and settings.
function ikeBlock(conn) {
  const ike = conn.ike, cfg = conn.config;
  const authClass = (cfg.remote_auth[0] ?? cfg.local_auth[0])?.auth;
  const remoteId = cfg.remote_auth[0]?.id;
  const proposals = cfg.proposals.map(p => h('div', { className: 'chips' },
    ...(p.encr ?? []).map(e => chip(e.replace(/_/g, '-'))), ...(p.prf ?? []).map(e => chip(hashName(e))), ...(p.ke ?? []).map(e => chip(keName(e)))));

  if (!ike) {
    return section('IKE security association', kv([
      ['State', badge('DOWN', 'danger')],
      ['Configured proposals', h('div', {}, proposals)],
      ['Authentication', chip(authName(authClass), lvl(conn, 'ike_auth'), authClass)],
      ['Remote ID', remoteId ? mono(remoteId) : muted('any')],
      ['Rekey interval', fmtSpan(cfg.rekey_time)],
      ['Liveness (DPD)', cfg.dpd_delay ? `every ${cfg.dpd_delay}s` : 'disabled'],
    ]));
  }

  const aead = isAead(ike.encr);
  return section('IKE security association', kv([
    ['State', badge(ike.state, stateKind(ike.state))],
    ['Role', ike.initiator ? 'Initiator (this router)' : 'Responder'],
    ['Encryption', chip(encName(ike.encr, ike.keysize), lvl(conn, 'ike_enc'), `${ike.encr}, ${ike.keysize ?? '?'}-bit key${aead ? ' · authenticated encryption' : ''}`)],
    ['Integrity', ike.integ ? chip(hashName(ike.integ), lvl(conn, 'ike_prf')) : muted(aead ? 'included (AEAD)' : '–')],
    ['PRF', chip(hashName(ike.prf), lvl(conn, 'ike_prf'), ike.prf)],
    ['Key exchange', chip(keName(ike.ke), lvl(conn, 'ike_ke'), ike.ke)],
    ['Authentication', chip(authName(authClass), lvl(conn, 'ike_auth'), authClass)],
    ['Peer IDs', mono(`${ike.local_id} ⇄ ${ike.remote_id}`)],
    ['SPIs', mono(`${ike.initiator_spi.slice(0, 8)}… / ${ike.responder_spi.slice(0, 8)}…`)],
    ['Established', `${fmtSpan(ike.established)} ago`],
    ['Lifetime', h('div', {}, lifebar({ elapsed: ike.established, rekeyIn: ike.rekey_time }),
      h('div', { className: 'muted small' }, `rekey in ${fmtSpan(ike.rekey_time)} (every ${fmtSpan(cfg.rekey_time)})`))],
    ['Reauthentication', cfg.reauth_time ? `every ${fmtSpan(cfg.reauth_time)}` : 'disabled (make-before-break rekeying)'],
    ['Liveness (DPD)', cfg.dpd_delay ? `probe every ${cfg.dpd_delay}s` : badge('disabled', 'warning')],
    ['Unique IDs', cfg.unique ?? '–'],
  ]));
}
//#endregion

//#region child SA (tunnel)
// Child SA (tunnel) section: selectors, negotiated ESP cipher, kernel XFRM state (replay window, NAT-T
// encapsulation, offload) and lifetimes; a configured child without an installed SA shows only its settings.
function childBlock(conn, child) {
  const title = `Tunnel · ${child.name}${child.orphan ? ' (not in configuration)' : ''}`;
  const sa = child.sas[0];
  const selectors = `${child.local_ts.join(', ')} ⇄ ${child.remote_ts.join(', ')}`;
  const closing = [['On DPD failure', child.dpd_action], ['On close', child.close_action]];

  if (!sa) {
    return section(title, kv([
      ['State', badge('NOT INSTALLED', 'danger')],
      ['Traffic selectors', mono(selectors)],
      ['Child rekey', child.rekey_time ? `every ${fmtSpan(child.rekey_time)}` : '–'],
      ...closing,
    ]));
  }

  const kin = sa.kernel.inbound, kout = sa.kernel.outbound;
  const esn = (child.esp_proposals[0]?.sn ?? []).some(s => s !== 'NO_EXT_SEQ') ? 'On (64-bit sequence numbers)' : 'Off (32-bit sequence numbers)';
  const failed = (kin?.replay_failed ?? 0) + (kout?.replay_failed ?? 0);
  const aead = isAead(sa.encr);
  const k = kin?.aead ?? kin?.enc;

  return section(title, kv([
    ['State', h('span', {}, badge(sa.state, stateKind(sa.state)), child.sas.length > 1 ? badge(`${child.sas.length} SAs (rekeying)`, 'info') : null)],
    ['Protocol', `${sa.protocol} · ${sa.mode}`],
    ['Encryption', chip(encName(sa.encr, sa.keysize), lvl(conn, 'esp_enc'), sa.encr)],
    ['Integrity', sa.integ ? chip(hashName(sa.integ)) : muted(aead ? 'included (AEAD)' : '–')],
    ['Forward secrecy', sa.ke ? chip(keName(sa.ke), lvl(conn, 'esp_pfs'), sa.ke) : chip('none', 'weak')],
    ['Kernel cipher', k ? mono(`${k.name} · ${k.bits}-bit${k.icv ? ` · ICV ${k.icv}` : ''}`) : muted('n/a')],
    ['ESN', esn],
    ['Replay window', h('span', {}, `in ${kin?.replay_window ?? '–'} · out ${kout?.replay_window ?? '–'} `,
      failed ? badge(`${failed} failed`, 'danger') : badge('0 failed', 'success'))],
    ['Encapsulation', kin?.encap ? `UDP ${kin.encap.sport} → ${kin.encap.dport} (NAT-T)` : 'None (native ESP, IP protocol 50)'],
    ['Crypto offload', kin?.offload ? badge(`Hardware · ${kin.offload}`, 'success') : badge('Software', '')],
    ['SPI in / out', mono(`${sa.spi_in} / ${sa.spi_out}`)],
    ['XFRM if_id', mono(hex(sa.if_id))],
    ['Traffic selectors', mono(selectors)],
    ['Installed', `${fmtSpan(sa.install_time)} ago`],
    ['Lifetime', h('div', {}, lifebar({ elapsed: sa.install_time, rekeyIn: sa.rekey_time, expiresIn: sa.life_time }),
      h('div', { className: 'muted small' }, `rekey in ${fmtSpan(sa.rekey_time)} · hard expiry in ${fmtSpan(sa.life_time)}`))],
    ['Child rekey', child.rekey_time ? `every ${fmtSpan(child.rekey_time)}` : '–'],
    ...closing,
  ]));
}
//#endregion

//#region traffic
// Throughput and xfrm interface section for a child SA: live rates and sparkline from the browser-side
// tracker (rates.js), interface counters, and the SA's own byte/packet totals.
function trafficBlock(conn, child) {
  const sa = child.sas[0];
  if (!sa) return section('Traffic & interface', muted('No traffic: tunnel is down.'));

  const s = series(conn, child);
  const now = latest(s);
  const ifc = sa.iface;
  const ifaceRows = ifc ? [
    ['Interface', h('span', {}, mono(ifc.name), ' ', badge(ifc.up ? 'up' : 'down', ifc.up ? 'success' : 'danger'))],
    ['Tunnel address', mono(`${ifc.local ?? '–'} ⇄ ${ifc.peer ?? '–'}`)],
    ...(ifc.addrs6?.length ? [['IPv6 address', h('div', {}, ifc.addrs6.map(a => mono(`${a.addr}${a.prefix != null ? '/' + a.prefix : ''}${a.peer ? ' ⇄ ' + a.peer : ''}`)))]] : []),
    ['MTU · zone · link', `${ifc.mtu ?? '–'} · ${ifc.zone ?? '–'} · via ${ifc.tunlink ?? '–'}`],
    ['Received', `${fmtBytes(ifc.rx_bytes)} · ${fmtNum(ifc.rx_packets)} pkts`],
    ['Sent', `${fmtBytes(ifc.tx_bytes)} · ${fmtNum(ifc.tx_packets)} pkts`],
    ['Errors (rx / tx)', h('span', {}, `${fmtNum(ifc.rx_errors)} / ${fmtNum(ifc.tx_errors)} `, ifc.tx_errors || ifc.rx_errors ? badge('check', 'warning') : null)],
    ['Dropped (rx / tx)', `${fmtNum(ifc.rx_dropped)} / ${fmtNum(ifc.tx_dropped)}`],
  ] : [['Interface', muted('no xfrm interface bound to this if_id')]];

  return section('Traffic & interface', h('div', { className: 'traffic' },
    h('div', { className: 'rate' },
      h('div', {}, icon('arrow-down'), h('b', {}, fmtBps(now.rx)), h('small', {}, ' in')),
      h('div', {}, icon('arrow-up'), h('b', {}, fmtBps(now.tx)), h('small', {}, ' out'))),
    sparkline([{ values: s.rx, cls: 'rx' }, { values: s.tx, cls: 'tx' }], { width: 220, height: 44 })),
  kv([
    ...ifaceRows,
    ['Current SA in / out', `${fmtBytes(sa.bytes_in)} / ${fmtBytes(sa.bytes_out)}`],
    ['Packets in / out', `${fmtNum(sa.packets_in)} / ${fmtNum(sa.packets_out)}`],
    ['Last used', `${fmtSpan(sa.use_in)} / ${fmtSpan(sa.use_out)} ago`],
  ]));
}
//#endregion

//#region score breakdown
// Per-part score meters (the backend's rating.parts) and the list of weaker algorithms offered by the config.
function scoreBlock(conn) {
  const r = conn.rating;
  return h('div', { className: 'vpn-score' },
    h('div', { className: 'parts' }, r.parts.map(p => h('div', { className: 'part' },
      h('div', { className: 'plabel' }, p.label),
      meter(p.score, p.max, p.level),
      h('div', { className: 'pval' }, `${Math.round(p.score * 10) / 10}/${p.max}`),
      p.note ? h('div', { className: 'pnote muted small' }, p.note) : null))),
    r.warnings.length ? h('ul', { className: 'warnings' }, r.warnings.map(w => h('li', { className: w.level },
      icon(w.level === 'bad' ? 'shield-exclamation' : 'exclamation-triangle'), w.text))) : null);
}
//#endregion

// The connection card; `compact` shows only the header, flow diagram and score (no IKE/tunnel/traffic columns).
export function connectionCard(conn, { compact = false } = {}) {
  const cols = compact ? null : h('div', { className: 'vpn-cols' },
    [ikeBlock(conn), ...conn.children.flatMap(c => [childBlock(conn, c), trafficBlock(conn, c)])]);
  return h('div', { className: `card vpn-card ${conn.state === 'ESTABLISHED' ? 'is-up' : 'is-down'}` },
    header(conn), flow(conn), cols, scoreBlock(conn));
}
