// Unit test for the client-side rate tracker (www/js/core/rates.js); needs no router.
// Usage: node rates.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const { createTracker, latest } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/core/rates.js')).href);

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

console.log('== rates ==');
const t = createTracker({ gapMs: 15000, maxSamples: 4 });
t.record('a', { rx: 0, tx: 0 }, 0);
t.record('a', { rx: 5000, tx: 1000 }, 5000);
check(t.rates('a', 'rx').join() === '1000' && t.rates('a', 'tx').join() === '200', 'rate = counter delta / elapsed seconds', `${t.rates('a', 'rx')} ${t.rates('a', 'tx')}`);
t.record('a', { rx: 100, tx: 0 }, 10000);
check(latest(t.rates('a', 'rx')) === 0, 'a counter reset counts as zero, never negative');
t.record('a', { rx: 200, tx: 10 }, 15000); t.record('a', { rx: 300, tx: 20 }, 20000); t.record('a', { rx: 400, tx: 30 }, 25000);
check(t.rates('a', 'rx').length === 3, 'history is capped (4 samples -> 3 rates)', String(t.rates('a', 'rx').length));
check(t.rates('missing', 'rx').length === 0 && latest(t.rates('missing', 'rx')) === null, 'unknown series is empty');

console.log('== gaps ==');
t.record('a', { rx: 10_000_000, tx: 0 }, 25000 + 20000);
check(t.rates('a', 'rx').length === 0, 'a gap longer than gapMs restarts the series');
t.record('a', { rx: 10_005_000, tx: 0 }, 25000 + 25000);
check(t.rates('a', 'rx').join() === '1000', 'the first sample after a gap is a real rate, not an average over the gap', t.rates('a', 'rx').join());

console.log('== ratios ==');
t.record('air', { busy: 0, active: 0 }, 0);
t.record('air', { busy: 200, active: 1000 }, 5000);
check(t.ratios('air', 'busy', 'active').join() === '20', 'ratio of two counter deltas in percent', t.ratios('air', 'busy', 'active').join());
t.record('air', { busy: 10, active: 20 }, 10000);
check(t.ratios('air', 'busy', 'active').at(-1) === null, 'a counter that went backwards (channel change) gives null, not nonsense');
t.record('air', { busy: 10, active: 20 }, 15000);
check(t.ratios('air', 'busy', 'active').at(-1) === null, 'zero airtime elapsed gives null (no division by zero)');
t.record('air', { busy: 5000, active: 1000 }, 20000);
check(t.ratios('air', 'busy', 'active').at(-1) === 100, 'ratios are capped at 100 %');

console.log('== housekeeping ==');
t.record('b', { rx: 1 }, 0); t.record('b', { rx: 2 }, 1000);
t.keep(['b']);
check(t.rates('a', 'rx').length === 0 && t.rates('b', 'rx').length === 1, 'keep() drops series of things that disappeared');
t.record('c', { rx: undefined, tx: NaN }, 0);
check(t.rates('c', 'rx').length === 0, 'non-numeric counters are ignored');

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall rate-tracker checks passed');
