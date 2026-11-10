// Application shell: navigation pane, command bar, hash routing and the refresh loop.
// Pages are plain modules registered in js/pages/index.js (see the contract documented there).

import { h, byId } from './dom.js';
import { icon } from './icons.js';
import { ubus, hasSession, logout, clearSession, AuthError } from './ubus.js';
import { showLogin } from './login.js';
import { card } from './ui.js';
import { pages } from '../pages/index.js';

let timer = null;
let board = null;
const loadedCss = new Set();

// Page-specific stylesheets are loaded once, the first time the page is opened.
function ensureCss(href) {
  if (!href || loadedCss.has(href)) return;
  loadedCss.add(href);
  document.head.append(h('link', { rel: 'stylesheet', href }));
}

const defaultPageId = pages[0].id;

async function route() {
  if (!hasSession()) return showLogin(route);
  clearInterval(timer);

  const page = pages.find(p => p.id === location.hash.slice(1)) ?? pages[0];
  ensureCss(page.css);

  // The board info feeds the navigation header on every page; failing to read it is not fatal.
  if (!board) {
    try {
      board = await ubus('system', 'board');
    } catch (e) {
      if (e instanceof AuthError) return expire();
    }
  }

  const nav = h('nav', { className: 'nav-pane' },
    h('div', { className: 'brand' }, h('strong', {}, board ? board.hostname : 'Router'), h('span', {}, board ? board.model : '')),
    ...pages.map(p => h('a', { href: `#${p.id}`, className: `nav-link-fl ${p === page ? 'active' : ''}` }, icon(p.icon), p.label)),
    h('div', { className: 'nav-spacer' }),
    h('button', { type: 'button', className: 'nav-link-fl', onclick: signOut }, icon('box-arrow-right'), 'Sign out'));

  const results = h('main', {}, h('div', { className: 'text-center muted p-5' }, h('div', { className: 'spinner-border spinner-border-sm' })));
  const stamp = h('span', { className: 'muted small' });
  let data = null;

  const rerender = () => { if (data) results.replaceChildren(...page.view(data, rerender)); };
  const ctl = page.controls ? page.controls({ rerender, reload: () => load() }) : { nodes: [] };
  const cmdbar = h('header', { className: 'cmdbar' }, h('h1', {}, page.title ?? page.label), ...ctl.nodes, stamp);

  byId('app').replaceChildren(h('div', { className: 'shell' }, nav, h('div', { className: 'content' }, cmdbar, results)));

  async function load() {
    try {
      data = await page.load();
      ctl.update?.(data);
      rerender();
      stamp.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      if (e instanceof AuthError) return expire();
      results.replaceChildren(card(null, h('div', { className: 'card-body text-danger' }, e.message)));
    }
  }

  await load();
  timer = setInterval(() => { if (!page.isPaused?.()) load(); }, page.interval);
}

function expire() {
  clearInterval(timer);
  clearSession();
  showLogin(route, 'Session expired');
}

async function signOut() {
  clearInterval(timer);
  await logout();
  showLogin(route);
}

export function start() {
  if (!location.hash) location.hash = defaultPageId;
  addEventListener('hashchange', route);
  route();
}
