// Reusable command-bar controls. Each factory returns DOM nodes and keeps its value in a
// plain state object owned by the page, so values survive auto-refresh redraws.

import { h } from './dom.js';
import { icon } from './icons.js';
import { button } from './ui.js';

// Text filter bound to state[key]; calls onchange after every edit.
export function searchControl(state, key, onchange, placeholder = 'Filter…') {
  const input = h('input', {
    className: 'form-control form-control-sm', type: 'search', placeholder, value: state[key],
    oninput: e => { state[key] = e.target.value; onchange(); },
  });
  return h('div', { className: 'search' }, icon('search'), input);
}

// Drop-down bound to state[key]. Returns { node, setOptions(options) } where options are [value, label] pairs.
export function selectControl(state, key, onchange, title) {
  const select = h('select', {
    className: 'form-select form-select-sm', title,
    onchange: e => { state[key] = e.target.value; onchange(); },
  });
  return {
    node: select,
    setOptions(options) {
      select.replaceChildren(...options.map(([value, label]) => h('option', { value }, label)));
      if (!options.some(([value]) => value === state[key])) state[key] = options[0][0];
      select.value = state[key];
    },
  };
}

// Pause/resume toggle bound to state.paused.
export function pauseControl(state) {
  const btn = button('Pause', 'pause-fill', () => {
    state.paused = !state.paused;
    btn.replaceChildren(icon(state.paused ? 'play-fill' : 'pause-fill'), state.paused ? 'Resume' : 'Pause');
  });
  return btn;
}

export const refreshControl = reload => button('Refresh', 'arrow-clockwise', reload, 'btn-brand');

// Two-state toggle bound to state[key]; the label shows the mode a click switches to.
export function toggleControl(state, key, [offLabel, onLabel], onchange) {
  const btn = button(state[key] ? onLabel : offLabel, null, () => {
    state[key] = !state[key];
    btn.textContent = state[key] ? onLabel : offLabel;
    onchange();
  });
  return btn;
}
