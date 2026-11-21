// The drawer that explains how BIRD chose among the routes of one prefix: every candidate with the values the selection rules compare,
// and, for each one that was not chosen, the rule it lost on. The reasoning is in routemodel.js; this only draws it.

import { h } from '../../../core/dom.js';
import { icon } from '../../../core/icons.js';
import { badge, mono, muted } from '../../../core/ui.js';
import { openDrawer } from '../../../core/drawer.js';
import { RULE_LABELS, explainPrefix } from './routemodel.js';
import { asPath, peerDot } from './util.js';

// The badge of a row: what the route is for BIRD.
const ROLE = {
  best: ['Best', 'success', 'The route BIRD uses'],
  ecmp: ['ECMP', 'info', 'Installed in the kernel next to the best path'],
  backup: ['Backup', '', 'Valid, used only if the better paths disappear'],
  other: ['Not selected', '', 'A route of another protocol'],
};

// A label over a value, one of the figures the selection rules compare.
const figure = (label, value) => h('div', { className: 'bgp-fig' }, h('span', { className: 'muted small' }, label), h('span', {}, value));

// The card of one candidate: who offers it, its badge, the figures BIRD compared, and why it was or was not chosen.
function item(r, data) {
  const c = r.candidate;
  const [label, kind, title] = ROLE[r.role];
  const bgp = c.kind === 'bgp';
  return h('div', { className: `bgp-why-item ${r.role}` },
    h('div', { className: 'bgp-why-head' },
      bgp ? h('span', { className: 'peer-label' }, peerDot(data, c.peer), h('strong', {}, c.peer)) : h('span', {}, mono(c.peer), ' ', muted('(not BGP)')),
      badge(label, kind, title)),
    h('div', { className: 'bgp-figs' },
      figure('Preference', c.preference ?? '–'),
      bgp ? [
        figure('Local pref', c.localPref),
        figure('AS path', asPath(c.path.as_path)),
        figure('Origin', c.origin ?? '–'),
        figure('MED', c.med),
        figure('Learned over', c.external ? 'eBGP' : 'iBGP'),
        figure('Router ID', c.routerId ? mono(c.routerId) : '–'),
      ] : null),
    h('p', { className: 'bgp-why' }, r.reason));
}

// Opens the drawer for `prefix`, from the data of the poll that is on screen (the drawer does not follow later polls: it says when it
// was drawn).
export function openRouteDetail(prefix, data) {
  const ex = explainPrefix(data, prefix);
  const body = h('div', {},
    ex.rows.length ? h('div', { className: 'bgp-why-list' }, ex.rows.map(r => item(r, data))) : muted('BIRD has no route for this prefix any more.'),
    h('h3', { className: 'sec-title mt-3' }, 'How BIRD decides'),
    h('p', { className: 'muted small' }, 'Between routes of one prefix BIRD first prefers the higher route preference, then applies these rules in order; the first rule on which two routes differ decides (BIRD 3 documentation, BGP route selection):'),
    h('ol', { className: 'small' }, RULE_LABELS.map(t => h('li', {}, t))),
    h('p', { className: 'muted small' }, 'BIRD\'s last rule, the distance to the boundary router (IGP metric), is not reported by BIRD and so is not shown. Paths that tie up to the router ID are installed together in the kernel when multipath is on (merge paths).'));
  openDrawer({
    title: prefix, icon: icon('signpost-split'),
    subtitle: `${ex.rows.length} route${ex.rows.length === 1 ? '' : 's'} · as of ${new Date().toLocaleTimeString()}`,
    body,
  });
}
