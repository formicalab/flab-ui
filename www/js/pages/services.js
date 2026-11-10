import { ubus } from '../core/ubus.js';
import { badge, card, table, tile, tiles } from '../core/ui.js';

export default {
  id: 'services',
  label: 'Services',
  icon: 'hdd-stack',
  interval: 5000,
  load: () => ubus('service', 'list'),

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
