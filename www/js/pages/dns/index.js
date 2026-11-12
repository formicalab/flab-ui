// DNS page (route #dns): the state of the router's DNS resolver, Unbound or dnsmasq (or both). It is an initial,
// read-only page: it shows what the resolver is doing and how it is configured, and changes nothing.
//
// Top to bottom: summary tiles, the findings banner, then the cards: Listening and configuration, Forwarding and Activity
// (each full width), then Upstream from the WAN beside Try it (which hands a name to the Toolbox). Everything comes from one call, flab.dns
// status (rpcd/ucode/flab.dns.uc), every 10 s; the model (model.js) is pure and unit-tested.
import { h } from '../../core/dom.js';
import { ubus } from '../../core/ubus.js';
import { refreshControl } from '../../core/controls.js';
import { emptyState, healthBanner, tile, tiles } from '../../core/ui.js';
import { engineName, findings, subject, summary } from './model.js';
import { forwardingCard } from './forwarding.js';
import { activityCard, resolverCard, tryCard, upstreamCard } from './cards.js';

// The view state that must survive the redraw on every poll: the forwarders' filter text, whether every row is
// drawn, whether the zones are grouped by server set, which groups are open, and the name typed into Try it.
const state = { fq: '', fall: false, grouped: true, open: new Set(), host: '' };

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'dns',
  label: 'DNS',
  title: 'DNS',
  icon: 'hdd-network',
  interval: 10000,
  css: ['css/forms.css', 'css/dns.css'],
  // A redraw would take the focus away from the filter box or the name being typed.
  isPaused: () => Boolean(document.activeElement?.closest?.('.dns-field')),

  load: () => ubus('flab.dns', 'status'),

  controls: ({ reload }) => ({ nodes: [refreshControl(reload)] }),

  // The nodes of the page for one reply; `rerender` redraws from the cached reply (Show all, the grouping toggle).
  view(data, rerender) {
    const e = subject(data);
    const okText = data.engine ? `${engineName(data.engine)} is running and answering queries on port 53.` : 'Nothing to report.';
    return [
      tiles(...summary(data).map(t => tile(t.label, t.value, t.sub, t.cls))),
      healthBanner(findings(data), okText),
      resolverCard(data),
      ...(e ? [forwardingCard(data, state, rerender)] : []),
      e ? activityCard(data) : emptyState('No resolver is installed, so there are no counters to show.'),
      h('div', { className: 'row g-3' },
        h('div', { className: 'col-12 col-xl-5' }, upstreamCard(data)),
        h('div', { className: 'col-12 col-xl-7' }, tryCard(state))),
    ];
  },
};
