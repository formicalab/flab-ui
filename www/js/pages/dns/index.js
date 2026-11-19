// Combined DNS page: the local resolver and ddns-scripts share one navigation entry and switch with top tabs.
import { tabsControl } from '../../core/controls.js';
import resolver from './resolver.js';
import dynamic from '../ddns/index.js';

const state = { tab: 'resolver' };
const pages = { resolver, dynamic };
const page = () => pages[state.tab];
export const routeForTab = tab => tab === 'dynamic' ? '#ddns' : '#dns';

// The old #ddns route opens this tab before the shell creates the controls.
export function openTab(tab) {
  if (pages[tab]) state.tab = tab;
}

export default {
  interval: 10000,
  css: ['css/forms.css', 'css/dns.css', 'css/ddns.css'],
  isPaused: () => page().isPaused?.() ?? false,

  async load() {
    const tab = state.tab;
    return { tab, data: await pages[tab].load() };
  },

  controls({ rerender, reload }) {
    const controls = Object.fromEntries(Object.entries(pages).map(([key, child]) => [
      key,
      child.controls?.({ rerender, reload }) ?? { nodes: [] },
    ]));
    const tabs = tabsControl(state, 'tab', tab => { location.hash = routeForTab(tab); });
    tabs.setOptions([['resolver', 'DNS resolver'], ['dynamic', 'Dynamic DNS']]);
    const show = () => {
      for (const [key, ctl] of Object.entries(controls))
        ctl.nodes.forEach(node => { node.hidden = key !== state.tab; });
    };
    show();
    return {
      nodes: [tabs.node, ...Object.values(controls).flatMap(ctl => ctl.nodes)],
      update(data) {
        show();
        controls[data.tab].update?.(data.data);
      },
    };
  },

  view(data, rerender) {
    return pages[data.tab].view(data.data, rerender);
  },
};
