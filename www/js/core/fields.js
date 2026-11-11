// Shared handling of editable UCI options, used by every page that edits a config (System settings, DHCP). Pure
// functions with no DOM and no network.
//
// A page describes its options as a table of fields (see pages/settings/schema.js for the full format):
//   { key, type: string | text | bool | int | enum | list, label, hint?, default?, check?, min?, max?, options?, items? }
// (`items` is the fixed set of values a list may hold) and these functions read a field's value from a UCI section, normalize and compare values, describe them for
// the review list, and validate them. A value in a form is a string ('' = not set), a boolean (a switch, with
// the OpenWrt default when the option is absent) or an array of strings (a list).

//#region Reading UCI

// The options of a section as `uci get` returns it, without its bookkeeping keys (.type, .name, .anonymous).
const optionsOf = section => Object.fromEntries(Object.entries(section).filter(([k]) => !k.startsWith('.')));

// Every section of a type in file order, as [{ section, values }] where `section` is the UCI name (anonymous
// sections are named cfgXXXXXX by uci) and `values` the options.
export function sectionsOf(cfg, type) {
  return Object.entries(cfg ?? {})
    .filter(([, s]) => s['.type'] === type)
    .map(([name, s]) => ({ section: s['.name'] ?? name, values: optionsOf(s) }));
}

// UCI spells booleans several ways; `fallback` is the value when the option is absent or unrecognized.
export function uciBool(v, fallback) {
  const s = String(v ?? '').toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(s)) return false;
  return fallback;
}

// A UCI option as a list: a single value may hold several words separated by spaces; absent is empty.
export const asList = v => (v == null ? [] : Array.isArray(v) ? v.map(String) : String(v).trim().split(/\s+/).filter(Boolean));

// The form value of a field from the raw option value on the router: a boolean (the default when absent), a
// list, or a string ('' = not set).
export function valueOf(field, raw) {
  if (field.type === 'bool') return uciBool(raw, field.default ?? false);
  if (field.type === 'list') return asList(raw);
  return raw == null ? '' : String(raw);
}

//#endregion

//#region Comparing and describing values

// A value as it will be written: strings trimmed (text keeps inner line breaks), lists trimmed without blanks.
export function normalize(field, v) {
  if (field.type === 'list') return v.map(s => s.trim()).filter(Boolean);
  if (field.type === 'bool') return v;
  return field.type === 'text' ? v.replace(/\r\n/g, '\n').trim() : v.trim();
}

// A value for the review list: on/off, a comma list, the text, or "default" when empty.
export function show(field, v) {
  if (field.type === 'bool') return v ? 'on' : 'off';
  if (field.type === 'list') return v.length ? v.join(', ') : 'none';
  return v === '' ? 'default' : v.length > 60 ? `${v.slice(0, 57)}…` : v;
}

// Whether two normalized values differ.
export const differs = (field, a, b) => (field.type === 'list' ? a.join('\n') !== b.join('\n') : a !== b);

// Whether a list value has blank rows that normalizing would drop (a row added and not filled in yet).
export const hasBlankRows = (field, v) => field.type === 'list' && v.length !== normalize(field, v).length;

// UCI booleans are written as '1' / '0'.
export const flag = b => (b ? '1' : '0');

//#endregion

//#region Validation

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^(?=.*:.*:)[0-9A-Fa-f:]+(\.[0-9]{1,3}){0,3}$/;
export const MAC = /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/;

// Whether `s` can be given to a daemon as a server: a host name, an IPv4 address or an IPv6 address.
export const validServer = s => HOSTNAME.test(s) || IPV6.test(s);

// The checks a field's `check` names: each returns an error message, or null when the value is fine.
// They run on non-empty values only (an empty value means "not set").
export const CHECKS = {
  label: v => (LABEL.test(v) ? null : 'must be one name of letters, digits and hyphens, without dots or spaces'),
  host: v => (validServer(v) ? null : 'is not a valid host name or IP address'),
  domain: v => (HOSTNAME.test(v) ? null : 'is not a valid domain name'),
  ip: v => (IPV4.test(v) || IPV6.test(v) ? null : 'is not an IP address'),
  ip4: v => (IPV4.test(v) ? null : 'is not an IPv4 address'),
  ip6: v => (IPV6.test(v) ? null : 'is not an IPv6 address'),
  ip4ignore: v => (v === 'ignore' || IPV4.test(v) ? null : 'must be an IPv4 address, or "ignore"'),
  prefix6: v => (/^[0-9A-Fa-f:.]+\/\d{1,3}$/.test(v) && +v.split('/')[1] <= 128 ? null : 'must be an IPv6 prefix such as 2001:db8::/32'),
  mac: v => (MAC.test(v) ? null : 'is not a MAC address such as 00:11:22:33:44:55'),
  duid: v => (/^([0-9A-Fa-f]{2})+(%[0-9A-Fa-f]+)?$/.test(v) ? null : 'must be hexadecimal digits in pairs, optionally followed by %IAID'),
  hostid: v => (v === 'ignore' || /^[0-9A-Fa-f]{1,16}$/.test(v) ? null : 'must be up to 16 hexadecimal digits, or "ignore"'),
  duration: v => (v === 'infinite' || /^\d+[smhdw]?$/.test(v) ? null : 'must be a time such as 12h, 30m, 3600 or infinite'),
  uri: v => (/^https?:\/\/\S+$/.test(v) ? null : 'must be an http or https address'),
  path: v => (/^\/\S+$/.test(v) ? null : 'must be an absolute path without spaces'),
  seed: v => (v === '0' || /^\/\S+$/.test(v) ? null : 'must be 0 or an absolute path without spaces'),
  ifname: v => (/^[A-Za-z0-9_.-]+$/.test(v) ? null : 'must be a network interface name (letters, digits, _ . -)'),
};

// The error for one non-empty value of a field, or null.
function fieldError(field, v) {
  if (field.type === 'int') {
    if (!/^\d+$/.test(v)) return 'must be a whole number';
    const n = +v;
    if (field.min != null && n < field.min) return `must be at least ${field.min}`;
    if (field.max != null && n > field.max) return `must be at most ${field.max}`;
    return null;
  }
  if (field.type === 'enum') return field.options.includes(v) ? null : `must be one of ${field.options.join(', ')}`;
  if (field.items && !field.items.includes(v)) return `must be one of ${field.items.join(', ')}`;
  if (field.type === 'string' && /[\r\n]/.test(v)) return 'must be a single line';
  return field.check ? CHECKS[field.check](v) : null;
}

// The errors of one field's draft value as [{ index?, text }], where `label` introduces each message. A list
// reports the row of each invalid or repeated item (blank rows are ignored); other fields report one error.
export function errorsOf(field, draftValue, label = field.label) {
  const out = [];
  if (field.type === 'bool') return out;
  if (field.type === 'list') {
    const seen = new Set();
    draftValue.forEach((raw, index) => {
      const v = raw.trim();
      if (!v) return;
      const bad = fieldError(field, v);
      if (bad) out.push({ index, text: `${label}: "${v}" ${bad}.` });
      else if (seen.has(v.toLowerCase())) out.push({ index, text: `${label}: "${v}" is listed twice.` });
      seen.add(v.toLowerCase());
    });
    return out;
  }
  const v = normalize(field, draftValue);
  const bad = v ? fieldError(field, v) : null;
  if (bad) out.push({ text: `${label} ${bad}.` });
  return out;
}

//#endregion
