// Checks of the values firewall4 reads in /etc/config/firewall, as small pure functions: each takes a non-empty value (and a context with
// the names of the router's interfaces) and returns what is wrong with it, in words that continue a sentence ("is not an IP address"), or
// null when it is fine. They follow fw4's own parsers (parse_port, parse_subnet, parse_limit, parse_time, ...), so a value accepted here
// is a value the firewall accepts.
import { parseAddress } from '../../core/ip.js';
import { ICMP_TYPES } from './schema.js';

// The value without a leading "!" (fw4 reads it as "everything except").
const unnegate = v => v.replace(/^\s*!\s*/, '');

// The digits of a whole number as a number, or null.
const whole = s => (/^\d+$/.test(s) ? Number(s) : null);

// The error of a port or a port range "start-stop" (a colon also works in the file), or null.
export function portError(v) {
  const m = /^(\d{1,5})(?:[-:](\d{1,5}))?$/.exec(unnegate(v));
  if (!m) return 'is not a port or a port range such as 6666-6670';
  const a = +m[1], b = m[2] == null ? a : +m[2];
  if (a > 65535 || b > 65535) return 'is above 65535, the highest port';
  if (a > b) return 'is a range that ends before it starts';
  return null;
}

// The address family of `text` (4 or 6), or null when it is not an address.
const family = text => parseAddress(text)?.family ?? null;

// The error of a subnet in fw4's forms (an address, address/prefix, address/mask, a range a-b, or the name of an interface), or null.
export function subnetError(v, ctx = {}) {
  const s = unnegate(v).trim();
  if (!s) return 'is empty';
  if ((ctx.networks ?? []).includes(s)) return null;
  const cut = s.indexOf('/');
  if (cut >= 0) {
    const fam = family(s.slice(0, cut)), rest = s.slice(cut + 1);
    if (!fam) return 'is not an IP address with a prefix length, such as 192.168.1.0/24 or 2001:db8::/32';
    const maskFam = family(rest);
    if (maskFam) return maskFam === fam ? null : 'mixes IPv4 and IPv6';
    const bits = whole(rest);
    if (bits == null || bits > (fam === 4 ? 32 : 128)) return `has a prefix length that is not 0 to ${fam === 4 ? 32 : 128}`;
    return null;
  }
  const dash = s.indexOf('-');
  if (dash >= 0) {
    const a = family(s.slice(0, dash)), b = family(s.slice(dash + 1));
    if (!a || !b) return 'is not a range of two IP addresses such as 192.168.1.10-192.168.1.20';
    return a === b ? null : 'mixes IPv4 and IPv6';
  }
  return family(s) ? null : 'is not an IP address, a subnet or the name of an interface';
}

// The error of a rate limit "N", "N/second", "N/minute", "N/hour" or "N/day" (the unit may be shortened, as in 3/min), or null.
export function limitError(v) {
  const m = /^(\d+)(?:\/([A-Za-z]+))?$/.exec(v.trim());
  if (!m) return 'must be a number with an optional unit, such as 3/minute';
  if (m[2] && !['second', 'minute', 'hour', 'day'].some(u => u.startsWith(m[2].toLowerCase()))) return 'has a unit that is not second, minute, hour or day';
  return null;
}

// The error of a time of day "hh", "hh:mm" or "hh:mm:ss", or null.
export function timeError(v) {
  const m = /^(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?$/.exec(v.trim());
  if (!m || +m[1] > 23 || +(m[2] ?? 0) > 59 || +(m[3] ?? 0) > 59) return 'is not a time of day such as 08:30 or 17:45:10';
  return null;
}

// The error of a date "yyyy", "yyyy-mm" or "yyyy-mm-dd" (the firewall reads years 1970 to 2038), or null.
export function dateError(v) {
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(v.trim());
  if (!m || +m[1] < 1970 || +m[1] > 2038 || +(m[2] ?? 1) < 1 || +(m[2] ?? 1) > 12 || +(m[3] ?? 1) < 1 || +(m[3] ?? 1) > 31) return 'is not a date such as 2026-12-31 (years 1970 to 2038)';
  return null;
}

// The error of a packet mark "value" or "value/mask" in hexadecimal (0x10) or decimal, or null.
export function markError(v) {
  const m = /^(0?x?[0-9a-fA-F]+)(?:\/(0?x?[0-9a-fA-F]+))?$/.exec(v.trim());
  if (!m) return 'is not a mark such as 0x10 or 0x10/0xff';
  const parts = [m[1], m[2] ?? '0'].map(Number);
  if (parts.some(Number.isNaN)) return 'is not a mark such as 0x10 or 0x10/0xff (hexadecimal needs the 0x prefix)';
  return parts.some(n => n > 0xffffffff) ? 'is above 0xFFFFFFFF' : null;
}

// The error of an ICMP type: a name fw4 knows, or type or type/code numbers, or null.
export function icmpError(v) {
  if (ICMP_TYPES.includes(v)) return null;
  const m = /^(\d{1,3})(?:\/(\d{1,3}))?$/.exec(v);
  if (m && +m[1] <= 255 && +(m[2] ?? 0) <= 255) return null;
  return 'is not an ICMP type name or number (see the hint for the names)';
}

// The error of a protocol: a name from /etc/protocols or a number from 0 to 255, or null.
export function protocolError(v) {
  if (/^\d+$/.test(v)) return +v <= 255 ? null : 'is above 255, the highest protocol number';
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(v) ? null : 'is not a protocol name or number';
}

// The error of a list of weekdays ("mon tue", "! sat sun"), or null.
export function weekdaysError(v) {
  const words = unnegate(v).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'has no day';
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return words.every(w => days.some(d => d.startsWith(w.toLowerCase()))) ? null : 'must list days such as mon tue fri';
}

// The checks a field's `check` names, each (value, ctx) => error or null. A single-valued option (a port forward's ports and
// addresses) uses the same checks as a list.
export const CHECKS = {
  zoneName: v => (/^[A-Za-z_.][A-Za-z0-9/_.-]*$/.test(v) ? null : 'must start with a letter, a dot or an underscore and hold only letters, digits and . _ - /'),
  device: v => (/^!?[A-Za-z0-9_.:+*/-]+$/.test(v) ? null : 'is not a device name (letters, digits and _ . : + * / -)'),
  subnet: (v, ctx) => subnetError(v, ctx),
  subnetOne: (v, ctx) => subnetError(v, ctx),
  mac: v => (/^!?\s*[0-9A-Fa-f]{1,2}([:-][0-9A-Fa-f]{1,2}){5}$/.test(v) ? null : 'is not a MAC address such as 00:11:22:33:44:55'),
  port: v => portError(v),
  portOne: v => portError(v),
  limit: v => limitError(v),
  time: v => timeError(v),
  date: v => dateError(v),
  mark: v => (v.trim().startsWith('!') ? 'must not be negated' : markError(v)),
  icmp: v => icmpError(v),
  protocol: v => protocolError(v),
  weekdays: v => weekdaysError(v),
};

// The address family of a subnet value ("!" and a mask are ignored): 4, 6, or null when it is a name or not an address.
export function subnetFamily(v) {
  const s = unnegate(v).trim();
  const first = s.split(/[/-]/)[0];
  return family(first);
}
