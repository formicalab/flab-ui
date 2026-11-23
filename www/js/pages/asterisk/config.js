// Config tab: the Asterisk configuration files, read only, secrets redacted, with the sections to jump to and the line a dialplan step came from.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { ubus } from '../../core/ubus.js';
import { badge, card, emptyState, muted, button } from '../../core/ui.js';
import { fmtBytes } from '../../core/format.js';
import { readLines, sections, splitOption } from './configmodel.js';
import { dataNodes } from './steps.js';
import { reload, rerender, state } from './state.js';

// Reads the file index and the selected file (pjsip.conf, or the first file with content, when none is chosen yet).
export async function loadConfig() {
  const index = await ubus('flab.asterisk', 'config');
  const files = index.files ?? [];
  let file = state.file;
  if (!file || !files.some(f => f.key === file)) file = (files.find(f => f.key === 'pjsip.conf') ?? files.find(f => f.active > 0) ?? files[0])?.key ?? null;
  state.file = file;
  if (!file) return { files, reloaded: index.reloaded, file: null };
  const doc = await ubus('flab.asterisk', 'config', { file });
  return { files: doc.files ?? files, reloaded: index.reloaded, file: doc };
}

// One line of the file: number and text, colored by kind.
function lineNode(l, hl) {
  const body = (() => {
    if (l.kind === 'option') {
      const o = splitOption(l.text);
      return o ? [o.indent, h('span', { className: 'k' }, o.key), o.sep, h('span', { className: 'v' }, dataNodes(o.value)), h('span', { className: 'c' }, o.comment)] : [l.text];
    }
    return [l.kind === 'exten' || l.kind === 'other' ? dataNodes(l.text) : l.text];
  })();
  return h('div', { className: `ast-ln ${l.kind} ${hl === l.no ? 'hl' : ''}`, id: `ast-line-${l.no}` }, h('span', { className: 'no' }, String(l.no)), h('span', { className: 'tx' }, body, l.text === '' ? ' ' : ''));
}

// The Config tab's nodes for the result of loadConfig().
export function configView(cfg) {
  if (!cfg.files.length) return [emptyState('No Asterisk configuration file was found in /etc/asterisk.')];
  const visible = cfg.files.filter(f => !state.hideEmpty || f.active > 0 || f.key === state.file);
  const list = card([icon('list-ul'), 'Files'], h('div', { className: 'ast-ctx-list' },
    visible.map(f => h('button', { type: 'button', className: `ast-ctx ${f.key === state.file ? 'active' : ''}`, onclick: () => { state.file = f.key; state.line = null; state.lineScrolled = false; reload(); } },
      h('span', { className: 'mono fw-semibold' }, f.name), h('span', { className: 'muted small' }, f.active != null ? `${f.active} active` : ''), f.changed ? badge('changed', 'warning') : null)),
    h('div', { className: 'p-2' }, button(state.hideEmpty ? 'Show files with no settings' : 'Hide files with no settings', null, () => { state.hideEmpty = !state.hideEmpty; rerender(); }, 'btn-outline-secondary btn-sm'))));
  const doc = cfg.file;
  if (!doc || doc.error) return [h('div', { className: 'ast-split' }, list, card(null, h('div', { className: 'card-body text-danger' }, doc?.error ?? 'The file cannot be read.')))];

  const lines = readLines(doc.text);
  const secs = sections(lines);
  const jump = h('select', { className: 'form-select form-select-sm ast-jump-select', title: 'Jump to a section', onchange: e => { document.getElementById(`ast-line-${e.target.value}`)?.scrollIntoView({ block: 'start' }); e.target.value = ''; } },
    h('option', { value: '' }, `Jump to a section (${secs.length})…`), secs.map(s => h('option', { value: s.line }, `${s.name}${s.type ? ` · ${s.type}` : ''}  (line ${s.line})`)));
  const head = h('div', { className: 'card-body ast-file-head' },
    h('div', { className: 'd-flex flex-wrap align-items-center gap-2' }, h('span', { className: 'name mono' }, doc.path), muted(`${fmtBytes(doc.size)} · modified ${new Date(doc.mtime * 1000).toLocaleString()}`),
      doc.changed ? badge('changed after Asterisk loaded it', 'warning') : null,
      doc.redacted ? badge(`${doc.redacted} secret${doc.redacted > 1 ? 's' : ''} hidden`, 'info') : null,
      doc.truncated ? badge('shown in part', 'warning') : null),
    secs.length ? jump : null);
  const code = h('div', { className: 'ast-code', role: 'region', 'aria-label': `Contents of ${doc.name}` }, lines.map(l => lineNode(l, state.line)));
  if (state.line && !state.lineScrolled) {
    state.lineScrolled = true;
    setTimeout(() => document.getElementById(`ast-line-${state.line}`)?.scrollIntoView({ block: 'center' }), 80);
  }
  return [h('div', { className: 'ast-split' }, list, h('div', { className: 'ast-main' }, card(null, h('div', {}, head, code))))];
}
