// Number and duration formatting helpers.

// Binary size ("1.5 MiB"); whole numbers for plain bytes, one decimal above.
export const fmtBytes = n => {
  if (n == null) return '–';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};

// Bytes per second, e.g. "12.3 KiB/s".
export const fmtBps = n => n == null ? '–' : `${fmtBytes(n)}/s`;

// Days/hours/minutes for long spans, e.g. "4d 2h 48m".
export const fmtDur = s => {
  const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return `${d ? d + 'd ' : ''}${hh}h ${m}m`;
};

// Adaptive span for lifetimes: "45s", "22m 10s", "3h 5m", "2d 4h".
export const fmtSpan = s => {
  if (s == null) return '–';
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h`;
};

// Bytes per second as a line rate, the way network gear reports it ("12.3 Mbit/s").
export const fmtLine = bytesPerSec => {
  if (bytesPerSec == null) return '–';
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbit/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbit/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kbit/s`;
  return `${Math.round(bits)} bit/s`;
};

// Rate value with one decimal, or none for whole numbers ("12", "12.5").
export const fmtRate = v => v == null ? '–' : Number.isInteger(v) ? String(v) : v.toFixed(1);
// Integer with locale thousands separators.
export const fmtNum = n => n == null ? '–' : n.toLocaleString();
// Dotted IPv4 string to a number for sorting; -1 (sorts first) when the address is missing.
export const ipNum = ip => ip ? ip.split('.').reduce((a, b) => a * 256 + Number(b), 0) : -1;
