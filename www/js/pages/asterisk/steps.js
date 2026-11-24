// Shared pieces of the Dialplan tab: the listing of an extension's steps (with what each step jumps to and dials) and the jump to a
// destination. Used by the browser and by the number tester.
import { h } from '../../core/dom.js';
import { badge, mono, muted } from '../../core/ui.js';
import { appInfo } from './apps.js';
import { globalVars, stepDials, stepJumps } from './dialplanmodel.js';
import { endpointKind } from './pjsipmodel.js';
import { go, rerender, state } from './state.js';

// A text with its ${variables} and $[expressions] marked, and the redaction marker flagged.
export function dataNodes(text) {
  return text.split(/(\$\{[^}]*\}|\$\[[^\]]*\]|<redacted>)/).filter(p => p !== '').map(part => {
    if (part === '<redacted>') return h('span', { className: 'ast-redacted', title: 'The value is hidden by flab-ui' }, part);
    if (part.startsWith('${') || part.startsWith('$[')) return h('span', { className: 'ast-var' }, part);
    return part;
  });
}

// The element id of an extension card, so a jump can scroll to it.
export const extId = (ctxName, pattern) => `ast-ext-${[...`${ctxName}|${pattern}`].map(c => c.charCodeAt(0).toString(16)).join('')}`;

// Shows a destination in the browser view: selects the context, opens the extension, marks the step and scrolls to it.
export function jumpTo(ctxName, pattern, prio) {
  state.dpView = 'browse';
  state.ctx = ctxName;
  state.ext = pattern;
  state.hl = prio ?? null;
  state.openExt.add(`${ctxName}|${pattern}`);
  if (state.tab === 'dialplan') rerender();
  else go('dialplan');
  setTimeout(() => document.getElementById(extId(ctxName, pattern))?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
}

// The jump and dial annotations of one step, as nodes: where it may go next and which endpoint it calls.
function annotations(dp, map, step, here) {
  const out = [];
  for (const j of stepJumps(dp, step, here)) {
    const same = j.context === here.context && j.exten === here.exten;
    const where = j.dynamic ? 'through a variable' : same ? `${j.prio}${j.label ? ` [${j.label}]` : ''}` : `${j.context},${j.exten},${j.prio}`;
    const text = `${j.branch === 'always' ? '→' : j.branch === 'then' ? '→ if true:' : '→ else:'} ${where}`;
    out.push(j.dynamic ? muted(text) : j.missing
      ? badge(`${text} (no such ${j.missing})`, 'warning')
      : h('button', { type: 'button', className: 'btn btn-link btn-sm p-0 ast-jump', title: j.cond ? `When ${j.cond}` : 'Show the destination', onclick: () => jumpTo(j.context, j.exten, j.prio) }, text));
  }
  for (const d of stepDials(step, globalVars(dp))) {
    if (d.kind === 'endpoint') {
      const t = map.targets.find(x => x.id === `tg:${d.endpoint}`);
      out.push(h('span', { className: 'ast-target', title: (t?.known ? `${d.endpoint}: ${t.state}` : `Asterisk has no endpoint ${d.endpoint}`) + (d.via ? ` (the value of ${d.via})` : '') },
        h('span', { className: `ast-dot ${t?.known ? endpointKind({ state: t.state, role: t.role }) || 'neutral' : 'danger'}` }), `calls ${d.endpoint}`));
    } else if (d.kind === 'dynamic') out.push(muted('calls an endpoint chosen at run time'));
    else if (d.kind === 'local') out.push(muted(`calls a Local channel into ${d.context ?? '?'}`));
  }
  return out;
}

// The steps of one extension as a table. `here` = { context, exten } for resolving jumps; the step with priority state.hl is marked.
export function stepsTable(dp, map, ext, here) {
  const rows = ext.steps.map(s => {
    const info = appInfo(s.app);
    return h('tr', { className: state.hl === s.prio && state.ext === here.exten && state.ctx === here.context ? 'ast-hl' : '' },
      h('td', { className: 'ast-prio mono' }, String(s.prio)),
      h('td', {}, s.label ? h('span', { className: 'ast-label mono' }, s.label) : null),
      h('td', {}, h('span', { className: `ast-app ${info.cat}`, title: info.text || s.app }, s.app)),
      h('td', { className: 'ast-data mono' }, dataNodes(s.data)),
      h('td', { className: 'ast-notes' }, annotations(dp, map, s, here)),
      h('td', { className: 'ast-src' }, s.source ? h('button', { type: 'button', className: 'btn btn-link btn-sm p-0 mono', title: 'Show this line in the configuration file',
        onclick: () => go('config', { file: s.source.file, line: s.source.line }) }, `${s.source.file}:${s.source.line}`) : null));
  });
  return h('div', { className: 'table-responsive' }, h('table', { className: 'table table-sm ast-steps' },
    h('thead', {}, h('tr', {}, ['#', 'Label', 'Application', 'Arguments', 'Next', 'Source'].map(c => h('th', {}, c)))), h('tbody', {}, rows)));
}
