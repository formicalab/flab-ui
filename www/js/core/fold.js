// Cards that fold down to their header, shared by the editing pages (DHCP pools, Dynamic DNS services). The header is the toggle
// (mouse, Enter or Space); the page remembers which cards are folded, so the choice survives the redraws of the poll. The styles
// are in css/forms.css (.fl-folded, .fl-fold-header, .fl-chevron).
import { h } from './dom.js';

// The triangle at the left of a foldable card's header: right when folded, down when open.
export const chevron = () => h('span', { className: 'fl-chevron' });

// Makes the card `el` foldable. `folded` is whether it starts folded; `onChange(folded)` is told each time the user toggles it, so
// the page can remember the choice. A click on a control inside the header (a badge, a button, an input) does not toggle.
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

// Makes sure the control `el` can be seen: opens the closed group and unfolds the folded card that hold it. Used for a control
// that has an error, which must not stay hidden.
export function reveal(el) {
  const group = el.closest('details');
  if (group && !group.open) group.open = true;
  if (el.closest('.fl-folded')) el.closest('.card').querySelector('.fl-fold-header').click();
}
