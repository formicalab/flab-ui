// Unit test for the client-side throughput history (www/js/pages/ipsec/rates.js); needs no router.
// Usage: node rates.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const rates = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/ipsec/rates.js')).href);
const { record, series, latest, GAP_MS } = rates;

let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

const child = { name: 'c' };
const sa = (rx, tx) => ({ iface: { rx_bytes: rx, tx_bytes: tx } });
const conn = (key, rx, tx) => ({ key, name: 'vpn', children: [{ name: 'c', sas: rx == null ? [] : [sa(rx, tx)] }] });
const poll = (t, ...conns) => record({ connections: conns }, t);
const rx = c => series(c, child).rx;

console.log('== throughput history ==');
const a = conn('a', 0, 0);
poll(0, conn('a', 0, 0));
poll(5000, conn('a', 5000, 1000));
check(rx(a).join() === '1000' && series(a, child).tx.join() === '200', 'rate = counter delta / elapsed seconds', JSON.stringify(series(a, child)));
poll(10000, conn('a', 5000, 1000));
check(latest(series(a, child)).rx === 0, 'idle tunnel reads zero');
poll(15000, conn('a', 100, 50));
check(latest(series(a, child)).rx === 0, 'a counter reset counts as zero, never negative');

console.log('== gaps ==');
poll(20000, conn('a', 200, 60));
check(rx(a).length === 4, 'history builds up', String(rx(a).length));
// Tunnel goes down: the child stays listed but has no counters, so nothing is recorded.
poll(25000, conn('a', null));
poll(25000 + GAP_MS + 1000, conn('a', 1000000, 500000));
check(rx(a).length === 0, 'history restarts after the tunnel was down for longer than the gap', String(rx(a).length));
poll(25000 + GAP_MS + 6000, conn('a', 1005000, 500000));
check(rx(a).join() === '1000', 'the first sample after a gap is a real 5 s rate, not an average over the gap', rx(a).join());

console.log('== paused polling ==');
const t0 = 200000;
poll(t0 + 5000, conn('a', 1010000, 500000));
poll(t0 + 5000 + 60000, conn('a', 9999999, 500000));
check(rx(a).length === 0, 'a long pause (paused or background tab) restarts the series', String(rx(a).length));

console.log('== several IKE SAs and removed connections ==');
const t1 = 400000;
poll(t1, conn('x#1', 0, 0), conn('x#2', 0, 0));
poll(t1 + 5000, conn('x#1', 5000, 0), conn('x#2', 50000, 0));
check(rx(conn('x#1')).join() === '1000' && rx(conn('x#2')).join() === '10000', 'series are kept per IKE SA key', `${rx(conn('x#1'))} / ${rx(conn('x#2'))}`);
poll(t1 + 10000, conn('x#1', 10000, 0));
check(rx(conn('x#2')).length === 0, 'series of a connection that disappeared is dropped');
check(rx(conn('x#1')).join() === '1000,1000', 'the remaining series continues', rx(conn('x#1')).join());

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall throughput-history checks passed');
