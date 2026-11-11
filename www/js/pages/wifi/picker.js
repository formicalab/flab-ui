// The channel picker of a radio card: the channels the regulatory domain allows as clickable tiles. Hovering (or
// focusing) a tile previews the block of channels the radio would occupy at its configured width, in blue, or in red
// when the block does not fit; clicking selects the channel, and the Auto chip hands the choice to the radio. Nothing
// is saved here: the choice goes into the page's draft and the review banner takes it from there.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { runningBlock, spanOf, widthOf } from './channels.js';

// "5170–5330 MHz" for a span.
const mhz = s => `${s.lo}–${s.hi} MHz`;

// What a block is, in words: "channels 36–64 (5170–5330 MHz)" for a run of channels, and for a 40 MHz block on
// 2.4 GHz "channel 4 with channel 8 above it (2417–2457 MHz), covering channels 4–8". Channels that only stick out
// of the block are counted: " and partly overlapping 4 more".
function describeSpan(s, channel) {
  const covered = [...s.channels, ...s.inside].sort((a, b) => a - b);
  const range = covered.length > 1 ? `channels ${covered[0]}–${covered.at(-1)}` : `channel ${covered[0]}`;
  let text = s.secondary
    ? `channel ${channel} with channel ${s.channels.find(c => c !== channel)} ${s.secondary} it (${mhz(s)}), covering ${range}`
    : `${range} (${mhz(s)})`;
  if (s.overlap.length) text += ` and partly overlapping ${s.overlap.length} more`;
  return text;
}

// The picker for radio `r`. `edit` connects it to the page's draft:
//   draft       the form's draft (draft.radios[name].channel is edited in place)
//   inputs      receives the picker element under `<radio>:channel`, so an error can mark it
//   touched()   called after every choice
export function channelPicker(r, edit) {
  const live = r.live ?? {};
  const width = widthOf(r.config?.htmode);
  const configured = String(r.config?.channel ?? 'auto');
  const mine = edit.draft.radios[r.name];
  const byNo = new Map(r.channels.map(c => [c.channel, c]));
  // Whether the whole block of the radio's width fits around each channel (computed once).
  const fits = new Map(r.channels.map(c => [c.channel, !c.disabled && spanOf(r, c.channel, width).fits]));
  const running = runningBlock(r);
  let previewed = null;

  const tiles = new Map();
  const summary = h('div', { className: 'rd-pick-sum' });
  const autoChip = h('button', { type: 'button', className: 'rd-auto', disabled: !edit.canEdit, title: 'Let the radio choose its channel when it starts (automatic channel selection)',
    onclick: () => choose('auto') }, icon('broadcast'), 'Auto');

  // The sentence under the tiles: what a hovered channel would use, else what the draft changes, else a hint.
  function describe() {
    const chosen = mine.channel;
    if (previewed != null) {
      const s = spanOf(r, previewed, width);
      return fits.get(previewed)
        ? [h('b', {}, `Channel ${previewed}`), ` at ${width} MHz would use ${describeSpan(s, previewed)}.`]
        : [h('b', {}, `Channel ${previewed}`), byNo.get(previewed).disabled ? ' is not allowed in this regulatory domain.' : ` cannot carry ${width} MHz: the block ${mhz(s)} is not entirely allowed.`];
    }
    if (chosen === 'auto') return [h('b', {}, 'Auto'), chosen === configured ? ': the radio picks its channel when it starts.' : ' selected: the radio will pick its channel when it starts.'];
    if (chosen !== configured) {
      const s = spanOf(r, +chosen, width);
      return [h('b', {}, `${configured} → ${chosen}`), ` would use ${describeSpan(s, +chosen)}, ${width} MHz.`];
    }
    return [`Hover a channel to see the ${width} MHz it would use, click to choose it.`];
  }

  // Sets the classes of every tile from the draft, the running channel and the hovered one.
  function paint() {
    const chosen = mine.channel;
    const picked = chosen !== configured && /^\d+$/.test(chosen) ? spanOf(r, +chosen, width) : null;
    const hovered = previewed != null ? spanOf(r, previewed, width) : null;
    const shown = hovered ?? picked;
    for (const [n, el] of tiles) {
      const c = byNo.get(n);
      const cls = ['chn', c.disabled ? 'off' : '', c.dfs ? 'dfs' : '', !c.disabled && !fits.get(n) ? 'nofit' : '',
        running.channels.includes(n) ? 'span' : running.inside.includes(n) ? 'span-in' : '', n === live.channel ? 'cur' : '',
        String(n) === configured && n !== live.channel ? 'cfg' : '',
        picked?.channels.includes(n) ? 'pend' : '', String(n) === chosen && chosen !== configured ? 'sel' : '',
        hovered?.channels.includes(n) ? (fits.get(previewed) ? 'pv' : 'pv-bad') : '', n === previewed ? 'pv-main' : '',
        shown?.inside.includes(n) ? 'in' : '', shown?.overlap.includes(n) ? 'ov' : ''].filter(Boolean).join(' ');
      el.className = cls;
      el.setAttribute('aria-pressed', String(String(n) === chosen));
    }
    autoChip.classList.toggle('on', chosen === 'auto');
    autoChip.setAttribute('aria-pressed', String(chosen === 'auto'));
    summary.replaceChildren(...describe());
  }

  // Selects a channel (or `auto`) into the draft and repaints; a channel that cannot carry the width is not selectable.
  function choose(value) {
    if (value !== 'auto' && !fits.get(+value)) return;
    mine.channel = String(value) === mine.channel && String(value) !== configured ? configured : String(value);
    paint();
    edit.touched();
  }

  for (const c of r.channels) {
    const tip = [`Channel ${c.channel} · ${c.freq} MHz`, c.disabled ? 'not allowed in this regulatory domain' : `up to ${c.max_power} dBm`, c.dfs ? 'DFS: radar detection required' : '', c.no_ir ? 'no initiating radiation' : ''].filter(Boolean).join(' · ');
    const el = h('button', { type: 'button', title: tip, disabled: !edit.canEdit || c.disabled,
      onclick: () => choose(c.channel),
      onmouseenter: () => { previewed = c.channel; paint(); }, onmouseleave: () => { previewed = null; paint(); },
      onfocus: () => { previewed = c.channel; paint(); }, onblur: () => { previewed = null; paint(); } },
    h('span', { className: 'n' }, c.channel), h('span', { className: 'f' }, c.freq));
    tiles.set(c.channel, el);
  }

  const root = h('div', { className: 'rd-pick' },
    h('div', { className: 'rd-pick-head' },
      h('div', { className: 'label' }, `Channel · ${r.channels.filter(c => !c.disabled).length} allowed · frequency in MHz`), autoChip),
    h('div', { className: 'chans' }, [...tiles.values()]),
    summary,
    h('div', { className: 'rd-pick-key muted small' },
      h('span', { className: 'key running' }), 'running ', h('span', { className: 'key sel' }), 'your choice ',
      h('span', { className: 'key pv' }), 'preview ', h('span', { className: 'key in' }), 'covered between ', h('span', { className: 'key ov' }), 'partly overlapped ', h('span', { className: 'key bad' }), 'does not fit ',
      h('span', { className: 'key dfs' }), 'radar (DFS) ', h('span', { className: 'key off' }), 'not allowed'));
  edit.inputs[`${r.name}:channel`] = root;
  paint();
  return root;
}
