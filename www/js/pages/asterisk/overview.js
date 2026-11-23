// Overview tab: is the daemon up, the key counts, what needs attention, the daemon card and the recent warnings and errors of the log.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, chip, emptyState, healthBanner, kv, tile, tiles, table, button, muted, mono } from '../../core/ui.js';
import { disclosure } from '../../core/fold.js';
import { fmtSpan } from '../../core/format.js';
import { registrationKind, endpointKind, countdown } from './pjsipmodel.js';
import { go } from './state.js';

// What the commonly seen modules are for, as a tooltip on the module chips; anything else shows its own description.
const MODULE_GROUPS = [
  [/^chan_/, 'channel driver'], [/^res_pjsip/, 'PJSIP'], [/^pbx_/, 'dialplan engine'], [/^app_/, 'dialplan application'],
  [/^func_/, 'dialplan function'], [/^codec_/, 'codec'], [/^format_/, 'file format'], [/^bridge_/, 'bridging'], [/^res_/, 'resource'],
];

// Chip level for a module group, to tell the families apart at a glance.
const moduleLevel = name => /^(chan_|pbx_)/.test(name) ? 'good' : /^res_pjsip/.test(name) ? 'info' : /^(app_|func_)/.test(name) ? 'fair' : '';

// The state of the daemon as a badge.
function stateBadge(s) {
  if (s.state === 'running') return badge('running', 'success');
  if (s.state === 'unreachable') return badge('not answering', 'warning');
  if (s.state === 'disabled') return badge('disabled', '');
  if (s.state === 'not_installed') return badge('not installed', '');
  return badge('stopped', 'danger');
}

// "4d 20h" style uptime with the start date.
function uptimeText(s) {
  if (s.uptime == null) return '–';
  return `${fmtSpan(s.uptime)} (since ${new Date(s.started * 1000).toLocaleString()})`;
}

// The summary tiles.
function summaryTiles(s) {
  if (s.state !== 'running') {
    return tiles(tile('Asterisk', { stopped: 'Stopped', disabled: 'Disabled', unreachable: 'Not answering' }[s.state] ?? '–',
      s.state === 'disabled' ? 'enabled is 0 in /etc/config/asterisk' : s.state === 'unreachable' ? 'process alive, no control socket' : 'not running',
      s.state === 'disabled' ? '' : 'text-danger'));
  }
  const sum = s.summary;
  const regOk = sum.registrations === 0 || sum.registered === sum.registrations;
  const epDown = sum.endpoints - sum.available;
  const changed = s.changed_files.length;
  return tiles(
    tile('Asterisk', `${s.version ?? '?'}`, `up ${fmtSpan(s.uptime)}`, 'text-success'),
    tile('Registrations', sum.registrations ? `${sum.registered} / ${sum.registrations}` : '–', sum.registrations ? (regOk ? 'all registered' : `${sum.registrations - sum.registered} not registered`) : 'none configured', sum.registrations ? (regOk ? 'text-success' : 'text-danger') : ''),
    tile('Endpoints', `${sum.available} / ${sum.endpoints}`, epDown ? `${epDown} unavailable` : 'all available', epDown ? 'text-warning' : ''),
    tile('Calls', String(s.calls.active ?? 0), `${s.calls.processed ?? 0} since start`),
    tile('Memory', s.rss_kb ? `${(s.rss_kb / 1024).toFixed(1)} MiB` : '–', s.pid ? `process ${s.pid}` : ''),
    tile('Configuration', changed ? `${changed} changed` : 'loaded', changed ? 'reload needed' : `reloaded ${fmtSpan((s.now - s.reloaded))} ago`, changed ? 'text-warning' : ''));
}

// The daemon card: status, version, process, what is exposed, logging, directories and the loaded modules.
function daemonCard(s) {
  if (s.state === 'not_installed') return emptyState('Asterisk is not installed on this router. Install the asterisk packages (asterisk, asterisk-pjsip and the modules you need) to use this page.');
  if (s.state !== 'running') {
    const text = s.state === 'disabled' ? 'Asterisk is not running because it is disabled: /etc/config/asterisk has option enabled 0.'
      : s.state === 'unreachable' ? 'The Asterisk process is alive, but its control socket does not answer.'
        : 'Asterisk is not running. The service is enabled, so it should be: check the system log.';
    return card([icon('cpu'), 'Asterisk daemon'], h('div', { className: `card-body ${s.state === 'stopped' ? 'text-danger' : 'muted'}` }, text));
  }
  const exposed = (on, name) => on ? badge(`${name} enabled`, 'warning') : badge(`${name} off`, '');
  const settings = s.settings, dir = s.directories;
  const body = h('div', { className: 'card-body ast-daemon' },
    kv([
      ['Status', stateBadge(s)],
      ['Version', `Asterisk ${s.version ?? '?'}${s.pjproject ? ` · PJPROJECT ${s.pjproject}` : ''}`],
      ['Uptime', uptimeText(s)],
      ['Last reload', s.reloaded ? `${fmtSpan(s.now - s.reloaded)} ago` : '–'],
      ['Process', s.pid ? h('span', {}, mono(String(s.pid)), ` · ${(s.rss_kb / 1024).toFixed(1)} MiB resident`) : '–'],
      ['Calls', `${s.calls.active ?? 0} active · ${s.calls.processed ?? 0} processed since start`],
      ['Call limit', settings.max_calls == null ? 'not set' : String(settings.max_calls)],
      ['Open file limit', settings.max_open_files == null ? '–' : String(settings.max_open_files)],
      ['Entity ID', settings.entity_id ? mono(settings.entity_id) : '–'],
    ]),
    kv([
      ['Management', h('span', { className: 'ast-badges' }, exposed(s.subsystems.ami, 'AMI'), exposed(s.subsystems.ami_http, 'AMI over HTTP'), exposed(s.subsystems.realtime, 'Realtime'))],
      ['Call records (CDR)', s.cdr.enabled ? badge(s.cdr.backends.length ? `${s.cdr.backends.length} backend${s.cdr.backends.length > 1 ? 's' : ''}` : 'no backend: nothing is stored', s.cdr.backends.length ? 'success' : '') : badge('off', '')],
      ['Logging', s.logger.length ? h('div', {}, s.logger.map(l => h('div', {}, mono(l.channel), ' ', muted(`${l.type} · ${l.status === 'Enabled' ? l.levels.join(' ').toLowerCase() : 'disabled'}`)))) : muted('no channel')],
      ['Configuration', mono(dir.config ?? '–')],
      ['Run directory', mono(dir.run ?? '–')],
      ['Log directory', mono(dir.log ?? '–')],
      ['Spool directory', mono(dir.spool ?? '–')],
    ]));
  const modules = disclosure({
    cls: 'mt-3', summary: `${s.modules.length} loaded modules`,
    body: h('div', { className: 'chips mt-2' }, s.modules.map(m => chip(m.name.replace(/\.so$/, ''), moduleLevel(m.name), `${m.desc}${m.use ? ` · in use ${m.use}×` : ''} · ${MODULE_GROUPS.find(([re]) => re.test(m.name))?.[1] ?? 'module'}`))),
  });
  return card([icon('cpu'), 'Asterisk daemon'], h('div', {}, body, h('div', { className: 'px-3 pb-3' }, modules)));
}

// The registrations and endpoints at a glance, with a way into the PJSIP tab.
function glance(s) {
  const sum = s.summary;
  if (!s.pjsip_loaded) return null;
  const regs = sum.registrations_list.map(r => [mono(r.name), badge(r.status, registrationKind(r.status)), r.expires != null ? muted(`renews ${countdown(r.expires)}`) : muted('–')]);
  const eps = sum.endpoints_list.map(e => [mono(e.name), badge(e.state, endpointKind({ state: e.state, role: null })), e.channels ? `${e.channels} call${e.channels > 1 ? 's' : ''}` : muted('idle')]);
  const open = button('Open PJSIP', 'arrow-right', () => go('pjsip'), 'btn-outline-secondary btn-sm');
  return h('div', { className: 'ast-glance' },
    card([icon('telephone'), 'Outbound registrations', h('span', { className: 'ms-auto' }, open)], regs.length ? table(['Registration', 'State', 'Renews'], regs) : h('div', { className: 'card-body muted' }, 'No outbound registration is configured.')),
    card([icon('person'), 'Endpoints'], eps.length ? table(['Endpoint', 'State', 'Calls'], eps) : h('div', { className: 'card-body muted' }, 'No endpoint is configured.')));
}

// The recent warnings and errors from /var/log/asterisk/messages.log.
function problemsCard(s) {
  const p = s.problems;
  if (!p.available) return card([icon('journal-text'), 'Recent warnings and errors'], h('div', { className: 'card-body muted' }, 'Asterisk writes no messages.log, so there is nothing to show. Enable a "messages" file channel in logger.conf to see warnings and errors here.'));
  const levelKind = { error: 'danger', fatal: 'danger', warning: 'warning', notice: 'info' };
  const rows = [...p.entries].reverse().map(e => [muted(e.time), badge(e.level, levelKind[e.level] ?? ''), mono(e.source), e.text]);
  return card([icon('journal-text'), 'Recent warnings and errors'],
    rows.length ? h('div', { className: 'ast-log' }, table(['Time', 'Level', 'Source', 'Message'], rows)) : h('div', { className: 'card-body muted' }, 'The log holds no warning or error.'));
}

// The Overview tab's nodes for a reply of `flab.asterisk status`.
export function overviewView(s) {
  if (s.state === 'not_installed') return [daemonCard(s)];
  return [
    summaryTiles(s),
    healthBanner(s.findings, 'Asterisk looks healthy.'),
    daemonCard(s),
    s.state === 'running' ? glance(s) : null,
    problemsCard(s),
  ];
}
