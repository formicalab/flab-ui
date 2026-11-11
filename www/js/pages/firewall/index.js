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

const state = { paused: false };

const offloadLabel = fw => !fw.defaults.flow_offloading ? 'Off' : fw.defaults.flow_offloading_hw ? 'Hardware' : 'Software';

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

export default {
  id: 'firewall',
  label: 'Firewall',
  title: 'Firewall · zones and rules',
  icon: 'shield-check',
  interval: 5000,
  css: 'css/firewall.css',
  isPaused: () => state.paused,

  load: async () => {
    const fw = await ubus('flab.firewall', 'status');
    recordFirewall(fw);
    return fw;
  },

  controls({ reload }) {
    return { nodes: [pauseControl(state), refreshControl(reload)] };
  },

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
