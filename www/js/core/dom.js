// Tiny DOM helpers shared by every page.

// Builds an element from properties and children. Text is always set through textContent/Text nodes,
// so data from the router is never parsed as HTML.
export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el[k] = v;
  el.append(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return el;
};

// Looks an element up by id (the #app mount point).
export const byId = id => document.getElementById(id);
