// Application shell: navigation pane, command bar, hash routing and the refresh loop.
// Pages are plain modules registered in js/pages/index.js (see the contract documented there).

import { h, byId } from './dom.js';
import { icon } from './icons.js';
import { ubus, hasSession, logout, clearSession, sessionStatus, sessionNotice, AuthError } from './ubus.js';
import { showLogin } from './login.js';
import { ensureCurrent } from './freshness.js';
import { button, card, spinner } from './ui.js';
import { basePages, installedPages, aliases } from '../pages/index.js';

// Module-level state: the refresh interval of the open page, a function that refreshes the open page (for the
// tab becoming visible again), the number of the current route (a route that was superseded while it awaited the
// router must not install itself), the last `system board` reply and the stylesheets already added to <head>.
let timer = null;
let refresh = null;
let routeNo = 0;
let board = null;
let freshnessChecked = false;
const loadedCss = new Set();
let pages = basePages;
let modulesLoaded = false;

// Page-specific stylesheets are loaded once, the first time the page is opened. `css` may be one path or a list.
function ensureCss(hrefs) {
  for (const href of [].concat(hrefs ?? [])) {
    if (!href || loadedCss.has(href)) continue;
    loadedCss.add(href);
    document.head.append(h('link', { rel: 'stylesheet', href }));
  }
}

// The topmost line of the command bar on every page: the title on the left; on the right the Pause and Refresh
// buttons (where the page has them) followed by the "Updated" timestamp.
const topRow = (heading, buttons, stamp) =>
  h('div', { className: 'cmd-top' }, heading, h('div', { className: 'cmd-actions' }, ...buttons, stamp));

// The first registered page opens when the URL has no hash.
const defaultPageId = basePages[0].id;

// Renders the page named by the URL hash (shell, navigation, command bar) and starts its refresh loop.
// Runs on start and on every hashchange; shows the login form first when there is no session.
async function route() {
  clearInterval(timer);
  refresh = null;
  const mine = ++routeNo;
  // Invalidate pending imports and requests even when this navigation opens login or redirects an alias.
  const current = () => mine === routeNo;
  if (!hasSession()) return showLogin(route);
  // Once per page load, after sign-in (the check is an authenticated call): replace browser-cached files that
  // the router no longer has; when that reloads the page, this route is abandoned.
  if (!freshnessChecked) {
    freshnessChecked = true;
    if (await ensureCurrent()) return;
    if (!current()) return;
  }
  if (!modulesLoaded) {
    try {
      const reply = await ubus('flab.system', 'modules');
      pages = installedPages(reply?.modules);
      modulesLoaded = true;
    } catch (e) {
      if (e instanceof AuthError) return expire();
      pages = basePages;
    }
    if (!current()) return;
  }
  // A route that moved to another page (see `aliases` in pages/index.js): the hash is replaced, which runs this function again.
  // hasOwn: a hash such as #constructor must not resolve to an inherited Object property.
  const wanted = location.hash.slice(1);
  if (Object.hasOwn(aliases, wanted)) { location.replace(`#${aliases[wanted]}`); return; }
  const entry = pages.find(p => p.id === wanted) ?? pages[0];

  // The board info feeds the navigation header on every page, and is read on every route so a renamed router
  // shows its new hostname; failing to read it is not fatal (the last reply stays).
  try {
    const fresh = await ubus('system', 'board');
    if (current()) board = fresh;
  } catch (e) {
    if (current() && e instanceof AuthError) return expire();
  }
  if (!current()) return;

  // Pages marked nav: 'bottom' (Settings) sit under the spacer with Sign out; the rest fill the main list.
  const active = p => p.id === (entry.navId ?? entry.id);
  const link = p => h('a', {
    href: `#${p.id}`,
    className: `nav-link-fl ${active(p) ? 'active' : ''}`,
    ariaCurrent: active(p) ? 'page' : null,
  }, icon(p.icon), p.label);
  const nav = h('nav', { className: 'nav-pane', ariaLabel: 'Main navigation' },
    h('div', { className: 'brand' }, h('strong', {}, board ? board.hostname : 'OpenWrt'), h('span', {}, board ? board.model : '')),
    ...pages.filter(p => !p.nav).map(link),
    h('div', { className: 'nav-spacer' }),
    ...pages.filter(p => p.nav === 'bottom').map(link),
    h('button', { type: 'button', className: 'nav-link-fl', onclick: signOut }, icon('box-arrow-right'), 'Sign out'));

  const results = h('main', { id: 'page-content' }, h('div', { className: 'text-center muted p-5' }, spinner('Loading page…')));
  const stamp = h('span', { className: 'cmd-stamp muted small' });
  const cmdbar = h('header', { className: 'cmdbar' }, topRow(h('h1', {}, entry.title ?? entry.label), [], stamp));
  byId('app').replaceChildren(h('div', { className: 'shell' }, nav, h('div', { className: 'content' }, cmdbar, results)));

  let module;
  try {
    module = await entry.resolve();
  } catch (e) {
    if (!current()) return;
    results.replaceChildren(card(null, h('div', { className: 'card-body text-danger', role: 'alert' },
      `Unable to load ${entry.label}. Check your connection, then retry or reload the browser. `,
      button('Retry', null, route, 'btn-outline-secondary'),
      h('div', { className: 'small' }, e.message))));
    return;
  }
  if (!current()) return;
  entry.activate?.(module);
  const page = module.default;
  ensureCss(page.css);
  let data = null;

  const ctl = page.controls ? page.controls({ rerender, reload: () => load() }) : { nodes: [] };
  if (ctl.nodes.some(node => node?.role === 'tablist')) results.setAttribute('role', 'tabpanel');
  const heading = h('h1', {}, entry.title ?? entry.label);
  const summarySlot = h('div', { className: 'fl-summary-slot' });
  // Summary tiles sit above command controls on every page; individual pages keep only their detailed content.
  const isLead = node => node?.classList?.contains('cmd-pause') || node?.classList?.contains('cmd-refresh');
  cmdbar.replaceChildren(topRow(heading, ctl.nodes.filter(isLead), stamp), summarySlot, ...ctl.nodes.filter(node => !isLead(node)));
  const drawSummaries = (summaries = []) => summarySlot.replaceChildren(...summaries);
  // Redraws the page from the last data without polling; controls call it so filter changes apply instantly.
  function rerender() {
    if (!current() || !data) return;
    const active = document.activeElement;
    const selection = active && typeof active.selectionStart === 'number'
      ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection }
      : null;
    const nodes = [page.view(data, rerender)].flat(Infinity).filter(Boolean);
    const summaries = nodes.filter(node => node?.classList?.contains('fl-summary'));
    drawSummaries(summaries);
    results.replaceChildren(...nodes.filter(node => !node?.classList?.contains('fl-summary')));
    if (active?.isConnected) {
      active.focus({ preventScroll: true });
      if (selection && typeof active.setSelectionRange === 'function')
        active.setSelectionRange(selection.start, selection.end, selection.direction);
    }
  }

  // Polls the page once and redraws it. A failed poll shows the error in place of the content; an expired session
  // returns to the login form. Only the newest request counts: an older reply that arrives late (a slow router, an
  // explicit refresh during a poll) is dropped, as is any reply for a page that was left meanwhile. A reply to a
  // timer poll is also dropped when the page became paused while it was on its way (the user clicked into a form,
  // started an edit or pressed Pause): redrawing then would rebuild the form under the user and take the focus away.
  // The next poll after the page is unpaused refreshes it; an explicit reload (a save, Refresh) is always applied.
  let requests = 0;
  let loading = false;
  // One poll cycle: fetches the page data and redraws, unless a newer request or a navigation superseded it.
  async function load(polled = false) {
    if (!current()) return;
    const n = ++requests;
    loading = true;
    try {
      const fresh = await page.load();
      if (!current() || n !== requests) return;
      if (polled && page.isPaused?.()) return;
      data = fresh;
      ctl.update?.(data);
      rerender();
      stamp.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      if (!current() || n !== requests) return;
      if (e instanceof AuthError) return expire();
      if (polled && page.isPaused?.()) return;
      drawSummaries();
      results.replaceChildren(card(null, h('div', { className: 'card-body text-danger' }, e.message)));
    } finally {
      if (n === requests) loading = false;
    }
  }

  await load();
  if (!current()) return;
  // Pages may suspend polling (Pause button) without stopping the timer. A poll is also skipped while the previous
  // one is still running and while the tab is in the background; the tab refreshes as soon as it is shown again.
  const due = () => !loading && !document.hidden && !page.isPaused?.();
  // A page may give its period as a function (re-read before each poll): a timeout that schedules the next one, which `clearInterval` ends too.
  if (typeof page.interval === 'function') {
    const next = () => { timer = setTimeout(() => { if (due()) load(true); next(); }, page.interval()); };
    next();
  } else {
    timer = setInterval(() => { if (due()) load(true); }, page.interval);
  }
  refresh = () => { if (!loading && !page.isPaused?.()) load(true); };
}

// Stops polling, drops the stored session and returns to the login form with an explanation.
function expire() {
  ++routeNo;
  clearInterval(timer);
  refresh = null;
  clearSession();
  hideNotice();
  showLogin(route, 'Session expired');
}

// Ends the session on the router, then shows the login form (with `message` when the sign-out was not the user's
// own choice or the router could not be told to end the session).
async function signOut(message) {
  const mine = ++routeNo;
  clearInterval(timer);
  refresh = null;
  hideNotice();
  const { destroyed, idleLeftS } = await logout();
  if (mine !== routeNo) return;
  showLogin(route, typeof message === 'string' ? message : destroyed ? undefined
    : `Signed out in this browser, but the router could not be reached to end the session. It ends by itself after about ${Math.max(1, Math.ceil(idleLeftS / 60))} minutes without activity.`);
}

// The session notice: a fixed bar outside the page (the shell is rebuilt on every route). A session that is only
// close to its idle limit offers "Stay signed in", which makes a cheap call; one that nears its maximum age cannot
// be extended, so the user is told to finish.
let notice = null;
function hideNotice() { notice?.remove(); notice = null; }
function showNotice(info) {
  const text = info.kind === 'age'
    ? `This session reaches its maximum age in ${info.seconds} s. Finish your work; you will have to sign in again.`
    : `You will be signed out in ${info.seconds} s because of inactivity.`;
  if (!notice) {
    notice = h('div', { className: 'session-notice alert alert-warning', role: 'alert' });
    document.body.append(notice);
  }
  notice.replaceChildren(h('span', {}, text), info.kind === 'idle' ? button('Stay signed in', null, stayAlive, 'btn-warning') : null);
}

// Any call restarts rpcd's idle countdown.
async function stayAlive() {
  try {
    await ubus('system', 'board');
  } catch (e) {
    if (e instanceof AuthError) return expire();
  }
  checkSession();
}

// Runs every few seconds: ends a session that reached its maximum age, otherwise shows or hides the notice.
function checkSession() {
  const status = sessionStatus();
  if (status?.ageLeftS === 0) { hideNotice(); signOut('Session ended: it reached its maximum age.'); return; }
  const info = sessionNotice(status);
  if (info) showNotice(info); else hideNotice();
}

// Entry point: picks the default page, routes on hash changes, refreshes the open page when the tab comes back to
// the foreground, and renders the current page.
export function start() {
  if (!location.hash) location.hash = defaultPageId;
  addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh?.(); checkSession(); } });
  setInterval(checkSession, 5000);
  route();
}
