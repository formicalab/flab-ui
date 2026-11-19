// Configuration backup and restore for the System settings page.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { chevron } from '../../core/fold.js';
import { saveFile } from '../../core/download.js';
import { openDialog } from '../../core/modal.js';
import { can, ubus } from '../../core/ubus.js';
import { button, muted } from '../../core/ui.js';

const MAX_BACKUP = 16 * 1024 * 1024;
const UPLOAD_CHUNK = 32768;

const state = {
  busy: '',
  message: null,
  upload: null,
  open: false,
  // The progress line of the card on screen, updated in place while a transfer runs.
  status: null,
};

export const busy = () => Boolean(state.busy);

// Shows a new progress text during a transfer. The progress line is edited in place because a redraw of the whole page
// (with its long time zone list) after every 32 KiB chunk would be wasteful.
function progress(rerender, text) {
  state.busy = text;
  if (state.status?.isConnected) state.status.textContent = text;
  else rerender();
}

function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) {
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(text);
}

function decoded(data) {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function setMessage(rerender, kind, text) {
  state.message = { kind, text };
  rerender();
}

async function download(rerender) {
  state.busy = 'Creating backup…';
  state.message = null;
  rerender();
  let backup = null;
  try {
    backup = await ubus('flab.system', 'backup_create', {});
    if (!backup?.ok) throw new Error(backup?.error || 'The router could not create the backup.');
    const parts = [];
    let from = 0;
    let part = null;
    do {
      progress(rerender, `Downloading backup… ${from.toLocaleString()} / ${backup.size.toLocaleString()} bytes`);
      part = await ubus('flab.system', 'backup_download', { id: backup.id, from });
      if (!part?.ok) throw new Error(part?.error || 'The backup download failed.');
      if (!(part.length > 0) && !part.done) throw new Error('The backup download stopped making progress.');
      const bytes = decoded(part.data);
      if (bytes.length !== part.length) throw new Error('The router sent a damaged backup chunk.');
      parts.push(bytes);
      from += part.length;
    } while (!part.done);
    if (from !== backup.size) throw new Error('The downloaded backup is incomplete.');
    saveFile(backup.name, parts, 'application/gzip');
    await ubus('flab.system', 'backup_cancel', { id: backup.id }).catch(() => {});
    setMessage(rerender, 'ok', `Downloaded ${backup.name}. Keep it encrypted or in protected storage; it can contain passwords and private keys.`);
  } catch (err) {
    setMessage(rerender, 'error', err.message);
    if (backup?.id) await ubus('flab.system', 'backup_cancel', { id: backup.id }).catch(() => {});
  } finally {
    state.busy = '';
    rerender();
  }
}

async function chooseFile(file, rerender) {
  if (!file) return;
  if (!(file.size > 0) || file.size > MAX_BACKUP) {
    setMessage(rerender, 'error', `Choose a nonempty OpenWrt backup no larger than ${Math.floor(MAX_BACKUP / 1024 / 1024)} MiB.`);
    return;
  }
  state.busy = 'Uploading and checking backup…';
  state.message = null;
  rerender();
  if (state.upload) {
    const old = state.upload;
    state.upload = null;
    await ubus('flab.system', 'backup_cancel', { id: old.id }).catch(() => {});
  }
  let begun = null;
  try {
    begun = await ubus('flab.system', 'backup_begin', { size: file.size });
    if (!begun?.ok) throw new Error(begun?.error || 'The router could not start the upload.');
    let from = 0;
    while (from < file.size) {
      progress(rerender, `Uploading backup… ${Math.round(from / file.size * 100)}%`);
      const end = Math.min(from + UPLOAD_CHUNK, file.size);
      const bytes = new Uint8Array(await file.slice(from, end).arrayBuffer());
      const reply = await ubus('flab.system', 'backup_upload', {
        id: begun.id,
        from,
        total: file.size,
        data: base64(bytes),
      });
      if (!reply?.ok) throw new Error(reply?.error || 'The backup upload failed.');
      if (reply.from !== end) throw new Error('The router reported an unexpected upload offset.');
      from = end;
    }
    progress(rerender, 'Validating backup…');
    const inspected = await ubus('flab.system', 'backup_inspect', { id: begun.id });
    if (!inspected?.ok || !Array.isArray(inspected.files)) throw new Error(inspected?.error || 'The backup is invalid.');
    state.upload = { id: begun.id, name: file.name, size: file.size, files: inspected.files };
    setMessage(rerender, 'ok', `Backup checked: ${file.name}. Review the files below before restoring.`);
  } catch (err) {
    setMessage(rerender, 'error', err.message);
    if (begun?.id) await ubus('flab.system', 'backup_cancel', { id: begun.id }).catch(() => {});
  } finally {
    state.busy = '';
    rerender();
  }
}

function confirmRestore(rerender) {
  const upload = state.upload;
  if (!upload) return;
  let answered = false;
  let dlg;
  const close = () => dlg.close();
  dlg = openDialog({
    title: 'Restore configuration backup?',
    subtitle: upload.name,
    staticBackdrop: true,
    body: [
      h('p', {}, 'This replaces the router configuration with the selected OpenWrt backup and then reboots the router.'),
      h('p', {}, 'Keep a working backup and another way to reach the router. A full configuration restore has no automatic rollback if networking or credentials become unusable.'),
    ],
    footer: [
      button('Cancel', 'x-lg', close),
      button('Restore and reboot', 'arrow-counterclockwise', async () => {
        if (answered) return;
        answered = true;
        state.busy = 'Restoring configuration…';
        dlg.close();
        rerender();
        try {
          const reply = await ubus('flab.system', 'backup_restore', { id: upload.id });
          if (!reply?.ok) throw new Error(reply?.error || 'The restore was not scheduled.');
          state.upload = null;
          setMessage(rerender, 'ok', 'Configuration restore accepted. The router will restore the backup and reboot now; this page may disconnect.');
        } catch (err) {
          state.busy = '';
          setMessage(rerender, 'error', err.message);
        }
      }, 'btn-danger'),
    ],
  });
}

function review(upload) {
  return h('div', { className: 'mt-3' },
    h('div', { className: 'fw-semibold' }, `${upload.name} · ${upload.files.length} files · ${upload.size.toLocaleString()} bytes`),
    h('details', { className: 'mt-2' },
      h('summary', {}, 'Review archive contents'),
      h('pre', { className: 'small mb-0 mt-2 backup-files' }, upload.files.join('\n'))));
}

export function backupCard(rerender) {
  const allowed = can('flab.system', 'backup_create') && can('flab.system', 'backup_restore');
  const body = h('div', { className: 'card-body' },
    h('p', { className: 'muted' }, 'Backups contain /etc configuration, installed-package selections and other files saved by OpenWrt. The unencrypted archive can contain passwords and private keys.'),
    h('div', { className: 'd-flex flex-wrap gap-2 align-items-center' },
      button(state.busy ? 'Working…' : 'Create backup', 'download', () => download(rerender), 'btn-brand', {
        disabled: Boolean(state.busy) || !allowed,
      }),
      h('label', { className: `btn btn-sm btn-fl${state.busy || !allowed ? ' disabled' : ''}` },
        icon('upload'), ' Choose backup to restore',
        h('input', {
          type: 'file',
          accept: '.tar.gz,.gz,application/gzip',
          className: 'visually-hidden',
          disabled: Boolean(state.busy) || !allowed,
          onchange: e => chooseFile(e.target.files?.[0], rerender),
        }))),
    state.busy ? h('div', { className: 'd-flex align-items-center gap-2 mt-3 text-primary', role: 'status', ariaLive: 'polite' },
      h('span', { className: 'spinner-border spinner-border-sm', ariaHidden: 'true' }),
      state.status = h('span', {}, state.busy)) : null,
    !allowed ? muted('This login needs the backup permissions added to its rpcd ACL. Sign out and in again after upgrading flab-ui.') : null,
    state.upload ? [
      review(state.upload),
      h('div', { className: 'd-flex gap-2 mt-3' },
        button('Discard upload', 'trash', async () => {
          try {
            await ubus('flab.system', 'backup_cancel', { id: state.upload.id });
            state.upload = null;
            rerender();
          } catch (err) {
            setMessage(rerender, 'error', err.message);
          }
        }, 'btn-fl', { disabled: Boolean(state.busy) }),
        button('Restore and reboot…', 'arrow-counterclockwise', () => confirmRestore(rerender), 'btn-danger', { disabled: Boolean(state.busy) })),
    ] : null,
    state.message ? h('div', {
      className: `alert alert-${state.message.kind === 'error' ? 'danger' : 'success'} alert-dismissible mt-3 mb-0`,
      role: 'alert',
    }, state.message.text,
    h('button', {
      type: 'button',
      className: 'btn-close',
      ariaLabel: 'Dismiss',
      onclick: () => { state.message = null; rerender(); },
    })) : null);
  return h('details', {
    className: 'card settings-disclosure',
    open: state.open,
    ontoggle: e => { state.open = e.currentTarget.open; },
  },
    h('summary', { className: 'card-header' }, chevron(), icon('gear'), h('span', {}, 'Configuration backup & restore')),
    body);
}
