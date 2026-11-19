// The packet capture's view: the figures and findings, the protocols and busiest conversations, a table of the packets as
// they arrive, and the download of the capture file. The meaning of the output comes from capturemodel.js; the view is
// repainted every time new output arrives, so the table fills in while the capture runs.
import { h } from '../../core/dom.js';
import { AuthError, can, ubus } from '../../core/ubus.js';
import { fmtBytes } from '../../core/format.js';
import { saveFile } from '../../core/download.js';
import { badge, button, mono, muted } from '../../core/ui.js';
import { stat } from './diagviews.js';
import { captureNotes, parseCapture } from './capturemodel.js';
import { banner, findingList } from './parts.js';

// The packets drawn in the table. The plugin sends the first 1000 packet lines (CAPTURE_SHOWN) and the figures above count
// all of them; the table stops earlier to keep the redraw every half second cheap.
const MAX_ROWS = 500;

// The color of a protocol's badge: connections and reliable transport in blue, datagrams and names in green, diagnostics in
// amber, anything unusual neutral.
const TONE = { TCP: 'info', UDP: 'success', DNS: 'success', mDNS: 'success', ICMP: 'warning', ICMPv6: 'warning', ARP: 'warning' };

// An endpoint of a packet: the address, with its port after a colon in muted type.
const endpoint = (addr, port) => (addr == null ? muted('–') : [mono(addr), port == null ? null : h('span', { className: 'muted mono' }, `:${port}`)]);

// A time in seconds since the first packet, as "0.000123".
const seconds = v => v.toFixed(6);

const pad = n => String(n).padStart(2, '0');

// The name of the capture file offered for download: the interface and the start time.
const fileName = job => {
  const t = new Date(job.t0);
  const iface = (job.cap?.iface ?? 'any').replace(/[^\w.-]/g, '_');
  return `capture-${iface}-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.pcap`;
};

// Fetches the capture file in pieces (the plugin returns it as base64, a few hundred kilobytes at a time) and hands it to the
// browser as a download. The button shows the progress and the outcome.
async function download(job, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  const parts = [];
  let from = 0;
  try {
    for (;;) {
      const r = await ubus('flab.diag', 'download', { id: job.id, from });
      if (!r.ok) throw new Error(r.error);
      if (r.length) parts.push(Uint8Array.from(atob(r.data), c => c.charCodeAt(0)));
      from += r.length;
      btn.textContent = `Downloading… ${r.size ? Math.min(100, Math.round(from / r.size * 100)) : 100}%`;
      if (r.done || !r.length) break;
    }
    saveFile(fileName(job), parts, 'application/vnd.tcpdump.pcap');
    btn.textContent = 'Downloaded';
  } catch (e) {
    btn.textContent = e instanceof AuthError ? 'Session expired' : `Failed: ${e.message}`;
  }
  setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
}

// The download button: always shown on a finished capture, disabled (with the reason) for a session that does not hold the
// permission, which a session opened before the plugin offered `download` does not.
function downloadButton(job) {
  const props = can('flab.diag', 'download') ? {} : { disabled: true, title: 'This login does not hold the download permission. Sign out and in again.' };
  return button('Download .pcap', 'download', e => download(job, e.currentTarget), 'btn-brand', props);
}

// The capture result. `job.cap` is the request ({ iface, seconds, packets, snaplen, filter }).
export function captureBody(job) {
  const c = parseCapture(job.text);
  const notes = captureNotes(c, job.cap);
  if (c.error && !c.packets.length && !job.running) return banner(`The capture failed: ${c.error}.`);
  const seen = c.packets.length + c.more;
  const rows = c.packets.slice(0, MAX_ROWS).map(p => h('tr', { className: /^Flags \[R/.test(p.info) ? 'rt-rst' : '' },
    h('td', { className: 'num mono' }, seconds(p.rel)),
    h('td', {}, badge(p.proto, TONE[p.proto] ?? '')),
    h('td', {}, endpoint(p.src, p.sport)),
    h('td', {}, endpoint(p.dst, p.dport)),
    h('td', { className: 'num' }, p.len == null ? muted('–') : String(p.len)),
    h('td', { className: 'rt-pkt-info mono', title: p.info }, p.iface ? [muted(`${p.iface} ${p.dir} `), p.info] : p.info)));
  return h('div', { className: 'rt-capture' },
    h('div', { className: 'rt-stats' },
      stat(c.done ? 'Packets captured' : 'Packets so far', String(c.captured ?? seen)),
      c.done && c.received != null ? stat('Matched the filter', String(c.received)) : null,
      c.done ? stat('Dropped by the kernel', String(c.dropped ?? 0), c.dropped > 0 ? 'warn' : 'ok') : null,
      c.tcp ? stat('New connections (SYN)', String(c.syn)) : null,
      c.tcp ? stat('Resets (RST)', String(c.rst), c.rst > 0 && c.rst / c.tcp >= 0.1 ? 'warn' : '') : null,
      c.packets.length > 1 ? stat('Span', `${c.span.toFixed(c.span < 10 ? 2 : 1)} s`) : null),
    findingList(notes),
    c.protocols.length ? h('div', { className: 'rt-cap-protos' }, h('span', { className: 'muted' }, `Protocols in the first ${c.packets.length}:`), c.protocols.map(([name, n]) => h('span', { className: 'rt-cap-proto' }, badge(name, TONE[name] ?? ''), ` ${n}`))) : null,
    c.conversations.length ? h('div', { className: 'rt-cap-talkers' }, h('div', { className: 'muted' }, 'Busiest conversations'), c.conversations.map(t => h('div', { className: 'rt-cap-talker' }, mono(t.a), h('span', { className: 'muted' }, ' ↔ '), mono(t.b), h('span', { className: 'muted' }, ` · ${t.packets} packet${t.packets === 1 ? '' : 's'}${t.bytes ? ` · ${fmtBytes(t.bytes)}` : ''}`)))) : null,
    !job.running && c.captured > 0 && job.id ? h('div', { className: 'rt-actions rt-mtr-actions' }, downloadButton(job), muted(can('flab.diag', 'download') ? 'Open it in Wireshark. The router keeps it for ten minutes, and only the newest capture.' : 'This session was opened before the download permission existed: sign out and in again to enable it.')) : null,
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover rt-trace rt-captable' },
      h('thead', {}, h('tr', {}, ['Time (s)', 'Protocol', 'Source', 'Destination', 'Length', 'Info'].map((t, i) => h('th', { className: i === 0 || i === 4 ? 'num' : '' }, t)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 6, className: 'muted' }, job.running ? 'Waiting for the first packet…' : 'No packets'))))),
    c.packets.length > MAX_ROWS ? muted(`Showing the first ${MAX_ROWS} of ${c.packets.length} packets in the table.`) : null);
}
