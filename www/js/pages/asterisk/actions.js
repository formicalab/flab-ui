// The Reload buttons at the right of the tab strip: Asterisk re-reads its configuration (flab.asterisk reload) after a confirmation. They are
// the only thing on this page that changes the PBX, and they run three fixed commands; calls in progress are not dropped.
import { h } from '../../core/dom.js';
import { can, ubus } from '../../core/ubus.js';
import { button, mono, muted, spinner } from '../../core/ui.js';
import { openDialog } from '../../core/modal.js';

// what -> the button, the command, and what the user is told before confirming.
const RELOADS = {
  core: { label: 'All', command: 'core reload', text: 'Asterisk re-reads all its configuration files: the dialplan, PJSIP, the logger and every module that supports a reload. Calls in progress go on.' },
  dialplan: { label: 'Dialplan', command: 'dialplan reload', text: 'Asterisk re-reads extensions.conf. Calls in progress keep the dialplan they started with; new calls use the new one.' },
  pjsip: { label: 'PJSIP', command: 'module reload res_pjsip.so', text: 'Asterisk re-reads pjsip.conf: endpoints, transports and registrations are rebuilt, so a registration with a provider is renewed.' },
};

// Asks, runs the reload, shows what Asterisk answered and then reads the page again.
function confirmReload(what, reload) {
  const r = RELOADS[what];
  const dialog = openDialog({
    title: `Reload ${r.label === 'All' ? 'the whole configuration' : r.label}`,
    body: h('div', {}, h('p', {}, r.text), h('p', { className: 'mb-0 small muted' }, 'It runs ', mono(`asterisk -rx "${r.command}"`), '.')),
    footer: [],
  });
  const close = button('Close', null, () => dialog.close(), 'btn-outline-secondary');
  const run = button('Reload', 'arrow-clockwise', async () => {
    dialog.setBody(h('div', {}, spinner(`Running ${r.command}…`)));
    dialog.setFooter(close);
    let reply;
    try {
      reply = await ubus('flab.asterisk', 'reload', { what });
    } catch (e) {
      reply = { ok: false, error: e.message };
    }
    dialog.setBody(reply.ok
      ? h('div', {}, h('p', { className: 'text-success mb-1' }, 'Done: Asterisk reloaded.'), reply.output ? h('pre', { className: 'small mb-0' }, reply.output) : muted('It had nothing to say.'))
      : h('div', { className: 'text-danger' }, reply.error ?? 'The reload failed.'));
    reload();
  }, 'btn-primary');
  dialog.setFooter([button('Cancel', null, () => dialog.close(), 'btn-outline-secondary'), run]);
}

// The control for the command bar, or null when the login may not call `reload`. update(data) greys the buttons when Asterisk is not running.
export function reloadControl(reload) {
  if (!can('flab.asterisk', 'reload')) return null;
  const buttons = Object.entries(RELOADS).map(([what, r]) => button(r.label, null, () => confirmReload(what, reload), 'btn-outline-secondary btn-sm', { title: `${r.command}: ${r.text}` }));
  const node = h('div', { className: 'cmd-reload' }, h('span', { className: 'muted small' }, 'Reload'), h('div', { className: 'btn-group btn-group-sm', role: 'group', ariaLabel: 'Reload Asterisk' }, buttons));
  return {
    node,
    update: data => { for (const b of buttons) b.disabled = data?.s?.state !== 'running'; },
  };
}
