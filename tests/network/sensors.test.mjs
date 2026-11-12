// Unit test for the temperature helpers of the Overview page (www/js/pages/overview/temperatures.js): sensors
// that give no reading must be left out, never crash the page. Pure functions: no router and no browser.
// Usage: node sensors.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const m = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/overview/temperatures.js')).href);

let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

// Sensors as the flab.sensors plugin reports them; the Qualcomm Wi-Fi drivers of a repeater give no reading while a radio is down.
const sensors = [
  { id: 'hwmon0/temp1', kind: 'hwmon', name: 'ath10k_hwmon', driver: 'ath10k_pci', label: null, temp: null, max: null, crit: null, throttle: null },
  { id: 'hwmon1/temp1', kind: 'hwmon', name: 'ath10k_hwmon', driver: 'ath10k_ahb', label: null, temp: 69, max: null, crit: null, throttle: null },
  { id: 'thermal_zone0', kind: 'zone', name: 'cpu-thermal', temp: 52.5, crit: 105, trips: [] },
];

console.log('== sensors without a reading ==');
check(m.readable(sensors).length === 2 && m.readable(undefined).length === 0 && m.readable([]).length === 0, 'only sensors with a temperature are kept, and a missing list is empty');
check(m.hottest(sensors)?.id === 'hwmon1/temp1', 'the hottest sensor ignores one with no reading', JSON.stringify(m.hottest(sensors)));
check(m.hottest([sensors[0]]) === null && m.hottest([]) === null, 'no readable sensor means no hottest one');
check(m.fmtTemp(null) === '–' && m.fmtTemp(undefined) === '–' && m.fmtTemp(52.5) === '52.5 °C', 'a missing temperature is a dash, a number has one decimal');

console.log('== names and levels ==');
const label = m.sensorLabel(sensors[1]);
check(label.title === 'Wi-Fi radio (Qualcomm)' && label.sub === 'ath10k_ahb · hwmon1', 'a Qualcomm Wi-Fi sensor is named after its driver and hwmon device', JSON.stringify(label));
check(m.sensorLabel({ name: 'mt7915_phy0', id: 'hwmon3/temp1' }).title === 'Wi-Fi radio phy0' && m.sensorLabel(sensors[2]).title === 'CPU (SoC)', 'the known MediaTek and SoC names are kept');
check(m.sensorLevel({ temp: 69 }) === 'good' && m.sensorLevel({ temp: 80 }) === 'fair' && m.sensorLevel({ temp: 91 }) === 'weak' && m.sensorLevel({ temp: 100, crit: 105 }) === 'weak', 'temperature levels: normal, warm, hot, and near the critical limit');

console.log(failed ? `\n${failed} check(s) failed` : '\nall sensor checks passed');
process.exit(failed ? 1 : 0);
