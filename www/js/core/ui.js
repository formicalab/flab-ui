// Reusable presentational components. Every page composes its UI from these building blocks.

import { h } from './dom.js';
import { icon } from './icons.js';

// Soft pill. kind: '' | success | warning | danger | info. Bootstrap supplies the component sizing and pill shape;
// the project only overrides the semantic colors to keep the Fluent theme in both color schemes.
export const badge = (text, kind = '', title = '') => h('span', { className: `badge rounded-pill fl-badge ${kind}`.trim(), title }, text);

// Algorithm / value chip colored by strength level: good | fair | weak | info
export const chip = (text, lvl = '', title = '') => h('span', { className: `alg-chip ${lvl}`, title }, text);

// Dimmed inline text for placeholders such as "none" or "not available".
export const muted = text => h('span', { className: 'muted' }, text);

// Monospace inline text for addresses, keys, names and other identifiers.
export const mono = text => h('span', { className: 'mono' }, text);

// Bootstrap loading indicator with a screen-reader label. Visible status text, when present, is supplied by a sibling.
export const spinner = (text = 'Loading…', extra = '') => h('span', { className: `spinner-border spinner-border-sm ${extra}`.trim(), role: 'status' },
  h('span', { className: 'visually-hidden' }, text));

// Badge kind for the 0-100 security grades (A+ … D) shown for Wi-Fi clients and IPsec connections.
export const GRADE_KIND = { 'A+': 'success', A: 'success', B: 'info', C: 'warning', D: 'danger' };

// Badge color of a wireless security label; shared so connected-device views do not depend on the radio UI module.
export const SECURITY_KIND = s => /WPA3|OWE/.test(s) ? 'success' : /WPA2/.test(s) ? 'warning' : /Open|WEP|^WPA-/.test(s) ? 'danger' : '';

// A card with an optional header row and a body (any node or list of nodes); `extra` adds CSS classes.
export const card = (header, body, extra = '') => h('div', { className: `card ${extra}` },
  header ? h('div', { className: 'card-header' }, header) : null, body);

// KPI tile used in summary rows.
export const tile = (label, value, sub, valueClass = '') => h('div', { className: 'col' },
  h('div', { className: 'card tile h-100' }, h('div', { className: 'card-body' },
    h('div', { className: 'label' }, label),
    h('div', { className: `value ${valueClass}` }, value),
    sub ? h('div', { className: 'sub' }, sub) : null)));

// Row of KPI tiles (see tile) in a responsive grid.
export const tiles = (...t) => h('div', { className: 'row fl-summary row-cols-2 row-cols-md-3 row-cols-xl-4 row-cols-xxl-6 g-3' }, t);

// Simple table: cols are labels, rows are arrays of nodes or strings.
export const table = (cols, rows) => h('div', { className: 'table-responsive' }, h('table', { className: 'table table-hover' },
  h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
  h('tbody', {}, rows.length
    ? rows.map(r => h('tr', {}, r.map(c => h('td', {}, c))))
    : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'Nothing to show')))));

// Small button with an optional leading icon. `cls` picks a Bootstrap variant and may add page classes; `props` sets
// other element properties. An icon-only button needs a title or ariaLabel.
export const button = (label, iconName, onclick, cls = 'btn-outline-secondary', props = {}) =>
  h('button', {
    type: 'button', ...props,
    className: `btn btn-sm ${cls}`,
    onclick,
  }, iconName ? icon(iconName) : null, label || null);

// The small x that closes a dialog or drawer or dismisses an alert. `label` names it for screen readers and as its tooltip; `props`
// sets other properties.
export const closeButton = (onclick, label = 'Close', props = {}) =>
  h('button', { type: 'button', className: 'btn-close', ariaLabel: label, title: label, ...props, onclick });

// A button that reads as a link: a jump to another place, inside a table cell or a line of text. `cls` adds classes (`mono`).
export const linkButton = (label, onclick, props = {}, cls = '') =>
  h('button', { type: 'button', className: `btn btn-link btn-sm p-0 ${cls}`.trim(), ...props, onclick }, label);

// Label/value list. rows: [label, node|string] pairs; null rows are skipped.
export const kv = rows => h('dl', { className: 'kv' },
  rows.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

// Titled block inside a card body.
export const section = (title, ...body) => h('div', { className: 'blk' }, h('h3', {}, title), ...body);

// Elapsed/remaining lifetime bar. `rekeyIn` marks the soft limit, `expiresIn` (optional) the hard limit.
export function lifebar({ elapsed, rekeyIn, expiresIn }) {
  const end = expiresIn != null ? elapsed + expiresIn : elapsed + (rekeyIn ?? 0);
  // A value as a percentage of the bar's full length, clamped to 0-100.
  const pct = v => end > 0 ? Math.min(100, Math.max(0, v / end * 100)) : 0;
  const value = pct(elapsed);
  const marker = rekeyIn != null && expiresIn != null ? h('i', { className: 'mark', style: `left:${pct(elapsed + rekeyIn)}%` }) : null;
  return h('div', { className: 'progress lifebar', role: 'progressbar', ariaLabel: 'Lifetime elapsed',
    ariaValueMin: '0', ariaValueMax: '100', ariaValueNow: String(Math.round(value)) },
  h('div', { className: 'progress-bar', style: `width:${value}%` }), marker);
}

// Horizontal score meter; lvl colors the fill (good | fair | weak).
export const meter = (score, max, lvl) => {
  const value = Math.min(100, Math.max(0, max ? score / max * 100 : 0));
  return h('div', { className: `progress meter ${lvl}`, role: 'progressbar', ariaLabel: 'Score',
    ariaValueMin: '0', ariaValueMax: '100', ariaValueNow: String(Math.round(value)) },
  h('div', { className: 'progress-bar', style: `width:${value}%` }));
};

// Inline SVG line chart. series: [{ values: number[], cls }]; all series share one scale.
export function sparkline(series, { width = 160, height = 36, max: fixedMax } = {}) {
  // Two points would draw a misleading diagonal, so wait for a few samples.
  if (series.every(s => s.values.length < 3)) return h('div', { className: 'spark-empty muted small', style: `width:${width}px` }, 'measuring…');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'spark');
  svg.setAttribute('preserveAspectRatio', 'none');
  // A fixed `max` (e.g. 100 for percentages) keeps the scale stable; otherwise all series share the data maximum.
  const max = fixedMax ?? Math.max(1, ...series.flatMap(s => s.values));
  for (const { values, cls } of series) {
    if (values.length < 2) continue;
    const pts = values.map((v, i) => `${(i / (values.length - 1) * width).toFixed(1)},${(height - 2 - v / max * (height - 4)).toFixed(1)}`);
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('class', cls);
    svg.append(line);
  }
  return svg;
}

// A card holding one muted sentence and an optional next action, shown when a page has nothing to list.
export const emptyState = (text, action = null) =>
  h('div', { className: 'card' }, h('div', { className: 'empty-state card-body' }, h('div', { className: 'muted' }, text), action));

// A banner listing what needs attention ({ level: 'bad' | 'warn' | 'info', text }), or a green all-clear.
export function healthBanner(list, okText) {
  if (!list.length) return h('div', { className: 'alert alert-success net-health ok', role: 'status' }, icon('check-circle'), okText);
  const worst = list.some(f => f.level === 'bad') ? 'bad' : list.some(f => f.level === 'warn') ? 'warn' : 'info';
  const variant = { bad: 'danger', warn: 'warning', info: 'info' }[worst];
  return h('div', { className: `alert alert-${variant} net-health ${worst}`, role: 'alert' },
    h('ul', {}, list.map(f => h('li', { className: f.level }, icon(f.level === 'bad' ? 'x-circle' : f.level === 'warn' ? 'exclamation-triangle' : 'info-circle'), f.text))));
}
