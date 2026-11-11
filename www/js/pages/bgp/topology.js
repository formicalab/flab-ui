// Topology diagram: this router -> BGP peers -> remote AS, drawn with CSS grid plus SVG connectors.
//
// The connectors use a 0..100 viewBox stretched over the whole column, so every peer cell must have
// the same height and the cells must touch (padding, not gaps); then a peer's vertical center is
// exactly (index + 0.5) / count of the column height.

import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card } from '../../core/ui.js';
import { fmtNum } from '../../core/format.js';
import { peerClass, peerTitle, isUp, stateKind, isPrivateAs } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// One animated connector per peer. `toPeer` selects the curve direction.
function links(items, toPeer) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'bgp-links');
  items.forEach(({ cls, up }, i) => {
    const y = ((i + 0.5) / items.length * 100).toFixed(2);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', toPeer ? `M0,50 C45,50 55,${y} 100,${y}` : `M0,${y} C45,${y} 55,50 100,50`);
    path.setAttribute('class', `link ${up ? 'up' : 'down'} ${cls}`);
    svg.append(path);
  });
  return svg;
}

function routerNode(data) {
  const local = data.peers[0]?.local_as;
  const origin = data.local.filter(r => r.source === 'static');
  const learned = new Set(data.paths.map(p => p.prefix)).size;
  return h('div', { className: 'bgp-node router' },
    icon('router', 30),
    h('b', {}, data.daemon.hostname ?? 'Router'),
    h('div', { className: 'chips justify-content-center' }, local != null ? badge(`AS ${local}`, 'info') : null, badge('BIRD ' + (data.daemon.version ?? ''))),
    h('div', { className: 'muted small' }, `Router ID ${data.daemon.router_id ?? '–'}`),
    h('div', { className: 'node-sep' }),
    h('div', { className: 'muted small' }, 'Originates'),
    origin.length ? h('div', { className: 'chips justify-content-center' }, origin.map(r => h('span', { className: 'alg-chip info mono', title: `${r.protocol} · ${r.kind}` }, r.prefix))) : h('span', { className: 'muted small' }, 'nothing'),
    h('div', { className: 'muted small mt-1' }, `Learns ${fmtNum(learned)} prefixes`));
}

function peerNode(data, p) {
  const ch = p.channels[0];
  const cls = peerClass(data, p.name);
  const up = isUp(p);
  return h('div', { className: 'bgp-peer-cell' }, h('div', { className: `bgp-peer ${cls} ${up ? 'is-up' : 'is-down'}` },
    h('span', { className: `dot ${up ? 'up' : 'down'}` }),
    h('div', { className: 'pn-main' },
      h('b', { title: p.name }, peerTitle(p)),
      h('div', { className: 'mono small muted' }, `${p.neighbor ?? '–'}${p.iface ? ' · ' + p.iface : ''}`)),
    h('div', { className: 'pn-stats' },
      h('span', { title: 'Routes received from this peer' }, icon('download', 14), fmtNum(ch?.routes?.imported ?? 0)),
      h('span', { title: 'Routes announced to this peer' }, icon('upload', 14), fmtNum(ch?.routes?.exported ?? 0))),
    badge(p.state, stateKind(p.state))));
}

function asNode(asn, peers, data) {
  const prefixes = new Set(data.paths.filter(r => peers.some(p => p.name === r.peer)).map(r => r.prefix)).size;
  const upCount = peers.filter(isUp).length;
  return h('div', { className: 'bgp-node remote' },
    icon('cloud', 30),
    h('b', {}, `AS ${asn}`),
    h('div', { className: 'chips justify-content-center' }, badge('eBGP', 'info'), isPrivateAs(asn) ? badge('private ASN', '', 'Private-use AS number (RFC 6996)') : null),
    h('div', { className: 'muted small' }, `${upCount}/${peers.length} peers up`),
    h('div', { className: 'muted small' }, `${fmtNum(prefixes)} prefixes`));
}

export function topologyCard(data) {
  if (!data.peers.length) return card([icon('diagram-2'), 'BGP topology'], h('div', { className: 'card-body muted' }, 'No BGP sessions are configured.'));

  const groups = new Map();
  for (const p of data.peers) {
    const key = p.neighbor_as ?? '?';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  const items = data.peers.map(p => ({ cls: peerClass(data, p.name), up: isUp(p) }));
  const blocks = [...groups].map(([asn, peers]) => h('div', { className: 'bgp-block' },
    h('div', { className: 'bgp-peers' }, peers.map(p => peerNode(data, p))),
    links(peers.map(p => ({ cls: peerClass(data, p.name), up: isUp(p) })), false),
    asNode(asn, peers, data)));

  return card([icon('diagram-2'), 'BGP topology', h('span', { className: 'sub' }, `${data.peers.length} sessions · ${groups.size} remote AS`)],
    h('div', { className: 'card-body bgp-topo' }, routerNode(data), links(items, true), h('div', { className: 'bgp-blocks' }, blocks)),
    'h-100');
}
