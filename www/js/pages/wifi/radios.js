// Radios section of the Wi-Fi page: one card per radio with the wireless networks on it: a table of the SSIDs (mesh
// interfaces are on the Mesh page) and, when the configuration can be edited, a form per network (editors.js). Data comes from the flab.radio plugin.
// The radio's own parts (header, rate tracker) are in ../radios/parts.js, shared with the Wi-Fi radios page (../radios/), which shows and edits the
// radios themselves; what is here is the radio's SSIDs and their editors.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, muted, mono } from '../../core/ui.js';
import { latest } from '../../core/rates.js';
import { fmtBytes, fmtLine, fmtNum } from '../../core/format.js';
import { networksEditor } from './editors.js';
import { SECURITY_KIND, tracker, header } from '../radios/parts.js';

//#region parts
// Badges for an interface's roaming (802.11r/k/v), WPS, OCV and access-control settings.
const featureChips = i => [
  i.features?.roaming_11r ? badge('802.11r', 'info', 'Fast BSS transition (roaming)') : null,
  i.features?.neighbor_11k ? badge('802.11k', 'info', 'Neighbor reports') : null,
  i.features?.bss_transition_11v ? badge('802.11v', 'info', 'BSS transition management') : null,
  i.features?.wps ? badge('WPS', 'warning', 'WPS push button enabled') : null,
  i.features?.ocv ? badge('OCV', '', 'Operating channel validation') : null,
  i.features?.proxy_arp ? badge('proxy ARP', '') : null,
  i.hidden ? badge('hidden SSID', '') : null,
  i.isolate ? badge('client isolation', 'info') : null,
  i.max_clients ? badge(`max ${i.max_clients} clients`, '') : null,
  i.macfilter ? badge(`MAC ${i.macfilter.policy} list (${i.macfilter.entries})`, '', 'Only the number of entries is shown') : null,
].filter(Boolean);

// Table row for one SSID: identity, networks, security, client count, current and total traffic, features
// and BSS state. Current throughput comes from the per-interface byte-counter series.
function interfaceRow(i) {
  const k = `if:${i.ifname}`;
  const rx = latest(tracker.rates(k, 'rx')), tx = latest(tracker.rates(k, 'tx'));
  const status = !i.enabled ? badge('disabled', '') : !i.up ? badge('not running', 'danger') : i.bss_status && i.bss_status !== 'ENABLED' ? badge(i.bss_status, 'warning') : badge(i.bss_status ?? 'up', 'success');
  return h('tr', {},
    h('td', {}, h('strong', {}, i.ssid ?? '(no SSID)'), ' ', badge(i.mode), h('div', { className: 'muted small mono' }, i.ifname ?? i.section)),
    h('td', {}, i.bssid ? mono(i.bssid) : muted('–')),
    h('td', {}, i.networks.length ? i.networks.map(n => badge(n, 'info')) : muted('–')),
    h('td', {}, badge(i.security, SECURITY_KIND(i.security)), h('div', { className: 'muted small mono' }, i.encryption)),
    h('td', { className: 'num' }, i.clients != null ? fmtNum(i.clients) : '–'),
    h('td', { className: 'num' }, i.ifname ? h('div', {}, h('div', {}, icon('arrow-down', 12), fmtLine(rx)), h('div', {}, icon('arrow-up', 12), fmtLine(tx))) : '–'),
    h('td', { className: 'num' }, i.rx_bytes != null ? h('div', {}, `↓ ${fmtBytes(i.rx_bytes)}`, h('div', {}, `↑ ${fmtBytes(i.tx_bytes)}`)) : '–'),
    h('td', {}, h('div', { className: 'rd-feat' }, featureChips(i))),
    h('td', {}, status));
}

// Table of the non-mesh wireless interfaces (SSIDs) of a radio.
function interfacesTable(r) {
  const cols = ['SSID', 'BSSID', 'Network', 'Security', 'Clients', 'Throughput now', 'Total', 'Features', 'State'];
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover' },
    h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
    h('tbody', {}, r.interfaces.length ? r.interfaces.map(interfaceRow) : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'No wireless interfaces are configured on this radio.')))));
}
//#endregion

// One card per radio: the header (state, band, standards, links to its mesh interfaces) and the radio's networks: a table of the SSIDs on it and, when
// the configuration can be edited, a form per network. The radio's own channel, settings and live figures are on the Wi-Fi radios page.
function radioCard(r, edit) {
  const editing = Boolean(edit?.wifi?.editable);
  return h('div', { className: `card rd-card ${r.up ? 'is-up' : 'is-down'}` },
    header(r),
    h('div', { className: 'rd-ifaces' }, h('h3', {}, `Interfaces (${r.interfaces.length})`), interfacesTable(r), editing ? networksEditor(r.name, edit) : null));
}

// Returns the nodes for the radios section; an empty list when the plugin is not available. Mesh interfaces
// are left out of the tables and shown as a link: they have their own page. `edit` is passed on to every card.
export function radiosSection(hw, edit) {
  if (!hw?.radios?.length) return [];
  const radios = hw.radios.map(r => ({ ...r, interfaces: r.interfaces.filter(i => i.mode !== 'mesh'), mesh: r.interfaces.filter(i => i.mode === 'mesh') }));
  return [h('div', { className: 'rd-grid' }, radios.map(r => radioCard(r, edit)))];
}