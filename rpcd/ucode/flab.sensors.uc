#!/usr/bin/ucode
//
// rpcd ucode plugin reporting hardware temperatures as JSON: ubus call flab.sensors status
//
// Reads sysfs only (/sys/class/thermal and /sys/class/hwmon); no other tool is
// involved. Sensors that appear both as a thermal zone and as its hwmon twin are reported once.

'use strict';
import { deferred } from 'flab.worker';

import { lsdir, readfile } from 'fs';
import { num } from 'flab.util';

// sysfs directories scanned for temperatures.
const THERMAL = '/sys/class/thermal';
const HWMON = '/sys/class/hwmon';

// Trimmed contents of a sysfs file, or null when it is missing.
function read(path) {
	let v = readfile(path);
	return v == null ? null : trim(v);
}

// sysfs reports millidegrees Celsius; returns degrees, or null when the file is missing or empty.
function celsius(path) {
	let v = read(path);
	return (v == null || v == '') ? null : (+v) / 1000.0;
}

// Sorted names in `dir` that match the regex `re` (empty when the directory does not exist).
function entries(dir, re) {
	return sort(filter(lsdir(dir) ?? [], (name) => match(name, re) != null));
}

// Appends one sensor per readable thermal_zoneN to `sensors`, with its trip points and the critical
// temperature among them. Each zone type is added to `seen` (dashes as underscores) so that
// hwmon_sensors() can skip the hwmon device that mirrors the same zone.
function thermal_zones(sensors, seen) {
	for (let zone in entries(THERMAL, /^thermal_zone[0-9]+$/)) {
		let dir = THERMAL + '/' + zone;
		let temp = celsius(dir + '/temp');
		if (temp == null)
			continue;

		let zone_type = read(dir + '/type');
		seen[replace(zone_type ?? '', /-/g, '_')] = true;

		// Trip points are numbered consecutively from 0; the first missing one ends the list (at most 32 are read).
		let trips = [];
		for (let i = 0; i < 32; i++) {
			let at = celsius(`${dir}/trip_point_${i}_temp`);
			if (at == null)
				break;
			push(trips, { type: read(`${dir}/trip_point_${i}_type`), temp: at, hyst: celsius(`${dir}/trip_point_${i}_hyst`) });
		}

		let crit = null;
		for (let t in trips)
			if (t.type == 'critical')
				crit = t.temp;

		push(sensors, { id: zone, kind: 'zone', name: zone_type, temp, crit, policy: read(dir + '/policy'), trips });
	}
}

// Appends one sensor per tempN_input of every hwmon device to `sensors`, skipping devices already
// reported as a thermal zone (matched by name). The driver comes from the device's uevent file and
// `throttle` from the optional throttleN attribute.
function hwmon_sensors(sensors, seen) {
	for (let hw in entries(HWMON, /^hwmon[0-9]+$/)) {
		let dir = HWMON + '/' + hw;
		let name = read(dir + '/name');
		if (seen[replace(name ?? '', /-/g, '_')])
			continue;

		let driver = match(readfile(dir + '/device/uevent') ?? '', /DRIVER=([^\n]+)/);
		for (let file in entries(dir, /^temp[0-9]+_input$/)) {
			let n = match(file, /^temp([0-9]+)_input$/)[1];
			let temp = celsius(`${dir}/${file}`);
			// A sensor that gives no reading (a radio that is down, for example) is of no use to the UI.
			if (temp == null)
				continue;
			push(sensors, {
				id: `${hw}/temp${n}`, kind: 'hwmon', name,
				driver: driver ? driver[1] : null,
				label: read(`${dir}/temp${n}_label`),
				temp,
				max: celsius(`${dir}/temp${n}_max`),
				crit: celsius(`${dir}/temp${n}_crit`),
				throttle: num(read(`${dir}/throttle${n}`)),
			});
		}
	}
}

// Builds the flab.sensors status reply: temperature sensors plus the thermal cooling devices
// (type, current and maximum state).
function collect() {
	let sensors = [];
	let seen = {};
	thermal_zones(sensors, seen);
	hwmon_sensors(sensors, seen);

	let cooling = [];
	for (let dev in entries(THERMAL, /^cooling_device[0-9]+$/)) {
		let dir = THERMAL + '/' + dev;
		push(cooling, { id: dev, type: read(dir + '/type'), cur: num(read(dir + '/cur_state')), max: num(read(dir + '/max_state')) });
	}

	return { generated: time(), sensors, cooling };
}

// rpcd registration: ubus object flab.sensors with the single method `status` (no arguments).
return deferred({
	'flab.sensors': {
		status: {
			call: function() {
				return collect();
			},
		},
	},
});
