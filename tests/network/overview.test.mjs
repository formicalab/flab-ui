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
