// Firewall page (route #firewall): the zones and what may flow between them, the traffic rules and port
// forwards, and what is reachable from the Internet, each with the live hit counters nftables keeps. The
// configuration comes from UCI firewall, the live state from `nft -j list ruleset`, both through the
// flab.firewall plugin, and is rediscovered on every poll.
import { tile, tiles, emptyState, healthBanner } from '../../core/ui.js';
import { ubus } from '../../core/ubus.js';
import { pauseControl, refreshControl } from '../../core/controls.js';
import { fmtNum } from '../../core/format.js';
import { matrixCard } from './matrix.js';
import { zonesCard } from './zones.js';
import { exposureCard, rulesCard, redirectsCard } from './rules.js';
import { findings, recordFirewall, packetsPerSec, fmtPps, wanZones } from './util.js';

// Nothing but the paused flag has to survive the redraw on every poll.
const state = { paused: false };

// Flow-offloading mode from the firewall defaults: software flowtable, or hardware when it is also enabled.
const offloadLabel = fw => !fw.defaults.flow_offloading ? 'Off' : fw.defaults.flow_offloading_hw ? 'Hardware' : 'Software';

// Summary tiles. "Turned away from outside" sums the packets that the reject/drop chains of Internet-facing
// zones (those with NAT) refused from the zone; conntrack turns amber above 80 % of the table limit.
function summary(fw) {
  const rules = fw.rules, on = rules.filter(r => r.enabled);
  const wan = wanZones(fw);
  const blocked = wan.reduce((t, z) => t + (z.blocked_from?.packets ?? 0), 0);
  const pps = wan.reduce((t, z) => t + (packetsPerSec(`zone/${z.name}/from`) ?? 0), 0);
  const { count, max } = fw.conntrack;
  return tiles(
    tile('Zones', fw.zones.length, fw.zones.map(z => z.name).join(', ') || 'none'),
    tile('Traffic rules', `${on.length} / ${rules.length}`, on.length === rules.length ? 'all enabled' : `${rules.length - on.length} disabled`),
    tile('Port forwards', fw.redirects.filter(r => r.enabled).length, fw.redirects.length ? 'configured' : 'none configured'),
    tile('Turned away from outside', fmtNum(blocked), wan.length ? (fmtPps(pps) ?? 'packets rejected from the Internet') : 'no zone faces the Internet'),
    tile('Connections', count != null ? fmtNum(count) : '–', max ? `${Math.round(count / max * 100)} % of ${fmtNum(max)} tracked` : '', max && count / max > 0.8 ? 'text-warning' : ''),
    tile('Flow offloading', offloadLabel(fw), fw.flowtable ? `${fw.flowtable.devices.length} devices` : 'no flowtable loaded', fw.defaults.flow_offloading ? 'text-success' : ''));
}

// Page object registered in pages/index.js (contract documented there).
export default {
  id: 'firewall',
  label: 'Firewall',
  title: 'Firewall · zones and rules',
  icon: 'shield-check',
  interval: 5000,
  css: 'css/firewall.css',
  isPaused: () => state.paused,

  // Counters are fed to the rate tracker before rendering so hit rates are live.
  load: async () => {
    const fw = await ubus('flab.firewall', 'status');
    recordFirewall(fw);
    return fw;
  },

  controls({ reload }) {
    return { nodes: [pauseControl(state), refreshControl(reload)] };
  },

  // When there is no firewall configuration at all, only the findings and an explanation are shown.
  view(fw) {
    if (!fw.zones.length && !fw.running) return [healthBanner(findings(fw), ''), emptyState('No firewall configuration was found.')];
    return [
      summary(fw),
      healthBanner(findings(fw), 'The firewall is running and nothing needs attention.'),
      matrixCard(fw),
      zonesCard(fw),
      exposureCard(fw),
      rulesCard(fw),
      redirectsCard(fw),
    ];
  },
};
