// The smaller cards of the DNS page: Listening and configuration, Upstream from the WAN, Activity and Try it.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, meter } from '../../core/ui.js';
import { fmtNum, fmtSpan } from '../../core/format.js';
import { fieldRow, legend } from '../../core/forms.js';
import { openTool } from '../toolbox/index.js';
import { activity, configAreas, configDraft, engineName, fmtPct, listenerChips, subject } from './model.js';

//#region Listening and configuration

// The title of a part of the card: "Listening on" or "Configuration".
const partTitle = text => h('div', { className: 'dns-part' }, text);

// The sockets the resolver accepts queries on, one chip per address and port with its protocols. The wildcard address
// is marked "all addresses".
function listeningPart(data, chips) {
  const both = data.engines?.unbound?.running && data.engines?.dnsmasq?.running;
  return chips.length
    ? h('div', {},
      h('div', { className: 'dns-legend' }, '0.0.0.0 and [::] mean every IPv4 or IPv6 address of the router; any other address is one interface only. Clients reach the resolver on these.'),
      h('div', { className: 'dns-pad chips' }, chips.map(c => h('span', { className: 'dns-sock' },
        h('span', { className: 'mono' }, c.text),
        h('span', { className: 'dns-proto' }, c.protos.join('/')),
        c.wildcard ? badge('all addresses', 'info') : null,
        both ? badge(engineName(c.engine), '') : null))))
    : h('div', { className: 'dns-pad muted' }, data.engine ? 'The resolver is running, but no listening socket was found for it.' : 'No resolver is listening: nothing answers DNS queries on this router.');
}

// The shape of the form for an editing page: a draft of the values (one per option, from configDraft) and what is allowed.
// Nothing is editable yet, so `canEdit` is false and every control is disabled; the settings can be made writable by
// setting it from the login's permissions, keeping the draft across the redraws of the poll (the page's `isPaused`
// already stops them while a control has the focus), and adding a plan of UCI operations and a save with the review
// banner, as the System settings and DHCP pages do (core/editpage.js). The controls and the field tables need no change.
const canEdit = false;

// The control for one option, connected to the draft.
function control(f, draft) {
  return fieldRow(f, {
    id: f.key,
    get: () => draft[f.key],
    set: v => { draft[f.key] = v; },
    disabled: !canEdit,
    touched: () => {},
    redraw: () => {},
    register: () => {},
  });
}

// Which areas are open, kept across the redraws of the poll (an area missing here starts as the schema says).
const opened = new Map();

// The resolver's options as the shared controls, in collapsible areas (General first, then Security and privacy, then the
// rest), each with its sections: a checkbox for a yes/no option, a drop-down for a fixed set of values, a number input for a
// number, a text box for a name and a list for several values. A folded area still shows its state in one line.
function configPart(data, e, file) {
  const draft = configDraft(data);
  const area = a => h('details', { className: 'dns-area', open: opened.get(a.id) ?? a.open, ontoggle: ev => opened.set(a.id, ev.target.open) },
    h('summary', {}, h('span', { className: 'dns-chevron' }), h('span', { className: 'dns-area-title' }, a.title), h('span', { className: 'dns-area-count muted' }, `${a.count} options`), a.summary ? h('span', { className: 'dns-area-sum muted' }, a.summary) : null),
    h('div', { className: 'dns-area-body' },
      h('p', { className: 'muted small dns-area-legend' }, a.legend),
      a.sections.map(s => h('section', { className: 'dns-sec' },
        s.title ? h('h4', { className: 'dns-sec-title' }, s.title) : null,
        h('div', { className: 'set-fields' }, s.fields.map(f => control(f, draft)))))));
  return h('div', {},
    legend([
      `Read only for now: this page shows the settings of ${engineName(e)} but cannot change them. Edit ${file} and restart the service to change one.`,
      'A box that is empty, or a drop-down that says "Default", is not set in the file: the default shown applies.']),
    h('div', { className: 'dns-areas' }, configAreas(data).map(area)));
}

// The full-width card at the top: where the resolver listens and how it is configured. Without a resolver there is
// nothing to configure, and the card is only the listening part.
export function resolverCard(data) {
  const chips = listenerChips(data);
  const e = subject(data);
  const file = e === 'unbound' ? '/etc/config/unbound' : '/etc/config/dhcp';
  const listening = chips.length ? `${chips.length} address${chips.length === 1 ? '' : 'es'} and port${chips.length === 1 ? '' : 's'}${data.truncated?.listeners ? ' (cut)' : ''}` : 'not listening';
  if (!e) return card([icon('broadcast'), 'Listening on', h('span', { className: 'sub' }, listening)], listeningPart(data, chips));
  return card([icon('broadcast'), 'Listening and configuration', h('span', { className: 'sub' }, `${listening} · ${engineName(e)} · ${file}${data.engine ? '' : ' · not running'}`)],
    h('div', {}, partTitle('Listening on'), listeningPart(data, chips), h('div', { className: 'dns-top' }, partTitle('Configuration'), configPart(data, e, file))));
}

//#endregion

//#region Upstream from the WAN

// The resolvers the WAN connection handed to the router (resolv.conf.auto).
export function upstreamCard(data) {
  const list = data.upstream ?? [];
  let note = 'The resolvers the WAN connection (DHCP, PPP or router advertisements) gave this router. Whether the resolver asks them depends on its configuration.';
  if (data.upstream_used === false) note = 'The WAN connection gave these resolvers, but dnsmasq ignores them (option noresolv).';
  else if (data.upstream_used === true) note = 'The resolvers the WAN connection (DHCP, PPP or router advertisements) gave this router. dnsmasq asks them in addition to its own servers.';
  const body = h('div', {},
    h('div', { className: 'dns-legend' }, note),
    list.length ? h('div', { className: 'dns-pad dns-servers' }, list.map(a => h('span', { className: 'dns-server' }, h('span', { className: 'mono' }, a))))
      : h('div', { className: 'dns-pad muted' }, 'The WAN gave no resolver (or the router has no WAN lease).'));
  return card([icon('cloud'), 'Upstream from the WAN', h('span', { className: 'sub' }, `${list.length} server${list.length === 1 ? '' : 's'}`)], body);
}

//#endregion

//#region Activity

// One row of the counters table: the label with its explanation, the value and a share bar when it has one.
function activityRow(r) {
  return h('tr', {},
    h('td', {}, h('div', {}, r.label), r.hint ? h('div', { className: 'dns-hint muted' }, r.hint) : null),
    h('td', { className: 'dns-num' }, h('strong', {}, fmtNum(r.value))),
    h('td', { className: 'dns-share' }, r.fraction != null
      ? h('div', { className: 'dns-bar' }, meter(Math.min(1, r.fraction), 1, r.level || 'good'), h('span', {}, fmtPct(r.fraction * 100)))
      : null));
}

// A counters table with its header.
const activityTable = (head, rows) => h('div', { className: 'grid-wrap' }, h('table', { className: 'table dns-act' },
  h('thead', {}, h('tr', {}, h('th', {}, head), h('th', { className: 'dns-num' }, 'Count'), h('th', {}, 'Share'))),
  h('tbody', {}, rows.map(activityRow))));

// The engine's counters (and, for Unbound with extended statistics, the answer codes).
export function activityCard(data) {
  const a = activity(data);
  const sub = a.since != null ? `since the resolver started ${fmtSpan(a.since)} ago` : '';
  let body;
  if (!a.rows.length) body = h('div', { className: 'card-body muted' }, a.note);
  else {
    const hint = a.codes.length ? null : data.engine === 'unbound' ? h('div', { className: 'dns-pad muted' }, "Answer codes (NOERROR, NXDOMAIN, SERVFAIL…) are not counted: set option extended_stats '1' in /etc/config/unbound to see them.") : null;
    const second = a.codes.length ? activityTable('Answer code', a.codes) : hint;
    body = h('div', {},
      h('div', { className: 'dns-legend' }, a.note),
      h('div', { className: `dns-act-grid${second ? '' : ' one'}` }, activityTable('Counter', a.rows), second));
  }
  return card([icon('activity'), 'Activity', sub ? h('span', { className: 'sub' }, sub) : null], body);
}

//#endregion

//#region Try it

// A name to look up through the Toolbox: "Look up" runs the DNS lookup tool, "Compare resolvers" asks several servers and
// compares them. Both open the Toolbox with the name filled in. An empty name is refused here, with a hint.
export function tryCard(state) {
  const hint = h('div', { className: 'dns-try-hint muted' }, '');
  const input = h('input', {
    className: 'form-control form-control-sm dns-input', type: 'text', placeholder: 'example.com', value: state.host, autocomplete: 'off', spellcheck: false,
    oninput: e => { state.host = e.target.value; hint.textContent = ''; },
    onkeydown: e => { if (e.key === 'Enter') go('dns'); },
  });
  // Opens the Toolbox with the tool and the name typed.
  function go(tool) {
    const host = state.host.trim();
    if (!host) { hint.textContent = 'Type a name to look up first.'; input.focus(); return; }
    openTool(tool, host);
  }
  const body = h('div', { className: 'card-body dns-field' },
    h('div', { className: 'dns-legend dns-flush' }, 'Opens the Toolbox and runs the tool on the router. "Look up" asks the router\'s own resolver; "Compare resolvers" asks it and the others side by side and times them.'),
    h('div', { className: 'dns-try' }, input,
      h('button', { type: 'button', className: 'btn btn-sm btn-brand', onclick: () => go('dns') }, icon('search'), 'Look up'),
      h('button', { type: 'button', className: 'btn btn-sm btn-fl', onclick: () => go('compare') }, icon('arrow-left-right'), 'Compare resolvers')),
    hint);
  return card([icon('search'), 'Try it'], body);
}

//#endregion
