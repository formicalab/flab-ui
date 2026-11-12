// A modal dialog on the native <dialog> element: the browser traps the focus, closes it with Escape and dims the page
// behind it. The dialog lives in <body>, so a redraw of the page (the poll, a refresh) does not touch it.
//
// openDialog({ title, subtitle?, body, footer, onClose? }) returns { dialog, close, setBody, setFooter }:
//   body, footer   nodes (the footer holds the buttons); setBody()/setFooter() replace them, for a form that redraws itself
//   onClose        called once, however the dialog was closed (a button, Escape, close())
import { h } from './dom.js';
import { icon } from './icons.js';

export function openDialog({ title, subtitle, body, footer, onClose }) {
  const bodyBox = h('div', { className: 'fl-dialog-body' }, body);
  const footBox = h('div', { className: 'fl-dialog-foot' }, footer);
  const dialog = h('dialog', { className: 'fl-dialog' },
    h('div', { className: 'fl-dialog-head' },
      h('div', {}, h('div', { className: 'fl-dialog-title' }, title), subtitle ? h('div', { className: 'muted small' }, subtitle) : null),
      h('button', { type: 'button', className: 'btn btn-sm btn-fl', title: 'Close', ariaLabel: 'Close', onclick: () => dialog.close() }, icon('x-lg'))),
    bodyBox, footBox);
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
