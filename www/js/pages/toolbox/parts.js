// Small view parts the Toolbox's views share: the message lines under a form or a result, the icon of a finding's level, the
// "working" spinner line, a date and the bar of a time. Kept here so that every view words and draws them the same way.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { AuthError } from '../../core/ubus.js';

// The icon and the extra class of each kind of message line (`rt-error` is the base class: it is the one the page's tests and
// css/routing.css know).
const BANNER = { error: ['x-circle', ''], warn: ['exclamation-triangle', ' warn'], ok: ['check-circle', ' ok'] };

// A message line with its icon: `kind` is 'error' (red), 'warn' (amber) or 'ok' (green).
export const banner = (text, kind = 'error') => h('div', { className: `rt-error${BANNER[kind][1]}` }, icon(BANNER[kind][0]), text);

// The icon of a finding or verdict level: 'ok', 'warn' or 'bad'.
export const LEVEL_ICON = { ok: 'check-circle', warn: 'exclamation-triangle', bad: 'x-circle' };

// A list of findings ({ level, text }) as the check lines of a result, or null when there are none.
export const findingList = list => (list.length ? h('div', { className: 'rt-findings' }, list.map(n => h('div', { className: `rt-finding ${n.level}` }, icon(LEVEL_ICON[n.level]), n.text))) : null);

// A spinner with `text`, for a part of a result that is still being worked on.
export const working = text => h('span', { className: 'rt-running' }, h('span', { className: 'spinner-border spinner-border-sm' }), text);

// The words of a failed ubus call: the plugin's own message, or a hint when the session has ended.
export const failure = e => (e instanceof AuthError ? 'The session has expired. Sign in again.' : e.message);

// A date (milliseconds) as "2026-12-25", or a dash.
export const day = ms => (ms == null ? '–' : new Date(ms).toISOString().slice(0, 10));

// A time with a small bar next to it, as long as the time is compared with the largest one `max` (never narrower than 3%).
export const timeBar = (text, ms, max) => h('span', { className: 'rt-avg' }, text, h('span', { className: 'rt-bar' }, h('i', { style: `width:${Math.max(3, ms / max * 100).toFixed(0)}%` })));
