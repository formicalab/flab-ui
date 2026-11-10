#!/usr/bin/ucode
//
// rpcd ucode plugin reporting hardware temperatures as JSON: ubus call flab.sensors status
//
// Reads sysfs only (/sys/class/thermal and /sys/class/hwmon); no other tool or LuCI component is
// involved. Sensors that appear both as a thermal zone and as its hwmon twin are reported once.

'use strict';

import { lsdir, readfile } from 'fs';
import { num } from 'flab.util';

const THERMAL = '/sys/class/thermal';
const HWMON = '/sys/class/hwmon';

function read(path) {
	let v = readfile(path);
	return v == null ? null : trim(v);
}

// sysfs reports millidegrees Celsius.
function celsius(path) {
	let v = read(path);
	return (v == null || v == '') ? null : (+v) / 1000.0;
}

function entries(dir, re) {
	return sort(filter(lsdir(dir) ?? [], (name) => match(name, re) != null));
}

function thermal_zones(sensors, seen) {
	for (let zone in entries(THERMAL, /^thermal_zone[0-9]+$/)) {
		let dir = THERMAL + '/' + zone;
		let temp = celsius(dir + '/temp');
		if (temp == null)
			continue;

		let type = read(dir + '/type');
		seen[replace(type ?? '', /-/g, '_')] = true;

		let trips = [];
		let i = 0;
		while (true) {
			let at = celsius(`${dir}/trip_point_${i}_temp`);
			if (at == null)
				break;
			push(trips, { type: read(`${dir}/trip_point_${i}_type`), temp: at, hyst: celsius(`${dir}/trip_point_${i}_hyst`) });
			i++;
		}

		let crit = null;
		for (let t in trips)
			if (t.type == 'critical')
				crit = t.temp;

		push(sensors, { id: zone, kind: 'zone', name: type, temp, crit, policy: read(dir + '/policy'), trips });
	}
}

function hwmon_sensors(sensors, seen) {
	for (let hw in entries(HWMON, /^hwmon[0-9]+$/)) {
		let dir = HWMON + '/' + hw;
		let name = read(dir + '/name');
		if (seen[replace(name ?? '', /-/g, '_')])
			continue;

		let driver = match(readfile(dir + '/device/uevent') ?? '', /DRIVER=([^\n]+)/);
		for (let file in entries(dir, /^temp[0-9]+_input$/)) {
			let n = match(file, /^temp([0-9]+)_input$/)[1];
			push(sensors, {
				id: `${hw}/temp${n}`, kind: 'hwmon', name,
				driver: driver ? driver[1] : null,
				label: read(`${dir}/temp${n}_label`),
				temp: celsius(`${dir}/${file}`),
				max: celsius(`${dir}/temp${n}_max`),
				crit: celsius(`${dir}/temp${n}_crit`),
				throttle: num(read(`${dir}/throttle${n}`)),
			});
		}
	}
}

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

return {
	'flab.sensors': {
		status: {
			call: function(request) {
				return collect();
			},
		},
	},
};
