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
  return h('div', { className: 'search input-group input-group-sm' },
    h('span', { className: 'input-group-text' }, icon('search')), input);
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
  btn.classList.add('cmd-pause');
  return btn;
}

// Refresh button that calls `reload` (a fresh poll of the page).
export const refreshControl = reload => {
  const btn = button('Refresh', 'arrow-clockwise', reload, 'btn-primary');
  btn.classList.add('cmd-refresh');
  return btn;
};

// A strip of tab buttons bound to state[key]; options are [value, label] pairs, and a null entry leaves a small gap between two groups of tabs.
// A click selects the tab and calls onchange(value). Returns { node, setOptions(options) } so a page can offer only the tabs that make sense
// (the selection falls back to the first tab when its own disappears; the strip is hidden below two tabs).
export function tabsControl(state, key, onchange) {
  const node = h('div', { className: 'btn-group btn-group-sm seg', role: 'tablist', ariaLabel: 'Views' });
  let options = [];
  let tabs = [];
  const choose = (index, focus = false) => {
    const next = tabs[index]?.[0];
    if (next == null || state[key] === next) return;
    state[key] = next;
    draw();
    if (focus) queueMicrotask(() => node.querySelector('[aria-selected="true"]')?.focus());
    onchange(next);
  };
  // Rebuilds the tab buttons from the current options and marks the selected one.
  const draw = () => {
    tabs = options.filter(Boolean);
    node.hidden = tabs.length < 2;
    let index = -1;
    node.replaceChildren(...options.map((option, at) => {
      if (!option) return h('span', { className: 'seg-gap', ariaHidden: 'true' });
      const [value, label] = option, mine = ++index;
      return h('button', {
        type: 'button', role: 'tab',
        className: `btn btn-outline-secondary seg-tab ${state[key] === value ? 'active' : ''} ${options[at + 1] === null ? 'seg-before-gap' : ''} ${options[at - 1] === null ? 'seg-after-gap' : ''}`,
        ariaSelected: String(state[key] === value), ariaControls: 'page-content', tabIndex: state[key] === value ? 0 : -1,
        onclick: () => choose(mine),
        onkeydown: event => {
          let to;
          if (event.key === 'ArrowRight') to = (mine + 1) % tabs.length;
          else if (event.key === 'ArrowLeft') to = (mine - 1 + tabs.length) % tabs.length;
          else if (event.key === 'Home') to = 0;
          else if (event.key === 'End') to = tabs.length - 1;
          if (to == null) return;
          event.preventDefault();
          choose(to, true);
        },
      }, label);
    }));
  };
  return {
    node,
    setOptions(next) {
      options = next;
      const first = options.find(Boolean);
      if (!options.some(option => option && option[0] === state[key])) state[key] = first[0];
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
