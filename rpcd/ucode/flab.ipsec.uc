#!/usr/bin/ucode
//
// rpcd ucode plugin reporting strongSwan tunnel status and security posture as JSON:
//   ubus call flab.ipsec status
//
// Sources:
//   - swanctl --raw (VICI): configured connections, IKE SAs, child SAs, daemon statistics
//   - ip -s xfrm state: kernel SA details; only algorithm names, sizes, replay and encapsulation
//     data are copied. Key material in the dump is never forwarded.
//   - netifd (network.device status) and UCI: xfrmN interfaces mapped to tunnels by if_id
//
// rpcd runs plugins in-process, so this must not call ubus objects served by rpcd itself.

'use strict';
import { deferred } from 'flab.worker';

import { connect } from 'ubus';
import { cursor } from 'uci';
import { run, fixture, safe_ifname, num, uci_all } from 'flab.util';
import { query, events, reply } from 'flab.vici';

//#region Algorithm strength tables (fraction of the maximum score, 0..1)

// Key-exchange strength by strongSwan name (DH/ECDH group, curve or ML-KEM). Anything not listed gets 0.4.
const KE = {
	ECP_521: 1, ECP_384: 0.95, ECP_256: 0.8, ECP_224: 0.5, ECP_192: 0.3,
	CURVE_448: 1, CURVE_25519: 0.9,
	MODP_8192: 0.9, MODP_6144: 0.88, MODP_4096: 0.8, MODP_3072: 0.7, MODP_2048: 0.45,
	MODP_1536: 0.15, MODP_1024: 0, MODP_768: 0,
	ML_KEM_512: 0.9, ML_KEM_768: 1, ML_KEM_1024: 1,
};

// Color band for a 0..1 strength: good from 0.85, fair from 0.55, otherwise weak.
function level(fraction) {
	return fraction >= 0.85 ? 'good' : fraction >= 0.55 ? 'fair' : 'weak';
}

// Split "AES_GCM_16_256" into { alg: "AES_GCM_16", keysize: 256 }; ICV sizes (8/12/16) are not key sizes.
function split_alg(name) {
	let m = match(name ?? '', /^(.+)_([0-9]+)$/);
	if (m && +m[2] >= 64)
		return { alg: m[1], keysize: +m[2] };
	return { alg: name, keysize: null };
}

// Strength 0..1 of an encryption algorithm name (strongSwan spelling, e.g. AES_CBC, AES_GCM_16) and key
// size. AEAD modes score highest; a truncated 8/12-byte ICV costs 0.15; broken ciphers score 0.
function rate_enc(alg, keysize) {
	alg = uc(alg ?? '');
	// Unknown key size is assumed to be 128 bits.
	let ks = keysize ?? 128;
	if (alg == '' || match(alg, /NULL/))
		return 0;
	if (match(alg, /GCM|CCM|CHACHA20/)) {
		let f = (ks >= 256 || match(alg, /CHACHA/)) ? 1 : ks >= 192 ? 0.9 : 0.85;
		return match(alg, /_(8|12)$/) ? f - 0.15 : f;
	}
	if (match(alg, /3DES/))
		return 0.15;
	if (match(alg, /DES|BLOWFISH|CAST|RC2|RC4|IDEA/))
		return 0;
	if (match(alg, /AES|CAMELLIA|SERPENT|TWOFISH/))
		return ks >= 256 ? 0.8 : ks >= 192 ? 0.7 : 0.6;
	return 0.4;
}

// Strength 0..1 of a PRF or integrity algorithm name; null when none is set (AEAD ciphers have no separate
// integrity algorithm). Applies to PRFs and integrity algorithms alike.
function rate_hash(name) {
	name = uc(name ?? '');
	if (name == '' || name == 'NONE')
		return null;
	if (match(name, /SHA2_(384|512)/)) return 1;
	if (match(name, /SHA2_256/)) return 0.9;
	if (match(name, /XCBC|CMAC/)) return 0.7;
	if (match(name, /MD5/)) return 0;
	// SHA-1 and anything not recognized.
	return 0.4;
}

// Strength 0..1 of a key-exchange method via the KE table; a "KEn_" prefix (additional exchanges in
// RFC 9370 style names) is ignored and "none" scores 0 (no PFS).
function rate_ke(name) {
	name = replace(uc(name ?? ''), /^KE[0-9]_/, '');
	if (name == '' || name == 'NONE')
		return 0;
	return KE[name] ?? 0.4;
}

// Strength 0..1 of an authentication class as VICI reports it ("public key", "EAP...", "pre-shared key").
function rate_auth(cls) {
	cls = lc(cls ?? '');
	if (match(cls, /public key/)) return 1;
	if (match(cls, /eap/)) return 0.8;
	if (match(cls, /pre-shared/)) return 0.6;
	return 0.4;
}
//#endregion

//#region Assessment

// One line of the score breakdown: `max` points scaled by `fraction` (clamped to 0..1), with its color
// level, the displayed `value` and an optional explanatory `note`.
function part(key, label, max, fraction, value, note) {
	fraction = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
	return {
		key, label, max, value, note,
		score: max * fraction,
		level: level(fraction),
	};
}

// Collect algorithm names from the configured proposals that rate as weak (a peer could pick them).
function weak_offered(proposals) {
	let weak = [];
	let add = (name) => { if (index(weak, name) < 0) push(weak, name); };

	for (let p in proposals) {
		for (let name in p.encr ?? []) {
			let s = split_alg(name);
			if (rate_enc(s.alg, s.keysize) < 0.55)
				add(name);
		}
		for (let name in [...(p.integ ?? []), ...(p.prf ?? [])]) {
			let f = rate_hash(name);
			if (f != null && f < 0.55)
				add(name);
		}
		for (let name in p.ke ?? []) {
			if (rate_ke(name) < 0.55)
				add(name);
		}
	}
	return weak;
}

// Score one connection from its negotiated (or, when down, configured) parameters.
// Points: IKE encryption 20, PRF/integrity 10, key exchange 20, authentication 10, ESP encryption 20,
// PFS 15 and rekeying/liveness 5 (total 100); returns { score, grade, parts, warnings }.
function assess(v) {
	let parts = [];
	let warnings = [];

	let enc = rate_enc(v.ike.encr, v.ike.keysize);
	push(parts, part('ike_enc', 'IKE encryption', 20, enc, v.ike.encr));

	// The PRF and integrity algorithm are rated together by the weaker of the two.
	let prf = rate_hash(v.ike.prf) ?? 0.4;
	let integ = rate_hash(v.ike.integ);
	push(parts, part('ike_prf', 'IKE PRF / integrity', 10, integ != null && integ < prf ? integ : prf, v.ike.prf));

	push(parts, part('ike_ke', 'IKE key exchange', 20, rate_ke(v.ike.ke), v.ike.ke));

	// An SA whose connection is not in the loaded configuration has no policy to rate: authentication and lifetimes are
	// unknown rather than weak, so they get a neutral score and no pre-shared-key advice.
	let auth = v.orphan ? 0.5 : rate_auth(v.auth);
	push(parts, part('ike_auth', 'Authentication', 10, auth, v.auth ?? (v.orphan ? 'unknown' : null),
		v.orphan ? 'Connection is not loaded, so the authentication method is unknown'
			: auth < 0.85 ? 'Pre-shared key: strength depends on key entropy, which the router cannot see' : null));
	if (auth < 0.85 && !v.orphan)
		push(warnings, { level: 'warn', text: 'Authenticated with a pre-shared key; use a long random key or certificates.' });

	let esp = rate_enc(v.esp.encr, v.esp.keysize);
	push(parts, part('esp_enc', 'ESP encryption', 20, esp, v.esp.encr));

	let pfs = rate_ke(v.esp.ke);
	push(parts, part('esp_pfs', 'Perfect forward secrecy', 15, pfs, v.esp.ke,
		pfs == 0 ? 'No PFS: child SA keys derive from the IKE SA keys' : null));
	if (pfs == 0)
		push(warnings, { level: 'warn', text: 'Perfect forward secrecy is not enabled for the child SA.' });

	// Hygiene points (max 5): DPD on 2, child SA lifetime <= 8 h or a byte limit 2, IKE SA lifetime <= 24 h
	// or reauthentication 1. Lifetimes are in seconds.
	let hygiene = 0;
	let notes = [];
	if (v.orphan) {
		hygiene = 2.5;
		push(notes, 'lifetime and liveness policy unknown');
	}
	else {
		if (v.dpd_delay > 0) { hygiene += 2; } else { push(notes, 'dead peer detection off'); }
		if (v.child_rekey != null && (v.child_rekey <= 28800 || v.child_rekey_bytes > 0)) { hygiene += 2; } else { push(notes, 'child SA lifetime above 8 h'); }
		if ((v.ike_rekey != null && v.ike_rekey <= 86400) || v.reauth > 0) { hygiene += 1; } else { push(notes, 'IKE SA lifetime above 24 h'); }
	}
	push(parts, part('hygiene', 'Rekeying & liveness', 5, hygiene / 5, null, length(notes) ? join(', ', notes) : 'DPD on, short lifetimes'));

	if (v.orphan)
		push(warnings, { level: 'warn', text: 'This SA is not in the loaded configuration (removed or renamed without terminating it); authentication and lifetime policy cannot be rated.' });

	if (v.version != 'IKEv2')
		push(warnings, { level: 'bad', text: 'IKEv1 is deprecated; use IKEv2.' });
	if (rate_enc(v.ike.encr, v.ike.keysize) < 0.55)
		push(warnings, { level: 'bad', text: `Weak IKE cipher in use: ${v.ike.encr}.` });
	if (rate_enc(v.esp.encr, v.esp.keysize) < 0.55)
		push(warnings, { level: 'bad', text: `Weak ESP cipher in use: ${v.esp.encr}.` });
	if (v.ike.integ != null && rate_hash(v.ike.integ) != null && rate_hash(v.ike.integ) < 0.55)
		push(warnings, { level: 'bad', text: `Weak IKE integrity algorithm: ${v.ike.integ}.` });
	if (v.esp.replay_in === 0)
		push(warnings, { level: 'bad', text: 'Anti-replay protection is disabled on the inbound SA.' });
	if (v.esp.replay_failed > 0)
		push(warnings, { level: 'warn', text: `${v.esp.replay_failed} packets failed the replay check.` });

	let weak = weak_offered([...v.ike_proposals, ...v.esp_proposals]);
	if (length(weak))
		push(warnings, { level: 'bad', text: 'Configuration also offers weak algorithms: ' + join(', ', weak) + '.' });

	let total = 0;
	for (let p in parts)
		total += p.score;
	total = int(total + 0.5);

	return {
		score: total,
		grade: total >= 95 ? 'A+' : total >= 85 ? 'A' : total >= 70 ? 'B' : total >= 50 ? 'C' : 'D',
		parts,
		warnings,
	};
}
//#endregion

//#region Data collection

// Values of a VICI section (an object whose keys are indexes or names) in key order; [] when absent.
function sorted_values(section) {
	let out = [];
	for (let k in sort(keys(section ?? {})))
		push(out, section[k]);
	return out;
}

// Authentication rounds of a connection as [{ auth, id, eap_id, certs, cacerts, groups }], read from the
// "local-N" or "remote-N" sections (`prefix` is "local" or "remote") in key order.
function auth_rounds(conf, prefix) {
	let out = [];
	let re = regexp('^' + prefix + '-[0-9]+$');
	for (let k in sort(keys(conf))) {
		if (!match(k, re))
			continue;
		let r = conf[k];
		push(out, {
			auth: r['class'], id: r.id, eap_id: r.eap_id,
			certs: r.certs ?? [], cacerts: r.cacerts ?? [], groups: r.groups ?? [],
		});
	}
	return out;
}

// Kernel SAs keyed by SPI (lower-case hex without 0x), parsed from `ip -s xfrm state`. Only whitelisted,
// non-secret fields are extracted; key bytes on the "enc"/"auth" lines are matched but never stored.
// Each SA starts at its "src ... dst ..." line and the following indented lines add to it.
function xfrm_states() {
	let states = {};
	let cur = null;
	for (let line in split(run('ip -s xfrm state 2>/dev/null'), '\n')) {
		let m = match(line, /^src ([^ ]+) dst ([^ ]+)/);
		if (m) {
			cur = { src: m[1], dst: m[2] };
			continue;
		}
		if (!cur)
			continue;

		if ((m = match(line, /proto ([a-z]+) spi 0x([0-9a-f]+)\(([0-9]+)\) reqid ([0-9]+)\(.*mode ([a-z]+)/))) {
			cur.proto = m[1];
			cur.reqid = +m[4];
			cur.mode = m[5];
			states[lc(m[2])] = cur;
		}
		else if ((m = match(line, /^[[:space:]]+replay-window ([0-9]+) seq/)))
			cur.replay_window = +m[1];
		else if ((m = match(line, /^[[:space:]]+(aead|enc|auth-trunc|auth) ([^ ]+) 0x[0-9a-f]+ \(([0-9]+) bits\)( ([0-9]+))?/)))
			cur[m[1]] = { name: m[2], bits: +m[3], icv: m[5] != null ? +m[5] : null };
		else if ((m = match(line, /encap type ([a-z]+) sport ([0-9]+) dport ([0-9]+)/)))
			cur.encap = { type: m[1], sport: +m[2], dport: +m[3] };
		else if ((m = match(line, /^[[:space:]]+dir (in|out|fwd)/)))
			cur.dir = m[1];
		else if ((m = match(line, /anti-replay context: seq 0x([0-9a-f]+), oseq 0x([0-9a-f]+)/))) {
			cur.seq = hex(m[1]);
			cur.oseq = hex(m[2]);
		}
		else if ((m = match(line, /replay-window [0-9]+ replay ([0-9]+) failed ([0-9]+)/))) {
			cur.replay_dropped = +m[1];
			cur.replay_failed = +m[2];
		}
		else if ((m = match(line, /^[[:space:]]+([0-9]+)\(bytes\), ([0-9]+)\(packets\)/))) {
			cur.bytes = +m[1];
			cur.packets = +m[2];
		}
		else if ((m = match(line, /offload parameters: dev ([^ ]+)/)))
			cur.offload = m[1];
		else if ((m = match(line, /^[[:space:]]+lastused ([0-9]{4}-[0-9-]+ [0-9:]+)/)))
			cur.lastused = m[1];
	}
	return states;
}

// Interfaces of proto xfrm as read from UCI and netifd (statistics included); addresses are added later.
function live_xfrm_interfaces(ubus) {
	let list = [];
	let uci = cursor();
	uci.load('network');
	uci.foreach('network', 'interface', (s) => {
		if (s.proto != 'xfrm')
			return;
		let name = s['.name'];
		if (!safe_ifname(name))
			return;

		let dev = ubus.call('network.device', 'status', { name }) ?? {};
		let st = dev.statistics ?? {};
		push(list, { name, ifid: +s.ifid, tunlink: s.tunlink, zone: s.zone, mtu: dev.mtu ?? num(s.mtu), up: dev.up ?? false,
			rx_bytes: st.rx_bytes, tx_bytes: st.tx_bytes, rx_packets: st.rx_packets, tx_packets: st.tx_packets,
			rx_errors: st.rx_errors, tx_errors: st.tx_errors, rx_dropped: st.rx_dropped, tx_dropped: st.tx_dropped });
	});
	return list;
}

// IPv4 tunnel endpoints (local and point-to-point peer) and global IPv6 addresses of an interface.
function add_addresses(info) {
	info.addrs6 = [];
	for (let line in split(run('ip -o addr show dev ' + info.name + ' 2>/dev/null'), '\n')) {
		let m = match(line, /inet ([0-9.]+)\/?([0-9]*)( peer ([0-9.]+))?/);
		if (m) {
			if (info.local == null) {
				info.local = m[1];
				info.peer = m[4];
			}
			continue;
		}
		m = match(line, /inet6 ([0-9a-f:]+)(\/([0-9]+))?( peer ([0-9a-f:]+)(\/[0-9]+)?)? scope (global|site)/);
		if (m)
			push(info.addrs6, { addr: m[1], prefix: num(m[3]), peer: m[5] });
	}
}

// xfrmN interfaces keyed by their numeric if_id. Fixture mode (FLAB_FIXTURES) reads a saved ifaces.json
// instead of querying UCI and netifd.
function xfrm_interfaces(ubus) {
	let out = {};
	let saved = fixture('ifaces.json');
	for (let info in (saved != null ? json(saved) : live_xfrm_interfaces(ubus))) {
		if (!safe_ifname(info.name))
			continue;
		add_addresses(info);
		out[+info.ifid] = info;
	}
	return out;
}

// JSON view of one child SA from VICI (`sa`), joined with the kernel SAs by SPI (`kernel`) and the xfrm
// interface selected by its inbound if_id (`ifaces`). Byte/packet counters come from the daemon;
// install_time, rekey_time and life_time are seconds.
function child_sa_view(sa, kernel, ifaces) {
	// if-id-in is a hex string; the xfrm interfaces are keyed by its numeric value.
	let if_id = sa['if-id-in'] ? hex(sa['if-id-in']) : null;
	let kin = kernel[lc(sa['spi-in'] ?? '')];
	let kout = kernel[lc(sa['spi-out'] ?? '')];
	return {
		name: sa.name,
		state: sa.state,
		uniqueid: num(sa.uniqueid),
		reqid: num(sa.reqid),
		mode: sa.mode,
		protocol: sa.protocol,
		spi_in: sa['spi-in'], spi_out: sa['spi-out'],
		if_id,
		encr: sa['encr-alg'], keysize: num(sa['encr-keysize']), integ: sa['integ-alg'], ke: sa['dh-group'],
		encap: sa.encap == 'yes',
		bytes_in: num(sa['bytes-in']), bytes_out: num(sa['bytes-out']),
		packets_in: num(sa['packets-in']), packets_out: num(sa['packets-out']),
		use_in: num(sa['use-in']), use_out: num(sa['use-out']),
		install_time: num(sa['install-time']), rekey_time: num(sa['rekey-time']), life_time: num(sa['life-time']),
		local_ts: sa['local-ts'] ?? [], remote_ts: sa['remote-ts'] ?? [],
		kernel: { inbound: kin, outbound: kout },
		iface: if_id != null ? ifaces[if_id] : null,
	};
}

// `sa` is one IKE SA (null when the connection is down). `conf` is null for an SA whose connection is
// not in the loaded configuration (orphan). `multi` is set when the connection has several IKE SAs at once.
function build_connection(name, conf, sa, kernel, ifaces, multi) {
	let orphan = conf == null;
	conf ??= {};
	let proposals = sorted_values(conf.proposals);
	let first = proposals[0] ?? {};
	let first_ike = split_alg((first.encr ?? [])[0]);

	let local = auth_rounds(conf, 'local');
	let remote = auth_rounds(conf, 'remote');
	let auth_class = (remote[0] ?? local[0])?.auth;

	// Configured children plus any child SA whose configuration is gone.
	let child_names = keys(conf.children ?? {});
	for (let k in keys(sa?.['child-sas'] ?? {})) {
		let n = sa['child-sas'][k].name;
		if (index(child_names, n) < 0)
			push(child_names, n);
	}

	// Per-child "first configured" values feed the fallbacks below for tunnels that have no SA.
	let children = [];
	let first_esp = null;
	let child_conf_first = null;
	for (let cname in sort(child_names)) {
		let cc = conf.children?.[cname];
		let child_orphan = cc == null;
		cc ??= {};
		let esp_props = sorted_values(cc.esp_proposals);
		let sas = [];
		for (let k in sort(keys(sa?.['child-sas'] ?? {}))) {
			if (sa['child-sas'][k].name == cname)
				push(sas, child_sa_view(sa['child-sas'][k], kernel, ifaces));
		}
		// Newest SA first (install_time is an age in seconds, so ascending order): during a rekey overlap
		// the older SA is about to be deleted.
		sas = sort(sas, (a, b) => (a.install_time ?? 0) - (b.install_time ?? 0));

		if (!child_orphan) {
			first_esp ??= { props: esp_props, cc };
			child_conf_first ??= cc;
		}
		push(children, {
			name: cname,
			orphan: child_orphan,
			mode: cc.mode ?? sas[0]?.mode,
			rekey_time: num(cc.rekey_time), rekey_bytes: num(cc.rekey_bytes), rekey_packets: num(cc.rekey_packets),
			dpd_action: cc.dpd_action, close_action: cc.close_action,
			local_ts: cc['local-ts'] ?? sas[0]?.local_ts ?? [], remote_ts: cc['remote-ts'] ?? sas[0]?.remote_ts ?? [],
			esp_proposals: esp_props,
			sas,
		});
	}

	// Prefer negotiated parameters; fall back to the first configured proposal for tunnels that are down.
	let primary = null;
	for (let c in children)
		if (length(c.sas)) { primary = c.sas[0]; break; }

	let esp_first = split_alg(((first_esp?.props[0] ?? {}).encr ?? [])[0]);
	let ike = {
		encr: sa?.['encr-alg'] ?? first_ike.alg, keysize: num(sa?.['encr-keysize']) ?? first_ike.keysize,
		integ: sa?.['integ-alg'], prf: sa?.['prf-alg'] ?? (first.prf ?? [])[0],
		ke: sa?.['dh-group'] ?? (first.ke ?? [])[0],
	};
	let esp = {
		encr: primary?.encr ?? esp_first.alg, keysize: primary?.keysize ?? esp_first.keysize,
		integ: primary?.integ, ke: primary ? primary.ke : ((first_esp?.props[0] ?? {}).ke ?? [])[0],
		replay_in: primary?.kernel?.inbound?.replay_window,
		replay_failed: (primary?.kernel?.inbound?.replay_failed ?? 0) + (primary?.kernel?.outbound?.replay_failed ?? 0),
	};

	let ike_view = null;
	if (sa) {
		let nat = sa['nat-local'] == 'yes' || sa['nat-remote'] == 'yes' || sa['nat-any'] == 'yes';
		ike_view = {
			state: sa.state, uniqueid: num(sa.uniqueid), version: num(sa.version),
			local_host: sa['local-host'], local_port: num(sa['local-port']), local_id: sa['local-id'],
			remote_host: sa['remote-host'], remote_port: num(sa['remote-port']), remote_id: sa['remote-id'],
			initiator: sa.initiator == 'yes',
			initiator_spi: sa['initiator-spi'], responder_spi: sa['responder-spi'],
			encr: sa['encr-alg'], keysize: num(sa['encr-keysize']), integ: sa['integ-alg'], prf: sa['prf-alg'], ke: sa['dh-group'],
			established: num(sa.established), rekey_time: num(sa['rekey-time']), reauth_time: num(sa['reauth-time']),
			nat,
			floated: num(sa['remote-port']) == 4500 || num(sa['local-port']) == 4500,
		};
	}

	let rating = assess({
		ike, esp, auth: auth_class, version: conf.version ?? (sa ? 'IKEv' + sa.version : null), orphan,
		dpd_delay: num(conf.dpd_delay), reauth: num(conf.reauth_time), ike_rekey: num(conf.rekey_time),
		child_rekey: num(child_conf_first?.rekey_time), child_rekey_bytes: num(child_conf_first?.rekey_bytes),
		ike_proposals: proposals, esp_proposals: first_esp?.props ?? [],
	});

	return {
		name,
		// Stable identity for client-side history; a connection with several IKE SAs gets one entry per SA.
		key: multi ? `${name}#${sa.uniqueid}` : name,
		instance: multi ? num(sa.uniqueid) : null,
		orphan,
		state: sa?.state ?? 'DOWN',
		version: conf.version ?? (sa ? 'IKEv' + sa.version : null),
		config: {
			local_addrs: conf.local_addrs ?? [], remote_addrs: conf.remote_addrs ?? [],
			local_port: num(conf.local_port), remote_port: num(conf.remote_port),
			rekey_time: num(conf.rekey_time), reauth_time: num(conf.reauth_time), dpd_delay: num(conf.dpd_delay),
			unique: conf.unique, proposals,
			local_auth: local, remote_auth: remote,
		},
		ike: ike_view,
		children,
		rating,
	};
}

// Builds the flab.ipsec status reply: daemon statistics plus one entry per IKE SA (or per configured
// connection that has none), each with children, kernel state and a security rating.
function collect() {
	let ubus = connect();
	let stats = reply('stats');
	// A missing stats reply means charon/swanctl is not reachable. The init script starts charon only when
	// /etc/config/swanctl has sections, so `configured` tells a stopped daemon with tunnels to run from one that
	// has nothing to do.
	let daemon = { running: stats != null, configured: length(keys(uci_all('swanctl'))) > 0 };

	if (stats) {
		let ver = match(run('swanctl --version 2>/dev/null'), /swanctl ([0-9][0-9.]*)/);
		daemon.version = ver ? ver[1] : null;
		daemon.uptime = stats.uptime?.running;
		daemon.since = stats.uptime?.since;
		daemon.workers = {
			total: num(stats.workers?.total), idle: num(stats.workers?.idle),
			active: stats.workers?.active ?? {},
		};
		daemon.queues = stats.queues ?? {};
		daemon.scheduled = num(stats.scheduled);
		daemon.ike_sas = { total: num(stats.ikesas?.total), half_open: num(stats.ikesas?.['half-open']) };
		daemon.plugins = stats.plugins ?? [];
	}

	// Every configured connection, plus any with live SAs that are absent from the configuration (orphans).
	let conns = stats ? query('list-conns') : {};
	let sas = {};
	for (let e in (stats ? events('list-sas') : [])) {
		sas[e.name] ??= [];
		push(sas[e.name], e.body);
	}
	let kernel = xfrm_states();
	let ifaces = xfrm_interfaces(ubus);

	let names = keys(conns);
	for (let n in keys(sas))
		if (conns[n] == null)
			push(names, n);

	let connections = [];
	for (let name in sort(names)) {
		let list = sas[name] ?? [];
		if (!length(list)) {
			push(connections, build_connection(name, conns[name], null, kernel, ifaces, false));
			continue;
		}
		// `established` is the IKE SA's age in seconds, so a descending sort puts the oldest first and entries
		// keep their order when a new one appears.
		list = sort(list, (a, b) => (num(b.established) ?? 0) - (num(a.established) ?? 0));
		for (let sa in list)
			push(connections, build_connection(name, conns[name], sa, kernel, ifaces, length(list) > 1));
	}

	return { generated: time(), daemon, connections };
}
//#endregion

// rpcd registration: ubus object flab.ipsec with the single method `status` (no arguments).
return deferred({
	'flab.ipsec': {
		status: {
			call: function() {
				return collect();
			},
		},
	},
});
