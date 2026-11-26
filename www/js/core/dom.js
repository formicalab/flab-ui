// Tiny DOM helpers shared by every page.

// Builds an element from properties and children. Text is always set through textContent/Text nodes,
// so data from the router is never parsed as HTML.
export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el[k] = v;
  el.append(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return el;
};

// Resolves after `ms` milliseconds: the pause between polls of a page that waits for the router to settle.
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Looks an element up by id (the #app mount point).
export const byId = id => document.getElementById(id);

// A keydown listener that runs `fn` on Enter, for an input or a control that has focus itself. Pass it to onkeydown or addEventListener.
// A key pressed on something inside the element is left alone.
export const onEnter = fn => e => {
  if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
  e.preventDefault();
  fn(e);
};

// Like onEnter, and Space too: the keys that activate a button, for an element that acts as one (a focusable row, card or header).
export const onActivate = fn => e => {
  if ((e.key !== 'Enter' && e.key !== ' ') || e.target !== e.currentTarget) return;
  e.preventDefault();
  fn(e);
};
