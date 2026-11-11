// Services page: procd services from the standard service list call. A service is "up" when it has
// instances and all of them are running; one-shot services (firewall, system, ...) show as idle.
import { ubus } from '../core/ubus.js';
import { badge, card, table, tile, tiles } from '../core/ui.js';

export default {
  id: 'services',
  label: 'Services',
  icon: 'hdd-stack',
  interval: 5000,
  load: () => ubus('service', 'list'),

  // One row per service, sorted by name; PIDs of all instances are listed (a stopped instance has none).
  view(svc) {
    const entries = Object.entries(svc).sort().map(([name, s]) => {
      const inst = Object.values(s.instances || {});
      return { name, running: inst.length > 0 && inst.every(i => i.running), pids: inst.map(i => i.pid).filter(Boolean).join(', ') };
    });
    const up = entries.filter(e => e.running).length;
    return [
      tiles(tile('Running', up, 'procd services'), tile('Idle / one-shot', entries.length - up, 'no running instance')),
      card('procd services', table(['Service', 'State', 'PID'],
        entries.map(e => [e.name, badge(e.running ? 'up' : 'idle', e.running ? 'success' : ''), e.pids]))),
    ];
  },
};
