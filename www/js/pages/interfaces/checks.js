// Pure value checks and address math for the network editor (Devices and Interfaces, Bridges): an address, a netmask, a prefix,
// a subnet and the other formats /etc/config/network takes. Each `check*` returns an error message that completes the
// sentence "<label> ...", or null when the value is fine. No DOM and no network.
import { parseAddress } from '../../core/ip.js';
import { CHECKS, MAC } from '../../core/fields.js';

//#region Addresses

// An IPv4 address as a BigInt, or null.
const v4 = text => { const a = parseAddress(text); return a?.family === 4 ? a.value : null; };
// An IPv6 address as a BigInt, or null.
const v6 = text => { const a = parseAddress(text); return a?.family === 6 ? a.value : null; };

// The prefix length of a dotted netmask (255.255.255.0 gives 24), or null when it is not a contiguous mask.
export function maskPrefix(text) {
  const value = v4(String(text ?? ''));
  if (value == null) return null;
  const bits = value.toString(2).padStart(32, '0');
  return /^1*0*$/.test(bits) ? bits.indexOf('0') < 0 ? 32 : bits.indexOf('0') : null;
}

// A prefix length as a bitmask of `size` bits.
const maskBits = (prefix, size) => (prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(size - prefix));

// An address with an optional prefix, as { family, value, prefix, hasPrefix, size }: "192.168.1.1", "192.168.1.1/24", "192.168.1.1/255.255.255.0",
// "2001:db8::1/64". `netmask` completes an IPv4 address that has no prefix. Null when the text is not an address.
export function parseCidr(text, netmask = '') {
  const [addr, rest, ...more] = String(text ?? '').trim().split('/');
  if (more.length) return null;
  const a = parseAddress(addr);
  if (!a) return null;
  const size = a.family === 4 ? 32 : 128;
  let prefix = null;
  if (rest != null) {
    if (a.family === 4 && /^\d+\.\d+\.\d+\.\d+$/.test(rest)) prefix = maskPrefix(rest);
    else if (/^\d{1,3}$/.test(rest) && +rest <= size) prefix = +rest;
    if (prefix == null) return null;
  } else if (a.family === 4 && netmask) {
    prefix = maskPrefix(netmask);
  }
  return { family: a.family, value: a.value, prefix, hasPrefix: prefix != null, size };
}

// The subnet an address with a prefix is on, as { family, network, prefix, size }; null when it has no prefix.
export function subnetOf(cidr) {
  if (!cidr?.hasPrefix) return null;
  return { family: cidr.family, network: cidr.value & maskBits(cidr.prefix, cidr.size), prefix: cidr.prefix, size: cidr.size };
}

// Whether `address` (a BigInt of the same family) lies inside `subnet`.
export const contains = (subnet, address) => (address & maskBits(subnet.prefix, subnet.size)) === subnet.network;

// Whether two subnets overlap (one contains the other's network address).
export const overlaps = (a, b) => a.family === b.family && (contains(a, b.network) || contains(b, a.network));

// An address as text, for messages about a subnet: "192.168.1.0/24".
export function subnetText(s) {
  if (s.family === 4) return `${[24n, 16n, 8n, 0n].map(n => (s.network >> n) & 255n).join('.')}/${s.prefix}`;
  const groups = Array.from({ length: 8 }, (_, i) => ((s.network >> BigInt(112 - 16 * i)) & 0xffffn).toString(16));
  return `${groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '::')}/${s.prefix}`;
}

//#endregion

//#region Checks

// An IPv4 address, optionally with a prefix length or a netmask (a static `ipaddr`).
export const checkIp4Cidr = v => (parseCidr(v)?.family === 4 ? null : 'is not an IPv4 address such as 192.168.1.1, 192.168.1.1/24 or 192.168.1.1/255.255.255.0');
// An IPv6 address with an optional prefix length (a static `ip6addr`).
export const checkIp6Cidr = v => (parseCidr(v)?.family === 6 ? null : 'is not an IPv6 address such as 2001:db8::1/64');
// A plain IPv4 address.
export const checkIp4 = v => (v4(v) != null ? null : 'is not an IPv4 address');
// A plain IPv6 address.
export const checkIp6 = v => (v6(v) != null ? null : 'is not an IPv6 address');
// An IPv4 or IPv6 address.
export const checkIp = v => (parseAddress(v) ? null : 'is not an IP address');
// A dotted IPv4 netmask: contiguous ones followed by zeros.
export const checkNetmask = v => (maskPrefix(v) != null ? null : 'is not a netmask such as 255.255.255.0');
// A MAC address.
export const checkMac = v => (MAC.test(v) ? null : 'is not a MAC address such as 74:36:6d:c0:9b:83');
// An even number of hexadecimal digits (a DHCP client identifier, a PPPoE Host-Uniq tag).
export const checkHexPairs = v => (/^([0-9A-Fa-f]{2})+$/.test(v) ? null : 'must be hexadecimal digits in pairs');
// A subprefix hint (`ip6hint`): hexadecimal digits.
export const checkHint = v => (/^[0-9A-Fa-f]{1,8}$/.test(v) ? null : 'must be up to 8 hexadecimal digits, for example 64');
// An interface identifier suffix (`ip6ifaceid`): eui64, random, or an address suffix such as ::1:2.
export const checkIfaceId = v => (v === 'eui64' || v === 'random' || (/^::?[0-9A-Fa-f:]*$/.test(v) && v6(v.startsWith('::') ? v : `::${v}`) != null) ? null : 'must be eui64, random or an address suffix such as ::1');
// A routing table: a number or a name from /etc/iproute2/rt_tables.
export const checkTable = v => (/^(\d{1,10}|[A-Za-z][A-Za-z0-9_.-]{0,31})$/.test(v) ? null : 'must be a table number or name');
// A search domain.
export const checkDomain = v => CHECKS.domain(v);
// A host name for a DHCP request, or * to send none.
export const checkHostnameOrStar = v => (v === '*' ? null : CHECKS.host(v) === null && !/:/.test(v) ? null : 'must be a host name, or * to send none');
// The additional DHCP options to send: words of `option:value` where the option is a number or a name.
export const checkSendOpts = v => (v.split(/\s+/).every(w => /^([0-9]{1,3}|[A-Za-z][A-Za-z0-9_-]*):\S+$/.test(w)) ? null : 'must be words of option:value, for example 60:vendor');
// The additional DHCP options to request: option numbers or names separated by spaces (DHCPv4) or commas (DHCPv6).
export const checkReqOpts = v => (v.split(/[\s,]+/).every(w => /^([0-9]{1,3}|[A-Za-z][A-Za-z0-9_-]*)$/.test(w)) ? null : 'must be option numbers or names separated by spaces or commas');
// A single line of free text.
export const checkLine = v => (/[\r\n]/.test(v) ? 'must be a single line' : null);
// The PPP keepalive: the failures to tolerate and the seconds between echo requests, separated by a space or a comma.
export const checkKeepalive = v => (/^\d+([\s,]+\d+)?$/.test(v) ? null : 'must be two numbers, such as "5 1": failed echoes before the link is declared down, and seconds between echoes');
// The IPv6 prefix to request from the provider: auto, no, a length from 1 to 64, or a prefix with its length.
export const checkReqPrefix = v => (v === 'auto' || v === 'no' || (/^\d{1,2}$/.test(v) && +v >= 0 && +v <= 64) || (parseCidr(v)?.family === 6 && parseCidr(v).hasPrefix) ? null : 'must be auto, no, a prefix length from 1 to 64, or a prefix such as 2001:db8::/56');

// A prefix class name (a name from the upstream interfaces, or local).
export const checkClass = v => (/^[A-Za-z0-9_.-]+$/.test(v) ? null : 'must be a class name such as local or the name of an upstream interface');

// The check functions by the name a schema field gives them.
export const VERIFY = {
  ip4cidr: checkIp4Cidr, ip6cidr: checkIp6Cidr, ip4: checkIp4, ip6: checkIp6, ip: checkIp, netmask: checkNetmask, mac: checkMac, hexpairs: checkHexPairs,
  hint: checkHint, ifaceid: checkIfaceId, table: checkTable, domain: checkDomain, hostname: checkHostnameOrStar, sendopts: checkSendOpts,
  reqopts: checkReqOpts, line: checkLine, keepalive: checkKeepalive, reqprefix: checkReqPrefix, class: checkClass,
};

//#endregion
