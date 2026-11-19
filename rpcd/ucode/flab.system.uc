#!/usr/bin/ucode
//
// rpcd ucode plugin with system facts the standard ubus objects lack:
//   ubus call flab.system cpu    CPU statistics as JSON
//   ubus call flab.system build  identifier and file list of the installed web files (browser cache refresh)
//   ubus call flab.system modules installed optional frontend module manifests
//   ubus call flab.system backup_create
//   ubus call flab.system backup_begin '{"size":1234}'
//   ubus call flab.system backup_upload '{"id":"...","from":0,"data":"<base64>"}'
//   ubus call flab.system backup_inspect '{"id":"..."}'
//   ubus call flab.system backup_restore '{"id":"..."}'
//   ubus call flab.system ntp_sync
//
// Returns the kernel's cumulative CPU time counters (/proc/stat), the load average and the task counts.
// Utilization is a rate, so it is derived from the difference between two successive calls (the UI does
// this); the counters are not converted here, which keeps the call instantaneous and rpcd unblocked.
// `cpu` reads procfs only; `build` only lists and stats the files under /www/flab. Backup methods additionally use
// fixed `sysupgrade`, `gzip`, and `tar` commands on validated temporary paths.

'use strict';
import { deferred } from 'flab.worker';
import { command_result } from 'flab.util';

import { mkdir, open, readfile, writefile, lsdir, stat } from 'fs';

// Order of the columns on a "cpu" line in /proc/stat (guest times are already part of user/nice).
const FIELDS = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'];

// Parses the text of /proc/stat into { cpus: [{ id, user, nice, ... }], ctxt, procs_running,
// procs_blocked }. The "cpu" line is the all-core total; "cpuN" lines are the individual cores. Values are
// cumulative jiffies (USER_HZ ticks), left unconverted; missing columns on old kernels count as 0.
function parse_stat(text) {
	let out = { cpus: [], ctxt: null, procs_running: null, procs_blocked: null };

	for (let line in split(text ?? '', '\n')) {
		let m = match(line, /^(cpu[0-9]*)[ ]+(.*)$/);
		if (m) {
			// Counters follow the id in the order given by FIELDS.
			let tok = split(trim(m[2]), /[ ]+/);
			let cpu = { id: m[1] };
			for (let i = 0; i < length(FIELDS); i++)
				cpu[FIELDS[i]] = +(tok[i] ?? 0);
			push(out.cpus, cpu);
			continue;
		}

		m = match(line, /^(ctxt|procs_running|procs_blocked) ([0-9]+)/);
		if (m)
			out[m[1]] = +m[2];
	}
	return out;
}

// Builds the flab.system cpu reply from /proc/stat, /proc/loadavg and /proc/uptime. `cores` counts the
// per-core "cpuN" entries (the aggregate "cpu" entry is excluded); fields are null when a file is unreadable.
function collect() {
	let parsed = parse_stat(readfile('/proc/stat'));

	// "0.01 0.03 0.05 2/210 16460": three averages, runnable/total tasks, last pid.
	let la = match(readfile('/proc/loadavg') ?? '', /^([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9]+)\/([0-9]+)/);
	let up = match(readfile('/proc/uptime') ?? '', /^([0-9.]+)/);

	return {
		generated: time(),
		// Router uptime lets the UI detect gaps between samples (e.g. after a pause) without its own clock.
		uptime: up ? +up[1] : null,
		cores: length(filter(parsed.cpus, (c) => c.id != 'cpu')),
		cpus: parsed.cpus,
		ctxt: parsed.ctxt,
		procs_running: parsed.procs_running,
		procs_blocked: parsed.procs_blocked,
		load: la ? [+la[1], +la[2], +la[3]] : null,
		runnable: la ? +la[4] : null,
		tasks: la ? +la[5] : null,
	};
}

// Directory served by uhttpd at /flab/ (see the package Makefile).
const WEB_ROOT = '/www/flab';

// Lists every file below `dir` as { path, sig }, where `path` is relative to the web root and `sig` combines the
// size and both timestamps. uhttpd sends no Cache-Control and package files carry a reproducible-build mtime,
// so browsers keep serving old files for a very long time; the status change time (ctime) is set whenever a file
// is written or replaced, which makes `sig` change on every install even when the size and mtime do not.
function list_files(dir, prefix, out) {
	for (let name in sort(lsdir(dir) ?? [])) {
		let path = dir + '/' + name, st = stat(path);
		if (!st)
			continue;
		if (st.type == 'directory')
			list_files(path, prefix + name + '/', out);
		else if (st.type == 'file')
			push(out, { path: prefix + name, sig: `${st.size}:${st.mtime}:${st.ctime}` });
	}
	return out;
}

// 32-bit FNV-1a hash of a string, as 8 hex digits. Only detects change; it is not a security measure.
function fingerprint(text) {
	let h = 2166136261;
	for (let i = 0; i < length(text); i++)
		h = ((h ^ ord(text, i)) * 16777619) % 4294967296;
	return sprintf('%08x', h);
}

// Builds the flab.system build reply: the identifier of the installed web files and the list of those files.
// The browser compares `id` with the one it stored, and re-downloads `files` when it differs (core/freshness.js).
function build() {
	let files = list_files(WEB_ROOT, '', []);
	return {
		id: fingerprint(join('\n', map(files, (f) => `${f.path}:${f.sig}`))),
		files: map(files, (f) => f.path),
	};
}

// Reads optional module manifests installed by flab-ui feature packages. Invalid files are ignored rather than
// taking down the base UI; the browser independently validates every field before creating a route.
function modules() {
	let root = `${WEB_ROOT}/modules`, out = [];
	for (let name in sort(lsdir(root) ?? [])) {
		let m = match(name, /^([a-z0-9-]+)\.json$/);
		let raw = m ? readfile(`${root}/${name}`) : null;
		if (raw == null)
			continue;
		try {
			let value = json(raw);
			if (type(value) == 'object' && type(value.entries) == 'array')
				push(out, value);
		} catch (e) {
			continue;
		}
	}
	return { modules: out };
}

function ntp_sync() {
	let result = command_result('/etc/init.d/sysntpd restart', { timeout: 15 });
	if (!result.ok)
		return { ok: false, error: trim(result.output) || 'The NTP service could not be restarted.' };
	return { ok: true, restarted: true };
}

// JEDEC manufacturer ids seen on eMMC parts.
const MMC_VENDORS = { '0x000015': 'Samsung', '0x000011': 'Toshiba / Kioxia', '0x000013': 'Micron', '0x00000d': 'Micron',
	'0x000045': 'SanDisk', '0x000090': 'SK Hynix', '0x000070': 'Kingston', '0x0000fe': 'Micron', '0x000088': 'Foresee' };

// Reads one sysfs attribute of a block device's controller, trimmed; '' when absent.
function attribute(name, file) {
	return trim(readfile(`/sys/class/block/${name}/${file}`) ?? '');
}

// The wear band of an eMMC life-time estimate: 0x01 means 0-10 % of the life used, 0x0b more than 100 %.
function wearBand(value) {
	if (!match(value ?? '', /^0x[0-9a-f]+$/))
		return null;
	let band = hex(value);
	return band >= 1 && band <= 11 ? { from: (band - 1) * 10, to: band > 10 ? null : band * 10 } : null;
}

// Physical disks (eMMC, NVMe, SATA/USB) with the identity, wear, traffic and partition table of each. Everything
// is optional: a field is omitted when the kernel does not expose it for that device.
function disks(block) {
	let list = [];
	for (let name in sort(keys(block))) {
		if (!match(name, /^(mmcblk[0-9]+|nvme[0-9]+n[0-9]+|sd[a-z]+)$/) || !(block[name].size > 0))
			continue;
		let disk = { name, kind: block[name].kind == 'MMC' ? 'eMMC' : match(name, /^nvme/) ? 'NVMe' : block[name].removable ? 'USB / removable' : 'SATA / SCSI',
			model: block[name].model, size: block[name].size, readonly: attribute(name, 'ro') == '1',
			rotational: attribute(name, 'queue/rotational') == '1' };
		let dev = 'device/';
		let vendor = lc(attribute(name, dev + 'manfid'));
		if (vendor)
			disk.vendor = MMC_VENDORS[vendor] ?? vendor;
		let files = { date: 'date', firmware: 'fwrev', revision: 'rev', erase: 'preferred_erase_size' };
		for (let key, file in files)
			if (attribute(name, dev + file) != '')
				disk[key] = attribute(name, dev + file);
		let life = split(attribute(name, dev + 'life_time'), ' ');
		if (length(life) == 2) {
			disk.wear = { slc: wearBand(life[0]), mlc: wearBand(life[1]) };
			// The more worn of the two areas; many devices report only one of them (the other reads 0x00).
			for (let band in [disk.wear.slc, disk.wear.mlc])
				if (band && (!disk.wear.worst || (band.to ?? 101) > (disk.wear.worst.to ?? 101)))
					disk.wear.worst = band;
		}
		let eol = attribute(name, dev + 'pre_eol_info');
		if (eol != '')
			disk.eol = { '0x01': 'normal', '0x02': 'warning', '0x03': 'urgent' }[eol] ?? eol;
		let stat = split(trim(attribute(name, 'stat')), /[ ]+/);
		if (length(stat) >= 7) {
			disk.read = +stat[2] * 512;
			disk.written = +stat[6] * 512;
			// A loop device on this disk (the f2fs overlay) turns its discards into zero-fill writes that the disk
			// counts as written data. They are not data written by the system, so they are reported separately.
			let discarded = 0;
			for (let loop, item in block) {
				let backing = replace(item.backing ?? '', /^\//, '');
				if (match(loop, /^loop[0-9]+$/) && index(backing, name) == 0 && match(substr(backing, length(name)), /^(p?[0-9]+)?$/)) {
					let loopStat = split(trim(attribute(loop, 'stat')), /[ ]+/);
					if (length(loopStat) >= 14)
						discarded += +loopStat[13] * 512;
				}
			}
			if (discarded > 0) {
				disk.discarded = discarded < disk.written ? discarded : disk.written;
				disk.written -= disk.discarded;
			}
		}
		disk.partitions = [];
		for (let part in sort(keys(block)))
			if (index(part, name) == 0 && part != name && match(substr(part, length(name)), /^p?[0-9]+$/)) {
				let uevent = readfile(`/sys/class/block/${part}/uevent`) ?? '';
				let label = match(uevent, /PARTNAME=([^\n]*)/);
				push(disk.partitions, { name: part, label: label ? label[1] : '', size: block[part].size });
			}
		push(list, disk);
	}
	return list;
}

// The NAND chip as the kernel logged it at boot ("nand: Macronix MX30LF1G18AC", "nand: 128 MiB, SLC, ...").
// The boot log can have rotated out, so every field is optional.
function nandChip() {
	let chip = {};
	let result = command_result("dmesg 2>/dev/null | grep -E 'nand: ' | head -6", { timeout: 3, max_output: 8192 });
	for (let line in split(result.output ?? '', '\n')) {
		line = trim(line);
		let geometry = match(line, /nand: ([0-9]+) MiB, ([A-Za-z]+), erase size: ([0-9]+) KiB, page size: ([0-9]+)/);
		let name = match(line, /nand: ([A-Z][A-Za-z]+ [A-Z0-9][A-Za-z0-9._-]*)$/);
		if (geometry)
			chip = { ...chip, size: +geometry[1] * 1048576, cell: geometry[2], erase: +geometry[3] * 1024, page: +geometry[4] };
		else if (name)
			chip.model = name[1];
	}
	return chip;
}

function numberAt(path) {
	let value = trim(readfile(path) ?? '');
	return match(value, /^[0-9]+$/) ? +value : null;
}

// Raw NAND flash managed by UBI (many routers and repeaters): chip identity, wear from UBI's erase counters, the
// bad-block count against UBI's spare reserve, ECC activity and the UBI volumes in place of partitions.
function nandDisks(chip) {
	let list = [];
	for (let ubi in sort(lsdir('/sys/class/ubi') ?? [])) {
		if (!match(ubi, /^ubi[0-9]+$/))
			continue;
		let base = `/sys/class/ubi/${ubi}`;
		let total = 0, corrected = 0, failures = 0;
		for (let mtd in (lsdir('/sys/class/mtd') ?? []))
			if (match(mtd, /^mtd[0-9]+$/) && trim(readfile(`/sys/class/mtd/${mtd}/type`) ?? '') == 'nand') {
				total += numberAt(`/sys/class/mtd/${mtd}/size`) ?? 0;
				corrected += numberAt(`/sys/class/mtd/${mtd}/corrected_bits`) ?? 0;
				failures += numberAt(`/sys/class/mtd/${mtd}/ecc_failures`) ?? 0;
			}
		let disk = { name: ubi, kind: 'NAND flash', model: chip.model ?? 'NAND flash', size: chip.size ?? total,
			cell: chip.cell, erase: numberAt(`${base}/eraseblock_size`), page: chip.page,
			nand: { maxErase: numberAt(`${base}/max_ec`), bad: numberAt(`${base}/bad_peb_count`),
				reserved: numberAt(`${base}/reserved_for_bad`), blocks: numberAt(`${base}/total_eraseblocks`), corrected, failures },
			partitions: [] };
		for (let entry in sort(lsdir('/sys/class/ubi') ?? []))
			if (index(entry, ubi + '_') == 0 && match(entry, /^ubi[0-9]+_[0-9]+$/))
				push(disk.partitions, { name: entry, label: trim(readfile(`/sys/class/ubi/${entry}/name`) ?? ''),
					size: numberAt(`/sys/class/ubi/${entry}/data_bytes`) ?? 0 });
		push(list, disk);
	}
	return list;
}

// The UBI volume behind a block device name such as ubi0_3 (the volume itself) or ubiblock0_1 (read-only squashfs on it).
function ubiVolume(name, chip) {
	let found = match(name, /^(ubi|ubiblock)([0-9]+)_([0-9]+)$/);
	if (!found)
		return null;
	let volume = `ubi${found[2]}_${found[3]}`;
	return { kind: 'NAND flash', model: chip.model ?? 'NAND flash', partition: trim(readfile(`/sys/class/ubi/${volume}/name`) ?? '') || volume,
		volumeSize: numberAt(`/sys/class/ubi/${volume}/data_bytes`) };
}

function storage() {
	let mounts = [];
	let result = command_result("df -kP 2>/dev/null | awk 'NR > 1 { print $1 \"\\t\" $2 \"\\t\" $3 \"\\t\" $4 \"\\t\" $5 \"\\t\" $6 }'",
		{ timeout: 5, max_output: 65536 });
	if (!result.ok)
		return { ok: false, filesystems: [] };

	let byMount = {};
	for (let line in split(trim(result.output ?? ''), '\n')) {
		let fields = split(line, '\t');
		if (length(fields) < 6)
			continue;
		let mount = fields[5];
		byMount[mount] = {
			device: fields[0], mount,
			total: +fields[1] * 1024, used: +fields[2] * 1024, available: +fields[3] * 1024,
			percent: +(replace(fields[4], '%', '')) || 0,
		};
	}
	for (let line in split(readfile('/proc/mounts') ?? '', '\n')) {
		let fields = split(line, /[ ]+/);
		if (length(fields) < 4 || !byMount[fields[1]])
			continue;
		byMount[fields[1]].fstype = fields[2];
		byMount[fields[1]].readonly = index(split(fields[3], ','), 'ro') >= 0;
	}
	let block = {};
	for (let name in (lsdir('/sys/class/block') ?? [])) {
		let model = trim(readfile(`/sys/class/block/${name}/device/name`) ?? '');
		let kind = trim(readfile(`/sys/class/block/${name}/device/type`) ?? '');
		let backing = trim(readfile(`/sys/class/block/${name}/loop/backing_file`) ?? '');
		let removable = trim(readfile(`/sys/class/block/${name}/removable`) ?? '') == '1';
		let size = +(trim(readfile(`/sys/class/block/${name}/size`) ?? '0')) * 512;
		block[name] = { name, model, kind, backing, removable, size };
	}
	let chip = length(lsdir('/sys/class/ubi') ?? []) ? nandChip() : {};
	let backingHardware = (device) => {
		let ubi = ubiVolume(replace(device, /^\/dev\//, ''), chip);
		if (ubi)
			return ubi;
		if (device == '/dev/root') {
			if (block.mmcblk0?.kind != 'MMC')
				for (let name in sort(keys(block)))
					if (match(name, /^ubiblock[0-9]+_[0-9]+$/))
						return ubiVolume(name, chip);
			return { kind: block.mmcblk0?.kind == 'MMC' ? 'eMMC firmware' : 'Firmware storage', model: block.mmcblk0?.model ?? 'root device' };
		}
		if (match(device, /^\/dev\/loop/)) {
			let name = replace(device, /^\/dev\//, '');
			let backing = block[name]?.backing ?? '';
			if (match(backing, /^\/?mmcblk/))
				return { kind: 'eMMC', model: block.mmcblk0?.model ?? 'mmcblk0', partition: backing };
			if (match(backing, /^\/?nvme/))
				return { kind: 'NVMe', model: backing };
			if (match(backing, /^\/?sd/))
				return { kind: 'USB / disk', model: backing };
			return backing ? { kind: 'Loop', model: backing } : { kind: 'Loop device', model: name };
		}
		let name = replace(device, /^\/dev\//, '');
		let parent = replace(name, /p?[0-9]+$/, '');
		let disk = block[parent] ?? block[name];
		if (match(name, /^mmcblk/))
			return { kind: disk?.kind == 'MMC' ? 'eMMC' : 'MMC', model: disk?.model ?? parent };
		if (match(name, /^nvme/))
			return { kind: 'NVMe', model: disk?.model ?? parent };
		if (match(name, /^sd/))
			return { kind: disk?.removable ? 'USB / removable' : 'SATA / SCSI', model: parent };
		return { kind: 'Block storage', model: device };
	};
	for (let mount, item in byMount)
		if (mount != '/dev' && mount != '/tmp/.ujail' && !match(mount, /^\/sys|^\/proc|^\/dev\//)) {
			let hardware = null;
			if (item.fstype == 'tmpfs')
				hardware = { kind: 'Volatile RAM', model: 'System memory' };
			else if (item.fstype == 'overlay')
				hardware = backingHardware(byMount['/overlay']?.device ?? '/dev/loop0');
			else
				hardware = backingHardware(item.device);
			item.deviceSize = hardware.volumeSize
				?? (item.fstype == 'overlay' ? block.mmcblk0?.size ?? block.loop0?.size ?? 0
				: item.device == '/dev/root' ? block.mmcblk0?.size ?? 0
				: block[replace(item.device, /^\/dev\//, '')]?.size ?? 0);
			delete hardware.volumeSize;
			item.hardware = hardware;
			push(mounts, item);
		}
	return { ok: true, disks: [...disks(block), ...nandDisks(chip)], filesystems: sort(mounts, (a, b) => {
		let ar = a.mount == '/' ? 0 : a.mount == '/overlay' ? 1 : a.mount == '/tmp' ? 2 : 3;
		let br = b.mount == '/' ? 0 : b.mount == '/overlay' ? 1 : b.mount == '/tmp' ? 2 : 3;
		return ar - br || (a.mount == b.mount ? 0 : a.mount < b.mount ? -1 : 1);
	}) };
}



const BACKUP_ROOT = '/tmp/flab-backup';
const BACKUP_ID = /^[0-9a-f]{12}$/;
const BACKUP_CHUNK = 32768;
const BACKUP_MAX = 16 * 1024 * 1024;
const BACKUP_FILES = 5000;
const BACKUP_KEEP_SECONDS = 900;

function backup_id(id) {
	return type(id) == 'string' && match(id, BACKUP_ID) ? id : null;
}

function backup_dir(id) {
	let valid = backup_id(id);
	return valid ? `${BACKUP_ROOT}/${valid}` : null;
}

function clean_backups() {
	let current = sort(map(filter(lsdir(BACKUP_ROOT) ?? [], backup_id), (id) => ({
		id,
		mtime: stat(`${BACKUP_ROOT}/${id}`)?.mtime ?? 0,
	})), (a, b) => a.mtime - b.mtime);
	while (length(current) > 4 || (current.length && time() - current[0].mtime > BACKUP_KEEP_SECONDS)) {
		let old = shift(current);
		command_result(`rm -rf ${BACKUP_ROOT}/${old.id}`);
	}
}

function new_backup_dir() {
	mkdir(BACKUP_ROOT);
	let id = '', dir = null;
	for (let i = 0; i < 5 && dir == null; i++) {
		id = hexenc(readfile('/dev/urandom', 6) ?? '');
		dir = backup_id(id) && mkdir(`${BACKUP_ROOT}/${id}`) ? `${BACKUP_ROOT}/${id}` : null;
	}
	clean_backups();
	return { id, dir };
}

function backup_create() {
	let job = new_backup_dir();
	if (job.dir == null)
		return { ok: false, error: 'Could not create a temporary backup file.' };
	let archive = `${job.dir}/backup.tar.gz`;
	let result = command_result(`sysupgrade -b ${archive}`, { timeout: 20 });
	let st = stat(archive);
	if (!result.ok || st == null || st.size == 0)
		return { ok: false, error: result.output || 'The router could not create a configuration backup.' };
	let host = trim(readfile('/proc/sys/kernel/hostname') ?? 'openwrt');
	host = match(host, /^[A-Za-z0-9._-]+$/) ? host : 'openwrt';
	return { ok: true, id: job.id, size: st.size, name: `flab-backup-${host}-${time()}.tar.gz` };
}

function backup_download(request) {
	let dir = backup_dir(request?.args?.id), archive = dir ? `${dir}/backup.tar.gz` : null;
	let st = archive ? stat(archive) : null;
	if (st == null)
		return { ok: false, error: 'This backup is no longer on the router. Create it again.' };
	let from = +request?.args?.from;
	if (!(from >= 0) || from > 1000000000)
		from = 0;
	let data = '', file = from < st.size ? open(archive, 'r') : null;
	if (file != null) {
		file.seek(from);
		data = file.read(BACKUP_CHUNK) ?? '';
		file.close();
	}
	return { ok: true, from, size: st.size, length: length(data), data: b64enc(data), done: from + length(data) >= st.size };
}

function backup_begin(request) {
	let size = +request?.args?.size;
	if (!(size > 0) || size > BACKUP_MAX)
		return { ok: false, error: `The backup must be between 1 byte and ${BACKUP_MAX} bytes.` };
	let job = new_backup_dir();
	if (job.dir == null)
		return { ok: false, error: 'Could not reserve temporary upload storage.' };
	let file = open(`${job.dir}/restore.tar.gz`, 'w');
	if (file == null)
		return { ok: false, error: 'Could not create the temporary upload file.' };
	file.close();
	writefile(`${job.dir}/size`, '' + size);
	return { ok: true, id: job.id, size };
}

function backup_upload(request) {
	let args = request?.args ?? {}, dir = backup_dir(args.id);
	let st = dir ? stat(`${dir}/restore.tar.gz`) : null, from = +args.from, total = +args.total;
	let expected = dir ? +(readfile(`${dir}/size`) ?? 0) : 0;
	let encoded = type(args.data) == 'string' ? args.data : '';
	let data = b64dec(encoded);
	if (st == null || total != expected || !(from >= 0) || from != st.size || !(total >= from) || total > BACKUP_MAX ||
		length(encoded) > 4 * BACKUP_CHUNK || data == null || length(data) == 0 || from + length(data) > total)
		return { ok: false, error: 'The upload chunk is invalid or out of sequence.' };
	let file = open(`${dir}/restore.tar.gz`, 'a');
	if (file == null || file.write(data) != length(data)) {
		file?.close();
		return { ok: false, error: 'The router could not write the uploaded backup.' };
	}
	file.close();
	return { ok: true, from: from + length(data), done: from + length(data) == total };
}

function inspect_backup(id) {
	let dir = backup_dir(id), archive = dir ? `${dir}/restore.tar.gz` : null;
	let st = archive ? stat(archive) : null;
	if (st == null || st.size == 0)
		return { ok: false, error: 'The uploaded backup is missing.' };
	let expected = +(readfile(`${dir}/size`) ?? 0);
	if (expected != st.size)
		return { ok: false, error: 'The uploaded backup is incomplete. Upload it again.' };
	let tested = command_result(`gzip -t ${archive}`, { timeout: 10 });
	if (!tested.ok)
		return { ok: false, error: 'The file is not a valid compressed OpenWrt configuration backup.' };
	let listed = command_result(`tar -tzf ${archive}`, { timeout: 10, max_output: 262144 });
	if (!listed.ok)
		return { ok: false, error: 'The backup contents could not be read.' };
	let files = filter(split(replace(listed.output ?? '', /\r/g, ''), '\n'), (name) => name != '');
	if (length(files) > BACKUP_FILES)
		return { ok: false, error: 'The backup contains too many files.' };
	for (let name in files) {
		if (match(name, /(^[/]|(^|[/])[.][.]([/]|$))/))
			return { ok: false, error: 'The backup contains an unsafe file path.' };
	}
	if (index(files, 'etc/config/system') < 0 && index(files, './etc/config/system') < 0)
		return { ok: false, error: 'The backup does not contain /etc/config/system.' };
	return { ok: true, id, size: st.size, files };
}

function backup_inspect(request) {
	return inspect_backup(request?.args?.id);
}

function backup_restore(request) {
	let id = backup_id(request?.args?.id), checked = id ? inspect_backup(id) : null;
	if (!checked?.ok)
		return checked ?? { ok: false, error: 'Choose a valid backup first.' };
	let archive = `${BACKUP_ROOT}/${id}/restore.tar.gz`;
	let launched = command_result(
		`(sleep 2; sysupgrade -r ${archive} && reboot) >/dev/null 2>&1 &`,
		{ timeout: 5 }
	);
	if (!launched.ok)
		return { ok: false, error: 'Could not schedule the configuration restore.' };
	return { ok: true, reboot: true };
}

function backup_cancel(request) {
	let id = backup_id(request?.args?.id);
	if (id == null)
		return { ok: false, error: 'The backup id is invalid.' };
	command_result(`rm -rf ${BACKUP_ROOT}/${id}`);
	return { ok: true };
}

// rpcd registration: ubus object flab.system.
return deferred({
	'flab.system': {
		cpu: {
			call: function() {
				return collect();
			},
		},
		build: {
			call: function() {
				return build();
			},
		},
		modules: {
			call: function() {
				return modules();
			},
		},
		ntp_sync: {
			call: function() {
				return ntp_sync();
			},
		},
		storage: {
			call: function() {
				return storage();
			},
		},
		backup_create: {
			call: function() {
				return backup_create();
			},
		},
		backup_download: {
			args: { id: '', from: 0 },
			call: function(request) {
				return backup_download(request);
			},
		},
		backup_begin: {
			args: { size: 0 },
			call: function(request) {
				return backup_begin(request);
			},
		},
		backup_upload: {
			args: { id: '', from: 0, total: 0, data: '' },
			call: function(request) {
				return backup_upload(request);
			},
		},
		backup_inspect: {
			args: { id: '' },
			call: function(request) {
				return backup_inspect(request);
			},
		},
		backup_restore: {
			args: { id: '' },
			call: function(request) {
				return backup_restore(request);
			},
		},
		backup_cancel: {
			args: { id: '' },
			call: function(request) {
				return backup_cancel(request);
			},
		},
	},
});
