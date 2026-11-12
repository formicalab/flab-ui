// The Toolbox tools: a connectivity check, ping, traceroute, DNS lookups and comparisons and a certificate check run on the
// router, with their output streaming in as it is produced and shown as statistics,
// a hop table, the answers, a certificate chain or a checklist (the views of the last three are in diagviews.js).
//
// The plugin (rpcd/ucode/flab.diag.uc) runs each tool as a detached job; this module starts it, then polls `read`
// every half second until the job ends (the page's own poll is not involved, and it is not needed: a job is a few
// seconds long). The form and the job live in the page's state (`state.diag`), so they survive redraws and leaving
// the page; the result is painted into one element that the view creates on every redraw, so a redraw in the middle
// of a job simply continues with the new element.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { AuthError, can, ubus } from '../../core/ubus.js';
import { badge, button, card, mono, muted } from '../../core/ui.js';
import { DNS_TYPES, MAX_SERVERS, PUBLIC_RESOLVERS, STARTTLS, WEAK_NSLOOKUP, blankForm, endOf, fmtMs, isAddress, parseBlocks, parseDns, parsePing, parseTraceroute, pingVerdict, requestOf, scriptProblem } from './diagmodel.js';
import { checkBody, compareBody, tlsBody } from './diagviews.js';

// How often a running job is read, in milliseconds.
const READ_EVERY = 500;
// How long the tool list and interface names are reused before they are read again, in milliseconds.
const STATUS_TTL = 60000;

// The tools offered, with their labels and titles.
const TOOLS = [['check', 'Connectivity check'], ['ping', 'Ping'], ['traceroute', 'Traceroute'], ['dns', 'DNS lookup'], ['compare', 'DNS compare'], ['tls', 'TLS certificate']];

// Whether the router has what `tool` needs (`status` is the plugin's answer).
const available = (status, tool) => {
  const t = status.tools ?? {};
  return { ping: t.ping, traceroute: t.traceroute, dns: Boolean(status.dns_tool), compare: Boolean(status.dns_tool), check: t.ping && Boolean(status.dns_tool), tls: t.openssl }[tool];
};

let cached = null;
let cachedAt = 0;

// The state of this tab: the form, the error under it, the current job and its timer and result element.
export const newDiag = () => ({ form: blankForm(), formError: null, job: null, timer: null, resultEl: null, autorun: false, status: null });

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
  const req = requestOf(d.form);
  if (req.error) { d.formError = req.error; return state.rerender(); }
  d.formError = null;
  const job = {
    tool: req.args.tool, host: req.args.host ?? cached?.check_host ?? 'example.com', id: null, command: '', text: '', size: 0, running: true, exit: null, stopped: false, timedOut: false, error: null, limit: null, t0: Date.now(), t1: null,
    name: req.args.sni ?? (isAddress(req.args.host) ? null : req.args.host), target: req.args.port ? `${req.args.host}:${req.args.port}` : req.args.host, total: req.args.servers?.length ?? null,
  };
  d.job = job;
  state.rerender();
  try {
    const r = await ubus('flab.diag', 'start', req.args);
    if (!r.ok) { job.running = false; job.error = r.error; job.t1 = Date.now(); }
    else { job.id = r.id; job.command = r.command; job.limit = r.limit; }
  } catch (e) {
    job.running = false; job.error = e instanceof AuthError ? 'The session has expired. Sign in again.' : e.message; job.t1 = Date.now();
  }
  if (job.running) track(state); else state.rerender();
}

// Asks the router to end the running job; the next read reports it as stopped.
async function stop(state) {
  const job = state.diag.job;
  if (!job?.id || !job.running) return;
  try { await ubus('flab.diag', 'stop', { id: job.id }); } catch { /* the next read shows what happened */ }
}

// Reads the job every READ_EVERY ms until it ends, repainting the result each time. It stops by itself when the job
// ends, and when the page is no longer showing it (the job then keeps its state and resumes on the next view).
export function track(state) {
  const d = state.diag;
  if (d.timer) return;
  const tick = async () => {
    const job = d.job;
    d.timer = null;
    if (!job?.running || !job.id) return;
    if (!d.resultEl?.isConnected) return;
    try {
      const r = await ubus('flab.diag', 'read', { id: job.id, from: job.size });
      if (!r.ok) { job.running = false; job.error = r.error; }
      else {
        job.text += r.text;
        job.size = r.size;
        job.running = r.running;
        job.exit = r.exit;
        job.stopped = r.stopped;
        job.timedOut = r.timed_out;
      }
    } catch (e) {
      job.running = false; job.error = e instanceof AuthError ? 'The session has expired. Sign in again.' : e.message;
    }
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

// One labeled input or select of the form. `build(el)` is given the element so a caller can add attributes.
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

// The source field: free text with the router's interface names offered as suggestions.
function sourceInput(state, status, disabled) {
  const input = textInput(state, 'source', { placeholder: 'interface or address', mono: true, disabled });
  input.setAttribute('list', 'rt-diag-devices');
  return [input, h('datalist', { id: 'rt-diag-devices' }, (status.devices ?? []).map(d => h('option', { value: d })))];
}

// The Run button; it is disabled for a login that may not start diagnostics.
function runButton(state, allowed) {
  const btn = button('Run', 'play-fill', () => start(state), 'btn-brand');
  btn.disabled = !allowed;
  return btn;
}

// The server choices of the DNS comparison: the router's own resolver, the ones it asks upstream, three public ones, and
// a free field for one more. A box toggles the server in form.servers (at most MAX_SERVERS).
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
  return h('div', { className: 'rt-servers' }, h('span', { className: 'rt-servers-title' }, `Servers to ask (up to ${MAX_SERVERS})`), h('div', { className: 'rt-checks' }, boxes),
    field('One more (optional)', 'Any other DNS server, by address or name', textInput(state, 'extraServer', { placeholder: 'e.g. 192.168.1.53', mono: true, disabled })));
}

// The form card: the tool, the host and the options that tool has, and Run / Stop.
function formCard(state, status) {
  const d = state.diag;
  const f = d.form;
  const running = Boolean(d.job?.running);
  const allowed = can('flab.diag', 'start');
  const tools = TOOLS.filter(([t]) => available(status, t));
  if (!tools.some(([t]) => t === f.tool) && tools.length) f.tool = tools[0][0];
  const family = () => field('Address family', 'Force IPv4 or IPv6 name resolution', selectInput(state, 'family', [['', 'automatic'], ['4', 'IPv4'], ['6', 'IPv6']], running));
  const source = () => field('From (optional)', 'The interface or address the probes leave from', sourceInput(state, status, running));

  const options = f.tool === 'ping' ? [
    field('Pings', 'How many echo requests to send (1 to 10)', textInput(state, 'count', { type: 'number', disabled: running })),
    field('Size (bytes)', 'The payload size (0 to 1400)', textInput(state, 'size', { type: 'number', disabled: running })),
    family(), source(),
  ] : f.tool === 'traceroute' ? [
    field('Max hops', 'The most routers to trace (1 to 30)', textInput(state, 'hops', { type: 'number', disabled: running })),
    field('Probes per hop', 'How many probes each router gets (1 to 3)', textInput(state, 'probes', { type: 'number', disabled: running })),
    field('Method', 'UDP probes are the traditional kind; ICMP passes some firewalls that block UDP', selectInput(state, 'method', [['udp', 'UDP'], ['icmp', 'ICMP echo']], running)),
    field('Host names', 'Look up the name of every router that answers. It shows who runs each hop, but is slower when the resolver has no reverse records', selectInput(state, 'resolve', [['', 'addresses only'], ['1', 'look up names']], running)),
    family(), source(),
  ] : f.tool === 'dns' ? [
    field('Record type', 'The kind of DNS record to ask for', selectInput(state, 'type', DNS_TYPES.map(t => [t, t]), running)),
    field('DNS server (optional)', 'Ask this server instead of the router\'s own resolver', textInput(state, 'server', { placeholder: 'the router\'s resolver', mono: true, disabled: running })),
  ] : f.tool === 'compare' ? [
    field('Record type', 'The kind of DNS record to ask for', selectInput(state, 'type', DNS_TYPES.map(t => [t, t]), running)),
  ] : f.tool === 'tls' ? [
    field('Port', 'The TCP port to connect to (default 443)', textInput(state, 'port', { type: 'number', placeholder: '443', disabled: running })),
    field('Server name (optional)', 'The name to ask the server for (SNI) and to check the certificate against, when it differs from the host', textInput(state, 'sni', { placeholder: 'same as the host', mono: true, disabled: running })),
    field('STARTTLS', 'Start in plain text and upgrade to TLS, as mail and FTP servers do', selectInput(state, 'starttls', [['', 'none (TLS from the start)'], ...STARTTLS.map(s => [s, s.toUpperCase()])], running)),
  ] : [];

  const weak = f.tool === 'dns' && status.dns_tool === 'nslookup' && WEAK_NSLOOKUP.includes(f.type);
  const hostLabel = f.tool === 'check' ? 'Host to test (optional)' : f.tool === 'compare' ? 'Name to look up' : 'Host or address';
  const hostHint = f.tool === 'check' ? `The name used for the DNS and TLS steps (${status.check_host ?? 'example.com'} by default)` : f.tool === 'compare' ? 'The name every server is asked about' : 'The name or address to probe';
  const hostHolder = f.tool === 'check' ? (status.check_host ?? 'example.com') : 'e.g. example.com or 1.1.1.1';
  return card([icon('activity'), 'Diagnostics', h('span', { className: 'sub' }, 'Run a tool on the router and watch its output as it arrives')],
    h('div', { className: 'card-body rt-diag' },
      segment(tools, f.tool, v => { f.tool = v; d.formError = null; state.rerender(); }, running),
      h('div', { className: 'rt-diagform' },
        field(hostLabel, hostHint, textInput(state, 'host', { placeholder: hostHolder, mono: true, disabled: running }), 'rt-host'),
        ...options,
        h('div', { className: 'rt-actions' },
          running ? button('Stop', 'x-lg', () => stop(state)) : runButton(state, allowed),
          d.job && !running ? button('Clear', 'x-lg', () => { d.job = null; d.formError = null; state.rerender(); }) : null)),
      f.tool === 'compare' ? serverPicker(state, status, running) : null,
      d.formError ? h('div', { className: 'rt-error' }, icon('exclamation-triangle'), d.formError) : null,
      !allowed ? h('div', { className: 'rt-error' }, icon('exclamation-triangle'), 'This login is not allowed to run diagnostics.') : null,
      weak ? h('div', { className: 'rt-note muted' }, icon('info-circle'), `This router only has busybox nslookup, which cannot show ${f.type} records in full. Installing bind-dig, knot-dig or ldns-drill gives complete answers.`) : null,
      ['dns', 'compare', 'check'].includes(f.tool) && status.dns_tool && status.dns_tool !== 'nslookup' ? h('div', { className: 'rt-note muted' }, icon('info-circle'), `Using ${status.dns_tool}.`) : null,
      f.tool === 'check' ? h('div', { className: 'rt-note muted' }, icon('info-circle'), 'Walks down the stack: default route, next hop, internet, DNS (through the router and a public resolver), IPv6 and a secure connection. About 15 seconds.') : null));
}

//#endregion

//#region The result

// The status at the top of a result: a spinner while it runs, otherwise how it ended and how long it took.
function statusBadge(job) {
  if (job.running) return h('span', { className: 'rt-running' }, h('span', { className: 'spinner-border spinner-border-sm' }), `Running · ${elapsed(job)} s`);
  const end = endOf(job, job.limit);
  return h('span', {}, badge(end.text, { ok: 'success', stopped: 'info', limit: 'warning', failed: 'danger' }[end.kind]), ` ${elapsed(job)} s`);
}

// One figure of the ping summary.
const stat = (label, value, kind = '') => h('div', { className: `rt-stat ${kind}` }, h('div', { className: 'v' }, value), h('div', { className: 'l' }, label));

// One bar per ping, in sequence: its height is the round-trip time (relative to the slowest), and a lost ping is a red
// marker. Busybox prints nothing for a lost ping, so a missing sequence number is the loss. While the ping still
// runs the strip reaches only as far as the last reply; once it has ended the summary's count fills in a lost tail.
function pingBars(p, ended) {
  const bySeq = new Map(p.replies.map(r => [r.seq, r]));
  const total = Math.max(ended ? p.sent : 0, p.replies.length ? Math.max(...p.replies.map(r => r.seq)) + 1 : 0);
  const max = Math.max(...p.replies.map(r => r.rtt), 0.001);
  const bars = Array.from({ length: total }, (_, i) => {
    const r = bySeq.get(i);
    return r
      ? h('i', { className: 'rt-bar-ok', style: `height:${Math.max(12, r.rtt / max * 100).toFixed(0)}%`, title: `#${i}: ${fmtMs(r.rtt)}` })
      : h('i', { className: 'rt-bar-lost', title: `#${i}: no reply` });
  });
  return h('div', { className: 'rt-bars' }, bars);
}

// The ping result: the figures, the round-trip history and a verdict.
function pingBody(job) {
  const p = parsePing(job.text);
  if (p.error && !p.replies.length) return h('div', { className: 'rt-error' }, icon('x-circle'), `ping failed: ${p.error}`);
  const verdict = pingVerdict(p);
  const kind = { ok: 'ok', lossy: 'warn', down: 'bad' }[verdict] ?? '';
  return h('div', { className: 'rt-pingbody' },
    h('div', { className: 'rt-stats' },
      stat('Sent', p.sent ? String(p.sent) : '–'),
      stat('Received', p.sent ? String(p.sent - p.lost) : '–'),
      stat('Loss', p.lossPct == null ? '–' : `${p.lossPct}%`, kind),
      stat('Fastest', fmtMs(p.stats?.min)), stat('Average', fmtMs(p.stats?.avg)), stat('Slowest', fmtMs(p.stats?.max)),
      stat('Jitter', fmtMs(p.stats?.jitter))),
    pingBars(p, !job.running),
    !job.running && verdict === 'down' ? h('div', { className: 'rt-error' }, icon('x-circle'), `No reply from ${p.target?.ip ?? job.host}. It may be down, unreachable, or it may not answer pings.`) : null,
    !job.running && verdict === 'lossy' ? h('div', { className: 'rt-error warn' }, icon('exclamation-triangle'), `${p.lossPct}% of the pings were lost.`) : null);
}

// The traceroute result: one row per hop with the routers that answered and the round-trip times.
function traceBody(job) {
  const t = parseTraceroute(job.text);
  if (t.error && !t.hops.length) return h('div', { className: 'rt-error' }, icon('x-circle'), `traceroute failed: ${t.error}`);
  const max = Math.max(1, ...t.hops.map(x => x.avg ?? 0));
  const rows = t.hops.map(hop => h('tr', { className: hop.addrs.includes(t.target?.ip) ? 'rt-hit' : '' },
    h('td', { className: 'num mono' }, String(hop.n)),
    h('td', {}, hop.silent ? muted('no reply') : h('div', { className: 'rt-hops' }, hop.routers.map(r => h('div', { className: 'rt-router' },
      r.name ? [h('span', { className: 'rt-rname', title: r.name }, r.name), h('span', { className: 'rt-raddr mono' }, r.addr)] : mono(r.addr))))),
    h('td', {}, h('span', { className: 'chips' }, hop.probes.map(p => p ? h('span', { className: 'chip' }, fmtMs(p.rtt)) : h('span', { className: 'chip muted' }, '*')))),
    h('td', { className: 'num' }, hop.avg == null ? muted('–') : h('span', { className: 'rt-avg' }, fmtMs(hop.avg), h('span', { className: 'rt-bar' }, h('i', { style: `width:${Math.max(3, hop.avg / max * 100).toFixed(0)}%` })))),
    h('td', {}, hop.addrs.includes(t.target?.ip) ? badge('destination', 'success') : null)));
  return h('div', {},
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover rt-trace' },
      h('thead', {}, h('tr', {}, ['Hop', 'Router', 'Round trips', 'Average', ''].map((c, i) => h('th', { className: i === 0 || i === 3 ? 'num' : '' }, c)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 5, className: 'muted' }, job.running ? 'Waiting for the first hop…' : 'No hops'))))),
    !job.running && t.hops.length && !t.reached ? h('div', { className: 'rt-error warn' }, icon('exclamation-triangle'), `The destination did not answer within ${t.maxHops ?? t.hops.length} hops. Routers that do not send replies show as "no reply"; the trace may still have passed through them.`) : null);
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
  const title = { ping: 'Ping', traceroute: 'Traceroute', dns: 'DNS lookup', check: 'Connectivity check', compare: 'DNS comparison', tls: 'TLS certificate' }[job.tool];
  const bodies = { ping: pingBody, traceroute: traceBody, dns: dnsBody, check: checkBody, compare: j => compareBody(j, d.status), tls: tlsBody };
  const problem = scriptProblem(job);
  const body = job.error && !job.text ? h('div', { className: 'rt-error' }, icon('x-circle'), job.error)
    : problem && !parseBlocks(job.text).length ? null : bodies[job.tool](job);
  return [card([icon('activity'), `${title} · ${job.tool === 'tls' ? job.target : job.host}`, job.command ? h('span', { className: 'sub mono' }, job.command) : null, h('span', { className: 'rt-state' }, statusBadge(job))],
    h('div', { className: 'card-body' },
      problem ? h('div', { className: 'rt-error' }, icon('x-circle'), problem) : null,
      body,
      job.error && job.text ? h('div', { className: 'rt-error' }, icon('x-circle'), job.error) : null,
      job.tool !== 'dns' && job.text ? h('details', { className: 'rt-raw' }, h('summary', {}, 'Raw output'), h('pre', {}, job.text)) : null))];
}

//#endregion

// The nodes of the tab. `state` is the page's state (it holds `diag`, `rerender` and `reload`).
export function diagView(data, state) {
  const d = state.diag;
  d.status = data.status;
  const result = h('div', { className: 'rt-result-slot' }, ...resultNodes(d));
  d.resultEl = result;
  if (d.job?.running) track(state);
  // A "ping / trace this address" button on the lookup answer opens the tab with the job ready to start.
  if (d.autorun) { d.autorun = false; queueMicrotask(() => start(state)); }
  return [formCard(state, data.status), result];
}
