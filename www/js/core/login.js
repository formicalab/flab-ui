// Sign-in screen.

import { h, byId } from './dom.js';
import { login } from './ubus.js';

export function showLogin(onSuccess, message) {
  const user = h('input', { className: 'form-control', name: 'username', value: 'flab', autocomplete: 'username' });
  const pass = h('input', { className: 'form-control', name: 'password', type: 'password', autocomplete: 'current-password', autofocus: true });
  const form = h('form', { className: 'd-grid gap-3' },
    h('div', {}, h('h1', { className: 'h4 mb-1' }, 'Sign in'), h('div', { className: 'muted' }, 'Router administration')),
    h('div', {}, h('label', { className: 'form-label' }, 'User name'), user),
    h('div', {}, h('label', { className: 'form-label' }, 'Password'), pass),
    h('button', { type: 'submit', className: 'btn btn-brand' }, 'Sign in'),
    message ? h('div', { className: 'text-danger' }, message) : null);

  form.onsubmit = async ev => {
    ev.preventDefault();
    try {
      await login(user.value, pass.value);
      onSuccess();
    } catch {
      showLogin(onSuccess, 'Sign-in failed. Check the user name and password.');
    }
  };
  byId('app').replaceChildren(h('div', { className: 'login' }, h('div', { className: 'card' }, form)));
}
