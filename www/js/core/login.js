// Sign-in screen: a branded hero next to the form, over a faint network motif. Everything is inline SVG and
// CSS, so there is nothing to download and it works offline.

import { h, byId } from './dom.js';
import { icon } from './icons.js';
import { login } from './ubus.js';

// The logo: a router with antennas, status LEDs and Wi-Fi arcs on a gradient tile.
const LOGO = `<svg viewBox="0 0 64 64" width="76" height="76" aria-hidden="true">
  <defs><linearGradient id="login-logo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4cc2ff"/><stop offset="1" stop-color="#7a5cff"/></linearGradient></defs>
  <rect width="64" height="64" rx="16" fill="url(#login-logo)"/>
  <g stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"><path d="M19 27 15 13"/><path d="M45 27 49 13"/></g>
  <rect x="9" y="26" width="46" height="18" rx="6" fill="#fff"/>
  <circle cx="19" cy="35" r="2.7" fill="#2dd4a0"/><circle cx="27.5" cy="35" r="2.7" fill="#4cc2ff"/><circle cx="36" cy="35" r="2.7" fill="#ffb84d"/>
  <path d="M43 33.5h8M43 37.5h5" stroke="#7a5cff" stroke-width="2.4" stroke-linecap="round"/>
  <g stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none"><path d="M22 51c5.5-4.5 14.5-4.5 20 0"/><path d="M27 55.5c3-2 7-2 10 0"/></g>
</svg>`;

// A scatter of nodes joined by lines, drawn behind the card. Purely decorative.
const NODES = [[90, 90], [260, 160], [120, 330], [330, 430], [520, 90], [690, 210], [610, 400], [760, 540], [440, 280], [60, 520], [250, 560]];
const LINKS = [[0, 1], [1, 4], [4, 5], [1, 8], [8, 5], [8, 3], [2, 1], [2, 3], [3, 6], [6, 5], [6, 7], [9, 2], [9, 10], [10, 3]];
const MOTIF = `<svg viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <g class="links">${LINKS.map(([a, b]) => `<line x1="${NODES[a][0]}" y1="${NODES[a][1]}" x2="${NODES[b][0]}" y2="${NODES[b][1]}"/>`).join('')}</g>
  <g class="nodes">${NODES.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 3 === 0 ? 7 : 5}" style="animation-delay:${(i * 0.7).toFixed(1)}s"/>`).join('')}</g>
</svg>`;

// Static markup only (the strings above), never router data.
const svgBox = (cls, markup) => {
  const el = h('div', { className: cls });
  el.innerHTML = markup;
  return el;
};

// An input with an icon in front, as one control.
const field = (iconName, input, ...after) => h('div', { className: 'login-field' }, icon(iconName, 18), input, ...after);

// The sign-in screen: builds the hero and the form, signs in on submit and calls `onSuccess`; a failed attempt
// shows the screen again with `message` (also used for "Session expired").
export function showLogin(onSuccess, message) {
  const user = h('input', { className: 'form-control', name: 'username', value: 'root', autocomplete: 'username', placeholder: 'User name' });
  const pass = h('input', { className: 'form-control', name: 'password', type: 'password', autocomplete: 'current-password', autofocus: true, placeholder: 'Password' });

  // Not a submit button, so the form still has exactly one.
  const reveal = h('button', { type: 'button', className: 'login-reveal', title: 'Show or hide the password' }, icon('eye', 18));
  reveal.setAttribute('aria-label', 'Show or hide the password');
  reveal.onclick = () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    reveal.replaceChildren(icon(show ? 'eye-slash' : 'eye', 18));
    pass.focus();
  };

  const submit = h('button', { type: 'submit', className: 'btn btn-brand login-submit' }, 'Sign in', icon('arrow-right', 18));
  const form = h('form', { className: 'login-form' },
    h('div', { className: 'login-head' }, h('h1', {}, 'Welcome back'), h('p', { className: 'muted' }, 'Sign in to manage this router.')),
    message ? h('div', { className: 'login-error', role: 'alert' }, icon('exclamation-triangle', 18), message) : null,
    h('label', {}, h('span', { className: 'form-label' }, 'User name'), field('person', user)),
    h('label', {}, h('span', { className: 'form-label' }, 'Password'), field('key', pass, reveal)),
    submit,
    h('div', { className: 'login-note muted small' }, icon('shield-check', 14), 'Sign in with the router login. The session ends when you close this tab.'));

  form.onsubmit = async ev => {
    ev.preventDefault();
    submit.disabled = true;
    try {
      await login(user.value, pass.value);
      onSuccess();
    } catch (e) {
      // A refused login is a ubus "permission denied"; anything else (router unreachable, no session storage) is reported as it is.
      showLogin(onSuccess, e.denied || !e.message ? 'Sign-in failed. Check the user name and password.' : e.message);
    }
  };

  const hero = h('div', { className: 'login-hero' },
    svgBox('login-logo', LOGO),
    h('h2', {}, 'OpenWrt'),
    h('div', { className: 'login-host' }, icon('hdd-stack', 14), location.hostname || 'this router'));

  byId('app').replaceChildren(h('div', { className: 'login' },
    svgBox('login-motif', MOTIF),
    h('div', { className: 'login-card' }, hero, form)));
  pass.focus();
}
