import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { readOverviewNetwork } from '../../www/js/pages/overview/model.js';

const dump = {
  interface: [
    {
      interface: 'lan', up: true,
      'ipv6-prefix-assignment': [{ address: '2a01::', mask: 60 }],
    },
    {
      interface: 'wan', up: true, proto: 'pppoe', l3_device: 'pppoe-wan', uptime: 120,
      'ipv4-address': [{ address: '203.0.113.8', mask: 32 }],
      route: [{ target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1', metric: 10 }],
      'dns-server': ['9.9.9.9'],
    },
    {
      interface: 'wan6', up: true, proto: 'dhcpv6', l3_device: 'pppoe-wan',
      'ipv6-address': [{ address: '2a01:100::1', mask: 64 }],
      route: [{ target: '::', mask: 0, nexthop: 'fe80::1', metric: 512 }],
      'ipv6-prefix': [{ address: '2a01:200::', mask: 56, preferred: 100, valid: 200,
        assigned: { lan: { address: '2a01:200::', mask: 60 } } }],
      'dns-server': ['2001:4860:4860::8888'],
    },
  ],
};

const result = readOverviewNetwork(dump);
assert.equal(result.online, true);
assert.equal(result.state, 'Online');
assert.equal(result.ipv4.name, 'wan');
assert.equal(result.ipv4.address, '203.0.113.8');
assert.equal(result.ipv6.name, 'wan6');
assert.equal(result.prefix.mask, 56);
assert.equal(result.prefix.assigned[0].name, 'lan');
assert.deepEqual(result.sources, ['wan', 'wan6']);
assert.deepEqual(result.dns4, ['9.9.9.9']);
assert.deepEqual(result.dns6, ['2001:4860:4860::8888']);
assert.deepEqual(result.inactiveDns4, []);
assert.equal(readOverviewNetwork({ interface: [{ interface: 'wan', up: true, route: [] }] }).state, 'Offline');

// No connectivity at all: only a LAN, no default route anywhere.
const none = readOverviewNetwork({ interface: [{ interface: 'loopback', up: true }, { interface: 'lan', up: true }] });
assert.deepEqual([none.state, none.online, none.ipv4, none.ipv6, none.prefix, none.sources, none.unavailable], ['Offline', false, null, null, null, [], false]);
// A failed or refused dump is "unavailable", never "Offline".
for (const bad of [null, undefined, {}, { interface: 'x' }])
  assert.deepEqual([readOverviewNetwork(bad).state, readOverviewNetwork(bad).unavailable], ['Unavailable', true]);
// IPv4 only: IPv6 and the delegation are simply absent.
const v4only = readOverviewNetwork({ interface: [dump.interface[1]] });
assert.deepEqual([v4only.online, v4only.ipv6, v4only.prefix, v4only.dns6], [true, null, null, []]);
// IPv6 without a delegated prefix, and a prefix that is not handed to any LAN.
const v6 = dump.interface[2];
assert.equal(readOverviewNetwork({ interface: [{ ...v6, 'ipv6-prefix': [] }] }).prefix, null);
assert.deepEqual(readOverviewNetwork({ interface: [{ ...v6, 'ipv6-prefix': [{ address: '2a01:200::', mask: 56 }] }] }).prefix.assigned, []);
// A router behind a modem or CGNAT has a private WAN address and is still online.
const natted = readOverviewNetwork({ interface: [{ ...dump.interface[1], 'ipv4-address': [{ address: '192.168.100.2', mask: 24 }] }] });
assert.deepEqual([natted.online, natted.ipv4.address, natted.ipv4.private], [true, '192.168.100.2', true]);
// A default route without any address yet is not online.
const bare = readOverviewNetwork({ interface: [{ ...dump.interface[1], 'ipv4-address': [] }] });
assert.deepEqual([bare.online, bare.state, bare.ipv4.address, bare.sources], [false, 'WAN up', null, ['wan']]);

const overviewDir = new URL('../../www/js/pages/overview/', import.meta.url);
for (const name of await readdir(overviewDir)) {
  if (!name.endsWith('.js')) continue;
  const source = await readFile(new URL(name, overviewDir), 'utf8');
  const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(imports.every(path => path.startsWith('../../core/') || path.startsWith('./')),
    `${name} imports only base-package core helpers or other Overview files`);
}

const baseAcl = JSON.parse(await readFile(new URL('../../rpcd/acl.d/flab-base.json', import.meta.url), 'utf8'));
assert.ok(baseAcl.flab.read.ubus['network.interface'].includes('dump'),
  'base ACL grants the WAN data used by Overview');
assert.ok(baseAcl.flab.read.ubus.system.includes('board') && baseAcl.flab.read.ubus.system.includes('info'),
  'base ACL grants the system data used by Overview');
assert.ok(baseAcl.flab.read.ubus['flab.system'].includes('storage'),
  'base ACL grants the storage data used by Overview');
console.log('PASS overview network model');
