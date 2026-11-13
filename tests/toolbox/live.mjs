// Browser test of the Toolbox page. A real browser opens the deployed UI; the flab.diag calls (status, start, read,
// stop) are answered by a small scripted job engine built from the real tool output in samples.mjs and
// samples-tools.mjs, so every tool can be driven through running, finishing, failing, stopping and a refused start
// WITHOUT running anything on a router. Everything else (login, system board) goes to the real router; the page only
// reads.
// Usage: node live.mjs   (env: FLAB_SID, FLAB_ACLS, FLAB_URL, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { DRILL, KDIG, KDIG_NX, NSLOOKUP, PING_DOWN, PING_LOSSY, PING_OK, PING_V6, PING_BAD, TRACE, TRACE6, TRACE6_NAMES, TRACE_NAMES } from './samples.mjs';
import { CHECK_OK, COMPARE, COMPARE_NX, TLS_EXAMPLE, TLS_EXPIRED, TLS_GAP, TLS_LEAFONLY, TLS_REFUSED, TLS_RESET, TLS_SELFSIGNED } from './samples-tools.mjs';

const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID;
const acls = JSON.parse(process.env.FLAB_ACLS);
const shots = process.env.FLAB_SHOTS;
// A deep copy of `o`, so each scenario can mutate its own state.
const clone = o => JSON.parse(JSON.stringify(o));
// The real capture fixtures/`f` (output of the tools on the router), with LF line endings.
const fx = f => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', f), 'utf8').replace(/\r/g, '');

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

//#region The mock router
const HOSTS = [{ mac: '34:c6:dd:35:4d:db', name: 'H7c', ip: '192.168.1.7', dev: 'br-lan', reserved: true }, { mac: 'dc:cd:2f:a8:b1:7a', name: 'Epson', ip: '192.168.1.21', reserved: true }, { mac: 'a4:5e:60:00:00:01', name: 'Tablet', ip: '192.168.1.50', dev: 'br-lan' }, { mac: '02:11:22:33:44:55' }];
const LIMITS = { ping: 25, traceroute: 60, dns: 15, tls: 25, compare: 60, check: 75, trace: 60, mtr: 15 };
const IPERF_ADDRESSES = [{ iface: 'lan', device: 'br-lan', ip: '192.168.1.1', family: 4, zone: 'lan', input: 'ACCEPT' }, { iface: 'lan6', device: 'br-lan', ip: '2001:db8:1::1', family: 6, zone: 'lan', input: 'ACCEPT' }, { iface: 'wan', device: 'wan', ip: '203.0.113.9', family: 4, zone: 'wan', input: 'REJECT' }];
// The mock `status` reply: available tools, limits, devices, and hosts, reflecting the current `mock` switches.
const STATUS = () => ({ generated: 1, tools: { ping: true, traceroute: true, nslookup: true, dig: false, kdig: mock.kdig, drill: true, openssl: mock.openssl, mtr: mock.mtr, iperf3: mock.iperf3 }, dns_tool: mock.dnsTool, asn: true, types: ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'PTR', 'SRV', 'CAA'], devices: ['br-lan', 'lo', 'wan'], limits: LIMITS, max_pings: 60, mtr_cycles: [3, 60, 10], starttls: ['smtp', 'imap', 'pop3', 'ftp'], upstream: ['2a01:8d0:601:5002:91:80:35:166', '1.1.1.1'], check_host: 'example.com', wol: mock.wol, hosts: mock.noHosts ? [] : HOSTS, iperf: mock.iperf3 ? { minutes: [1, 2, 5, 15, 30], port: 5201, min_port: 1024, addresses: IPERF_ADDRESSES, exposed: mock.exposed ? ['wan'] : [] } : null });

// A block of the connectivity check's output with its body replaced (the END line keeps the given exit code).
function swapBlock(text, id, body, exit = 1) {
  return text.replace(new RegExp(`(### BEGIN ${id} [^\\n]*\\n)[\\s\\S]*?(\\n### END )\\d+`), (m, a, b) => `${a}${body}\n${b}${exit}`);
}
const DNS_TIMEOUT = ';; WARNING: response timeout for 127.0.0.1@53(UDP)\n;; ERROR: failed to query server 127.0.0.1@53(UDP)\n';
// The check when the router's resolver is broken but a public one works, and when the link to the provider is dead.
const CHECK_DNSFAIL = swapBlock(CHECK_OK, 'dns_router', DNS_TIMEOUT);
const DEAD = '--- x ping statistics ---\n2 packets transmitted, 0 packets received, 100% packet loss\n';
const CHECK_NOLINK = ['gateway'].reduce((t, id) => swapBlock(t, id, DEAD), CHECK_OK).replace(/(### BEGIN internet4 [^\n]*\n)[\s\S]*?(\n### END )\d+/g, (m, a, b) => `${a}${DEAD}\n${b}1`);

// The text of a sample revealed in `steps` cumulative pieces (a job that prints as it goes), at line boundaries.
function reveal(text, steps) {
  const lines = text.split('\n');
  const body = lines.slice(0, -1);
  const per = Math.max(1, Math.ceil(body.length / steps));
  const pieces = [];
  for (let n = per; n < body.length; n += per) pieces.push(body.slice(0, n).join('\n') + '\n');
  pieces.push(text);
  return pieces;
}

// The scripted job for a start request: { chunks (cumulative output per read), exit, endless }.
function script(a) {
  const h = a.host;
  if (a.tool === 'check') {
    if (h === 'broken.example.com') return { chunks: ['job.sh: line 37: syntax error: unexpected end of file (expecting "fi")\n'], exit: 2 };
    if (h === 'dnsfail.example.com') return { chunks: reveal(CHECK_DNSFAIL, 3), exit: 0 };
    if (h === 'nolink.example.com') return { chunks: reveal(CHECK_NOLINK, 3), exit: 0 };
    return { chunks: reveal(CHECK_OK, 8), exit: 0 };
  }
  if (a.tool === 'compare') return { chunks: reveal(h === 'nx.example' ? COMPARE_NX : COMPARE, 4), exit: 0 };
  if (a.tool === 'tls') {
    const sample = { 'expired.example': TLS_EXPIRED, 'self-signed.example': TLS_SELFSIGNED, 'leaf-only.example': TLS_LEAFONLY, 'gap.example': TLS_GAP, 'reset.example': TLS_RESET, 'closed.example': TLS_REFUSED }[h] ?? TLS_EXAMPLE;
    return { chunks: reveal(sample, 3), exit: 0 };
  }
  if (a.tool === 'ping') {
    if (h === 'slow.example') return { endless: true, header: `PING slow.example (10.1.1.1): 56 data bytes\n`, line: i => `64 bytes from 10.1.1.1: seq=${i} ttl=58 time=${(4 + i % 3).toFixed(3)} ms\n` };
    if (h === '192.0.2.77') return { chunks: [PING_DOWN], exit: 1 };
    if (h === 'no-such-host.invalid') return { chunks: [PING_BAD], exit: 1 };
    if (h === 'lossy.example') return { chunks: reveal(PING_LOSSY, 3), exit: 0 };
    if (h === '2606:4700:4700::1111') return { chunks: reveal(PING_V6, 2), exit: 0 };
    return { chunks: reveal(PING_OK, 4), exit: 0 };
  }
  if (a.tool === 'traceroute') {
    // With the AS lookups on (the default) the job is a script; the plain samples are wrapped in the one block it starts with.
    const wrap = t => a.asn ? `### BEGIN trace 1.0 \n${t}\n### END 0 2.0\n` : t;
    if (h === 'asn.example') return { chunks: reveal(fx('traceroute-asn.txt'), 5), exit: 0 };
    if (h === 'unreached.example') return { chunks: reveal(wrap(TRACE.split('\n').slice(0, 6).join('\n') + '\n'), 3), exit: 0 };
    if (h === 'v6.example') return { chunks: reveal(wrap(a.resolve ? TRACE6_NAMES : TRACE6), 3), exit: 0 };
    return { chunks: reveal(wrap(a.resolve ? TRACE_NAMES : TRACE), 4), exit: 0 };
  }
  if (a.tool === 'mtr') return { chunks: reveal(fx('mtr.txt'), 5), exit: 0 };
  if (a.tool === 'trace') {
    const sample = { 'www.ibm.com': 'trace-ibm.txt', 'www.github.com': 'trace-github.txt', 'nope-flab-test.example.com': 'trace-nxdomain.txt' }[h] ?? (a.family === '6' ? 'trace-v6.txt' : 'trace-example.txt');
    return { chunks: reveal(fx(sample), 6), exit: 0 };
  }
  if (a.tool === 'iperf') {
    // One minute: the server runs out of time after the tests; otherwise it keeps listening until it is stopped.
    return a.minutes === 1 ? { chunks: reveal(fx('iperf-tests.txt'), 4), exit: 124, timedOut: true } : { chunks: reveal(fx('iperf-tests.txt'), 5), hold: true, exit: 0 };
  }
  if (h === 'no-such-host.invalid') return { chunks: [KDIG_NX], exit: 0 };
  if (mock.dnsTool === 'nslookup') return { chunks: [NSLOOKUP], exit: 0 };
  return { chunks: [a.type === 'MX' ? DRILL : KDIG], exit: 0 };
}

const mock = { dnsTool: 'kdig', kdig: true, mtr: true, iperf3: true, exposed: false, openssl: true, wol: 'etherwake', noHosts: false, wakes: [], jobs: new Map(), starts: [], stops: [], reads: 0, next: 1, writes: [] };

// The text of an endless job after its current read: the header and one line per read.
function textOf(job) {
  return job.script.header + Array.from({ length: Math.max(0, job.pos) }, (_, i) => job.script.line(i)).join('');
}

// The JSON-RPC answer for a request the mock handles, or null to let it through to the real router.
function answer(body) {
  const [, obj, method, args] = body.params;
  // A successful JSON-RPC reply carrying `data`.
  const ok = data => ({ jsonrpc: '2.0', id: body.id, result: [0, data] });
  if (obj === 'uci' && ['set', 'add', 'delete', 'apply', 'commit'].includes(method)) { mock.writes.push(`${obj}.${method}`); return { jsonrpc: '2.0', id: body.id, result: [6] }; }
  if (obj === 'flab.diag') {
    if (method === 'status') return ok(STATUS());
    if (method === 'start') {
      mock.starts.push(args);
      if (args.host === 'refused.example') return ok({ ok: false, error: '3 diagnostics are already running. Stop one or wait for it to end.' });
      const id = String(mock.next++).padStart(12, '0');
      const cmd = {
        ping: () => `ping -c ${args.count} -W 2 -w 20 -s ${args.size} ${args.host}`,
        traceroute: () => `traceroute ${args.resolve ? '' : '-n '}-w 2 -q ${args.probes} -m ${args.hops} ${args.host}`,
        dns: () => `${mock.dnsTool} ${args.host} ${args.type}`,
        compare: () => `${mock.dnsTool} ${args.host} ${args.type} @${args.servers.join(' @')}`,
        tls: () => `openssl s_client -connect ${args.host}:${args.port}${args.starttls ? ` -starttls ${args.starttls}` : ''}`,
        check: () => `connectivity check (${args.host ?? 'example.com'})`,
        mtr: () => `mtr --raw -n -c ${args.cycles} -i 1 -G 2 ${args.host}`,
        trace: () => `DNS trace ${args.host} ${args.type ?? 'A'}`,
        iperf: () => `iperf3 -s -p ${args.port ?? 5201}${args.bind ? ` -B ${args.bind}` : ''} (stops after ${args.minutes} minute${args.minutes === 1 ? '' : 's'})`,
      }[args.tool]();
      const s = script(args);
      mock.jobs.set(id, { id, args, script: s, pos: 0, reads: 0, stopped: false });
      return ok({ ok: true, id, tool: args.tool, command: cmd, limit: args.tool === 'iperf' ? args.minutes * 60 : LIMITS[args.tool], dns_tool: args.tool === 'dns' ? mock.dnsTool : null, started: 1 });
    }
    if (method === 'read') {
      mock.reads++;
      const job = mock.jobs.get(args.id);
      if (!job) return ok({ ok: false, error: 'There is no such job.' });
      job.reads++;
      // A finite script shows its pieces one per read, the first read showing the first piece; an endless one
      // (a ping that never ends on its own) gains a line per read.
      let text, running;
      if (job.script.endless) {
        if (!job.stopped) job.pos++;
        text = textOf(job);
        running = !job.stopped;
      } else {
        const last = job.script.chunks.length - 1;
        const cur = job.pos;
        text = job.script.chunks[cur];
        running = !job.stopped && (cur < last || job.script.hold === true);
        if (!job.stopped && cur < last) job.pos++;
      }
      const timedOut = !running && !job.stopped && job.script.timedOut === true;
      return ok({ ok: true, id: job.id, running, exit: running ? null : job.stopped ? (job.script.hold ? 0 : 143) : job.script.exit, size: text.length, text: text.slice(args.from ?? 0), truncated: false, timed_out: timedOut, stopped: job.stopped && !job.script.hold });
    }
    if (method === 'wake') {
      mock.wakes.push(args);
      if (args.mac === '02:00:00:00:00:99') return ok({ ok: false, error: 'The interface must be a network device of this router.' });
      const iface = args.iface ?? (args.mac === '34:c6:dd:35:4d:db' ? 'br-lan' : 'br-lan');
      return ok({ ok: true, mac: args.mac, iface, method: mock.wol, command: mock.wol === 'etherwake' ? `etherwake -i ${iface} ${args.mac}` : `UDP broadcast to 255.255.255.255:9 on ${iface} (socat)`, output: '', sent: 1 });
    }
    if (method === 'stop') {
      mock.stops.push(args.id);
      const job = mock.jobs.get(args.id);
      if (job) job.stopped = true;
      return ok({ ok: true, id: args.id, running: false });
    }
  }
  return null;
}
//#endregion

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
// Certificates are judged by the date: it is held at the day the samples were captured so "days left" does not drift.
await ctx.clock.setFixedTime('2026-11-12T08:00:00Z');
const errors = [];
await ctx.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const reply = body ? answer(body) : null;
  return reply ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) }) : route.continue();
});
// Opens a page with a session in sessionStorage, the way a real sign-in leaves the tab.
const open = async granted => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(([id, a]) => { sessionStorage.setItem('sid', id); sessionStorage.setItem('acls', JSON.stringify(a)); }, [sid, granted ?? acls]);
  await p.goto(`${baseUrl}#toolbox`);
  await p.waitForSelector('.rt-diag', { timeout: 20000 });
  return p;
};
let page = await open();

// Helpers.
const tool = name => page.locator('.rt-seg .seg-tab', { hasText: name });
// The target host input.
const host = () => page.locator('.rt-host input');
// The form field (diagnostic options or DNS servers) labeled `label`.
const fieldOf = label => page.locator(`.rt-diagform label:has(span:text-is("${label}")), .rt-servers label:has(span:text-is("${label}"))`);
// The Run button.
const runBtn = () => page.locator('.rt-diag button:has-text("Run")');
// The Stop button.
const stopBtn = () => page.locator('.rt-diag button:has-text("Stop")');
// The run state badge text, whitespace collapsed.
const badgeText = () => page.locator('.rt-state').innerText().then(t => t.replace(/\s+/g, ' ').trim());
// The text of the result area, whitespace collapsed.
const resultText = () => page.locator('.rt-result-slot').innerText().then(t => t.replace(/\s+/g, ' '));
// The value of the summary stat labeled `label`.
const stat = label => page.locator(`.rt-stat:has(.l:text-is("${label}")) .v`).innerText();
// Waits until the run state badge shows an end state (or `text`).
const waitDone = (text = /Finished|Stopped|Failed|Ended|limit/) => page.locator('.rt-state .fl-badge', { hasText: text }).waitFor({ timeout: 20000 });
// Saves a full-page screenshot named after `label`, only when a screenshot directory is configured.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `diag-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Runs `tool` against `h` with the form's defaults and waits for the end.
const runFor = async (t, h, wait = true) => {
  await tool(t).click();
  await host().fill(h);
  await runBtn().click();
  if (wait) await waitDone();
};

console.log('== the page and the form ==');
check((await page.locator('.nav-pane a.active').innerText()).trim() === 'Toolbox' && (await page.locator('.cmdbar h1').innerText()).trim() === 'Toolbox' && await page.locator('.cmdbar .seg-tab').count() === 0, 'the Toolbox is its own page, with no tabs');
const navItems = (await page.locator('.nav-pane a.nav-link-fl').allInnerTexts()).map(t => t.trim());
check(navItems.indexOf('Toolbox') === navItems.indexOf('Logs') - 1 && navItems.indexOf('Toolbox') > 0, 'it sits just above Logs in the navigation', navItems.join(' | '));
check((await page.locator('.rt-seg .seg-tab').allInnerTexts()).join() === 'Connectivity check,Ping,Traceroute,MTR,DNS lookup,DNS trace,DNS compare,TLS certificate,iperf3 server,Wake-on-LAN', 'the Toolbox offers the connectivity check, ping, traceroute, DNS lookup and comparison, the certificate check and Wake-on-LAN');
check(await tool('Ping').getAttribute('class').then(c => c.includes('active')) && await host().inputValue() === '' && await fieldOf('Pings').locator('input').inputValue() === '4' && await fieldOf('Size (bytes)').locator('input').inputValue() === '56' && await runBtn().isEnabled() && await page.locator('.rt-result-slot > *').count() === 0, 'ping is the default tool, with its defaults, and nothing is shown before the first run');
check((await page.locator('#rt-diag-devices option').evaluateAll(o => o.map(x => x.value))).join() === 'br-lan,lo,wan', 'the router\'s interfaces are offered as sources');
await shot('empty');

console.log('\n== the form refuses bad input before asking the router ==');
await runBtn().click();
check(/Enter a host name or an IPv4 or IPv6 address/.test(await page.locator('.rt-error').innerText()) && mock.starts.length === 0, 'an empty host is refused in the form');
for (const bad of ['a b', '-c1', '1.1.1.1; reboot', '$(id)']) {
  await host().fill(bad); await runBtn().click();
  if (!/Enter a host name/.test(await page.locator('.rt-error').innerText())) check(false, `"${bad}" is refused`);
}
check(mock.starts.length === 0, 'hosts with spaces, a leading "-" or shell characters never reach the router');
await host().fill('1.1.1.1');
await fieldOf('Pings').locator('input').fill('61'); await runBtn().click();
check(/number of pings must be a whole number from 1 to 60/.test(await page.locator('.rt-error').innerText()) && mock.starts.length === 0, 'a number outside its limits is refused with the limits named');
await fieldOf('Pings').locator('input').fill('4');

console.log('\n== a ping, live ==');
await runBtn().click();
const seen = [];
for (let i = 0; i < 60; i++) {
  seen.push({ running: await page.locator('.rt-running').count() > 0, received: await page.locator('.rt-stat:has(.l:text-is("Received")) .v').count() ? await stat('Received') : null });
  if (await page.locator('.rt-state .fl-badge').count()) break;
  await page.waitForTimeout(120);
}
await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'ping', host: '1.1.1.1', count: 4, size: 56 }), 'the request carries the tool, the host, the count and the size', j(mock.starts.at(-1)));
check(seen.some(s => s.running && /^[1-3]$/.test(s.received ?? '')) && await page.locator('.rt-running').count() === 0, 'the figures update while the ping runs (a running state with some of the replies), and it ends', j(seen.filter((s, i, a) => i === 0 || s.received !== a[i - 1].received)));
check(await stat('Sent') === '4' && await stat('Received') === '4' && await stat('Loss') === '0%' && await stat('Fastest') === '3.8 ms' && await stat('Average') === '4.2 ms' && await stat('Slowest') === '4.4 ms', 'sent, received, loss, fastest, average and slowest', [await stat('Sent'), await stat('Loss'), await stat('Average')].join());
check(/^Finished \d+ s$/.test(await badgeText()) && /Ping · 1\.1\.1\.1\s+ping -c 4 -W 2 -w 20 -s 56 1\.1\.1\.1/.test((await page.locator('.rt-result-slot .card-header').innerText()).replace(/\s+/g, ' ')), 'the header shows the command that ran; the status says Finished and how long it took');
check(await page.locator('.rt-chart .rt-pt').count() === 4 && await page.locator('.rt-chart .rt-pt-lost').count() === 0 && await stat('Loss').then(async () => (await page.locator('.rt-stat.ok').count()) === 1), 'one point per ping on the chart, none lost, and the loss figure is green');
check(await runBtn().isVisible() && await stopBtn().count() === 0 && await page.locator('.rt-diag button:has-text("Clear")').isVisible(), 'afterwards Run and Clear are offered again');
await page.locator('.rt-raw summary').click();
check(/round-trip min\/avg\/max = 3\.782\/4\.164\/4\.434 ms/.test(await page.locator('.rt-raw pre').innerText()), 'the raw output is one click away');
const readsAfter = mock.reads;
await page.waitForTimeout(1500);
check(mock.reads === readsAfter, 'the page stops reading when the job has ended');
await shot('ping');

console.log('\n== loss, no reply, errors ==');
await runFor('Ping', 'lossy.example');
check(await stat('Sent') === '4' && await stat('Received') === '3' && await stat('Loss') === '25%' && await page.locator('.rt-pt').count() === 3 && await page.locator('.rt-pt-lost').count() === 1 && /25% of the pings were lost/.test(await resultText()) && await page.locator('.rt-stat.warn').count() === 1, '25% loss: the lost ping is a red mark on the chart, the figure is amber, and the page says so');
await runFor('Ping', '192.0.2.77');
check(await stat('Loss') === '100%' && await page.locator('.rt-chart').count() === 0 && /No reply from 192\.0\.2\.77/.test(await resultText()) && await page.locator('.rt-stat.bad').count() === 1 && await stat('Fastest') === '–', 'no reply at all: 100% loss in red, no statistics and no chart (nothing to plot), a plain explanation');
await runFor('Ping', 'no-such-host.invalid');
check(/ping failed: bad address 'no-such-host\.invalid'/.test(await resultText()) && await page.locator('.rt-stats').count() === 0, 'a name that does not resolve is reported as the tool\'s error');

console.log('\n== the options of a ping ==');
await tool('Ping').click(); await host().fill('2606:4700:4700::1111');
await fieldOf('Pings').locator('input').fill('2'); await fieldOf('Size (bytes)').locator('input').fill('1400');
await fieldOf('Address family').locator('select').selectOption('6'); await fieldOf('From (optional)').locator('input').fill('br-lan');
await runBtn().click(); await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'ping', host: '2606:4700:4700::1111', count: 2, size: 1400, family: '6', source: 'br-lan' }), 'count, size, family and source are sent when set', j(mock.starts.at(-1)));
check((await resultText()).includes('Received') && await stat('Received') === '2', 'an IPv6 ping');

console.log('\n== stopping a ping ==');
await tool('Ping').click(); await host().fill('slow.example');
await fieldOf('Pings').locator('input').fill('10'); await fieldOf('Size (bytes)').locator('input').fill('56');
await fieldOf('Address family').locator('select').selectOption(''); await fieldOf('From (optional)').locator('input').fill('');
await runBtn().click();
await page.waitForFunction(() => document.querySelectorAll('.rt-pt').length >= 3, null, { timeout: 15000 });
check(await page.locator('.rt-running').count() === 1 && await stopBtn().isVisible() && await runBtn().count() === 0 && await host().isDisabled() && await fieldOf('Pings').locator('input').isDisabled(), 'while it runs the form is locked, Stop replaces Run and the status shows it running');
const slowId = [...mock.jobs.values()].at(-1).id;
await stopBtn().click();
await waitDone(/Stopped/);
check(mock.stops.at(-1) === slowId && /^Stopped \d+ s$/.test(await badgeText()) && await runBtn().isVisible(), 'Stop asks the router to end the job; the next read shows it as stopped and the form is free again');
const rs = mock.reads; await page.waitForTimeout(1200);
check(mock.reads === rs, 'no more reads after a stop');

console.log('\n== traceroute ==');
await tool('Traceroute').click(); await host().fill('1.1.1.1');
check(await fieldOf('Max hops').locator('input').inputValue() === '20' && await fieldOf('Probes per hop').locator('input').inputValue() === '2' && await fieldOf('Method').locator('select').inputValue() === 'udp' && await fieldOf('Pings').count() === 0, 'a traceroute has its own options and defaults');
await fieldOf('Max hops').locator('input').fill('8'); await fieldOf('Method').locator('select').selectOption('icmp');
await runBtn().click();
let sawPartial = false;
for (let i = 0; i < 60 && !(await page.locator('.rt-state .fl-badge').count()); i++) { if (await page.locator('.rt-trace tbody tr').count() > 0 && await page.locator('.rt-running').count()) sawPartial = true; await page.waitForTimeout(100); }
await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'traceroute', host: '1.1.1.1', hops: 8, probes: 2, method: 'icmp', asn: true }), 'hops, probes, the ICMP method and the AS lookups are sent', j(mock.starts.at(-1)));
check(sawPartial, 'the hops appear one after another while the trace runs');
const rows = await page.locator('.rt-trace tbody tr').allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
check(rows.length === 7 && /^1 37\.179\.98\.1 4\.9 ms 3\.4 ms 4\.2 ms$/.test(rows[0]) && /^2 no reply \* \* –$/.test(rows[1]) && /^7 1\.1\.1\.1 5\.7 ms 6\.2 ms 5\.9 ms\s+destination$/.test(rows[6]), 'seven hops: the router with its probe times and average, silent hops marked, the destination last', rows.join(' | '));
check(await page.locator('.rt-trace tr.rt-hit').count() === 1 && await page.locator('.rt-bar').count() === 5 && await page.locator('.rt-error').count() === 0, 'the destination row is highlighted; each answering hop has a bar for its average');
await shot('traceroute');
await runFor('Traceroute', 'unreached.example');
check(/The destination did not answer within 8 hops/.test(await resultText()) && await page.locator('.rt-trace tr.rt-hit').count() === 0, 'a trace that does not reach the destination says so');
await runFor('Traceroute', 'v6.example');
const v6 = await page.locator('.rt-trace tbody tr').allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
check(v6.length === 5 && /^4 2a01:8d0:90e:a:1::a 2001:7f8:10::3:722 27 ms 5\.4 ms/.test(v6[3]) && /^5 2a01:8d0:90e:a:1::b 5\.5 ms \*/.test(v6[4]), 'IPv6 hops; a hop answered by two routers lists both; a lost probe among answers shows as *', v6.join(' | '));

console.log('\n== traceroute with host names ==');
check(await fieldOf('Host names').locator('select').inputValue() === '' && (await fieldOf('Host names').locator('option').allInnerTexts()).join() === 'addresses only,look up names', 'host names are off by default (addresses only), with the option to look them up');
check(await page.locator('.rt-rname').count() === 0, 'a numeric trace shows no names');
await tool('Traceroute').click(); await host().fill('1.1.1.1');
await fieldOf('Host names').locator('select').selectOption('1');
await runBtn().click(); await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'traceroute', host: '1.1.1.1', hops: 8, probes: 2, method: 'icmp', resolve: true, asn: true }), 'asking for names sends resolve: true', j(mock.starts.at(-1)));
const named = await page.locator('.rt-trace tbody tr').allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
check(named.length === 7 && /^1 net-37-179-98-1\.cust\.vodafonedsl\.it 37\.179\.98\.1 5\.5 ms 16 ms/.test(named[0]) && /^4 185\.210\.48\.76 7\.4 ms 5\.7 ms/.test(named[3]) && /^5 185\.210\.48\.77 \* 5\.4 ms/.test(named[4]) && /^7 one\.one\.one\.one 1\.1\.1\.1 5\.2 ms 4\.4 ms .* destination$/.test(named[6]), 'each router shows its name with the address beneath; a router with no reverse record shows just the address; the destination is still marked', named.join(' | '));
check(await page.locator('.rt-rname').count() === 2 && await page.locator('.rt-raddr').count() === 2 && await page.locator('.rt-trace tr.rt-hit').count() === 1, 'two routers have names; the destination row is still highlighted');
await shot('traceroute-names');
await runFor('Traceroute', 'v6.example');
check(await page.locator('.rt-rname').allInnerTexts().then(t => t.join()) === 'vodafone.rom.namex.it,cloudflare.rom.namex.it', 'IPv6 routers with names');
await fieldOf('Host names').locator('select').selectOption('');

console.log('\n== DNS lookup ==');
await tool('DNS lookup').click(); await host().fill('example.com');
check(await fieldOf('Record type').locator('select').inputValue() === 'A' && (await fieldOf('Record type').locator('option').allInnerTexts()).join() === 'A,AAAA,MX,TXT,NS,CNAME,SOA,PTR,SRV,CAA' && await fieldOf('From (optional)').count() === 0 && /Using kdig\./.test(await page.locator('.rt-note').innerText()), 'a lookup has a record type and a server; the tool in use is named');
await runBtn().click(); await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'dns', host: 'example.com', type: 'A' }), 'a lookup asks for the host and the type only', j(mock.starts.at(-1)));
check(/2 answers/.test(await page.locator('.rt-dnshead').innerText()) && /answered by 127\.0\.0\.1/.test(await page.locator('.rt-dnshead').innerText()) && /ANSWER SECTION/.test(await page.locator('.rt-raw-out').innerText()), 'the answer count and the server, then the tool\'s own output');
await fieldOf('Record type').locator('select').selectOption('MX'); await fieldOf('DNS server (optional)').locator('input').fill('9.9.9.9');
await runBtn().click(); await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'dns', host: 'example.com', type: 'MX', server: '9.9.9.9' }), 'type and server are sent', j(mock.starts.at(-1)));
await host().fill('no-such-host.invalid'); await runBtn().click(); await waitDone();
check(/Name does not exist \(NXDOMAIN\)/.test(await page.locator('.rt-dnshead').innerText()), 'NXDOMAIN is spelled out');
await shot('dns');

console.log('\n== the connectivity check ==');
await tool('Connectivity check').click(); await host().fill('');
check(await fieldOf('Host to test (optional)').count() === 1 && /Walks down the stack/.test(await page.locator('.rt-note').last().innerText()) && await page.locator('.rt-diagform label').count() === 1, 'the check asks only for an optional host');
await runBtn().click();
let stepsSeen = false;
for (let i = 0; i < 80 && !(await page.locator('.rt-state .fl-badge').count()); i++) {
  if (await page.locator('.rt-step.ok').count() > 0 && await page.locator('.rt-step.pending').count() > 0) stepsSeen = true;
  await page.waitForTimeout(80);
}
await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'check' }) && stepsSeen, 'no host is sent; steps turn from waiting to done while the check runs');
check((await page.locator('.rt-step-title').allInnerTexts()).join() === 'Default route,Next hop,Internet (IPv4),DNS through the router,DNS through a public resolver,Internet (IPv6),DNS (IPv6 records),Secure connection (TLS)' && await page.locator('.rt-step.ok').count() === 8, 'eight steps, all ok on a healthy router');
check(/Everything works/.test(await page.locator('.rt-verdict.ok').innerText()) && /via 37\.179\.98\.1 on pppoe-wan/.test(await resultText()) && /certificate for example\.com is trusted/.test(await resultText()), 'a good verdict, and each step says what it found');
check(await page.locator('.rt-result-slot .card-header').innerText().then(t => /Connectivity check · example\.com/.test(t.replace(/\s+/g, ' '))), 'the header names the host used by default');
await shot('check');
await host().fill('dnsfail.example.com'); await runBtn().click(); await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'check', host: 'dnsfail.example.com' }) && await page.locator('.rt-verdict.bad').count() === 1 && /router's DNS resolver fails while a public one answers/.test(await page.locator('.rt-verdict').innerText()) && await page.locator('.rt-step.bad').count() === 1, 'a broken router resolver with a working public one is the verdict, with one red step', `${j(mock.starts.at(-1))} ${await page.locator('.rt-verdict').allInnerTexts()} bad=${await page.locator('.rt-step.bad').count()}`);
await host().fill('nolink.example.com'); await runBtn().click(); await waitDone();
check(/next hop 37\.179\.98\.1 does not answer/.test(await page.locator('.rt-verdict').innerText()) && await page.locator('.rt-step.bad').count() >= 2, 'a dead next hop is blamed first');
await host().fill('broken.example.com'); await runBtn().click(); await waitDone(/Failed/);
check(/The job script could not run: job\.sh: line 37: syntax error/.test(await page.locator('.rt-result-slot .rt-error').innerText()) && /^Failed \(exit code 2\)/.test(await badgeText()) && await page.locator('.rt-step').count() === 0, 'a script that cannot run is reported with the shell\'s message and the failed status, not an empty checklist');
await host().fill('a b'); await runBtn().click();
check(/Enter a host name, or leave it empty/.test(await page.locator('.rt-diag .rt-error').innerText()), 'a bad host is refused in the form');
await host().fill('');

console.log('\n== the DNS comparison ==');
await tool('DNS compare').click(); await host().fill('example.com');
check(await page.locator('.rt-check').allInnerTexts().then(t => t.map(x => x.trim()).join('|')) === 'The router\'s resolver|2a01:8d0:601:5002:91:80:35:166 (upstream)|1.1.1.1 (Cloudflare)|8.8.8.8 (Google)|9.9.9.9 (Quad9)', 'the choices: the router, its upstream resolver (public ones are not repeated), and three public resolvers');
check(await page.locator('.rt-check input:checked').count() === 3 && await fieldOf('One more (optional)').count() === 1, 'the router, Cloudflare and Google are chosen to begin with');
await page.locator('.rt-check input').evaluateAll(b => b.forEach(x => x.checked && x.click()));
await runBtn().click();
check(/Choose at least one DNS server/.test(await page.locator('.rt-diag .rt-error').innerText()), 'with no server chosen the form refuses');
await page.locator('.rt-check', { hasText: 'router' }).locator('input').click();
await page.locator('.rt-check', { hasText: '1.1.1.1' }).locator('input').click();
await page.locator('.rt-check', { hasText: '8.8.8.8' }).locator('input').click();
await fieldOf('One more (optional)').locator('input').fill('192.0.2.1');
await fieldOf('Record type').locator('select').selectOption('A');
await runBtn().click();
let rowCounts = new Set();
for (let i = 0; i < 80 && !(await page.locator('.rt-state .fl-badge').count()); i++) { rowCounts.add(await page.locator('.rt-compare tbody tr').count()); await page.waitForTimeout(80); }
await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'compare', host: 'example.com', type: 'A', servers: ['router', '1.1.1.1', '8.8.8.8', '192.0.2.1'] }), 'the chosen servers and the extra one are sent in order', j(mock.starts.at(-1)));
check([1, 2, 3].some(n => rowCounts.has(n)) && await page.locator('.rt-compare tbody tr').count() === 4, 'rows appear as the servers answer', j([...rowCounts]));
const cmpRows = await page.locator('.rt-compare tbody tr').allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
check(/^The router's resolver what the clients on this network use Answers ?DNSSEC 104\.20\.23\.154 172\.66\.147\.243 0\.50 ms fastest$/.test(cmpRows[0]) && /^1\.1\.1\.1 Cloudflare Answers ?DNSSEC .* 9\.4 ms$/.test(cmpRows[1]) && /^192\.0\.2\.1 No reply – –$/.test(cmpRows[3]), 'each server with its answers, DNSSEC flag and time; the fastest is marked; a silent one says No reply', cmpRows.join(' | '));
check(await page.locator('.rt-compare tr.rt-down').count() === 1 && /Every server that answered gave the same addresses/.test(await resultText()) && await page.locator('.rt-differs').count() === 0, 'the failure is highlighted, and the agreement is stated');
await shot('compare');
await host().fill('nx.example'); await fieldOf('One more (optional)').locator('input').fill(''); await runBtn().click(); await waitDone();
check(await page.locator('.rt-compare tbody tr').count() === 2 && await page.locator('.rt-compare tbody tr').first().innerText().then(t => /No answer/.test(t)), 'a name that gives no answer is shown as "No answer" for each server');
await fieldOf('Record type').locator('select').selectOption('AAAA'); await runBtn().click(); await waitDone();
check(mock.starts.at(-1).type === 'AAAA', 'the record type is sent');

console.log('\n== the certificate check ==');
await tool('TLS certificate').click(); await host().fill('example.com');
check(await fieldOf('Port').locator('input').getAttribute('placeholder') === '443' && await fieldOf('Server name (optional)').count() === 1 && (await fieldOf('STARTTLS').locator('option').allInnerTexts()).join() === 'none (TLS from the start),SMTP,IMAP,POP3,FTP', 'port, server name and STARTTLS are offered');
await fieldOf('Port').locator('input').fill('0'); await runBtn().click();
check(/The port must be a whole number from 1 to 65535/.test(await page.locator('.rt-diag .rt-error').innerText()), 'a bad port is refused in the form');
await fieldOf('Port').locator('input').fill('');
await runBtn().click(); await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'tls', host: 'example.com', port: 443 }), 'the port defaults to 443 and nothing else is sent', j(mock.starts.at(-1)));
check(await page.locator('.rt-finding.ok').count() === 4 && await page.locator('.rt-finding.bad, .rt-finding.warn').count() === 0 && await page.locator('.rt-result-slot .card-header').innerText().then(t => /TLS certificate · example\.com:443/.test(t.replace(/\s+/g, ' '))), 'a good certificate: trusted, in order, covers the name, valid; the header names host and port');
check(await page.locator('.rt-chain-missing').count() === 0 && /exactly as the server sent them/.test(await page.locator('.rt-chain-note').innerText()), 'the chain is said to be exactly what the server sent, and a complete one has no missing marker');
check(await stat('Protocol') === 'TLSv1.3' && await stat('Cipher') === 'TLS_AES_256_GCM_SHA384' && await stat('Key exchange') === 'X25519MLKEM768', 'the protocol, cipher and key exchange');
check(await page.locator('.rt-cert').count() === 4 && await page.locator('.rt-cert.leaf').count() === 1 && /Certificate chain sent by the server \(4\)/.test(await page.locator('.rt-chain h3:has-text("Certificate chain sent")').innerText()), 'the chain shows all four certificates, the first one marked');
const leafText = (await page.locator('.rt-cert.leaf').innerText()).replace(/\s+/g, ' ');
check(/Server certificate CN=example\.com \d+ days left/.test(leafText) && /Issued by C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3/.test(leafText) && /Key EC prime256v1 · signed with ecdsa-with-SHA256/.test(leafText) && /Valid 2026-09-26 to 2026-12-25/.test(leafText) && /Names example\.com \*\.example\.com/.test(leafText) && /Serial 01EEE6AABB521D5E14FC315FD9985690/.test(leafText) && /SHA-256 85:CA:6A:B0/.test(leafText) && /Certificate authority no/.test(leafText), 'the server certificate: issuer, key, dates, names, serial and fingerprint', leafText);
check(await page.locator('.rt-cert').nth(1).innerText().then(t => t.replace(/\s+/g, ' ')).then(t => /Intermediate/.test(t) && /Certificate authority yes/.test(t)), 'the issuers are labeled as intermediates and certificate authorities');
await page.locator('.rt-cert.leaf .rt-raw summary').click();
check(/^-----BEGIN CERTIFICATE-----/.test(await page.locator('.rt-cert.leaf .rt-raw pre').innerText()), 'the PEM text is available');
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
await page.locator('.rt-cert.leaf button:has-text("Copy PEM")').click();
await page.locator('.rt-cert.leaf button:has-text("Copied")').waitFor({ timeout: 5000 });
check((await page.evaluate(() => navigator.clipboard.readText())).startsWith('-----BEGIN CERTIFICATE-----'), 'Copy PEM puts the certificate on the clipboard');
await shot('tls');
await fieldOf('Server name (optional)').locator('input').fill('expired.badssl.com'); await host().fill('expired.example'); await runBtn().click(); await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'tls', host: 'expired.example', port: 443, sni: 'expired.badssl.com' }) && await page.locator('.rt-finding.bad').count() === 1 && /expired \d+ days ago/.test(await page.locator('.rt-finding.bad').innerText()) && /expired \d+ days ago/.test(await page.locator('.rt-cert.leaf .rt-cert-head .fl-badge').last().innerText()), 'an expired certificate: said once as a finding and as a badge; the server name is sent', await page.locator('.rt-findings').innerText());
await host().fill('self-signed.example'); await fieldOf('Server name (optional)').locator('input').fill('self-signed.badssl.com'); await runBtn().click(); await waitDone();
check(await page.locator('.rt-cert').count() === 1 && /self-signed/.test(await page.locator('.rt-finding.bad').innerText()) && /Issued by itself \(self-signed\)/.test((await page.locator('.rt-cert').innerText()).replace(/\s+/g, ' ')), 'a self-signed certificate is called out');
await host().fill('leaf-only.example'); await fieldOf('Server name (optional)').locator('input').fill(''); await runBtn().click(); await waitDone();
check(await page.locator('.rt-cert').count() === 1 && /only its own certificate, without the certificate of its issuer/.test(await page.locator('.rt-finding.warn').innerText()) && /Issuer not sent\. The server sent no certificate for O=Example Lab, CN=Example Lab Issuing CA/.test((await page.locator('.rt-chain-missing').innerText()).replace(/\s+/g, ' ')), 'a server that sends only its own certificate: a warning and a marker where the issuer should be');
await shot('tls-leaf-only');
await host().fill('gap.example'); await runBtn().click(); await waitDone();
check(await page.locator('.rt-cert').count() === 2 && /incomplete or out of order/.test(await page.locator('.rt-finding.warn').innerText()) && await page.locator('.rt-chain:has(.rt-cert) > *').evaluateAll(n => n.map(x => x.className.trim()).join()) === ',rt-chain-note,rt-cert leaf,rt-chain-missing,rt-cert', 'a gap in the chain is marked between the two certificates');
await fieldOf('Server name (optional)').locator('input').fill(''); await host().fill('reset.example'); await runBtn().click(); await waitDone();
check(await page.locator('.rt-cert').count() === 0 && /closed the connection during the handshake/.test(await page.locator('.rt-finding.bad').innerText()), 'a server that hangs up has no chain and a plain explanation');
await host().fill('closed.example'); await fieldOf('Port').locator('input').fill('9'); await runBtn().click(); await waitDone();
check(/closed\.example:9 refused the connection/.test(await page.locator('.rt-finding.bad').innerText()), 'a closed port is "refused", with the host and port');
await host().fill('mail.example'); await fieldOf('Port').locator('input').fill('465'); await fieldOf('STARTTLS').locator('select').selectOption('smtp'); await runBtn().click(); await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'tls', host: 'mail.example', port: 465, starttls: 'smtp' }) && /-starttls smtp/.test(await page.locator('.rt-result-slot .card-header').innerText()), 'a STARTTLS check sends the protocol');
await fieldOf('Port').locator('input').fill(''); await fieldOf('STARTTLS').locator('select').selectOption('');

console.log('\n== Wake-on-LAN ==');
// The Wake-on-LAN host picker.
const wolSelect = () => page.locator('.rt-host select');
await tool('Wake-on-LAN').click();
check(await fieldOf('Host to wake').count() === 1 && (await fieldOf('Interface').locator('option').allInnerTexts()).join() === 'automatic,br-lan,lo,wan' && /Sends one magic packet as an Ethernet frame \(etherwake\)/.test(await page.locator('.rt-note').innerText()) && await fieldOf('Pings').count() === 0, 'the form asks for a host and an interface, and says how the packet is sent');
check((await page.locator('.rt-host optgroup').evaluateAll(g => g.map(x => `${x.label}: ${[...x.querySelectorAll('option')].map(o => o.textContent).join(' / ')}`))).join(' | ') === 'Reservations: H7c · 192.168.1.7 · 34:c6:dd:35:4d:db / Epson · 192.168.1.21 · dc:cd:2f:a8:b1:7a | Seen on the network: Tablet · 192.168.1.50 · a4:5e:60:00:00:01 / unnamed · 02:11:22:33:44:55', 'the list offers the DHCP reservations first, then the other hosts the router has seen, by name, address and MAC');
check((await wolSelect().locator('> option').allInnerTexts()).join('|') === 'Choose a host…|Another MAC address…' && await host().count() === 0 && await wolSelect().inputValue() === '', 'it starts with nothing chosen, and no text field for a MAC');
await runBtn().click();
check(/Choose a host from the list/.test(await page.locator('.rt-diag .rt-error').innerText()) && mock.wakes.length === 0, 'running with nothing chosen is refused in the form');
await wolSelect().selectOption('dc:cd:2f:a8:b1:7a'); await runBtn().click(); await waitDone();
check(j(mock.wakes.at(-1)) === j({ mac: 'dc:cd:2f:a8:b1:7a' }) && mock.starts.every(s => s.tool !== 'wol'), 'the chosen host\'s MAC is sent, with no interface when it is left on automatic, and no job is started');
check(/^Wake-on-LAN · dc:cd:2f:a8:b1:7a\s+etherwake -i br-lan dc:cd:2f:a8:b1:7a/.test((await page.locator('.rt-result-slot .card-header').innerText()).replace(/\s+/g, ' ')) && /^Finished/.test(await badgeText()), 'the header shows the MAC and the command that ran');
const wolText = await resultText();
check(/Magic packet sent to Epson \(dc:cd:2f:a8:b1:7a\)\./.test(wolText) && /left the router on br-lan as an Ethernet frame \(etherwake\)/.test(wolText) && /whether it woke up has to be checked/.test(wolText) && await page.locator('.rt-verdict.ok').count() === 1, 'the result names the host, the interface and the method, and says the router cannot know whether it woke', wolText);
await shot('wol');
await page.locator('.rt-wolbody button', { hasText: 'Ping 192.168.1.21' }).click();
await page.locator('.rt-result-slot .card-header', { hasText: 'Ping · 192.168.1.21' }).waitFor({ timeout: 10000 });
await waitDone();
check(mock.starts.at(-1).tool === 'ping' && mock.starts.at(-1).host === '192.168.1.21' && await tool('Ping').getAttribute('class').then(c => c.includes('active')) && await host().inputValue() === '192.168.1.21', 'the Ping button runs a ping of the host\'s address', j(mock.starts.at(-1)));
await tool('Wake-on-LAN').click();
check(await wolSelect().inputValue() === '' && await wolSelect().locator('option:checked').innerText() === 'Choose a host…', 'a host address left in the form by the Ping button is not taken for a choice');
await wolSelect().selectOption('02:11:22:33:44:55'); await fieldOf('Interface').locator('select').selectOption('lo'); await runBtn().click(); await waitDone();
check(j(mock.wakes.at(-1)) === j({ mac: '02:11:22:33:44:55', iface: 'lo' }) && /Magic packet sent to 02:11:22:33:44:55\./.test(await resultText()) && /does not know this host's address/.test(await resultText()) && await page.locator('.rt-wolbody button').count() === 0, 'a chosen interface is sent; a host without an address has no Ping button');
await wolSelect().selectOption('__other');
check(await host().count() === 1 && await host().inputValue() === '' && await host().getAttribute('placeholder') === 'aa:bb:cc:dd:ee:ff', '"Another MAC address…" brings up a text field');
await host().fill('192.168.1.21'); await runBtn().click();
check(/Enter a MAC address such as aa:bb:cc:dd:ee:ff/.test(await page.locator('.rt-diag .rt-error').innerText()) && mock.wakes.length === 2, 'an address instead of a MAC is refused in the form');
await host().fill('AA-BB-CC-DD-EE-FF'); await runBtn().click(); await waitDone();
check(j(mock.wakes.at(-1)) === j({ mac: 'aa:bb:cc:dd:ee:ff', iface: 'lo' }) && /Magic packet sent to aa:bb:cc:dd:ee:ff\./.test(await resultText()), 'a typed MAC is normalized and sent');
await host().fill('02:00:00:00:00:99'); await runBtn().click(); await waitDone(/Failed/);
check(/The interface must be a network device of this router\./.test(await page.locator('.rt-result-slot .rt-error').innerText()) && await page.locator('.rt-verdict').count() === 0, 'a refusal from the router is shown as a failure, not as success');
mock.wol = 'socat';
page = await open();
await tool('Wake-on-LAN').click();
check(/UDP broadcast to port 9 \(socat\)/.test(await page.locator('.rt-note').innerText()), 'with only socat the note says the packet is a UDP broadcast');
await wolSelect().selectOption('34:c6:dd:35:4d:db'); await runBtn().click(); await waitDone();
check(/UDP broadcast to 255\.255\.255\.255:9 on br-lan \(socat\)/.test(await page.locator('.rt-result-slot .card-header').innerText()) && /as a UDP broadcast to port 9 \(socat\)/.test(await resultText()), 'the result names the UDP broadcast');
mock.wol = 'etherwake';
mock.noHosts = true;
page = await open();
await tool('Wake-on-LAN').click();
check(await wolSelect().count() === 0 && await host().isVisible(), 'a router that knows no hosts shows only the MAC field');
mock.noHosts = false;
page = await open();

console.log('\n== ping chart, compare chart, certificate diagram ==');
await runFor('Ping', 'lossy.example');
check(await page.locator('.rt-chart').count() === 1 && await page.locator('.rt-chart .rt-ch-line').count() === 1 && await page.locator('.rt-chart .rt-ch-avg').count() === 1, 'the ping chart is a line through the replies with the average marked');
await shot('ping-chart');
await tool('DNS compare').click(); await host().fill('example.com'); await runBtn().click(); await waitDone();
check(await page.locator('.rt-hchart .rt-hrow').count() >= 2 && await page.locator('.rt-hchart .rt-hbar.best').count() === 1 && await page.locator('.rt-hchart .rt-hval').count() >= 2, 'the comparison draws a bar per server with its time, the fastest marked');
await shot('compare-chart');
await tool('TLS certificate').click(); await host().fill('example.com'); await runBtn().click(); await waitDone();
const certs = await page.locator('.rt-cdiagram .rt-cd-node:not(.missing)').count();
check(certs >= 2 && await page.locator('.rt-timeline .rt-tl-row').count() === certs && await page.locator('.rt-cd-node.leaf').count() === 1 && await page.locator('.rt-tl-now').count() === certs, 'the certificates are drawn as a chain (leaf first) and as bars on a timeline with a mark for today', String(certs));
await shot('tls-diagram');
await tool('TLS certificate').click(); await host().fill('expired.example'); await runBtn().click(); await waitDone();
check(await page.locator('.rt-tl-bar.bad').count() >= 1 && await page.locator('.rt-cd-node.bad').count() >= 1, 'an expired certificate is red in both pictures');
await tool('TLS certificate').click(); await host().fill('gap.example'); await runBtn().click(); await waitDone();
check(await page.locator('.rt-cd-node.missing').count() >= 1, 'a certificate the server did not send is drawn as a placeholder in the chain');
await shot('tls-gap');

console.log('\n== traceroute with the networks of the hops ==');
await tool('Traceroute').click(); await host().fill('asn.example');
check(await fieldOf('Networks (AS)').locator('select').inputValue() === '1', 'looking up the networks is on by default');
await runBtn().click(); await waitDone();
const asnRows = await page.locator('.rt-trace tbody tr').allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
check(mock.starts.at(-1).asn === true && /^1 37\.179\.98\.1 AS30722 Fastweb SpA · IT/.test(asnRows[0]) && /^4 185\.210\.48\.76 no AS data/.test(asnRows[3]) && /^7 1\.1\.1\.1 AS13335 Cloudflare, Inc\./.test(asnRows[6]), 'each router that answered is followed by its AS number, organization and country; one with no record says so', asnRows.join(' | '));
check(/Crosses 2 networks:\s*AS30722 Fastweb SpA\s*→\s*AS13335 Cloudflare, Inc\./.test((await page.locator('.rt-aspath').innerText()).replace(/\s+/g, ' ')), 'the networks the path crosses are listed in order');
await shot('traceroute-asn');
await fieldOf('Networks (AS)').locator('select').selectOption(''); await runBtn().click(); await waitDone();
check(!('asn' in mock.starts.at(-1)) && await page.locator('.rt-asn').count() === 0 && await page.locator('.rt-aspath').count() === 0, 'with the lookups off nothing is asked and no network is shown');
await fieldOf('Networks (AS)').locator('select').selectOption('1');

console.log('\n== mtr ==');
await tool('MTR').click(); await host().fill('1.1.1.1');
check(await fieldOf('Rounds').locator('input').inputValue() === '10' && await fieldOf('Method').locator('select').inputValue() === 'icmp', 'mtr offers the number of rounds (10) and ICMP by default');
await runBtn().click(); await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'mtr', host: '1.1.1.1', cycles: 10 }), 'mtr sends the host and the rounds', j(mock.starts.at(-1)));
const mrows = await page.locator('.rt-mtrtable tbody tr').allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
check(mrows.length === 7 && /^1 37\.179\.98\.1 0% 6 /.test(mrows[0]) && /^2 no reply no reply 6 /.test(mrows[1]) && /^5 185\.210\.48\.77 33\.3% 6 /.test(mrows[4]) && /^7 1\.1\.1\.1 0% 6 /.test(mrows[6]) && await page.locator('.rt-mtrtable tr.rt-hit').count() === 1, 'seven hops with loss, the silent ones marked and the destination highlighted', mrows.join(' | '));
check(/No probe to the destination was lost/.test(await page.locator('.rt-findings').innerText()) && /limits its own replies/.test(await page.locator('.rt-findings').innerText()) && await page.locator('.rt-loss').count() === 5, 'the findings say the destination lost nothing and that hop 5 only limits its own replies');
await shot('mtr');
await fieldOf('Rounds').locator('input').fill('2'); await runBtn().click();
check(/rounds must be a whole number from 3 to 60/.test(await page.locator('.rt-error').innerText()), 'a number of rounds outside its limits is refused', await page.locator('.rt-error').innerText());
await fieldOf('Rounds').locator('input').fill('10');

console.log('\n== DNS trace ==');
await tool('DNS trace').click(); await host().fill('www.example.com');
await runBtn().click(); await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'trace', host: 'www.example.com', type: 'A' }), 'the trace asks for the name and the type', j(mock.starts.at(-1)));
check(await page.locator('.rt-hop').count() === 3 && (await page.locator('.rt-zone').allInnerTexts()).join() === '. (root),com,example.com' && await page.locator('.rt-tseg').count() === 3 && await page.locator('.rt-resolver').count() === 1, 'three servers are asked in turn (root, .com, the zone itself), with a time bar and the router\'s resolver at the end', (await page.locator('.rt-zone').allInnerTexts()).join());
const dtText = await resultText();
check(/Signed delegation: DS record for com/.test(dtText) && /a\.root-servers\.net/.test(dtText) && /hera\.ns\.cloudflare\.com/.test(dtText) && /172\.66\.147\.243/.test(dtText), 'each step names the server and what it said: signed delegations, then the answer');
await shot('dnstrace');
await host().fill('www.ibm.com'); await runBtn().click(); await waitDone();
check(await page.locator('.rt-alias').count() === 2 && await page.locator('.rt-hop').count() === 10, 'a name behind two aliases is followed, restarting from the root each time', String(await page.locator('.rt-hop').count()));
await shot('dnstrace-aliases');
await host().fill('nope-flab-test.example.com'); await runBtn().click(); await waitDone();
check(/does not exist/.test(await resultText()), 'a name that does not exist is reported as such');
await host().fill('www.example.com'); await fieldOf('Address family').locator('select').selectOption('6'); await fieldOf('Record type').locator('select').selectOption('AAAA'); await runBtn().click(); await waitDone();
check(j(mock.starts.at(-1)) === j({ tool: 'trace', host: 'www.example.com', type: 'AAAA', family: '6' }) && /2001:503:ba3e::2:30/.test(await resultText()), 'over IPv6 the servers are IPv6', j(mock.starts.at(-1)));

console.log('\n== the iperf3 server ==');
await tool('iperf3 server').click();
// The Start server button of the iperf3 server's form.
const startBtn = () => page.locator('.rt-diag button:has-text("Start server")');
check(await page.locator('.rt-host').count() === 0 && await startBtn().isEnabled() && await fieldOf('Run for').locator('select').inputValue() === '2' && await fieldOf('Port').locator('input').inputValue() === '5201' && (await fieldOf('Run for').locator('option').allInnerTexts()).join() === '1 minute,2 minutes,5 minutes,15 minutes,30 minutes', 'the iperf3 server needs no host: a time (2 minutes by default), a port and an address', [await page.locator('.rt-host').count(), await startBtn().isEnabled(), await fieldOf('Run for').locator('select').inputValue(), await fieldOf('Port').locator('input').inputValue(), (await fieldOf('Run for').locator('option').allInnerTexts()).join()].join(' | '));
check((await fieldOf('Listen on').locator('option').allInnerTexts()).join() === 'every address,192.168.1.1 (lan, lan),2001:db8:1::1 (lan6, lan),203.0.113.9 (wan, wan)', 'the addresses of the router are offered, with their zone');
await startBtn().click();
await page.waitForSelector('.rt-iperf-head');
check(j(mock.starts.at(-1)) === j({ tool: 'iperf', minutes: 2 }), 'only the time is sent when the rest is default', j(mock.starts.at(-1)));
check(/Listening on port 5201 on every address/.test((await page.locator('.rt-iperf-head').innerText()).replace(/\s+/g, ' ')) && /left/.test(await page.locator('.rt-iperf-left').innerText()) && await page.locator('.rt-countdown').count() === 1 && await page.locator('.rt-diag button:has-text("Stop server")').isVisible(), 'a running server says where it listens and for how long, and offers Stop server', [await page.locator('.rt-iperf-head').innerText(), await page.locator('.rt-iperf-left').innerText(), await page.locator('.rt-countdown').count(), await page.locator('.rt-diag button:has-text("Stop server")').isVisible()].join(' | '));
check(/iperf3 -c 192\.168\.1\.1/.test(await page.locator('.rt-connect').innerText()) && /Addresses the firewall blocks \(1\)/.test(await page.locator('.rt-connect').innerText()) && await page.locator('.rt-connect .rt-cmd button').count() >= 1, 'the page tells a client what to type, with a copy button, and sets aside the addresses the firewall blocks');
await page.waitForFunction(() => document.querySelectorAll('.rt-iperf-history tbody tr').length >= 3, null, { timeout: 20000 });
check(await page.locator('.rt-iperf-test').count() === 1 && await page.locator('.rt-iperf-history tbody tr').count() === 3 && /UDP/.test(await page.locator('.rt-iperf-test').innerText()), 'the newest test is shown in full and the earlier ones in a table', String(await page.locator('.rt-iperf-history tbody tr').count()));
await shot('iperf-live');
await page.locator('.rt-diag button:has-text("Stop server")').click();
await waitDone(/Stopped/);
check(mock.stops.length > 0 && await page.locator('.rt-iperf-state.ended').count() === 1 && await page.locator('.rt-iperf-history tbody tr').count() === 3, 'Stop ends the server; the tests it saw stay on the page');
await shot('iperf-stopped');
await fieldOf('Run for').locator('select').selectOption('1');
await fieldOf('Listen on').locator('select').selectOption('192.168.1.1');
await fieldOf('Port').locator('input').fill('5300');
await startBtn().click();
await waitDone(/Time is up/);
check(j(mock.starts.at(-1)) === j({ tool: 'iperf', minutes: 1, port: 5300, bind: '192.168.1.1' }) && /The time was up/.test(await page.locator('.rt-iperf-state.ended').innerText()), 'a different time, port and address are sent; a server that runs out of time ends with the time-up note', j(mock.starts.at(-1)));
await fieldOf('Port').locator('input').fill('80'); await startBtn().click();
check(/port must be a whole number from 1024 to 65535/.test(await page.locator('.rt-error').innerText()), 'a port below 1024 is refused in the form', await page.locator('.rt-error').innerText());
await fieldOf('Port').locator('input').fill('');
mock.exposed = true;
page = await open();
await tool('iperf3 server').click();
await startBtn().click();
await page.waitForSelector('.rt-iperf-head');
check(/zone wan accepts traffic for the router/.test(await page.locator('.rt-iperf').innerText()), 'a server that the internet could reach is flagged while it runs');
await page.locator('.rt-diag button:has-text("Stop server")').click(); await waitDone(/Stopped/);
mock.exposed = false;

console.log('\n== tools the router does not have ==');
mock.mtr = false; mock.kdig = false; mock.iperf3 = false;
page = await open();
check((await page.locator('.rt-seg .seg-tab').allInnerTexts()).join() === 'Connectivity check,Ping,Traceroute,DNS lookup,DNS compare,TLS certificate,Wake-on-LAN', 'mtr, the DNS trace and the iperf3 server are not offered without mtr, kdig and iperf3');
mock.mtr = true; mock.kdig = true; mock.iperf3 = true;
page = await open();

console.log('\n== a refused start ==');
await tool('Ping').click(); await host().fill('refused.example'); await runBtn().click();
await page.locator('.rt-result-slot .rt-error').waitFor({ timeout: 10000 });
check(/3 diagnostics are already running/.test(await resultText()) && /^Failed \d+ s$/.test(await badgeText()) && await runBtn().isVisible(), 'the plugin\'s refusal is shown as the result (status Failed, the reason in the body) and the form is free again');

console.log('\n== leaving the page and coming back ==');
await runFor('Ping', 'slow.example', false);
await page.waitForFunction(() => document.querySelectorAll('.rt-pt').length >= 2, null, { timeout: 15000 });
await page.locator('.nav-pane a', { hasText: 'Routing' }).click();
await page.waitForSelector('.rt-lookup button:has-text("Look up")');
await page.waitForTimeout(800);
const away = mock.reads; await page.waitForTimeout(1600);
check(mock.reads === away, 'polling stops while another page is open');
await page.locator('.nav-pane a', { hasText: 'Toolbox' }).click();
await page.waitForSelector('.rt-running');
const back = mock.reads; const barsBefore = await page.locator('.rt-pt').count();
await page.waitForFunction(n => document.querySelectorAll('.rt-pt').length > n, barsBefore, { timeout: 10000 });
check(mock.reads > back && /Ping · slow\.example/.test(await resultText()) && await host().inputValue() === 'slow.example' && await stopBtn().isVisible(), 'the job and the form are still there, and the reading resumes');

console.log('\n== a redraw in the middle of a job ==');
await page.click('button:has-text("Refresh")');
await page.waitForTimeout(600);
const mid = await page.locator('.rt-pt').count();
check(await page.locator('.rt-running').count() === 1 && await stopBtn().isVisible(), 'Refresh redraws the page and the job carries on');
await page.waitForFunction(n => document.querySelectorAll('.rt-pt').length > n, mid, { timeout: 10000 });
await stopBtn().click(); await waitDone(/Stopped/);

console.log('\n== a login that may not run diagnostics ==');
const limited = clone(acls);
limited.ubus['flab.diag'] = (limited.ubus['flab.diag'] ?? []).filter(m => !['start', 'stop'].includes(m));
const p2 = await open(limited);
check(await p2.locator('.rt-diag button:has-text("Run")').isDisabled() && /not allowed to run diagnostics/.test(await p2.locator('.rt-diag').innerText()), 'Run is disabled and the page says why');
await p2.locator('.rt-seg .seg-tab', { hasText: 'Wake-on-LAN' }).click();
check(await p2.locator('.rt-diag button:has-text("Run")').isEnabled(), 'waking a host is its own permission: a login that may not start tools can still use it');
await p2.close();
const noWake = clone(acls);
noWake.ubus['flab.diag'] = (noWake.ubus['flab.diag'] ?? []).filter(m => m !== 'wake');
const p3 = await open(noWake);
await p3.locator('.rt-seg .seg-tab', { hasText: 'Wake-on-LAN' }).click();
check(await p3.locator('.rt-diag button:has-text("Run")').isDisabled() && /not allowed to run diagnostics/.test(await p3.locator('.rt-diag').innerText()), 'a login without the wake permission cannot run it');
await p3.close();

console.log('\n== a router without openssl ==');
mock.openssl = false;
page = await open();
check((await page.locator('.rt-seg .seg-tab').allInnerTexts()).join() === 'Connectivity check,Ping,Traceroute,MTR,DNS lookup,DNS trace,DNS compare,iperf3 server,Wake-on-LAN', 'the certificate check is not offered without openssl');
mock.openssl = true;
mock.wol = '';
page = await open();
check((await page.locator('.rt-seg .seg-tab').allInnerTexts()).join() === 'Connectivity check,Ping,Traceroute,MTR,DNS lookup,DNS trace,DNS compare,TLS certificate,iperf3 server', 'Wake-on-LAN is not offered on a router that has neither etherwake nor socat');
mock.wol = 'etherwake';
mock.openssl = true;

console.log('\n== busybox nslookup only ==');
mock.dnsTool = 'nslookup';
page = await open();
await tool('DNS lookup').click();
check(await page.locator('.rt-note').count() === 0, 'no note for a record type nslookup can show (A)');
await fieldOf('Record type').locator('select').selectOption('MX');
check(/only has busybox nslookup, which cannot show MX records in full/.test(await page.locator('.rt-note').innerText()), 'for MX the page explains the limit and how to fix it');
await fieldOf('Record type').locator('select').selectOption('PTR');
check(await page.locator('.rt-note').count() === 0, 'PTR works in nslookup, so no note');
await host().fill('example.com'); await fieldOf('Record type').locator('select').selectOption('A'); await runBtn().click(); await waitDone();
check(/4 answers/.test(await page.locator('.rt-dnshead').innerText()), 'nslookup output is counted too', await page.locator('.rt-dnshead').innerText());

console.log('\n== dark theme ==');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(300);
await shot('dark');
await runFor('Ping', 'lossy.example'); await shot('dark-ping');
await tool('DNS trace').click(); await host().fill('www.example.com'); await runBtn().click(); await waitDone(); await shot('dark-dnstrace');
await tool('MTR').click(); await host().fill('1.1.1.1'); await runBtn().click(); await waitDone(); await shot('dark-mtr');
await tool('TLS certificate').click(); await host().fill('example.com'); await runBtn().click(); await waitDone(); await shot('dark-tls');
await tool('iperf3 server').click(); await page.locator('.rt-diag button:has-text("Start server")').click(); await page.waitForFunction(() => document.querySelectorAll('.rt-iperf-history tbody tr').length >= 3, null, { timeout: 20000 }); await shot('dark-iperf');
await page.locator('.rt-diag button:has-text("Stop server")').click(); await waitDone(/Stopped/);
await page.emulateMedia({ colorScheme: 'light' });

check(mock.writes.length === 0, 'nothing was written to the router', mock.writes.join());
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall Toolbox browser checks passed');
process.exit(failed ? 1 : 0);
