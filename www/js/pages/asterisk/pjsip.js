// PJSIP tab: outbound registrations, a signalling diagram, the endpoints (with a side panel for one), contacts, transports and active channels.
import { h, onActivate } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { ubus } from '../../core/ubus.js';
import { badge, card, chip, emptyState, kv, mono, muted, sparkline, button } from '../../core/ui.js';
import { disclosure } from '../../core/fold.js';
import { openDrawer } from '../../core/drawer.js';
import { fmtSpan } from '../../core/format.js';
import { CONTACT_TEXT, ENDPOINT_GROUPS, ROLE_TEXT, allContacts, contactKind, countdown, endpointKind, endpointNotes, fmtRtt, matchesEndpoint, registrationKind } from './pjsipmodel.js';
import { go, rtt, state } from './state.js';

// A small colored dot for a state, with the text as its tooltip.
const dot = (kind, title) => h('span', { className: `ast-dot ${kind || 'neutral'}`, title });

// One card per outbound registration.
function registrationCards(p) {
  if (!p.registrations.length) return emptyState('No outbound registration is configured: Asterisk does not register with a provider.');
  return h('div', { className: 'ast-grid' }, p.registrations.map(r => {
    const set = r.settings ?? {};
    const detail = [['Client URI', set.client_uri], ['Server URI', set.server_uri], ['Linked endpoint', r.endpoint], ['Expiration', set.expiration && `${set.expiration} s`], ['Retry interval', set.retry_interval && `${set.retry_interval} s`],
      ['After a fatal error', set.fatal_retry_interval && `${set.fatal_retry_interval} s`], ['After a 403', set.forbidden_retry_interval && `${set.forbidden_retry_interval} s`], ['Max retries', set.max_retries],
      ['Outbound proxy', set.outbound_proxy], ['Authentication', r.auth]].filter(([, v]) => v);
    const ep = p.endpoints.find(e => e.name === r.endpoint);
    return h('div', { className: `card ast-reg ${r.status === 'Registered' ? '' : 'bad'}` },
      h('div', { className: 'card-body' },
        h('div', { className: 'ast-head' }, icon('telephone'), h('span', { className: 'name' }, r.name), badge(r.status, registrationKind(r.status)),
          ep ? h('span', { className: 'ms-auto' }, button(r.endpoint, 'arrow-right', () => openEndpointDrawer(ep), 'btn-outline-secondary btn-sm', { title: 'Open the endpoint of this registration' })) : null),
        h('div', { className: 'muted small mb-2' }, r.expires != null ? `Renews ${countdown(r.expires)}` : (r.status === 'Registered' ? '' : 'Not registered: Asterisk keeps retrying by the intervals below.')),
        kv(detail.map(([k, v]) => [k, mono(String(v))]))));
  }));
}

// Phones on the left, Asterisk with its transports in the middle, trunks on the right.
function flowDiagram(p) {
  const phones = p.endpoints.filter(e => e.role !== 'trunk'), trunks = p.endpoints.filter(e => e.role === 'trunk');
  const node = e => h('button', { type: 'button', className: 'ast-node', onclick: () => openEndpointDrawer(e), title: `${e.name}: ${e.state}` },
    dot(endpointKind(e), e.state), h('span', { className: 'ast-node-name' }, e.name),
    e.registration ? badge(p.registrations.find(r => r.name === e.registration)?.status ?? '', registrationKind(p.registrations.find(r => r.name === e.registration)?.status)) : null,
    e.channels ? badge(`${e.channels} call${e.channels > 1 ? 's' : ''}`, 'info') : null);
  const side = (title, list, empty) => h('div', { className: 'ast-side' }, h('div', { className: 'ast-side-title' }, title), list.length ? list.map(node) : muted(empty));
  const center = h('div', { className: 'ast-core' }, icon('telephone', 28), h('div', { className: 'fw-semibold' }, 'Asterisk'),
    h('div', { className: 'chips justify-content-center' }, p.transports.map(t => chip(`${t.type.toUpperCase()} ${t.bind}`, 'info', `Transport ${t.name}`))));
  const busy = p.endpoints.some(e => e.channels > 0);
  return card([icon('diagram-3'), 'Signalling'], h('div', { className: 'ast-flow' },
    side('Phones and other endpoints', phones, 'none'), h('div', { className: `ast-wire ${busy ? 'live' : ''}` }), center, h('div', { className: `ast-wire ${busy ? 'live' : ''}` }), side('Trunks', trunks, 'none')));
}

// Codec chips.
const codecChips = list => h('span', { className: 'chips' }, (list ?? []).length ? list.map(c => chip(c, 'info')) : muted('default'));

// The endpoints table; a row opens the side panel.
function endpointsCard(p) {
  const shown = p.endpoints.filter(e => matchesEndpoint(e, state.q, state.role));
  const rows = shown.map(e => {
    const reachable = e.contacts.filter(c => c.status === 'Avail').length;
    return h('tr', { className: 'ast-row', tabIndex: 0, onclick: () => openEndpointDrawer(e), onkeydown: onActivate(() => openEndpointDrawer(e)) },
      h('td', {}, h('div', { className: 'fw-semibold' }, e.name), h('div', { className: 'muted small' }, ROLE_TEXT[e.role] ?? e.role, e.callerid && e.callerid !== '<unknown>' ? ` · ${e.callerid}` : '')),
      h('td', {}, badge(e.state, endpointKind(e))),
      h('td', {}, e.channels ? `${e.channels}${e.max_channels != null ? ` of ${e.max_channels}` : ''}` : muted('–')),
      h('td', {}, e.context ? h('button', { type: 'button', className: 'btn btn-link btn-sm p-0 mono', onclick: ev => { ev.stopPropagation(); go('dialplan', { dpView: 'browse', ctx: e.context, ext: null }); }, title: 'Show this context in the dialplan' }, e.context) : muted('–')),
      h('td', {}, codecChips(e.codecs)),
      h('td', {}, e.contacts.length ? `${reachable} of ${e.contacts.length} reachable` : (e.role === 'phone' ? muted('none registered') : muted('–'))),
      h('td', {}, e.identifies.length ? h('div', { className: 'chips' }, e.identifies.flatMap(i => i.matches).map(m => chip(m, '', 'Calls from this address are matched to the endpoint'))) : muted('by user name')));
  });
  return card([icon('person'), `Endpoints (${shown.length}${shown.length !== p.endpoints.length ? ` of ${p.endpoints.length}` : ''})`],
    h('div', { className: 'table-responsive' }, h('table', { className: 'table table-hover ast-table' },
      h('thead', {}, h('tr', {}, ['Endpoint', 'State', 'Calls', 'Context', 'Codecs', 'Contacts', 'Identified by'].map(c => h('th', {}, c)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 7, className: 'muted' }, p.endpoints.length ? 'No endpoint matches the filter.' : 'No endpoint is configured.'))))));
}

// All contacts with their round-trip time and its recent history.
function contactsCard(p) {
  const list = allContacts(p);
  if (!list.length) return null;
  const rows = list.map(c => h('tr', {},
    h('td', {}, mono(c.endpoint)), h('td', {}, mono(c.uri)), h('td', {}, badge(CONTACT_TEXT[c.status] ?? c.status, contactKind(c.status))),
    h('td', { className: 'text-nowrap' }, fmtRtt(c.rtt)),
    h('td', {}, sparkline([{ values: rtt.get(`${c.endpoint}|${c.hash}`) ?? [], cls: 'rx' }], { width: 120, height: 26 })),
    h('td', {}, mono(c.hash))));
  return card([icon('activity'), 'Contacts'], h('div', { className: 'table-responsive' }, h('table', { className: 'table ast-table' },
    h('thead', {}, h('tr', {}, ['Endpoint', 'Contact', 'Status', 'Round trip', 'History', 'Hash'].map(c => h('th', {}, c)))), h('tbody', {}, rows))));
}

// The transports: what Asterisk listens on and what it announces.
function transportsCard(p) {
  if (!p.transports.length) return null;
  const rows = p.transports.map(t => {
    const s = t.settings ?? {};
    const nets = [].concat(s.local_net ?? []).filter(Boolean);
    return h('tr', {}, h('td', {}, mono(t.name)), h('td', {}, t.type.toUpperCase()), h('td', {}, mono(t.bind)),
      h('td', {}, [s.external_signaling_address && `signalling ${s.external_signaling_address}`, s.external_media_address && `media ${s.external_media_address}`].filter(Boolean).join(' · ') || muted('as bound')),
      h('td', {}, nets.length ? h('div', { className: 'chips' }, nets.map(n => chip(n, '', 'Local network: addresses here are not translated'))) : muted('–')));
  });
  return card([icon('broadcast'), 'Transports'], h('div', { className: 'table-responsive' }, h('table', { className: 'table ast-table' },
    h('thead', {}, h('tr', {}, ['Transport', 'Type', 'Listens on', 'Announced as', 'Local networks'].map(c => h('th', {}, c)))), h('tbody', {}, rows))));
}

// The channels that carry a call now.
function channelsCard(p) {
  if (!p.channels.length) return null;
  const rows = p.channels.map(c => h('tr', {}, h('td', {}, mono(c.channel)), h('td', {}, c.state), h('td', {}, `${c.app}${c.data ? `(${c.data})` : ''}`),
    h('td', {}, c.callerid || muted('–')), h('td', {}, c.context ? mono(`${c.context},${c.exten},${c.priority}`) : muted('–')), h('td', { className: 'text-nowrap' }, c.duration != null ? fmtSpan(c.duration) : '–')));
  return card([icon('activity'), `Active channels (${p.channels.length})`], h('div', { className: 'table-responsive' }, h('table', { className: 'table ast-table' },
    h('thead', {}, h('tr', {}, ['Channel', 'State', 'Doing', 'Caller', 'Dialplan position', 'Duration'].map(c => h('th', {}, c)))), h('tbody', {}, rows))));
}

// The PJSIP tab's nodes for a reply of `flab.asterisk pjsip`.
export function pjsipView(p) {
  if (!p.available) {
    return [emptyState(p.reason === 'module' ? 'The PJSIP channel driver (chan_pjsip) is not loaded, so there is nothing to show about SIP. Install asterisk-pjsip.' : 'Asterisk is not running or does not answer, so its SIP state cannot be read.')];
  }
  return [
    p.truncated ? h('div', { className: 'alert alert-info' }, 'There are more endpoints than the page reads in detail; the later ones show no codec or context.') : null,
    h('h2', { className: 'ast-h' }, 'Outbound registrations'),
    registrationCards(p),
    flowDiagram(p),
    endpointsCard(p),
    contactsCard(p),
    transportsCard(p),
    channelsCard(p),
  ];
}

// The side panel of one endpoint: what it is, how to reach it, its settings by group, and every parameter on demand.
export function openEndpointDrawer(e) {
  const notes = endpointNotes(e);
  const settings = e.settings ?? {};
  const groups = ENDPOINT_GROUPS.map(([title, keys]) => {
    const rows = keys.map(([label, key]) => settings[key] ? [label, key === 'allow' ? codecChips(e.codecs) : mono(String(settings[key]))] : null).filter(Boolean);
    return rows.length ? h('div', { className: 'blk' }, h('h3', {}, title), kv(rows)) : null;
  });
  const all = h('div', { className: 'muted small' }, 'Loading…');
  let loaded = false;
  const params = disclosure({
    cls: 'mt-3', summary: 'Every parameter Asterisk reports',
    onToggle: async open => {
      if (!open || loaded) return;
      loaded = true;
      try {
        const r = await ubus('flab.asterisk', 'endpoint', { name: e.name });
        const filled = (r.params ?? []).filter(x => x.value !== '');
        all.replaceChildren(h('div', { className: 'table-responsive' }, h('table', { className: 'table table-sm ast-table' }, h('tbody', {}, filled.map(x => h('tr', {}, h('td', { className: 'mono' }, x.name), h('td', { className: 'mono' }, x.value)))))),
          h('div', { className: 'muted small' }, `${(r.params ?? []).length - filled.length} parameters are empty and not shown.`));
      } catch (err) {
        all.replaceChildren(h('span', { className: 'text-danger' }, `Could not read the parameters: ${err.message}`));
        loaded = false;
      }
    },
    body: all,
  });
  const body = h('div', { className: 'ast-drawer' },
    h('div', { className: 'mb-3 d-flex flex-wrap gap-2 align-items-center' }, badge(ROLE_TEXT[e.role] ?? e.role, ''), badge(e.state, endpointKind(e)),
      e.channels ? badge(`${e.channels} call${e.channels > 1 ? 's' : ''}`, 'info') : null, e.registration ? badge(`registration ${e.registration}`, 'info') : null),
    notes.length ? h('ul', { className: 'warnings' }, notes.map(n => h('li', { className: n.level }, icon(n.level === 'warn' ? 'exclamation-triangle' : 'info-circle'), n.text))) : null,
    ...groups,
    e.auths.length ? h('div', { className: 'blk' }, h('h3', {}, 'Credentials'), kv(e.auths.map(a => [a.dir === 'in' ? 'Accepts' : 'Presents', mono(`${a.id} · user ${a.username}`)]))) : null,
    e.contacts.length ? h('div', { className: 'blk' }, h('h3', {}, 'Contacts'), kv(e.contacts.map(c => [c.status === 'Avail' ? 'Reachable' : (CONTACT_TEXT[c.status] ?? c.status), h('span', {}, mono(c.uri), ' ', muted(fmtRtt(c.rtt)))]))) : null,
    e.identifies.length ? h('div', { className: 'blk' }, h('h3', {}, 'Identified by address'), kv(e.identifies.map(i => [i.name, mono(i.matches.join(', '))]))) : null,
    params);
  const drawer = openDrawer({
    title: e.name, subtitle: `${ROLE_TEXT[e.role] ?? 'Endpoint'}${e.context ? ` · context ${e.context}` : ''}`, icon: icon('telephone'), body,
    footer: e.context ? button('Show its context in the dialplan', 'diagram-3', () => { drawer.close(); go('dialplan', { dpView: 'browse', ctx: e.context, ext: null }); }, 'btn-outline-primary btn-sm') : null,
  });
}
