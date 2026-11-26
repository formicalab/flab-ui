// The BIRD configuration as the BGP tab shows it: a read-only card with the file (/etc/bird.conf, secrets already hidden by the
// backend), a syntax check, and, for each peer, the part of the file that defines it. Nothing here edits the file.

import { h } from '../../../core/dom.js';
import { icon } from '../../../core/icons.js';
import { AuthError, can, ubus } from '../../../core/ubus.js';
import { badge, button, card, closeButton, kv, muted, mono, section, chip } from '../../../core/ui.js';
import { chevron, disclosure, foldable } from '../../../core/fold.js';
import { fmtBytes } from '../../../core/format.js';
import { blockText, configOf, findBlock, nameOf, protocolBlocks } from './configmodel.js';

// Runs `configure check` on the router and remembers the answer in the page state (`state.cfgCheck`); the page redraws around it.
async function runCheck(state, rerender) {
  state.cfgCheck = { busy: true };
  rerender();
  try {
    state.cfgCheck = { ...await ubus('flab.bgp', 'check'), at: Date.now() };
  } catch (e) {
    // An expired session goes back to the sign-in screen through the next poll.
    if (e instanceof AuthError) return state.reload();
    state.cfgCheck = { ok: false, output: e.message, at: Date.now() };
  }
  rerender();
}

// The outcome of the last check: green with BIRD's words when it passed, red with the error and its line number when not. The close
// button forgets it (`state.cfgCheck`), so the note does not stay until the page is left.
function checkNote(state, rerender) {
  const check = state.cfgCheck;
  if (!check) return null;
  if (check.busy) return h('div', { className: 'muted small' }, 'Checking…');
  return h('div', { className: `cfg-check ${check.ok ? 'ok' : 'bad'}`, role: 'status', id: 'bgp-cfg-outcome' },
    icon(check.ok ? 'check-circle' : 'x-circle', 17),
    h('div', { className: 'cfg-check-body' }, h('strong', {}, check.ok ? 'BIRD accepts this configuration.' : 'BIRD rejects this configuration.'),
      check.output ? h('pre', { className: 'cfg-output' }, check.output) : null,
      h('div', { className: 'muted small' }, `Checked ${new Date(check.at).toLocaleTimeString()}; the check does not apply anything.`)),
    closeButton(() => { state.cfgCheck = null; rerender(); }, 'Close', { id: 'bgp-cfg-outcome-close' }));
}

// The file with line numbers, comments dimmed and the lines of the selected block highlighted. A block comment or a `#` comment is
// dimmed from the column where the scanner saw it start.
function codeBox(config, state) {
  const selected = findBlock(config, state.cfgBlock?.kind, state.cfgBlock?.name);
  const lines = config.lines.at(-1) === '' ? config.lines.slice(0, -1) : config.lines;
  const rows = lines.map((line, i) => {
    const col = config.commentCols[i];
    const hit = selected && i + 1 >= selected.startLine && i + 1 <= selected.endLine;
    return h('div', { className: `cfg-line${hit ? ' cfg-hit' : ''}`, id: `cfg-line-${i + 1}` },
      h('span', { className: 'cfg-ln' }, String(i + 1)),
      h('span', { className: 'cfg-tx' }, col >= 0 ? line.slice(0, col) : line, col >= 0 ? h('span', { className: 'cfg-comment' }, line.slice(col)) : null));
  });
  const box = h('div', { className: 'cfg-code', tabIndex: 0, role: 'region', ariaLabel: 'BIRD configuration file, read only', onscroll: () => { state.cfgScroll = box.scrollTop; } }, rows);
  // The box is in the page only after this function returns: restore the scroll position of the last draw, or jump to the block that was clicked.
  requestAnimationFrame(() => {
    const first = state.cfgJump && box.querySelector(`#cfg-line-${state.cfgJump}`);
    if (first) box.scrollTop = Math.max(0, first.offsetTop - box.offsetTop - 6);
    else box.scrollTop = state.cfgScroll ?? 0;
    state.cfgJump = null;
  });
  return box;
}

// A row of buttons, one per block of the file worth jumping to: protocols, templates and filters.
function blockIndex(config, state, rerender) {
  const blocks = config.blocks.filter(b => nameOf(b) && ['protocol', 'template', 'filter'].includes(b.kind));
  const label = b => b.kind === 'protocol' ? nameOf(b) : `${b.kind} ${b.name}`;
  return h('div', { className: 'cfg-index' }, h('span', { className: 'muted small' }, 'Jump to'),
    blocks.map(b => h('button', {
      type: 'button', className: `alg-chip cfg-chip ${state.cfgBlock?.name === nameOf(b) && state.cfgBlock?.kind === b.kind ? 'good' : ''}`,
      title: `Lines ${b.startLine}-${b.endLine}${b.name ? '' : '; BIRD names this protocol itself, as the file does not'}`,
      onclick: () => { state.cfgBlock = { kind: b.kind, name: nameOf(b) }; state.cfgJump = b.firstLine; rerender(); },
    }, label(b))));
}

// The card with the whole file. Folded at first: it is a reference rather than something to read at every visit. `null` when the router's
// plugin has no `config` method (an older package).
export function configCard(data, state, rerender) {
  const reply = data.config;
  if (!reply) return null;
  const head = [chevron(), icon('journal-text'), 'BIRD configuration'];
  if (!reply.available) {
    return foldable(card([...head, h('span', { className: 'sub' }, reply.path)],
      h('div', { className: 'card-body muted' }, `${reply.path} does not exist on this router, so BIRD runs without a configuration file.`)), state.cfgFolded, folded => { state.cfgFolded = folded; });
  }
  const config = configOf(reply);
  const loaded = data.daemon?.reconfigured;
  const stale = loaded != null && reply.mtime > loaded;
  const meta = h('div', { className: 'cfg-meta' },
    mono(reply.path), badge(fmtBytes(reply.size), ''),
    badge(`modified ${new Date(reply.mtime * 1000).toLocaleString()}`, stale ? 'warning' : ''),
    loaded == null ? null : stale
      ? badge('changed after BIRD read it', 'warning', 'The running configuration may differ from the file: run "birdc configure" to apply it')
      : badge('read by BIRD', 'success', `BIRD last reconfigured at ${new Date(loaded * 1000).toLocaleString()}, after the file was last changed`),
    reply.redacted ? badge(`${reply.redacted} secret${reply.redacted === 1 ? '' : 's'} hidden`, 'info', 'Passwords and keys never leave the router') : null,
    reply.truncated ? badge('shown truncated', 'warning', 'Only the first part of a very large file is shown') : null,
    can('flab.bgp', 'check') ? button('Check', 'check2', () => runCheck(state, rerender), 'btn-outline-secondary btn-sm', { id: 'bgp-cfg-check', title: 'Ask BIRD to parse the file without applying it' }) : null);
  const body = h('div', { className: 'card-body' }, meta, checkNote(state, rerender), blockIndex(config, state, rerender), codeBox(config, state));
  return foldable(card([...head, h('span', { className: 'sub' }, `${config.lines.length - (config.lines.at(-1) === '' ? 1 : 0)} lines · read only`)], body),
    state.cfgFolded, folded => { state.cfgFolded = folded; });
}

// Opens the configuration card at the source of a filter (a chip of the table or a tag of the diagram): unfolds the card, highlights
// the filter and scrolls the file to it.
export function showFilterSource(state, rerender, name, block) {
  state.cfgFolded = false;
  state.cfgBlock = { kind: 'filter', name };
  state.cfgJump = block.firstLine;
  rerender();
  requestAnimationFrame(() => document.querySelector('.cfg-code')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

// A fold with the source of one block of the file; whether it is open is kept in the page state across the redraws of the poll.
function sourceFold(state, key, title, text) {
  return disclosure({
    cls: 'cfg-fold', summary: title, open: state.cfgOpen.has(key),
    onToggle: open => { if (open) state.cfgOpen.add(key); else state.cfgOpen.delete(key); },
    body: h('pre', { className: 'cfg-src' }, text),
  });
}

// The section of a peer's card that says where the peer comes from: its lines in the file, the template it inherits from and the
// source of its protocol block, template and filters. `null` when no file was read; a note when the peer is not defined in the file.
export function peerConfigSection(p, data, state) {
  const config = configOf(data.config);
  if (!config) return null;
  const { own, template } = protocolBlocks(config, p.name);
  if (!own) return section('Configuration', muted(`${p.name} is not defined in ${data.config.path} (for example, it was created dynamically).`));
  const names = [...new Set(p.channels.flatMap(c => [c.input_filter, c.output_filter]).filter(f => f && f !== 'ACCEPT' && f !== 'REJECT'))];
  const filters = names.map(n => findBlock(config, 'filter', n)).filter(Boolean);
  return section('Configuration', h('div', {},
    kv([
      ['Defined in', `${data.config.path}, lines ${own.startLine}–${own.endLine}`],
      template ? ['Template', chip(template.name, 'info', `Settings inherited from the template, lines ${template.startLine}–${template.endLine}`)] : null,
    ]),
    sourceFold(state, `${p.name}:protocol`, 'Protocol block', blockText(config, own)),
    template ? sourceFold(state, `${p.name}:template`, `Template ${template.name}`, blockText(config, template)) : null,
    filters.map(f => sourceFold(state, `${p.name}:filter:${f.name}`, `Filter ${f.name}`, blockText(config, f)))));
}
