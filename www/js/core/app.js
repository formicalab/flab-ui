// Application shell: navigation pane, command bar, hash routing and the refresh loop.
// Pages are plain modules registered in js/pages/index.js (see the contract documented there).

import { h, byId } from './dom.js';
import { icon } from './icons.js';
import { ubus, hasSession, logout, clearSession, AuthError } from './ubus.js';
import { showLogin } from './login.js';
import { ensureCurrent } from './freshness.js';
import { button, card } from './ui.js';
import { pages, aliases } from '../pages/index.js';

// Module-level state: the refresh interval of the open page, a function that refreshes the open page (for the
// tab becoming visible again), the number of the current route (a route that was superseded while it awaited the
// router must not install itself), the last `system board` reply and the stylesheets already added to <head>.
let timer = null;
let refresh = null;
let routeNo = 0;
let board = null;
let freshnessChecked = false;
const loadedCss = new Set();

// Page-specific stylesheets are loaded once, the first time the page is opened. `css` may be one path or a list.
function ensureCss(hrefs) {
  for (const href of [].concat(hrefs ?? [])) {
    if (!href || loadedCss.has(href)) continue;
    loadedCss.add(href);
    document.head.append(h('link', { rel: 'stylesheet', href }));
  }
}

// The first registered page opens when the URL has no hash.
const defaultPageId = pages[0].id;

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
  // A route that moved to another page (see `aliases` in pages/index.js): the hash is replaced, which runs this function again.
  const alias = aliases[location.hash.slice(1)];
  if (alias) { location.replace(`#${alias}`); return; }
  const entry = pages.find(p => p.id === location.hash.slice(1)) ?? pages[0];

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
  const link = p => h('a', { href: `#${p.id}`, className: `nav-link-fl ${p === entry ? 'active' : ''}` }, icon(p.icon), p.label);
  const nav = h('nav', { className: 'nav-pane' },
    h('div', { className: 'brand' }, h('strong', {}, board ? board.hostname : 'Router'), h('span', {}, board ? board.model : '')),
    ...pages.filter(p => p.nav !== 'bottom').map(link),
    h('div', { className: 'nav-spacer' }),
    ...pages.filter(p => p.nav === 'bottom').map(link),
    h('button', { type: 'button', className: 'nav-link-fl', onclick: signOut }, icon('box-arrow-right'), 'Sign out'));

  const results = h('main', {}, h('div', { className: 'text-center muted p-5' }, h('div', { className: 'spinner-border spinner-border-sm' })));
  const stamp = h('span', { className: 'muted small' });
  const cmdbar = h('header', { className: 'cmdbar' }, h('h1', {}, entry.label), stamp);
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

  // Redraws the page from the last data without polling; controls call it so filter changes apply instantly.
  const rerender = () => { if (current() && data) results.replaceChildren(...page.view(data, rerender)); };
  const ctl = page.controls ? page.controls({ rerender, reload: () => load() }) : { nodes: [] };
  cmdbar.replaceChildren(h('h1', {}, page.title ?? page.label), ...ctl.nodes, stamp);

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
  showLogin(route, 'Session expired');
}

// Ends the session on the router, then shows the login form.
async function signOut() {
  const mine = ++routeNo;
  clearInterval(timer);
  refresh = null;
  await logout();
  if (mine === routeNo) showLogin(route);
}

// Entry point: picks the default page, routes on hash changes, refreshes the open page when the tab comes back to
// the foreground, and renders the current page.
export function start() {
  if (!location.hash) location.hash = defaultPageId;
  addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh?.(); });
  route();
}
