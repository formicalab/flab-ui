// A modal dialog built the way Bootstrap documents modals (https://getbootstrap.com/docs/5.3/components/modal/): a `.modal` that
// fills the viewport and scrolls, a centered `.modal-dialog`, and a `.modal-content` with `.modal-header` (the title and a
// `.btn-close`), `.modal-body` and `.modal-footer`. Bootstrap's own CSS does the layout. Its JavaScript plugin is not used (it is not
// vendored): the element is a native <dialog>, so the browser traps the focus, closes it with Escape, dims the page behind it
// (::backdrop) and puts it above everything. A click on the dimmed area outside the dialog closes it, as in Bootstrap, unless the
// dialog holds a form (`staticBackdrop`). The dialog lives in <body>, so a redraw of the page does not touch it. The styles that
// give it the theme's colors are in css/base.css.
//
// openDialog({ title, subtitle?, body, footer, size?, staticBackdrop?, onClose? }) returns { dialog, close, setBody, setFooter }:
//   body, footer     nodes (the footer holds the buttons); setBody()/setFooter() replace them, for a form that redraws itself
//   size             'lg' or 'xl' for Bootstrap's wider dialogs (default: the 500 px one)
//   staticBackdrop   true to keep a click outside from closing the dialog
//   onClose          called once, however the dialog was closed (a button, Escape, the backdrop, close())
import { h } from './dom.js';
import { closeButton } from './ui.js';

// How many dialogs were opened, to give each title a unique id for aria-labelledby.
let opened = 0;

// Opens a modal dialog in <body> and returns its handle (see the header for the shape).
export function openDialog({ title, subtitle, body, footer, size, staticBackdrop = false, onClose }) {
  const titleId = `fl-dialog-title-${++opened}`;
  const bodyBox = h('div', { className: 'modal-body fl-dialog-body' }, body);
  const footBox = h('div', { className: 'modal-footer fl-dialog-foot' }, footer);
  const dialog = h('dialog', { className: 'modal fl-dialog' },
    h('div', { className: `modal-dialog modal-dialog-centered${size ? ` modal-${size}` : ''}` },
      h('div', { className: 'modal-content' },
        h('div', { className: 'modal-header' },
          h('div', {}, h('h1', { className: 'modal-title fs-5 fl-dialog-title', id: titleId }, title), subtitle ? h('div', { className: 'muted small' }, subtitle) : null),
          closeButton(() => dialog.close())),
        bodyBox, footBox)));
  // The dialog is named by its title (h() sets properties, and aria-labelledby has no string property).
  dialog.setAttribute('aria-labelledby', titleId);
  // The dialog fills the viewport, so a click that lands on the dialog itself (not on its content) is a click on the dimmed area.
  if (!staticBackdrop) dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  // The browser fires `close` for every way out; the element is removed then, so no dialog is left behind.
  dialog.addEventListener('close', () => { dialog.remove(); onClose?.(); });
  document.body.append(dialog);
  dialog.showModal();
  return {
    dialog,
    close: () => dialog.close(),
    setBody: node => bodyBox.replaceChildren(node),
    setFooter: node => footBox.replaceChildren(...[node].flat()),
  };
}
