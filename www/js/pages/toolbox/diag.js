// The Toolbox tools: a connectivity check, ping, traceroute, MTR, DNS lookups (one server, or several to compare), a DNS
// trace, a certificate check, a packet capture, an iperf3 server and Wake-on-LAN. Each runs on the router with its output
// streaming in as it is produced, shown as statistics, a hop table, the answers, a certificate chain or a checklist (the
// views of the richer tools are in diagviews.js and the files next to it).
//
// The plugin (rpcd/ucode/flab.diag.uc) runs each tool as a detached job; this module starts it, then polls `read`
// every half second until the job ends (the page's own poll is not involved, and it is not needed: a job is a few
// seconds long, or, for the iperf3 server and a capture, ends by itself at the limit). The form and the job live in the
// page's state (`state.diag`), so they survive redraws and leaving the page; the result is painted into one element that
// the view creates on every redraw, so a redraw in the middle of a job simply continues with the new element.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { can, ubus } from '../../core/ubus.js';
import { disclosure } from '../../core/fold.js';
import { badge, button, card, mono, muted } from '../../core/ui.js';
import { CAPTURE, DNS_TYPES, IPERF_MINUTES, MAX_SERVERS, PUBLIC_RESOLVERS, STARTTLS, WEAK_NSLOOKUP, blankForm, endOf, fmtMs, hostOf, isAddress, isMac, normMac, parseBlocks, parseDns, parsePing, parseTraceroute, pingVerdict, requestOf, scriptProblem } from './diagmodel.js';
import { checkBody, compareBody, stat, tlsBody, wolBody } from './diagviews.js';
import { pingChart } from './charts.js';
import { captureBody } from './captureview.js';
import { iperfBody } from './iperfview.js';
import { dnsTraceBody } from './dnstraceview.js';
import { asnLine, asPathView, mtrBody } from './pathview.js';
import { parseAsn } from './pathmodel.js';
import { retainOutput } from './output.js';
import { banner, failure, timeBar, working } from './parts.js';

// How often a running job is read, in milliseconds.
const READ_EVERY = 500;
// How long the tool list and interface names are reused before they are read again, in milliseconds.
const STATUS_TTL = 60000;

// The tools offered, with their labels: [id, label]. The label is also the heading of the tool's result.
const TOOLS = [['check', 'Connectivity check'], ['ping', 'Ping'], ['traceroute', 'Traceroute'], ['mtr', 'MTR'], ['dns', 'DNS lookup'], ['trace', 'DNS trace'], ['tls', 'TLS certificate'], ['capture', 'Packet capture'], ['iperf', 'iperf3 server'], ['wol', 'Wake-on-LAN']];

// The heading of a result for each job (a DNS lookup of two or more servers runs as the plugin's `compare` tool).
const TITLES = { ...Object.fromEntries(TOOLS), compare: 'DNS lookup' };

// Whether the router has what `tool` needs (`status` is the plugin's answer).
const available = (status, tool) => {
  const t = status.tools ?? {};
  return { ping: t.ping, traceroute: t.traceroute, mtr: t.mtr, dns: Boolean(status.dns_tool), trace: t.kdig, check: t.ping && Boolean(status.dns_tool), tls: t.openssl, capture: Boolean(status.capture), iperf: Boolean(status.iperf), wol: Boolean(status.wol) }[tool];
};

// The select value of "Another MAC address…" in the Wake-on-LAN host list.
const WOL_OTHER = '__other';

let cached = null;
let cachedAt = 0;

// The state of this tab: the form, the error under it, the current job with its poll timer (and whether a read is under way)
// and result element, whether a button elsewhere asked for a run (`autorun`), the plugin's last `status`, and whether the
// result's "Raw output" is open.
export const newDiag = () => ({ form: blankForm(), formError: null, job: null, timer: null, polling: false, resultEl: null, autorun: false, status: null, rawOpen: false, defaulted: false });

// Reads what the router can run (the tools, the DNS tool it would use, its interfaces), reusing the last answer for a
// minute because it does not change while the page is open.
export async function loadDiag() {
  if (!cached || Date.now() - cachedAt > STATUS_TTL) {
    cached = await ubus('flab.diag', 'status');
    cachedAt = Date.now();
  }
  return { tab: 'diag', status: cached };
}

//#region Running a job

// Seconds a job has been running, or ran for.
const elapsed = job => Math.max(0, Math.round(((job.t1 ?? Date.now()) - job.t0) / 1000));

// Starts a job from the form. A refused request (the plugin checks everything again) becomes the job's error.
async function start(state) {
  const d = state.diag;
  if (d.job?.running) return;
  if (d.form.tool === 'wol' && !d.form.wolOther && d.status?.hosts?.length && !hostOf(d.status.hosts, d.form.host)) {
    d.formError = 'Choose a host from the list, or pick "Another MAC address…" and enter one.';
    return state.rerender();
  }
  const req = requestOf(d.form);
  if (req.error) { d.formError = req.error; return state.rerender(); }
  d.formError = null;
  const job = {
    tool: req.args.tool, host: req.args.tool === 'iperf' || req.args.tool === 'capture' ? '' : req.args.host ?? req.args.mac ?? cached?.check_host ?? 'example.com', id: null, command: '', text: '', size: 0, running: true, exit: null, stopped: false, stopRequested: false, timedOut: false, error: null, limit: null, t0: Date.now(), t1: null,
    name: req.args.sni ?? (isAddress(req.args.host) ? null : req.args.host), target: req.args.port ? `${req.args.host}:${req.args.port}` : req.args.host, total: req.args.servers?.length ?? null,
    dnsType: req.args.type ?? null, asn: Boolean(req.args.asn), iperf: req.args.tool === 'iperf' ? { port: req.args.port ?? d.status?.iperf?.port ?? 5201, bind: req.args.bind ?? null, minutes: req.args.minutes } : null,
  };
  // The connectivity check's port is shown with its host; without a host the plugin's default name is used.
  if (req.args.tool === 'check') {
    job.port = req.args.port ?? null;
    job.target = job.port ? `${job.host}:${job.port}` : job.host;
  }
  // A packet capture remembers what it was asked for, to say how it ended and to name the file.
  if (req.args.tool === 'capture') {
    const a = req.args;
    job.cap = { iface: a.iface, seconds: a.seconds, packets: a.packets, snaplen: a.snaplen, filter: [a.proto, a.host && `host ${a.host}`, a.port && `port ${a.port}`, a.filter && (a.proto || a.host || a.port ? `(${a.filter})` : a.filter)].filter(Boolean).join(' and ') };
  }
  d.job = job;
  state.rerender();
  // Waking a host is one quick call, not a job to follow: its answer is the whole result.
  if (req.args.tool === 'wol') {
    try {
      const r = await ubus('flab.diag', 'wake', { mac: req.args.mac, ...(req.args.iface ? { iface: req.args.iface } : {}) });
      job.wake = r;
      job.command = r.command ?? '';
      job.text = retainOutput('', r.output).text;
      job.exit = r.ok ? 0 : 1;
      if (!r.ok) job.error = r.error;
    } catch (e) {
      job.error = failure(e);
    }
    job.running = false; job.t1 = Date.now();
    return state.rerender();
  }
  try {
    const r = await ubus('flab.diag', 'start', req.args);
    if (!r.ok) { job.running = false; job.error = r.error; job.t1 = Date.now(); }
    else { job.id = r.id; job.command = r.command; job.limit = r.limit; }
  } catch (e) {
    job.running = false; job.error = failure(e); job.t1 = Date.now();
  }
  if (job.running && d.job !== job) release(job.id);
  else if (job.running) track(state);
  else state.rerender();
}

// Asks the router to end a job nobody follows any more (the page started another one meanwhile); a failure is ignored because
// the plugin also ends every job at its time limit.
const release = id => { ubus('flab.diag', 'stop', { id }).catch(() => {}); };

// Asks the router to end the running job; the next read reports it as stopped. The job notes that the user asked, because a
// server that ends on a TERM (iperf3) reports a clean exit that would otherwise look like a normal end.
async function stop(state) {
  const job = state.diag.job;
  if (!job?.id || !job.running) return;
  job.stopRequested = true;
  try { await ubus('flab.diag', 'stop', { id: job.id }); } catch { /* the next read shows what happened */ }
}

// Reads the job every READ_EVERY ms until it ends, repainting the result each time. It stops by itself when the job
// ends, and when the page is no longer showing it (the job then keeps its state and resumes on the next view). Exported for the
// polling tests.
export function track(state) {
  const d = state.diag;
  if (d.timer || d.polling) return;
  // One poll: appends the new output, repaints, and schedules the next poll while the job runs. `d.polling` covers the read
  // itself, so a redraw during it (which calls track again) cannot start a second chain that would append the same chunk twice.
  const tick = async () => {
    const job = d.job;
    d.timer = null;
    if (!job?.running || !job.id) return;
    if (!d.resultEl?.isConnected) return;
    d.polling = true;
    try {
      const r = await ubus('flab.diag', 'read', { id: job.id, from: job.size });
      if (!r.ok) { job.running = false; job.error = r.error; }
      else {
        const retained = retainOutput(job.text, r.text);
        job.text = retained.text;
        job.size = r.size;
        // Drain already-finished jobs too: "truncated" historically means another chunk remains.
        job.running = r.running || r.truncated;
        job.exit = r.exit;
        job.stopped = r.stopped;
        job.timedOut = r.timed_out;
        if (retained.limited || (r.output_limited && !r.truncated)) {
          if (r.running) {
            try { await ubus('flab.diag', 'stop', { id: job.id }); } catch { /* the server also caps every job */ }
          }
          job.running = false;
          job.error = 'Output limit reached. The diagnostic was stopped and its output was truncated.';
        }
      }
    } catch (e) {
      job.running = false; job.error = failure(e);
    } finally {
      d.polling = false;
    }
    // A reply that was overtaken by a new job (discardJob) must not paint or schedule a second polling chain; the new job, if
    // it is running already, takes over.
    if (d.job !== job) return track(state);
    if (!job.running) job.t1 = Date.now();
    if (job.running) { paint(state); d.timer = setTimeout(tick, READ_EVERY); }
    else state.rerender();
  };
  d.timer = setTimeout(tick, 250);
}

// Repaints the result card's content from the job.
function paint(state) {
  const d = state.diag;
  if (d.resultEl?.isConnected) d.resultEl.replaceChildren(...resultNodes(d));
}

//#endregion

//#region The form

// A segmented control: options are [value, label]; a click picks one.
function segment(options, value, onpick, disabled) {
  return h('div', { className: 'seg rt-seg', role: 'tablist' }, options.map(([v, label]) => h('button', {
    type: 'button', role: 'tab', className: `seg-tab ${v === value ? 'active' : ''}`, disabled, onclick: () => { if (v !== value) onpick(v); },
  }, label)));
}

// One labeled input or select of the form (`control` is the element; `title` is the hint shown on hover).
function field(label, title, control, className = '') {
  return h('label', { className: `rt-field ${className}`, title }, h('span', {}, label), control);
}

// A text or number input bound to form[key].
function textInput(state, key, { placeholder = '', mono: m = false, disabled = false, type = 'text', width = '' } = {}) {
  const input = h('input', {
    className: `form-control form-control-sm ${m ? 'mono' : ''}`, type, placeholder, value: state.diag.form[key], spellcheck: false, autocomplete: 'off', disabled,
    oninput: e => { state.diag.form[key] = e.target.value; },
    onkeydown: e => { if (e.key === 'Enter') start(state); },
  });
  if (width) input.style.maxWidth = width;
  return input;
}

// A select bound to form[key]; options are [value, label].
function selectInput(state, key, options, disabled = false) {
  const select = h('select', { className: 'form-select form-select-sm', disabled, onchange: e => { state.diag.form[key] = e.target.value; state.rerender(); } },
    options.map(([value, label]) => h('option', { value }, label)));
  select.value = state.diag.form[key];
  return select;
}

// The source field: a select of "automatic" and the router's interface names (a value already in the form that is not one of
// them, such as an address, is kept as an extra choice).
function sourceInput(state, status, disabled) {
  const devices = status.devices ?? [];
  const current = state.diag.form.source;
  const extra = current && !devices.includes(current) ? [current] : [];
  return selectInput(state, 'source', [['', 'automatic'], ...[...devices, ...extra].map(d => [d, d])], disabled);
}

// The Run button (`label` reads "Start server" for the iperf3 server); it is disabled for a login that may not start
// diagnostics.
function runButton(state, allowed, label = 'Run') {
  return button(label, 'play-fill', () => start(state), 'btn-brand', { disabled: !allowed });
}

// The server choices of the DNS lookup: the router's own resolver, the ones it asks upstream, three public ones, and a
// free field for one more. A box toggles the server in form.servers (at most MAX_SERVERS); one server is a plain lookup,
// two or more are compared.
function serverPicker(state, status, disabled) {
  const f = state.diag.form;
  const upstream = status.upstream ?? [];
  const choices = [['router', 'The router\'s resolver'], ...upstream.filter(a => !PUBLIC_RESOLVERS.some(([p]) => p === a)).map(a => [a, `${a} (upstream)`]), ...PUBLIC_RESOLVERS.map(([a, name]) => [a, `${a} (${name})`])];
  const boxes = choices.map(([value, label]) => {
    const box = h('input', { type: 'checkbox', className: 'form-check-input', checked: f.servers.includes(value), disabled, onchange: e => {
      f.servers = e.target.checked ? [...f.servers, value] : f.servers.filter(s => s !== value);
    } });
    return h('label', { className: 'rt-check form-check' }, box, h('span', {}, label));
  });
  return h('div', { className: 'rt-servers' }, h('span', { className: 'rt-servers-title' }, `Servers to ask (up to ${MAX_SERVERS}): one for a plain lookup, two or more to compare`), h('div', { className: 'rt-checks' }, boxes),
    field('One more (optional)', 'Any other DNS server, by address or name', textInput(state, 'extraServer', { placeholder: 'e.g. 192.168.1.53', mono: true, disabled })));
}

// The host choice of Wake-on-LAN: a list of the hosts the router knows (its DHCP reservations first, then the other hosts it
// has seen), and "Another MAC address…", which brings up a text field. Without any known host only the text field shows.
function wolPicker(state, status, disabled) {
  const f = state.diag.form;
  const hosts = status.hosts ?? [];
  if (!hosts.length) f.wolOther = true;
  // The option label of a host: name, address and MAC address, whichever are known.
  const text = host => [host.name ?? 'unnamed', host.ip, host.mac].filter(Boolean).join(' · ');
  // An option group titled `title` for the hosts in `list`; null when there are none.
  const group = (title, list) => (list.length ? h('optgroup', { label: title }, list.map(x => h('option', { value: x.mac }, text(x)))) : null);
  const input = textInput(state, 'host', { placeholder: 'aa:bb:cc:dd:ee:ff', mono: true, disabled });
  if (!hosts.length) return input;
  const select = h('select', { className: 'form-select form-select-sm', disabled, onchange: e => {
    f.wolOther = e.target.value === WOL_OTHER;
    f.host = f.wolOther || !e.target.value ? '' : e.target.value;
    state.rerender();
  } },
  h('option', { value: '' }, 'Choose a host…'),
  group('Reservations', hosts.filter(x => x.reserved)),
  group('Seen on the network', hosts.filter(x => !x.reserved)),
  h('option', { value: WOL_OTHER }, 'Another MAC address…'));
  select.value = f.wolOther ? WOL_OTHER : (hostOf(hosts, f.host) ? normMac(f.host) : '');
  return [select, f.wolOther ? input : null];
}

// The form card: the tool, the host and the options that tool has, and Run / Stop.
function formCard(state, status) {
  const d = state.diag;
  const f = d.form;
  const running = Boolean(d.job?.running);
  const allowed = can('flab.diag', f.tool === 'wol' ? 'wake' : 'start');
  const tools = TOOLS.filter(([t]) => available(status, t));
  if (!tools.some(([t]) => t === f.tool) && tools.length) f.tool = tools[0][0];
  // A capture starts on the LAN bridge when the router has one, otherwise on every interface.
  if (f.tool === 'capture' && !f.capIface) f.capIface = (status.devices ?? []).includes('br-lan') ? 'br-lan' : 'any';
  // The address family field, shared by the tools that resolve names.
  const family = () => field('Address family', 'Force IPv4 or IPv6 name resolution', selectInput(state, 'family', [['', 'automatic'], ['4', 'IPv4'], ['6', 'IPv6']], running));
  // The optional source field (the interface the probes leave from), shared by ping and traceroute.
  const source = () => field('From', 'The interface the probes leave from; automatic lets the routing table decide', sourceInput(state, status, running));

  const options = f.tool === 'ping' ? [
    field('Pings', `How many echo requests to send (1 to ${status.max_pings ?? 60}), one a second`, textInput(state, 'count', { type: 'number', disabled: running })),
    field('Size (bytes)', 'The payload size (0 to 1400)', textInput(state, 'size', { type: 'number', disabled: running })),
    family(), source(),
  ] : f.tool === 'traceroute' ? [
    field('Max hops', 'The most routers to trace (1 to 30)', textInput(state, 'hops', { type: 'number', disabled: running })),
    field('Probes per hop', 'How many probes each router gets (1 to 3)', textInput(state, 'probes', { type: 'number', disabled: running })),
    field('Method', 'UDP probes are the traditional kind; ICMP passes some firewalls that block UDP', selectInput(state, 'method', [['udp', 'UDP'], ['icmp', 'ICMP echo']], running)),
    field('Host names', 'Look up the name of every router that answers. It shows who runs each hop, but is slower when the resolver has no reverse records', selectInput(state, 'resolve', [['', 'addresses only'], ['1', 'look up names']], running)),
    status.asn ? field('Networks (AS)', 'Look up which network (autonomous system) and organization each router that answered belongs to, from Team Cymru\'s DNS service, asked through the router\'s resolver', selectInput(state, 'asn', [['1', 'look up'], ['', 'off']], running)) : null,
    family(), source(),
  ] : f.tool === 'mtr' ? [
    field('Rounds', `How many probes each hop gets, one a second (${status.mtr_cycles?.[0] ?? 3} to ${status.mtr_cycles?.[1] ?? 60})`, textInput(state, 'cycles', { type: 'number', disabled: running })),
    field('Method', 'ICMP echo is what mtr sends by default; UDP passes some firewalls that block ICMP; TCP SYN passes a firewall that only lets web traffic through (to the port you give)', selectInput(state, 'mtrMethod', [['icmp', 'ICMP echo'], ['udp', 'UDP'], ['tcp', 'TCP SYN']], running)),
    f.mtrMethod !== 'icmp' ? field('Port', f.mtrMethod === 'tcp' ? 'The TCP port to connect to (80 when empty)' : 'The UDP destination port; empty lets mtr pick one per probe', textInput(state, 'mtrPort', { type: 'number', placeholder: f.mtrMethod === 'tcp' ? '80' : 'automatic', disabled: running })) : null,
    f.mtrMethod !== 'tcp' ? field('Size (bytes)', 'The packet size with its headers (28 to 1400); empty uses the 64 bytes mtr sends by default', textInput(state, 'mtrSize', { type: 'number', placeholder: '64', disabled: running })) : null,
    field('Host names', 'Look up the name of every router that answers. It shows who runs each hop, but is slower when the resolver has no reverse records', selectInput(state, 'resolve', [['', 'addresses only'], ['1', 'look up names']], running)),
    status.asn ? field('Networks (AS)', 'Look up which network (autonomous system) and organization each router that answered belongs to, from Team Cymru\'s DNS service, asked through the router\'s resolver once the run has ended', selectInput(state, 'asn', [['1', 'look up'], ['', 'off']], running)) : null,
    family(), source(),
  ] : f.tool === 'check' ? [
    field('Port', 'The port of the last step. 443 (the default) is a TLS handshake; another port is a TCP connection, which is also judged as TLS when the service speaks it', textInput(state, 'checkPort', { type: 'number', placeholder: '443', disabled: running })),
  ] : f.tool === 'dns' ? [
    field('Record type', 'The kind of DNS record to ask for', selectInput(state, 'type', DNS_TYPES.map(t => [t, t]), running)),
  ] : f.tool === 'trace' ? [
    field('Record type', 'The kind of DNS record to look up', selectInput(state, 'type', DNS_TYPES.filter(t => t !== 'PTR').map(t => [t, t]), running)),
    field('Address family', 'Ask the servers over IPv4 or IPv6', selectInput(state, 'family', [['', 'IPv4'], ['6', 'IPv6']], running)),
  ] : f.tool === 'tls' ? [
    field('Port', 'The TCP port to connect to (default 443)', textInput(state, 'port', { type: 'number', placeholder: '443', disabled: running })),
    field('Server name (optional)', 'The name to ask the server for (SNI) and to check the certificate against, when it differs from the host', textInput(state, 'sni', { placeholder: 'same as the host', mono: true, disabled: running })),
    field('STARTTLS', 'Start in plain text and upgrade to TLS, as mail and FTP servers do', selectInput(state, 'starttls', [['', 'none (TLS from the start)'], ...STARTTLS.map(s => [s, s.toUpperCase()])], running)),
  ] : f.tool === 'iperf' ? [
    field('Run for', 'The server stops by itself after this time', selectInput(state, 'minutes', [...IPERF_MINUTES].sort((a, b) => a - b).map(m => [String(m), `${m} minute${m === 1 ? '' : 's'}`]), running)),
    field('Port', 'The TCP and UDP port the server listens on (1024 to 65535, default 5201)', textInput(state, 'iperfPort', { type: 'number', placeholder: '5201', disabled: running })),
    field('Listen on', 'Every address of the router (the firewall decides who can connect), or just one of them', selectInput(state, 'bind', [['', 'every address'], ...(status.iperf?.addresses ?? []).map(a => [a.ip, `${a.ip} (${a.iface}${a.zone ? `, ${a.zone}` : ''})`])], running)),
  ] : f.tool === 'capture' ? [
    field('Interface', 'Where to listen: one network device, or every interface at once (any)', selectInput(state, 'capIface', [['any', 'all interfaces (any)'], ...(status.devices ?? []).map(x => [x, x])], running)),
    field('Protocol', 'Only packets of this protocol', selectInput(state, 'capProto', [['', 'all'], ...CAPTURE.protos], running)),
    !f.capProto || f.capProto === 'tcp' || f.capProto === 'udp' ? field('Port', 'Only packets to or from this port', textInput(state, 'capPort', { type: 'number', placeholder: 'any', disabled: running })) : null,
    field('Advanced filter (optional)', 'A tcpdump (BPF) expression, combined with the choices above by "and". Examples: not port 443 · host 10.0.0.1 or host 10.0.0.2 · tcp[tcpflags] & tcp-syn != 0 · net 192.168.1.0/24 and not arp', textInput(state, 'capFilter', { placeholder: 'e.g. not port 443', mono: true, disabled: running }), 'rt-capfilter'),
    field('Duration', 'The capture stops by itself after this time', selectInput(state, 'capSeconds', CAPTURE.seconds.map(s => [String(s), s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`]), running)),
    field('Packets', 'It also stops after this many packets', selectInput(state, 'capPackets', CAPTURE.packets.map(n => [String(n), n.toLocaleString('en')]), running)),
    field('Keep per packet', 'How much of each packet is stored. Headers are enough to see who talks to whom; whole packets also keep what is not encrypted', selectInput(state, 'capSnap', [['96', 'headers only (96 bytes)'], ['256', '256 bytes'], ['1514', 'whole packets (1514 bytes)']], running)),
  ] : f.tool === 'wol' ? [
    field('Interface', 'The network the host is on. Automatic uses the interface the router last saw the host on, or br-lan', selectInput(state, 'iface', [['', 'automatic'], ...(status.devices ?? []).map(x => [x, x])], running)),
  ] : [];

  const weak = f.tool === 'dns' && status.dns_tool === 'nslookup' && WEAK_NSLOOKUP.includes(f.type);
  const hostLabel = f.tool === 'check' ? 'Host to test (optional)' : f.tool === 'capture' ? 'Host to filter on (optional)' : f.tool === 'dns' ? 'Name to look up' : f.tool === 'trace' ? 'Name to trace' : f.tool === 'wol' ? 'Host to wake' : 'Host or address';
  const hostHint = f.tool === 'check' ? `The name used for the DNS and TLS steps (${status.check_host ?? 'example.com'} by default)` : f.tool === 'capture' ? 'Only packets to or from this IP address (an address, not a name)' : f.tool === 'dns' ? 'The name every server is asked about (an address for a PTR lookup)' : f.tool === 'trace' ? 'The name whose path from the root servers is traced' : f.tool === 'wol' ? 'A host the router knows: its DHCP reservations first, then the other hosts it has seen. Or enter another MAC address' : 'The name or address to probe';
  const hostHolder = f.tool === 'check' ? (status.check_host ?? 'example.com') : f.tool === 'capture' ? 'e.g. 192.168.1.50' : f.tool === 'wol' ? 'aa:bb:cc:dd:ee:ff' : f.tool === 'trace' ? 'e.g. www.example.com' : 'e.g. example.com or 1.1.1.1';
  const hostControl = f.tool === 'wol' ? wolPicker(state, status, running) : textInput(state, 'host', { placeholder: hostHolder, mono: true, disabled: running });
  const serving = f.tool === 'iperf';
  const capturing = f.tool === 'capture';
  return card([icon('activity'), 'Diagnostics', h('span', { className: 'sub' }, 'Run a tool on the router and watch its output as it arrives')],
    h('div', { className: 'card-body rt-diag' },
      segment(tools, f.tool, v => { f.tool = v; if (v === 'wol' && !isMac(f.host)) f.host = ''; if (v === 'capture' && !isAddress(f.host)) f.host = ''; d.formError = null; state.rerender(); }, running),
      h('div', { className: 'rt-diagform' },
        serving ? null : field(hostLabel, hostHint, hostControl, 'rt-host'),
        ...options,
        h('div', { className: 'rt-actions' },
          running ? button(serving ? 'Stop server' : capturing ? 'Stop capture' : 'Stop', 'x-lg', () => stop(state)) : runButton(state, allowed, serving ? 'Start server' : capturing ? 'Start capture' : 'Run'),
          d.job && !running ? button('Clear', 'trash', () => { d.job = null; d.formError = null; state.rerender(); }) : null)),
      f.tool === 'dns' ? serverPicker(state, status, running) : null,
      d.formError ? banner(d.formError) : null,
      !allowed ? banner('This login is not allowed to run diagnostics.') : null,
      weak ? h('div', { className: 'rt-note muted' }, icon('info-circle'), `This router only has busybox nslookup, which cannot show ${f.type} records in full. Installing bind-dig, knot-dig or ldns-drill gives complete answers.`) : null,
      ['dns', 'check'].includes(f.tool) && status.dns_tool && status.dns_tool !== 'nslookup' ? h('div', { className: 'rt-note muted' }, icon('info-circle'), `Using ${status.dns_tool}.`) : null,
      f.tool === 'check' ? h('div', { className: 'rt-note muted' }, icon('info-circle'), 'Walks down the stack: default route, next hop, internet, DNS (through the router and a public resolver), IPv6 and a connection to the host (a secure one on port 443; with another port, a plain TCP connection unless the service speaks TLS). About 15 seconds.') : null,
      f.tool === 'trace' ? h('div', { className: 'rt-note muted' }, icon('info-circle'), 'Asks a root server, then the servers it points to, down to the one that answers: the way a resolver finds a name. It shows who answered, how long each step took and the DNSSEC records on the way, and ends with what the router\'s own resolver says.') : null,
      f.tool === 'traceroute' && status.tools?.mtr ? h('div', { className: 'rt-note muted' }, icon('info-circle'), 'MTR sends the same probes for several rounds and shows the loss and delay of every hop, which tells a router that merely limits its replies from a real fault.',
        button('Use MTR', null, () => { f.tool = 'mtr'; d.formError = null; state.rerender(); }, 'btn-link', { disabled: running })) : null,
      f.tool === 'mtr' ? h('div', { className: 'rt-note muted' }, icon('info-circle'), 'Probes every hop once a second for the chosen number of rounds and keeps its loss and delay up to date, like ping and traceroute in one. Loss that does not reach the last hop is a router limiting its own replies, not a fault. It follows one path per run, so it does not show the alternatives of a load-balanced hop; Traceroute does.') : null,
      serving ? h('div', { className: 'rt-note muted' }, icon('info-circle'), 'Starts an iperf3 server on the router that stops by itself. From a computer in the network run the command shown once it listens; the test measures the path to the router (and the router\'s CPU), not to the internet.') : null,
      capturing ? h('div', { className: 'rt-note muted' }, icon('info-circle'), 'Records the packets that cross the chosen interface with tcpdump and lists them as they arrive. It sees everyone\'s traffic, including what is not encrypted, so keep the filter narrow and the capture short. The capture stops by itself at the time or the packet count, is kept in the router\'s memory (the newest only, for ten minutes after it ends) and can be downloaded as a .pcap file for Wireshark. Traffic between two devices on the same switch port does not pass the router and is not seen; the page\'s own connection to the router is, when you capture its address.') : null,
      f.tool === 'wol' ? h('div', { className: 'rt-note muted' }, icon('info-circle'), `Sends one magic packet${status.wol === 'etherwake' ? ' as an Ethernet frame (etherwake)' : ' as a UDP broadcast to port 9 (socat)'}. The host has to be switched off but connected, with Wake-on-LAN enabled in its firmware and operating system, and on the same network as the chosen interface.`) : null));
}

//#endregion

//#region The result

// The status at the top of a result: a spinner while it runs, otherwise how it ended and how long it took.
function statusBadge(job) {
  if (job.running) return working(`Running · ${elapsed(job)} s`);
  const end = endOf(job, job.limit);
  return h('span', {}, badge(end.text, { ok: 'success', stopped: 'info', limit: 'warning', failed: 'danger' }[end.kind]), ` ${elapsed(job)} s`);
}

// The ping result: the figures, the latency chart and a verdict.
function pingBody(job) {
  const p = parsePing(job.text);
  if (p.error && !p.replies.length) return banner(`ping failed: ${p.error}`);
  const verdict = pingVerdict(p);
  const kind = { ok: 'ok', lossy: 'warn', down: 'bad' }[verdict] ?? '';
  return h('div', { className: 'rt-pingbody' },
    h('div', { className: 'rt-stats' },
      stat('Sent', p.sent ? String(p.sent) : '–'),
      stat('Received', p.sent ? String(p.sent - p.lost) : '–'),
      stat('Loss', p.lossPct == null ? '–' : `${p.lossPct}%`, kind),
      stat('Fastest', fmtMs(p.stats?.min)), stat('Average', fmtMs(p.stats?.avg)), stat('Slowest', fmtMs(p.stats?.max)),
      stat('Jitter', fmtMs(p.stats?.jitter))),
    pingChart(p, !job.running),
    !job.running && verdict === 'down' ? banner(`No reply from ${p.target?.ip ?? job.host}. It may be down, unreachable, or it may not answer pings.`) : null,
    !job.running && verdict === 'lossy' ? banner(`${p.lossPct}% of the pings were lost.`, 'warn') : null);
}

// The traceroute result: one row per hop with the routers that answered, the network each belongs to (when the AS lookup
// was asked for) and the round-trip times, and below the table the networks the path crosses.
function traceBody(job) {
  const t = parseTraceroute(job.text);
  if (t.error && !t.hops.length) return banner(`traceroute failed: ${t.error}`);
  const asn = job.asn ? parseAsn(job.text) : null;
  const max = Math.max(1, ...t.hops.map(x => x.avg ?? 0));
  const rows = t.hops.map(hop => h('tr', { className: hop.addrs.includes(t.target?.ip) ? 'rt-hit' : '' },
    h('td', { className: 'num mono' }, String(hop.n)),
    h('td', {}, hop.silent ? muted('no reply') : h('div', { className: 'rt-hops' }, hop.routers.map(r => h('div', { className: 'rt-router' },
      r.name ? [h('span', { className: 'rt-rname', title: r.name }, r.name), h('span', { className: 'rt-raddr mono' }, r.addr)] : mono(r.addr), asn ? asnLine(asn, r.addr) : null)))),
    h('td', {}, h('span', { className: 'chips' }, hop.probes.map(p => p ? h('span', { className: 'chip' }, fmtMs(p.rtt)) : h('span', { className: 'chip muted' }, '*')))),
    h('td', { className: 'num' }, hop.avg == null ? muted('–') : timeBar(fmtMs(hop.avg), hop.avg, max)),
    h('td', {}, hop.addrs.includes(t.target?.ip) ? badge('destination', 'success') : null)));
  return h('div', {},
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover rt-trace' },
      h('thead', {}, h('tr', {}, ['Hop', 'Router', 'Round trips', 'Average', ''].map((c, i) => h('th', { className: i === 0 || i === 3 ? 'num' : '' }, c)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 5, className: 'muted' }, job.running ? 'Waiting for the first hop…' : 'No hops'))))),
    asn ? asPathView(t.hops, asn) : null,
    !job.running && t.hops.length && !t.reached ? banner(`The destination did not answer within ${t.maxHops ?? t.hops.length} hops. Routers that do not send replies show as "no reply"; the trace may still have passed through them.`, 'warn') : null);
}

// The DNS result: how the lookup went, then what the tool said.
function dnsBody(job) {
  const d = parseDns(job.text);
  const verdict = { ok: ['success', `${d.answers} answer${d.answers === 1 ? '' : 's'}`], empty: ['warning', 'No answer'], nxdomain: ['danger', 'Name does not exist (NXDOMAIN)'], servfail: ['danger', 'Server failure (SERVFAIL)'], refused: ['danger', 'Refused'], timeout: ['danger', 'No reply from the server'] }[d.verdict];
  return h('div', {},
    job.text ? h('div', { className: 'rt-dnshead' }, badge(verdict[1], verdict[0]), d.server ? h('span', { className: 'muted' }, ['answered by ', mono(d.server)]) : null) : null,
    h('pre', { className: 'rt-raw-out' }, job.text || (job.running ? 'Waiting for the answer…' : '')));
}

// The nodes of the result card for the job in `d` (none without a job).
function resultNodes(d) {
  const job = d.job;
  if (!job) return [];
  const bodies = {
    ping: pingBody, traceroute: traceBody, mtr: mtrBody, dns: dnsBody, trace: dnsTraceBody, check: checkBody, compare: j => compareBody(j, d.status), tls: tlsBody, capture: captureBody,
    iperf: j => iperfBody(j, d.status), wol: j => wolBody(j, d.status, ip => d.openPing(ip)),
  };
  const problem = scriptProblem(job);
  // A view that chokes on unexpected output must not stop the polling or leave the page without a result.
  let body;
  try {
    body = job.error && !job.text ? banner(job.error)
      : problem && !parseBlocks(job.text).length ? null : bodies[job.tool](job);
  } catch (e) {
    body = banner(`The result could not be shown: ${e.message}`);
  }
  const subject = job.tool === 'iperf' ? '' : job.tool === 'capture' ? ` · ${job.cap.iface}${job.cap.filter ? ` · ${job.cap.filter}` : ''}` : ` · ${job.tool === 'tls' || job.tool === 'check' ? job.target : job.host}`;
  return [card([icon('activity'), `${TITLES[job.tool]}${subject}`, job.command ? h('span', { className: 'sub mono' }, job.command) : null, h('span', { className: 'rt-state' }, statusBadge(job))],
    h('div', { className: 'card-body' },
      problem ? banner(problem) : null,
      body,
      job.error && job.text ? banner(job.error) : null,
      // The open state of "Raw output" is kept in the page state, because the result is rebuilt every time output arrives.
      job.tool !== 'dns' && job.tool !== 'capture' && job.text ? disclosure({ cls: 'rt-raw', summary: 'Raw output', body: h('pre', {}, job.text), open: d.rawOpen, onToggle: open => { d.rawOpen = open; } }) : null))];
}

//#endregion

// The nodes of the tab. `state` is the page's state (it holds `diag`, `rerender` and `reload`).
export function diagView(data, state) {
  const d = state.diag;
  d.status = data.status;
  // The page opens on MTR when the router has it (it does what ping and traceroute do, with loss per hop), unless a tool was
  // asked for by a button elsewhere (the Routing page, Wake-on-LAN).
  if (!d.defaulted) {
    d.defaulted = true;
    if (!d.autorun && !d.job && d.form.tool === 'ping' && data.status.tools?.mtr) d.form.tool = 'mtr';
  }
  const result = h('div', { className: 'rt-result-slot' }, ...resultNodes(d));
  d.resultEl = result;
  // The Wake-on-LAN result offers a ping of the host it woke: fill the form in and run it.
  d.openPing = ip => { Object.assign(d.form, { tool: 'ping', host: ip }); d.job = null; d.formError = null; d.autorun = true; state.rerender(); };
  if (d.job?.running) track(state);
  // A "ping / trace this address" button on the lookup answer opens the Toolbox with the job ready to start.
  if (d.autorun) { d.autorun = false; queueMicrotask(() => start(state)); }
  return [formCard(state, data.status), result];
}
