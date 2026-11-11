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
  // The button re-labels itself in place, so no page redraw is needed.
  const btn = button('Pause', 'pause-fill', () => {
    state.paused = !state.paused;
    btn.replaceChildren(icon(state.paused ? 'play-fill' : 'pause-fill'), state.paused ? 'Resume' : 'Pause');
  });
  return btn;
}

// Refresh button that calls `reload` (a fresh poll of the page).
export const refreshControl = reload => button('Refresh', 'arrow-clockwise', reload, 'btn-brand');

// A strip of tab buttons bound to state[key]; options are [value, label] pairs. A click selects the tab and calls
// onchange(value). Returns { node, setOptions(options) } so a page can offer only the tabs that make sense
// (the selection falls back to the first tab when its own disappears; the node is empty below two tabs).
export function tabsControl(state, key, onchange) {
  const node = h('div', { className: 'seg', role: 'tablist' });
  let options = [];
  const draw = () => {
    node.hidden = options.length < 2;
    node.replaceChildren(...options.map(([value, label]) => h('button', {
      type: 'button', role: 'tab', className: `seg-tab ${state[key] === value ? 'active' : ''}`, ariaSelected: String(state[key] === value),
      onclick: () => { if (state[key] === value) return; state[key] = value; draw(); onchange(value); },
    }, label)));
  };
  return {
    node,
    setOptions(next) {
      options = next;
      if (!options.some(([value]) => value === state[key])) state[key] = options[0][0];
      draw();
    },
  };
}

// Two-state toggle bound to state[key]; the label shows the mode a click switches to.
export function toggleControl(state, key, [offLabel, onLabel], onchange) {
  // The button re-labels itself in place, so no page redraw is needed beyond what onchange does.
  const btn = button(state[key] ? onLabel : offLabel, null, () => {
    state[key] = !state[key];
    btn.textContent = state[key] ? onLabel : offLabel;
    onchange();
  });
  return btn;
}
