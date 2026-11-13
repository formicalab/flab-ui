// The Diagnostics tab's model: what the output of ping, traceroute and DNS tools means, and what a request may
// contain. Pure functions with no DOM and no network, so they are unit-tested directly (tests/routing/diag.test.mjs).
// The plugin (rpcd/ucode/flab.diag.uc) only streams the tools' text; everything shown beyond the raw text is
// derived here, which keeps the parsing next to the tests that pin the formats of busybox ping and traceroute.

//#region Requests

// A host name or an address, as the plugin accepts it: letters, digits, ".", ":", "_" and "-", at most 253
// characters, not starting with "-".
export const isHost = text => /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,252}$/.test(String(text ?? ''));

// An IPv4 or IPv6 address (the characters an address can hold, with a colon for IPv6).
export const isAddress = text => /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(String(text)) || (String(text).includes(':') && /^[0-9A-Fa-f:.]{2,45}$/.test(String(text)));

// A MAC address: six hex pairs separated by colons or dashes.
export const isMac = text => /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/.test(String(text ?? ''));

// A MAC address as lowercase pairs joined by colons (what the plugin sends back); the text itself when it is not one.
export const normMac = text => (isMac(text) ? String(text).toLowerCase().replaceAll('-', ':') : String(text ?? ''));

// The known host with this MAC address from the plugin's host list ({ mac, name, ip, dev }), or null.
export const hostOf = (hosts, mac) => (hosts ?? []).find(x => x.mac === normMac(mac)) ?? null;

// The number limits of each field, as the plugin enforces them: [min, max, default].
const LIMITS = { count: [1, 60, 4], size: [0, 1400, 56], hops: [1, 30, 20], probes: [1, 3, 2], port: [1, 65535, 443], cycles: [3, 60, 10], iperfPort: [1024, 65535, 5201] };

// The minutes an iperf3 server may run for, as the plugin allows them (the first is the default).
export const IPERF_MINUTES = [2, 1, 5, 15, 30];

// The DNS record types the page offers.
export const DNS_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'PTR', 'SRV', 'CAA'];

// The public resolvers the DNS comparison offers next to the router's own: [address, name].
export const PUBLIC_RESOLVERS = [['1.1.1.1', 'Cloudflare'], ['8.8.8.8', 'Google'], ['9.9.9.9', 'Quad9']];

// The most servers one comparison asks (the plugin enforces the same limit).
export const MAX_SERVERS = 6;

// The protocols the certificate check can upgrade to TLS (STARTTLS), as the plugin accepts them.
export const STARTTLS = ['smtp', 'imap', 'pop3', 'ftp'];

// Types busybox nslookup cannot show in full (it prints "mail exchanger = 0" with no host, for instance).
export const WEAK_NSLOOKUP = ['MX', 'TXT', 'NS', 'CNAME', 'SOA', 'SRV', 'CAA'];

// The empty form: the values each tool starts with.
export const blankForm = () => ({
  tool: 'ping', host: '', family: '', source: '',
  count: String(LIMITS.count[2]), size: String(LIMITS.size[2]),
  hops: String(LIMITS.hops[2]), probes: String(LIMITS.probes[2]), method: 'udp', resolve: '', asn: '1',
  cycles: String(LIMITS.cycles[2]), mtrMethod: 'icmp',
  type: 'A', server: '',
  port: '', sni: '', starttls: '',
  servers: ['router', '1.1.1.1', '8.8.8.8'], extraServer: '', iface: '', wolOther: false,
  minutes: String(IPERF_MINUTES[0]), iperfPort: String(LIMITS.iperfPort[2]), bind: '',
});

// A whole number between the limits of `field`, or null when the text is not one. Empty text is the default.
export function numberOf(text, field) {
  const [lo, hi, def] = LIMITS[field];
  const t = String(text ?? '').trim();
  if (t === '') return def;
  return /^\d+$/.test(t) && +t >= lo && +t <= hi ? +t : null;
}

// The request for `flab.diag start` from the form, or { error } when the form is not valid. Only the fields the
// chosen tool uses are sent.
export function requestOf(form) {
  const host = String(form.host ?? '').trim();
  // Wake-on-LAN takes a MAC address in the host field and an optional interface (empty: the one the host was seen on).
  if (form.tool === 'wol') {
    if (!isMac(host)) return { error: 'Enter a MAC address such as aa:bb:cc:dd:ee:ff.' };
    const iface = String(form.iface ?? '').trim();
    if (iface && !/^[A-Za-z0-9_.:-]{1,15}$/.test(iface)) return { error: 'The interface must be a network device name.' };
    return { args: iface ? { tool: 'wol', mac: normMac(host), iface } : { tool: 'wol', mac: normMac(host) } };
  }
  // The connectivity check works without a host (it uses the plugin's default name).
  if (form.tool === 'check') {
    if (host && !isHost(host)) return { error: 'Enter a host name, or leave it empty to use the default.' };
    return { args: host ? { tool: 'check', host } : { tool: 'check' } };
  }
  // The iperf3 server has no host: it listens for a chosen number of minutes on a port, on every address or on one of the
  // router's own.
  if (form.tool === 'iperf') {
    const minutes = +form.minutes;
    if (!IPERF_MINUTES.includes(minutes)) return { error: `The server may run for ${[...IPERF_MINUTES].sort((a, b) => a - b).join(', ')} minutes.` };
    const port = numberOf(form.iperfPort, 'iperfPort');
    if (port == null) return { error: `The port must be a whole number from ${LIMITS.iperfPort[0]} to ${LIMITS.iperfPort[1]}.` };
    const bind = String(form.bind ?? '').trim();
    if (bind && !isAddress(bind)) return { error: 'The address to listen on must be an IP address of the router.' };
    return { args: { tool: 'iperf', minutes, ...(port !== LIMITS.iperfPort[2] ? { port } : {}), ...(bind ? { bind } : {}) } };
  }
  if (!isHost(host)) return { error: 'Enter a host name or an IPv4 or IPv6 address.' };
  const source = String(form.source ?? '').trim();
  if (source && !isAddress(source) && !/^[A-Za-z0-9_.:-]{1,15}$/.test(source)) return { error: 'The source must be an address or an interface name.' };
  const args = { tool: form.tool, host };
  // Validates one numeric option against LIMITS and stores it in `args`; returns an error message, or null when valid.
  const need = (field, label) => {
    const n = numberOf(form[field], field);
    if (n == null) return `${label} must be a whole number from ${LIMITS[field][0]} to ${LIMITS[field][1]}.`;
    args[field] = n;
    return null;
  };
  let problem = null;
  if (form.tool === 'ping') {
    problem = need('count', 'The number of pings') ?? need('size', 'The packet size');
  } else if (form.tool === 'traceroute') {
    problem = need('hops', 'The maximum number of hops') ?? need('probes', 'The number of probes');
    if (form.method === 'icmp') args.method = 'icmp';
    if (form.resolve === '1') args.resolve = true;
    if (form.asn === '1') args.asn = true;
  } else if (form.tool === 'mtr') {
    problem = need('cycles', 'The number of rounds');
    if (form.mtrMethod === 'udp') args.method = 'udp';
  } else if (form.tool === 'trace') {
    args.type = form.type;
  } else if (form.tool === 'dns') {
    args.type = form.type;
    const server = String(form.server ?? '').trim();
    if (server && !isHost(server)) return { error: 'The DNS server must be a host name or an address.' };
    if (server) args.server = server;
  } else if (form.tool === 'compare') {
    args.type = form.type;
    const servers = [...(form.servers ?? [])];
    const extra = String(form.extraServer ?? '').trim();
    if (extra && !servers.includes(extra)) servers.push(extra);
    if (extra && !isHost(extra)) return { error: 'The extra DNS server must be a host name or an address.' };
    if (!servers.length) return { error: 'Choose at least one DNS server.' };
    if (servers.length > MAX_SERVERS) return { error: `Choose at most ${MAX_SERVERS} DNS servers.` };
    args.servers = servers;
  } else if (form.tool === 'tls') {
    problem = need('port', 'The port');
    const sni = String(form.sni ?? '').trim();
    if (sni && !isHost(sni)) return { error: 'The server name must be a host name.' };
    if (sni) args.sni = sni;
    if (form.starttls) {
      if (!STARTTLS.includes(form.starttls)) return { error: 'Choose one of the STARTTLS protocols, or none.' };
      args.starttls = form.starttls;
    }
  } else {
    return { error: 'Choose a tool.' };
  }
  if (problem) return { error: problem };
  if (form.tool === 'ping' || form.tool === 'traceroute') {
    if (form.family === '4' || form.family === '6') args.family = form.family;
    if (source) args.source = source;
  }
  if ((form.tool === 'mtr' || form.tool === 'trace') && (form.family === '4' || form.family === '6')) args.family = form.family;
  return { args };
}

//#endregion

//#region Ping

// What a ping's output says: the target, each reply, an error line, the summary the tool prints at the end and
// figures derived from the replies (they are available while the ping still runs).
//   { target: { name, ip } | null, replies: [{ seq, ttl, rtt, from }], dups, error, summary: { sent, received, loss } | null,
//     stats: { min, avg, max, jitter } | null, sent, lost, lossPct }
// `sent` and `lost` come from the summary when the tool printed it, otherwise from the sequence numbers seen so far
// (busybox prints nothing for a lost packet, so a gap in the sequence is the only sign of it).
export function parsePing(text) {
  const out = { target: null, replies: [], dups: 0, error: null, summary: null, stats: null, sent: 0, lost: 0, lossPct: null };
  for (const line of String(text ?? '').split('\n')) {
    let m;
    if ((m = line.match(/^PING (\S+) \(([^)]+)\)/))) out.target = { name: m[1], ip: m[2] };
    else if ((m = line.match(/^(\d+) bytes from (\S+?):? seq=(\d+) ttl=(\d+) time=([\d.]+) ms(.*)$/))) {
      if (/DUP!/.test(m[6])) out.dups++;
      else out.replies.push({ seq: +m[3], ttl: +m[4], rtt: +m[5], from: m[2].replace(/:$/, '') });
    } else if ((m = line.match(/^(\d+) packets transmitted, (\d+) packets received.*?(\d+)% packet loss/))) out.summary = { sent: +m[1], received: +m[2], loss: +m[3] };
    else if (/^ping: /.test(line)) out.error = line.replace(/^ping: /, '').trim();
  }
  const rtts = out.replies.map(r => r.rtt);
  if (rtts.length) {
    const jitter = rtts.length > 1 ? rtts.slice(1).reduce((s, v, i) => s + Math.abs(v - rtts[i]), 0) / (rtts.length - 1) : 0;
    out.stats = { min: Math.min(...rtts), avg: rtts.reduce((s, v) => s + v, 0) / rtts.length, max: Math.max(...rtts), jitter };
  }
  if (out.summary) {
    out.sent = out.summary.sent;
    out.lost = out.summary.sent - out.summary.received;
    out.lossPct = out.summary.loss;
  } else if (out.replies.length) {
    out.sent = Math.max(...out.replies.map(r => r.seq)) + 1;
    out.lost = Math.max(0, out.sent - out.replies.length);
    out.lossPct = out.sent ? Math.round(out.lost / out.sent * 100) : null;
  }
  return out;
}

// The kind of verdict for a finished ping ('ok', 'lossy', 'down', 'error'), for the badge and the colors.
export function pingVerdict(p) {
  if (p.error && !p.replies.length) return 'error';
  if (!p.replies.length) return p.summary || p.sent ? 'down' : 'error';
  return p.lossPct > 0 ? 'lossy' : 'ok';
}

//#endregion

//#region Traceroute

// One traceroute line after its hop number: the probes in order. A probe is { addr, name, rtt, flags } or null for "*".
// The tool prints a router once per run of probes it answered: "address", or "name (address)" when it resolves names
// (and "address (address)" for a router with no reverse record, which means no name), then the round-trip time;
// "!H", "!N" and similar annotations follow a time.
function probesOf(rest) {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const probes = [];
  let addr = null, name = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '*') { probes.push(null); continue; }
    if (t === 'ms') continue;
    if (/^!/.test(t)) { if (probes.at(-1)) probes.at(-1).flags.push(t); continue; }
    if (/^[\d.]+$/.test(t) && tokens[i + 1] === 'ms') { probes.push({ addr, name, rtt: +t, flags: [] }); continue; }
    const paren = t.match(/^\((.+)\)$/);
    if (paren) { name = addr && addr !== paren[1] ? addr : null; addr = paren[1]; continue; }
    addr = t;
    name = null;
  }
  return probes;
}

// What a traceroute's output says: the target, the hops so far and whether the destination answered.
//   { target: { name, ip } | null, maxHops, hops: [{ n, probes, addrs, routers: [{ addr, name }], rtts, avg, silent }],
//     reached, error }
export function parseTraceroute(text) {
  const out = { target: null, maxHops: null, hops: [], reached: false, error: null };
  for (const line of String(text ?? '').split('\n')) {
    let m;
    if ((m = line.match(/^traceroute to (\S+) \(([^)]+)\), (\d+) hops max/))) { out.target = { name: m[1], ip: m[2] }; out.maxHops = +m[3]; }
    else if ((m = line.match(/^\s*(\d+)\s+(.*)$/))) {
      const probes = probesOf(m[2]);
      const rtts = probes.filter(Boolean).map(p => p.rtt);
      const routers = [];
      for (const p of probes.filter(Boolean)) {
        const seen = routers.find(r => r.addr === p.addr);
        if (!seen) routers.push({ addr: p.addr, name: p.name });
        else if (!seen.name && p.name) seen.name = p.name;
      }
      out.hops.push({
        n: +m[1], probes, rtts, silent: !rtts.length, routers,
        addrs: routers.map(r => r.addr).filter(Boolean),
        avg: rtts.length ? rtts.reduce((s, v) => s + v, 0) / rtts.length : null,
      });
    } else if (/^traceroute: /.test(line)) out.error = line.replace(/^traceroute: /, '').trim();
  }
  out.reached = Boolean(out.target) && out.hops.some(h => h.addrs.includes(out.target.ip));
  return out;
}

//#endregion

//#region DNS

// What a DNS lookup's output says: 'ok' with the number of answers, 'nxdomain', 'servfail', 'refused', 'timeout' or
// 'empty' (a valid reply with no answer), with the name of the tool that printed it ('dig' and 'kdig' print a header,
// 'drill' likewise, busybox 'nslookup' prints answer lines).
export function parseDns(text) {
  const t = String(text ?? '');
  const out = { verdict: 'ok', answers: 0, server: null };
  const server = t.match(/^(?:Server:\s+(\S+)|;; SERVER: (\S+)|;; From (\S+?)@)/m);
  out.server = server ? server[1] ?? server[2] ?? server[3] : null;
  if (/NXDOMAIN/.test(t)) out.verdict = 'nxdomain';
  else if (/SERVFAIL/.test(t)) out.verdict = 'servfail';
  else if (/REFUSED/.test(t)) out.verdict = 'refused';
  else if (/timed out|no servers could be reached|connection timed out|;; No response|response timeout|failed to query/i.test(t)) out.verdict = 'timeout';
  const header = t.match(/ANSWER: (\d+)/);
  if (header) {
    out.answers = +header[1];
  } else {
    // busybox nslookup: the "Server:/Address:" block names the resolver; every later "Address:" line, and every
    // "<name> <type> = <data>" line (PTR, MX, TXT, NS, CNAME, SRV), is an answer.
    const body = t.replace(/^Server:.*\n(?:Address:.*\n)?/m, '');
    out.answers = (body.match(/^Address: /gm) ?? []).length + (body.match(/\s(?:name|text|nameserver|canonical name|service|mail exchanger)\s=\s/g) ?? []).length;
  }
  if (out.verdict === 'ok' && out.answers === 0 && /\S/.test(t)) out.verdict = 'empty';
  return out;
}

//#endregion

//#region Blocks

// Splits the output of a script job into its blocks: `### BEGIN <id> <uptime> <detail>` … `### END <exit> <uptime>`.
//   [{ id, detail, output, running, exit, secs }]
// A block with no END line is still running (`exit` and `secs` are null). Text outside any block is ignored.
export function parseBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    let m;
    if ((m = line.match(/^### BEGIN (\S+) ([\d.]+)\s*(.*)$/))) {
      cur = { id: m[1], detail: m[3].trim(), output: [], running: true, exit: null, secs: null, t0: +m[2] };
      blocks.push(cur);
    } else if (cur && (m = line.match(/^### END (\d+) ([\d.]+)$/))) {
      cur.running = false;
      cur.exit = +m[1];
      cur.secs = Math.max(0, +m[2] - cur.t0);
      cur = null;
    } else if (cur) {
      cur.output.push(line);
    }
  }
  return blocks.map(({ t0, output, ...b }) => ({ ...b, output: output.join('\n').replace(/\n+$/, '') }));
}

// The lines of a script job's output that are not inside any block (the shell's own complaints, such as a syntax error in
// the script), with blank lines left out.
export function outsideBlocks(text) {
  const out = [];
  let inside = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^### BEGIN \S+ [\d.]+/.test(line)) inside = true;
    else if (inside && /^### END \d+ [\d.]+$/.test(line)) inside = false;
    else if (!inside && /\S/.test(line)) out.push(line.trim());
  }
  return out;
}

// What went wrong with a finished script job (the connectivity check, the comparison, the certificate check, the DNS trace
// or a traceroute with AS lookups) in words, or null: the shell's own complaint when the script could not run, or a note
// that nothing was produced. A job that was stopped or hit its time limit is not a failure of the script.
export function scriptProblem(job) {
  const script = ['check', 'compare', 'tls', 'trace'].includes(job.tool) || (job.tool === 'traceroute' && job.asn);
  if (job.running || job.stopped || job.timedOut || !script) return null;
  const stray = outsideBlocks(job.text);
  if (stray.length) return `The job script could not run: ${stray.slice(0, 3).join(' ')}`;
  if (!parseBlocks(job.text).length && !job.error) return 'The job produced no output.';
  return null;
}

//#endregion

//#region DNS comparison

// What one DNS reply says, whichever tool printed it (kdig, dig and drill print a header and an answer section, busybox
// nslookup prints "Address:" lines).
//   { verdict, answers: [{ name, ttl, type, data }], data: [sorted answer data], ms, ad }
// `verdict` is as in parseDns. `ms` is the query time the tool reports, or null; `ad` says the resolver validated the
// answer with DNSSEC.
export function dnsReply(text) {
  const t = String(text ?? '');
  const out = { ...parseDns(t), answers: [], ms: null, ad: false };
  let section = false;
  for (const line of t.split('\n')) {
    if (/^;; ANSWER SECTION/.test(line)) { section = true; continue; }
    if (section && !/\S/.test(line)) section = false;
    const m = section && line.match(/^(\S+)\s+(\d+)\s+IN\s+(\S+)\s+(.+?)\s*$/);
    if (m) out.answers.push({ name: m[1], ttl: +m[2], type: m[3], data: m[4] });
  }
  if (!out.answers.length && !/ANSWER:/.test(t)) {
    // busybox nslookup: the first "Address:" belongs to the server.
    const addrs = [...t.matchAll(/^Address:\s+(\S+)/gm)].map(x => x[1].replace(/#\d+$/, '')).slice(1);
    for (const data of addrs) out.answers.push({ name: null, ttl: null, type: null, data });
  }
  const flags = t.match(/;; flags:\s*([a-z ]*?)\s*;/i);
  out.ad = Boolean(flags && flags[1].split(/\s+/).includes('ad'));
  const ms = t.match(/;; From \S+ in ([\d.]+) ms/) ?? t.match(/;; Query time: (\d+) msec/);
  out.ms = ms ? +ms[1] : null;
  out.data = out.answers.map(a => a.data).sort();
  return out;
}

// The DNS comparison: one row per server in the order asked, and whether the servers agree.
//   { rows: [{ server, running, verdict, answers, data, ms, ad, secs, text }], agree, fastest, done }
// `agree` is true when every server that answered gave the same set of answers, false when two sets differ, and null
// when fewer than two servers answered. (A name behind a CDN can give each resolver a different, correct set.)
export function parseCompare(text, total = null) {
  const blocks = parseBlocks(text).filter(b => b.id === 'server');
  const rows = blocks.map(b => {
    if (b.running) return { server: b.detail, running: true, verdict: null, answers: [], data: [], ms: null, ad: false, secs: null, text: b.output };
    const r = dnsReply(b.output);
    return { server: b.detail, running: false, verdict: r.verdict, answers: r.answers, data: r.data, ms: r.ms ?? (r.verdict === 'timeout' ? null : Math.round(b.secs * 1000)), ad: r.ad, secs: b.secs, text: b.output };
  });
  const answered = rows.filter(r => r.verdict === 'ok');
  const sets = new Set(answered.map(r => r.data.join('|')));
  const timed = answered.filter(r => r.ms != null);
  return {
    rows,
    agree: answered.length < 2 ? null : sets.size === 1,
    fastest: timed.length > 1 ? timed.reduce((a, b) => (b.ms < a.ms ? b : a)).server : null,
    done: rows.length > 0 && rows.every(r => !r.running) && (total == null || rows.length >= total),
  };
}

//#endregion

//#region TLS certificate

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// A date as openssl prints it ("Sep  3 00:00:00 2025 GMT") as a time in milliseconds, or null when it is not one.
export function parseCertDate(text) {
  const m = String(text ?? '').trim().match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d\d):(\d\d):(\d\d)\s+(\d{4})\s+GMT$/);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return month < 0 ? null : Date.UTC(+m[6], month, +m[2], +m[3], +m[4], +m[5]);
}

// Whether `name` is covered by one of the certificate names: an exact match, or a wildcard ("*.example.com") standing
// for exactly one label. Case does not matter.
export function nameMatches(name, names) {
  const n = String(name).toLowerCase();
  return names.some(entry => {
    const e = entry.toLowerCase();
    if (e === n) return true;
    const dot = n.indexOf('.');
    return e.startsWith('*.') && dot > 0 && e.slice(2) === n.slice(dot + 1);
  });
}

// What each openssl verification code means here, in the words of the page.
const VERIFY_TEXT = {
  9: 'The certificate is not valid yet. Its start date is still in the future, which is also what a router with a wrong clock sees.',
  10: 'The certificate has expired.',
  18: 'The certificate is self-signed: no authority vouches for it.',
  19: 'The chain ends in a self-signed certificate that the router does not trust.',
  20: 'The router does not know the issuer of this certificate. Either the server did not send its whole chain, or the router has no CA bundle (ca-bundle package).',
  21: 'The chain cannot be completed: the server probably did not send its intermediate certificate.',
  62: 'The certificate does not cover the name that was asked for.',
  64: 'The certificate does not cover the address that was asked for.',
};

// The short key description of an s_client "a:" line: "RSA 2048 bit", "EC prime256v1".
function keyOf(text) {
  const m = text.match(/PKEY:\s*([^,;]+),\s*\(?([^;)]+?)(?:\))?\s*(\(bit\))?\s*;/);
  if (!m) return null;
  return m[3] ? `${m[1]} ${m[2].trim()} bit` : `${m[1]} ${m[2].trim()}`;
}

// What a certificate check's output says: the connection, the chain and the findings.
//   { running, error, address, protocol, cipher, group, verify: { code, text } | null, chain: [certificate], gaps, findings, level }
// `chain` is exactly what the server sent, in order; `gaps` the positions i where certificate i was not issued by
// certificate i + 1.
// A certificate is { n, subject, issuer, key, bits, sigalg, notBefore, notAfter, daysLeft, serial, sha256, sans, ca,
// selfSigned, role, pem }. `findings` is [{ level: 'ok' | 'warn' | 'bad', text }] and `level` the worst of them.
// `ctx.name` is the name the certificate should cover (none for an address, which is matched against its IP names), and
// `now` the time to judge dates by, in milliseconds.
export function parseTls(text, ctx = {}, now = Date.now()) {
  const block = parseBlocks(text).find(b => b.id === 'tls');
  const out = { running: !block || block.running, error: null, address: null, protocol: null, cipher: null, group: null, verify: null, chain: [], gaps: [], findings: [], level: 'ok' };
  if (!block) return out;
  const lines = block.output.split('\n');
  let section = '';
  let cert = null, pem = null, extra = null, field = '';
  const detail = new Map();
  for (const line of lines) {
    let m;
    if ((m = line.match(/^Connecting to (\S+)/))) out.address = m[1];
    if (/^Certificate chain/.test(line)) { section = 'chain'; continue; }
    if (/^### CERT (\d+)/.test(line)) { section = 'cert'; extra = {}; detail.set(+line.match(/(\d+)/)[1], extra); field = ''; continue; }
    if (section === 'chain') {
      if ((m = line.match(/^\s*(\d+) s:(.*)$/))) { cert = { n: +m[1], subject: m[2].trim(), issuer: '', key: null, bits: null, sigalg: null, notBefore: null, notAfter: null, pem: '' }; out.chain.push(cert); pem = null; }
      else if (cert && (m = line.match(/^\s+i:(.*)$/))) cert.issuer = m[1].trim();
      else if (cert && (m = line.match(/^\s+a:(.*)$/))) {
        cert.key = keyOf(m[1]);
        const bits = m[1].match(/(\d+) \(bit\)/);
        cert.bits = bits ? +bits[1] : null;
        cert.sigalg = (m[1].match(/sigalg:\s*(\S+)/) ?? [])[1] ?? null;
      } else if (cert && (m = line.match(/^\s+v:NotBefore:\s*(.*?);\s*NotAfter:\s*(.*)$/))) {
        cert.notBefore = parseCertDate(m[1]);
        cert.notAfter = parseCertDate(m[2]);
      } else if (cert && /^-----BEGIN CERTIFICATE-----/.test(line)) { pem = [line]; }
      else if (pem) { pem.push(line); if (/^-----END CERTIFICATE-----/.test(line)) { cert.pem = pem.join('\n'); pem = null; } }
      else if (/^---/.test(line)) section = '';
      continue;
    }
    if (section === 'cert') {
      if ((m = line.match(/^serial=(\S+)/))) extra.serial = m[1];
      else if ((m = line.match(/^sha256 Fingerprint=(\S+)/i))) extra.sha256 = m[1];
      else if (/^X509v3 Subject Alternative Name/.test(line)) field = 'sans';
      else if (/^X509v3 Basic Constraints/.test(line)) field = 'ca';
      else if (field === 'sans' && /^\s+\S/.test(line)) extra.sans = [...(extra.sans ?? []), ...line.split(',').map(s => s.trim()).filter(Boolean)];
      else if (field === 'ca' && (m = line.match(/CA:(TRUE|FALSE)/))) extra.ca = m[1] === 'TRUE';
      continue;
    }
    if ((m = line.match(/^Protocol:\s*(\S+)/))) out.protocol = m[1];
    else if ((m = line.match(/Cipher is (\S+)/)) && m[1] !== '(NONE)') out.cipher = m[1];
    else if ((m = line.match(/^Negotiated TLS1\.3 group:\s*(\S+)/)) && m[1] !== '<NULL>') out.group = m[1];
    else if ((m = line.match(/^Server Temp Key:\s*(.*)$/))) out.group = m[1].trim();
    else if ((m = line.match(/^\s*Verify return code:\s*(\d+) \((.*)\)/))) out.verify = { code: +m[1], text: m[2] };
  }
  for (const c of out.chain) {
    const d = detail.get(c.n + 1) ?? {};
    Object.assign(c, { serial: d.serial ?? null, sha256: d.sha256 ?? null, sans: d.sans ?? [], ca: d.ca ?? null });
    c.selfSigned = c.subject === c.issuer;
    c.daysLeft = c.notAfter == null ? null : Math.floor((c.notAfter - now) / 86400000);
    c.role = c.n === 0 ? 'Server certificate' : c.selfSigned ? 'Root' : 'Intermediate';
  }
  // The chain as the server sent it, judged on its own: each certificate should have been issued by the next one. The
  // router's CA store plays no part here (s_client lists the certificates received, not the ones it verified).
  out.gaps = out.chain.flatMap((c, i) => (i + 1 < out.chain.length && c.issuer !== out.chain[i + 1].subject ? [i] : []));
  if (!out.chain.length && !block.running) {
    out.error = connectionError(block.output, ctx);
    out.verify = null;
    out.findings = [{ level: 'bad', text: out.error }];
  } else if (!block.running) out.findings = findingsOf(out, ctx, now);
  out.level = out.findings.some(f => f.level === 'bad') ? 'bad' : out.findings.some(f => f.level === 'warn') ? 'warn' : 'ok';
  return out;
}

// Why no certificate came back, in words: the refusal, the timeout, the unknown name or a server that hung up.
function connectionError(output, ctx) {
  const target = ctx.target ?? 'the server';
  if (/errno=111|Connection refused/.test(output)) return `${target} refused the connection. Nothing is listening on that port.`;
  if (/errno=110|errno=113|timed out|Operation timed out/i.test(output)) return `${target} did not answer in time.`;
  if (/Name or service not known|getaddrinfo|Temporary failure in name resolution|bad address/i.test(output)) return `The name ${target} could not be resolved.`;
  if (/errno=104|no peer certificate/.test(output)) return `${target} closed the connection during the handshake without sending a certificate. A server that picks its certificate by name often does this when it does not know the name asked for.`;
  return `No certificate was received from ${target}.`;
}

// What the certificates the server sent say about the chain itself, whatever the router's CA store would add: a lone
// certificate without its issuer, a gap or a wrong order, or a chain in order. Each finding has `chain: true`.
function chainFindings(t, leaf) {
  const sent = t.chain.length;
  const last = t.chain[sent - 1];
  const trusted = t.verify?.code === 0;
  if (t.gaps.length) {
    const i = t.gaps[0];
    return [{ level: 'warn', chain: true, text: `The chain the server sent is incomplete or out of order: certificate ${i} was issued by ${t.chain[i].issuer}, but the next certificate it sent is ${t.chain[i + 1].subject}.${trusted ? ' The router only trusts it because its own CA store fills the gap.' : ''}` }];
  }
  if (sent === 1 && !leaf.selfSigned)
    return [{ level: 'warn', chain: true, text: `The server sent only its own certificate, without the certificate of its issuer (${leaf.issuer}). A client that does not already have that issuer cannot verify it.${trusted ? ' The router only trusts it because its own CA store holds that issuer.' : ''}` }];
  if (sent > 1 && last.selfSigned)
    return [{ level: 'ok', chain: true, text: `The server sent ${sent} certificates in order, up to the root ${last.subject}.` }];
  if (sent > 1 && t.verify?.code !== 20 && t.verify?.code !== 21)
    return [{ level: 'ok', chain: true, text: `The server sent ${sent} certificates in order, ending with ${last.subject}; the root that issued it is not part of the chain, as usual.` }];
  return [];
}

// What the chain and the session mean: the trust verdict, the name, the dates, weak algorithms and old protocols.
function findingsOf(t, ctx, now) {
  const f = [];
  const leaf = t.chain[0];
  if (!leaf) return f;
  const name = ctx.name ?? null;
  const names = leaf.sans.length ? leaf.sans.map(s => s.replace(/^(DNS|IP Address):/i, '').trim()) : [(leaf.subject.match(/CN\s*=\s*([^,]+)/) ?? [])[1]?.trim()].filter(Boolean);
  const namesKnown = leaf.sans.length > 0;
  // Without the names list (the connectivity check does not read it) openssl's own verdict on the name stands in.
  const covered = name == null ? null : namesKnown ? nameMatches(name, names) : t.verify ? !(t.verify.code === 62 || t.verify.code === 64) : null;
  if (t.verify) {
    if (t.verify.code === 0) f.push({ level: 'ok', text: 'The chain is trusted: it leads to a certificate authority in the router\'s store.' });
    else if (!(t.verify.code === 62 || t.verify.code === 64) || covered !== false) {
      // An expiry the dates below already report is not said twice.
      if (!(t.verify.code === 10 && leaf.daysLeft != null && leaf.daysLeft < 0)) f.push({ level: 'bad', text: VERIFY_TEXT[t.verify.code] ?? `The certificate is not trusted: ${t.verify.text}.` });
    }
  }
  f.push(...chainFindings(t, leaf));
  if (covered === true) f.push({ level: 'ok', text: `The certificate covers ${name}.` });
  else if (covered === false) f.push({ level: 'bad', text: `The certificate does not cover ${name}. It is valid for ${names.join(', ') || 'no name'}.` });
  if (leaf.notBefore != null && leaf.notBefore > now) f.push({ level: 'bad', text: `The certificate is not valid until ${new Date(leaf.notBefore).toISOString().slice(0, 10)}.` });
  else if (leaf.daysLeft != null && leaf.daysLeft < 0) f.push({ level: 'bad', text: `The certificate expired ${-leaf.daysLeft} day${leaf.daysLeft === -1 ? '' : 's'} ago.` });
  else if (leaf.daysLeft != null && leaf.daysLeft <= 14) f.push({ level: 'warn', text: `The certificate expires in ${leaf.daysLeft} day${leaf.daysLeft === 1 ? '' : 's'}.` });
  else if (leaf.daysLeft != null) f.push({ level: 'ok', text: `The certificate is valid for ${leaf.daysLeft} more days.` });
  for (const c of t.chain) {
    if (c.bits != null && /^RSA/.test(c.key ?? '') && c.bits < 2048) f.push({ level: 'warn', text: `Certificate ${c.n} has a weak ${c.bits} bit RSA key.` });
    if (/sha1|md5/i.test(c.sigalg ?? '') && !c.selfSigned) f.push({ level: 'warn', text: `Certificate ${c.n} is signed with ${c.sigalg}, which is no longer considered safe.` });
  }
  if (t.protocol && /^(SSL|TLSv1(\.[01])?$)/.test(t.protocol)) f.push({ level: 'warn', text: `The server negotiated ${t.protocol}, which is older than TLS 1.2.` });
  return f;
}

//#endregion

//#region Connectivity check

// The checks in the order they run: [id, title].
export const CHECK_STEPS = [
  ['route', 'Default route'], ['gateway', 'Next hop'], ['internet', 'Internet (IPv4)'], ['dns_router', 'DNS through the router'],
  ['dns_public', 'DNS through a public resolver'], ['ipv6', 'Internet (IPv6)'], ['dns6', 'DNS (IPv6 records)'], ['tls', 'Secure connection (TLS)'],
];

// The summary of a ping block: { ok, partial, lossPct, avg, p } with `ok` when every ping was answered.
function pingOf(block) {
  const p = parsePing(block.output);
  return { p, ok: p.replies.length > 0 && p.lossPct === 0, partial: p.replies.length > 0 && p.lossPct > 0, avg: p.stats?.avg ?? null };
}

// The connectivity check: the steps with their state and the verdict.
//   { steps: [{ id, title, state: 'pending' | 'running' | 'ok' | 'warn' | 'bad' | 'skip', text, output, tls? }], verdict, done }
// `verdict` is { level, text, notes: [text] } once the check is far enough to tell, otherwise null. `running` says whether
// the job is still going (a missing block is then pending rather than skipped). `now` is the time for the certificate.
export function parseCheck(text, running, ctx = {}, now = Date.now()) {
  const blocks = parseBlocks(text);
  // All blocks with the given id (a step can have several, such as one per public address).
  const of = id => blocks.filter(b => b.id === id);
  // The first block with the given id, or null.
  const first = id => of(id)[0] ?? null;
  const steps = CHECK_STEPS.map(([id, title]) => ({ id, title, state: running ? 'pending' : 'skip', text: '', output: '' }));
  // The step with the given id.
  const step = id => steps.find(s => s.id === id);
  // Records the outcome of a step: its state, message and the output of the blocks it was judged from.
  const set = (id, state, msg, blocksUsed = []) => {
    const s = step(id);
    s.state = state;
    s.text = msg;
    s.output = blocksUsed.map(b => b.output).join('\n');
  };
  // Marks `id` as running when one of its blocks (named `from`, the step id by default) has no END line yet.
  const busy = (id, from = id) => { const bs = of(from); if (bs.some(b => b.running)) { step(id).state = 'running'; step(id).output = bs.map(b => b.output).join('\n'); return true; } return false; };

  // Default route
  const r4 = first('route4');
  const via = r4?.output.match(/^default(?: via (\S+))? dev (\S+)/m);
  if (r4 && !r4.running) set('route', via ? 'ok' : 'bad', via ? `${via[1] ? `via ${via[1]} ` : ''}on ${via[2]}` : 'The router has no default IPv4 route, so it does not know where to send internet traffic.', [r4]);

  // Next hop
  const gw = first('gateway');
  const gwAddr = gw?.detail.split(/\s+/)[0] ?? '';
  if (gw && gw.running) busy('gateway');
  else if (gw) {
    if (!gwAddr) set('gateway', 'skip', 'No next hop address could be found.', [gw]);
    else {
      const g = pingOf(gw);
      set('gateway', g.ok ? 'ok' : g.partial ? 'warn' : 'bad', g.ok ? `${gwAddr} answers (${fmtMs(g.avg)})` : g.partial ? `${gwAddr} loses some pings` : `${gwAddr} does not answer`, [gw]);
    }
  }

  // Internet over IPv4: two public addresses, so that one unreachable service does not decide it.
  const inet = of('internet4');
  if (inet.some(b => b.running)) busy('internet', 'internet4');
  else if (inet.length >= 2) {
    const res = inet.map(b => [b.detail, pingOf(b)]);
    const up = res.filter(([, g]) => g.ok || g.partial);
    set('internet', up.length === res.length && res.every(([, g]) => g.ok) ? 'ok' : up.length ? 'warn' : 'bad',
      up.length ? `${up.map(([a, g]) => `${a} (${fmtMs(g.avg)})`).join(' and ')} answer${up.length === 1 ? 's' : ''}${up.length < res.length ? `; ${res.filter(([, g]) => !g.ok && !g.partial).map(([a]) => a).join(' and ')} does not` : ''}` : `Neither ${res.map(([a]) => a).join(' nor ')} answers.`, inet);
  }

  // DNS through the router and through a public resolver
  for (const [id, label] of [['dns_router', 'The router\'s resolver'], ['dns_public', 'The public resolver 1.1.1.1']]) {
    const b = first(id);
    if (!b) continue;
    if (b.running) { busy(id); continue; }
    const r = dnsReply(b.output);
    const msg = { ok: `${label} answers with ${r.answers.length} address${r.answers.length === 1 ? '' : 'es'}${r.ms != null ? ` in ${fmtMs(r.ms)}` : ''}`, empty: `${label} answers, but with no address`, nxdomain: `${label} says the name does not exist`, servfail: `${label} fails (SERVFAIL)`, refused: `${label} refuses the query`, timeout: `${label} does not answer` }[r.verdict];
    set(id, r.verdict === 'ok' ? 'ok' : r.verdict === 'empty' ? 'warn' : 'bad', msg, [b]);
  }

  // IPv6: no default route means IPv6 is simply not in use, which is not a fault.
  const r6 = first('route6');
  const i6 = first('internet6');
  if (r6 && !r6.running && !/^default/m.test(r6.output)) set('ipv6', 'skip', 'No IPv6 default route: IPv6 is not in use on this router.', [r6]);
  else if (i6 && i6.running) busy('ipv6', 'internet6');
  else if (i6) {
    const g = pingOf(i6);
    set('ipv6', g.ok ? 'ok' : g.partial ? 'warn' : 'bad', g.ok ? `${i6.detail} answers (${fmtMs(g.avg)})` : g.partial ? `${i6.detail} loses some pings` : `${i6.detail} does not answer over IPv6`, [i6]);
  }
  const d6 = first('dns6');
  if (d6 && d6.running) busy('dns6');
  else if (d6) {
    const r = dnsReply(d6.output);
    set('dns6', r.verdict === 'ok' ? 'ok' : 'warn', r.verdict === 'ok' ? `${r.answers.length} IPv6 address${r.answers.length === 1 ? '' : 'es'} found` : r.verdict === 'empty' ? 'The name has no IPv6 address.' : 'The lookup for IPv6 addresses failed.', [d6]);
  }

  // TLS
  const tlsBlock = first('tls');
  let tls = null;
  if (tlsBlock && tlsBlock.running) busy('tls');
  else if (tlsBlock) {
    tls = parseTls(text, { name: ctx.name, target: ctx.name }, now);
    const leaf = tls.chain[0];
    const bad = tls.findings.find(x => x.level === 'bad') ?? tls.findings.find(x => x.level === 'warn' && x.chain);
    set('tls', tls.error ? 'bad' : tls.level, tls.error ?? (bad ? bad.text : leaf ? `${tls.protocol ?? 'TLS'} · certificate for ${ctx.name ?? 'the server'} is trusted, ${leaf.daysLeft} days left` : 'No certificate was received.'), [tlsBlock]);
    step('tls').tls = tls;
  }

  // The state of a step once it has been judged.
  const state = id => step(id).state;
  const notes = [];
  if (state('ipv6') === 'bad') notes.push('IPv4 works, but IPv6 does not: the router has an IPv6 default route that does not lead anywhere. Applications that prefer IPv6 can be slow.');
  let verdict = null;
  const anyPending = steps.some(s => s.state === 'pending' || s.state === 'running');
  if (state('route') === 'bad') verdict = { level: 'bad', text: 'The router has no default route, so it cannot reach the internet. Check that the WAN interface is up and has an address.' };
  else if (state('internet') === 'bad' && state('gateway') === 'bad') verdict = { level: 'bad', text: `The next hop ${gwAddr} does not answer. The link to the provider (the modem, the cable or the PPP session) is the first thing to check.` };
  else if (state('internet') === 'bad') verdict = { level: 'bad', text: `${state('gateway') === 'ok' ? 'The next hop answers, but nothing' : 'Nothing'} on the internet does. The provider may have an outage, or a firewall or routing rule is blocking the traffic.` };
  else if (state('dns_router') === 'bad' && state('dns_public') === 'ok') verdict = { level: 'bad', text: 'The internet works, but the router\'s DNS resolver fails while a public one answers. Check the resolver on the router (Unbound or dnsmasq) and the servers it asks.' };
  else if (state('dns_router') === 'bad' && state('dns_public') === 'bad' && state('internet') === 'ok') verdict = { level: 'bad', text: 'The internet works, but no name can be looked up through either the router or a public resolver. DNS traffic (port 53) may be blocked.' };
  else if (tls && (tls.error || tls.level === 'bad')) {
    const code = tls.verify?.code;
    verdict = { level: 'warn', text: (code === 9 || code === 10) ? 'Connections work, but the certificate looks out of date: this often means the router\'s clock is wrong. Check the time on the System page.' : tls.error ? 'Connections work, but the secure connection test failed.' : 'Connections and names work, but the certificate of the test server is not trusted. The router may be missing its CA bundle, or something on the path is intercepting TLS.' };
  } else if (!anyPending && steps.every(s => s.state === 'ok' || s.state === 'skip')) verdict = { level: 'ok', text: 'Everything works: the router reaches the internet, resolves names and makes secure connections.' };
  else if (!anyPending) verdict = { level: 'warn', text: 'The router is online, with some warnings in the steps above.' };
  return { steps, verdict: verdict ? { ...verdict, notes } : null, done: !anyPending && !running, tls };
}

//#endregion

//#region Job state

// How a finished job ended, as text for the status line: { kind: 'ok' | 'stopped' | 'limit' | 'failed', text }.
// `limit` is the number of seconds the tool was allowed to run. An iperf3 server is meant to run until its time is up (the
// timeout ends it with code 124) or until the user stops it (it then exits with 0, so the page's own note of the Stop is used).
export function endOf(job, limit) {
  if (job.error) return { kind: 'failed', text: 'Failed' };
  if (job.stopped || job.stopRequested) return { kind: 'stopped', text: 'Stopped' };
  if (job.timedOut) return job.tool === 'iperf' ? { kind: 'ok', text: 'Time is up' } : { kind: 'limit', text: `Stopped at the ${limit} second limit` };
  if (job.exit === 0 || job.exit === 1) return { kind: 'ok', text: 'Finished' };
  return { kind: 'failed', text: job.exit == null ? 'Ended' : `Failed (exit code ${job.exit})` };
}

// A time in milliseconds, with the precision that suits its size ("0.12 ms", "4.3 ms", "120 ms").
export function fmtMs(n) {
  if (n == null) return '–';
  return `${n < 10 ? n.toFixed(n < 1 ? 2 : 1) : Math.round(n)} ms`;
}

//#endregion
