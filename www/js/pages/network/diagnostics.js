// "Why does this port show errors?": the breakdown behind a port's error and drop totals. Shown under the
// port in the details table when the user presses the Details button. Three sources, all from the backend:
// the non-zero kernel counters, the driver's own error counters (ethtool -S) and recent kernel log lines
// that mention the port. Counters are cumulative since boot, so what changed since the page was opened is
// called out separately.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { fmtNum } from '../../core/format.js';
import { newErrors, errorsOf, dropsOf } from './util.js';

const KERNEL = {
  rx_errors: ['Receive errors', 'Frames the receiver rejected. This is the total; the specific causes below (if any) add up to part of it.'],
  rx_crc_errors: ['CRC errors', 'Frames with a bad checksum: usually a faulty cable or connector, interference, or a duplex/speed mismatch.'],
  rx_frame_errors: ['Frame alignment errors', 'Misaligned frames, typically a cabling or duplex problem.'],
  rx_length_errors: ['Length errors', 'Frames shorter or longer than allowed.'],
  rx_over_errors: ['Receive overruns', 'The receiver was overrun: frames arrived faster than they could be stored.'],
  rx_fifo_errors: ['Receive FIFO errors', 'The hardware receive buffer overflowed.'],
  rx_missed_errors: ['Missed frames', 'Frames missed because no receive buffer was available.'],
  rx_dropped: ['Receive drops', 'Frames the kernel or driver discarded after reception (no buffer, filtered, unknown protocol).'],
  tx_errors: ['Transmit errors', 'Frames that could not be sent.'],
  tx_dropped: ['Transmit drops', 'Frames dropped before transmission (queue full, device or link down at that moment).'],
  tx_aborted_errors: ['Aborted transmissions', 'Transmissions aborted, for example after too many collisions.'],
  tx_carrier_errors: ['Carrier lost while sending', 'The link dropped during transmission.'],
  tx_fifo_errors: ['Transmit FIFO errors', 'The hardware transmit buffer underran.'],
  tx_heartbeat_errors: ['Heartbeat errors', 'Missing signal-quality heartbeat (legacy hardware).'],
  tx_window_errors: ['Late collisions', 'Collisions after the normal window: usually a duplex mismatch.'],
  collisions: ['Collisions', 'Frames that collided (half-duplex links only).'],
};

const DRIVER = [
  [/checksum/i, 'The hardware checksum check flagged the frame as corrupt. Often a bad cable, connector or interference on the link, or a misbehaving peer.'],
  [/crc/i, 'Bad frame checksum: a faulty cable or connector.'],
  [/drop|discard/i, 'The driver or hardware discarded frames.'],
  [/fifo|overrun|underrun/i, 'A hardware buffer overflowed or ran empty.'],
  [/timeout/i, 'A transmit timeout occurred: the driver had to reset the queue.'],
  [/err|fail|bad|invalid/i, 'A driver-reported error condition.'],
];

const explainDriver = name => DRIVER.find(([re]) => re.test(name))?.[1] ?? '';

function counterTable(title, entries) {
  if (!entries.length) return null;
  return h('div', { className: 'diag-block' }, h('h4', {}, title),
    h('table', { className: 'table table-sm diag-table' }, h('tbody', {}, entries.map(([name, label, value, hint]) => h('tr', {},
      h('td', {}, h('div', { className: 'fw-semibold' }, label), name !== label ? h('div', { className: 'muted small mono' }, name) : null),
      h('td', { className: 'num' }, fmtNum(value)),
      h('td', { className: 'muted small' }, hint))))));
}

export function diagnosticsPanel(p) {
  const d = p.diagnostics;
  const kernel = Object.entries(d.counters ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, KERNEL[k]?.[0] ?? k, v, KERNEL[k]?.[1] ?? '']);
  const driver = Object.entries(d.driver ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, k, v, explainDriver(k)]);
  const fresh = newErrors(p);
  const log = d.log ?? [];

  return h('div', { className: 'diag' },
    h('div', { className: 'diag-head' }, icon('info-circle'),
      h('span', {}, `${p.name}: ${fmtNum(errorsOf(p))} error${errorsOf(p) === 1 ? '' : 's'}, ${fmtNum(dropsOf(p))} drop${dropsOf(p) === 1 ? '' : 's'} since the router booted. `,
        fresh ? h('b', { className: 'text-danger' }, `${fresh} new since this page was opened.`) : h('span', { className: 'muted' }, 'None new since this page was opened: these are historical counts.'))),
    h('div', { className: 'diag-grid' },
      counterTable('Kernel counters', kernel),
      counterTable('Driver counters (ethtool -S)', driver)),
    kernel.length === 1 && !driver.length ? h('div', { className: 'muted small' }, 'The kernel reports only this total for the port, and the driver exposes no error counters, so the cause cannot be broken down further.') : null,
    h('div', { className: 'diag-block' }, h('h4', {}, 'Recent system log lines mentioning this port'),
      log.length ? h('pre', { className: 'diag-log mono' }, log.join('\n')) : h('div', { className: 'muted small' }, `Nothing in the system log mentions ${p.name} (the log only keeps recent messages).`)));
}
