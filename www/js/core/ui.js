// Reusable presentational components. Every page composes its UI from these building blocks.

import { h } from './dom.js';
import { icon } from './icons.js';

// Soft pill. kind: '' | success | warning | danger | info
export const badge = (text, kind = '', title = '') => h('span', { className: `fl-badge ${kind}`, title }, text);

// Algorithm / value chip colored by strength level: good | fair | weak | info
export const chip = (text, lvl = '', title = '') => h('span', { className: `alg-chip ${lvl}`, title }, text);

export const card = (header, body, extra = '') => h('div', { className: `card ${extra}` },
  header ? h('div', { className: 'card-header' }, header) : null, body);

// KPI tile used in summary rows.
export const tile = (label, value, sub, valueClass = '') => h('div', { className: 'col' },
  h('div', { className: 'card tile h-100' }, h('div', { className: 'card-body' },
    h('div', { className: 'label' }, label),
    h('div', { className: `value ${valueClass}` }, value),
    sub ? h('div', { className: 'sub' }, sub) : null)));

export const tiles = (...t) => h('div', { className: 'row row-cols-2 row-cols-md-3 row-cols-xl-4 row-cols-xxl-6 g-3' }, t);

// Simple table: cols are labels, rows are arrays of nodes or strings.
export const table = (cols, rows) => h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover' },
  h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
  h('tbody', {}, rows.length
    ? rows.map(r => h('tr', {}, r.map(c => h('td', {}, c))))
    : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'Nothing to show')))));

export const button = (label, iconName, onclick, cls = 'btn-fl') =>
  h('button', { type: 'button', className: `btn btn-sm ${cls}`, onclick }, iconName ? icon(iconName) : null, label);

// Label/value list. rows: [label, node|string] pairs; null rows are skipped.
export const kv = rows => h('dl', { className: 'kv' },
  rows.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

// Titled block inside a card body.
export const section = (title, ...body) => h('div', { className: 'blk' }, h('h3', {}, title), ...body);

// Elapsed/remaining lifetime bar. `rekeyIn` marks the soft limit, `expiresIn` (optional) the hard limit.
export function lifebar({ elapsed, rekeyIn, expiresIn }) {
  const end = expiresIn != null ? elapsed + expiresIn : elapsed + (rekeyIn ?? 0);
  const pct = v => end > 0 ? Math.min(100, Math.max(0, v / end * 100)) : 0;
  const marker = rekeyIn != null && expiresIn != null ? h('i', { className: 'mark', style: `left:${pct(elapsed + rekeyIn)}%` }) : null;
  return h('div', { className: 'lifebar' }, h('div', { className: 'track' },
    h('div', { className: 'fill', style: `width:${pct(elapsed)}%` }), marker));
}

// Horizontal score meter; lvl colors the fill (good | fair | weak).
export const meter = (score, max, lvl) => h('div', { className: `meter ${lvl}` },
  h('div', { className: 'fill', style: `width:${max ? score / max * 100 : 0}%` }));

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

export const emptyState = text => h('div', { className: 'card' }, h('div', { className: 'card-body muted' }, text));

// A banner listing what needs attention ({ level: 'bad' | 'warn' | 'info', text }), or a green all-clear.
export function healthBanner(list, okText) {
  if (!list.length) return h('div', { className: 'net-health ok' }, icon('check-circle'), okText);
  const worst = list.some(f => f.level === 'bad') ? 'bad' : list.some(f => f.level === 'warn') ? 'warn' : 'info';
  return h('div', { className: `net-health ${worst}` },
    h('ul', {}, list.map(f => h('li', { className: f.level }, icon(f.level === 'bad' ? 'shield-exclamation' : f.level === 'warn' ? 'exclamation-triangle' : 'info-circle'), f.text))));
}
