// A side panel (drawer) on the right edge of the page, built the way Bootstrap documents offcanvas
// (https://getbootstrap.com/docs/5.3/components/offcanvas/): an `.offcanvas.offcanvas-end` with `.offcanvas-header`, `.offcanvas-body` and, below
// the body, a footer that stays in view. Unlike a modal dialog it does not dim the page or trap the focus: the page stays usable and visible
// beside it (the page decides what to highlight there). Bootstrap's JavaScript is not used (it is not vendored). One drawer is open at a time;
// opening another one closes the first. It closes with its close button, with Escape (unless a dialog is open above it) and when the page
// route changes, because a drawer belongs to the page that opened it. The styles are in css/drawer.css.
//
// openDrawer({ title, subtitle?, icon?, body, footer?, onClose? }) returns { el, isOpen, setTitle, setBody, setFooter, close }:
//   title, subtitle  strings; setTitle(title, subtitle) replaces both
//   icon             an icon node shown before the title
//   body             a node (setBody replaces it and keeps the scroll position)
//   footer           a node or a list of nodes, always visible below the body (setFooter replaces them; empty hides the footer)
//   onClose          called once, however the drawer was closed (button, Escape, close(), a route change, another drawer replacing it)
import { h } from './dom.js';

// How many drawers were opened, to give each title a unique id for aria-labelledby.
let opened = 0;
// The drawer that is open now, as { handle, teardown }, or null.
let current = null;

// Whether a key press should close the drawer: Escape, not already handled by a control (a menu or a dialog that took it), not part of
// an input method's composition, and no modal dialog open above the page.
export function closesOnKey({ key, defaultPrevented = false, isComposing = false }, dialogOpen = false) {
  return key === 'Escape' && !defaultPrevented && !isComposing && !dialogOpen;
}

// Normalizes a footer argument (a node, a list of nodes or nothing) to a flat list of nodes.
export const footerNodes = footer => [footer ?? []].flat(Infinity).filter(n => n != null && n !== false);

// Opens the drawer (see the header for the shape) and returns its handle.
export function openDrawer({ title, subtitle, icon, body, footer, onClose } = {}) {
  current?.teardown();
  const titleId = `fl-drawer-title-${++opened}`;
  const titleNode = h('h2', { className: 'offcanvas-title fs-5 fl-drawer-title', id: titleId }, title ?? '');
  const subNode = h('div', { className: 'muted small fl-drawer-sub' }, subtitle ?? '');
  const bodyBox = h('div', { className: 'offcanvas-body fl-drawer-body' }, body);
  const footBox = h('div', { className: 'fl-drawer-foot' }, footerNodes(footer));
  const closeButton = h('button', { type: 'button', className: 'btn-close', ariaLabel: 'Close', title: 'Close (Esc)', onclick: () => handle.close() });
  const el = h('aside', { className: 'offcanvas offcanvas-end fl-drawer', tabIndex: -1 },
    h('div', { className: 'offcanvas-header fl-drawer-head' }, icon ?? null, h('div', { className: 'fl-drawer-titles' }, titleNode, subNode), closeButton),
    bodyBox, footBox);
  el.setAttribute('aria-labelledby', titleId);
  el.setAttribute('role', 'complementary');
  subNode.hidden = !subtitle;
  footBox.hidden = !footBox.childNodes.length;

  let alive = true;
  // Escape closes the drawer, unless something above it (a dialog, a menu) is dealing with the key.
  const onKey = e => { if (closesOnKey(e, Boolean(document.querySelector('dialog[open]')))) handle.close(); };
  // The route changed: the drawer belongs to the page that opened it.
  const onRoute = () => handle.close();
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', onRoute);
  // Removes the drawer from the page and calls onClose once.
  const teardown = () => {
    if (!alive) return;
    alive = false;
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', onRoute);
    document.body.classList.remove('fl-drawer-open');
    el.remove();
    if (current?.handle === handle) current = null;
    onClose?.();
  };

  const handle = {
    el,
    isOpen: () => alive,
    setTitle(next, sub) {
      titleNode.textContent = next ?? '';
      subNode.textContent = sub ?? '';
      subNode.hidden = !sub;
    },
    // Replaces the body; the scroll position stays where it was.
    setBody(node) {
      const top = bodyBox.scrollTop;
      bodyBox.replaceChildren(node);
      bodyBox.scrollTop = top;
    },
    setFooter(nodes) {
      const list = footerNodes(nodes);
      footBox.replaceChildren(...list);
      footBox.hidden = !list.length;
    },
    close: teardown,
    // The scrolling part, for a page that keeps the position across redraws.
    bodyEl: bodyBox,
  };
  current = { handle, teardown };
  document.body.append(el);
  document.body.classList.add('fl-drawer-open');
  // The slide-in runs when the class is added after the first layout.
  requestAnimationFrame(() => el.classList.add('show'));
  return handle;
}
