// Folding, shared by the pages: `disclosure()` is the native <details> fold (a group of settings, a "show more" block), `foldable()` +
// `chevron()` make a whole card fold down to its header (DHCP pools, Dynamic DNS services), and `reveal()` makes sure a control with an
// error is visible again. The page remembers what is open or folded (the onToggle / onChange callbacks), so the choice survives the
// redraws of the poll. The styles are in css/base.css (.fl-disclosure*, .fl-folded, .fl-fold-header, .fl-chevron), which every page has.
import { h } from './dom.js';

// The triangle at the left of a foldable card's header: right when folded, down when open.
export const chevron = () => h('span', { className: 'fl-chevron' });

// Makes the card `el` foldable: its header is the toggle (mouse, Enter or Space). `folded` is whether it starts folded; `onChange(folded)`
// is told each time the user toggles it, so the page can remember the choice. A click on a control inside the header (a badge, a
// button, an input) does not toggle.
export function foldable(el, folded, onChange) {
  const header = el.querySelector('.card-header');
  el.classList.toggle('fl-folded', folded);
  // Folds or unfolds the card and tells the page.
  const toggle = () => {
    const now = el.classList.toggle('fl-folded');
    header.setAttribute('aria-expanded', String(!now));
    onChange(now);
  };
  header.classList.add('fl-fold-header');
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-expanded', String(!folded));
  header.title = 'Click to fold or unfold';
  header.addEventListener('click', e => { if (!e.target.closest('input, button, select, a')) toggle(); });
  header.addEventListener('keydown', e => { if (e.target === header && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } });
  return el;
}

// A native <details> fold with the shared arrow (css/base.css, .fl-disclosure). `summary` is a node or a list of nodes; `cls` adds
// classes to the <details> (`fl-disclosure-bar` makes the summary a padded group header); `summaryCls` adds classes to the <summary>.
// `open` is the initial state; `onToggle(open)` lets the page remember the choice across redraws.
export const disclosure = ({ cls = '', summary, summaryCls = '', body, open = false, onToggle }) =>
  h('details', { className: `fl-disclosure ${cls}`.trim(), open, ontoggle: e => onToggle?.(e.target.open) },
    h('summary', { className: summaryCls }, summary), body);

// Makes sure the control `el` can be seen: opens every closed group around it and unfolds the folded card that holds it. Used for a
// control that has an error, which must not stay hidden.
export function reveal(el) {
  for (let group = el.closest('details'); group; group = group.parentElement?.closest('details')) group.open = true;
  el.closest('.fl-folded')?.querySelector('.fl-fold-header')?.click();
}
