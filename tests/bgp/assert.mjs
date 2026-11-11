// Checks the backend JSON produced for each scenario. Usage: node assert.mjs <dir with <scenario>.json files>
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const load = n => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));
let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const find = (d, n) => d.peers.find(p => p.name === n);
const texts = d => d.findings.map(f => `[${f.level}] ${f.text}`);

console.log('== base (real captured output) ==');
const base = load('base');
check(base.peers.length === 4 && base.paths.length === 40 && base.local.length === 5 && base.protocols.length === 8, 'same shape as the live router (4 peers, 40 paths, 5 local, 8 protocols)', JSON.stringify([base.peers.length, base.paths.length, base.local.length, base.protocols.length]));
check(base.peers.every(p => p.state === 'Established'), 'all peers Established');
check(base.paths.filter(p => p.best).every(p => p.in_kernel) && base.paths.filter(p => p.best).every(p => p.kernel_paths === 2), 'best paths in kernel with ECMP x2');
check(base.paths.every(p => p.table === 'master4'), 'routes tagged master4');
check(base.peers.every(p => p.channels.length === 1 && p.exported.length === 1), 'one channel and one announcement per peer');
check(texts(base).every(t => t.startsWith('[good]')), 'only green findings', texts(base).join(' | '));

console.log('== down (xfrm1 Active) ==');
const down = load('down');
const x1 = find(down, 'azure_xfrm1');
check(down.peers.length === 4, 'peer still listed');
check(x1.state === 'Active' && x1.protocol_state === 'start', 'state Active, protocol start', `${x1.state}/${x1.protocol_state}`);
check(/Active/.test(x1.info) && /Connection refused/.test(x1.info), 'info line parsed', x1.info);
check(x1.last_error === 'Socket: Connection refused', 'last error parsed', x1.last_error);
check(x1.connect_delay && x1.connect_delay.left === 3.21 && x1.connect_delay.total === 5, 'connect delay timer parsed', JSON.stringify(x1.connect_delay));
check(x1.hold_timer === null && x1.keepalive_timer === null, 'missing timers are null, not errors');
check(x1.local_caps.length === 0 && x1.neighbor_caps.length === 0, 'no capabilities for a down session');
check(x1.channels.length === 1 && x1.channels[0].state === 'DOWN', 'channel DOWN');
check(x1.exported.length === 0, 'no announcements to a down peer');
check(down.paths.every(p => p.peer !== 'azure_xfrm1') && down.paths.length === 30, 'its 10 learned paths are gone', String(down.paths.length));
check(texts(down).some(t => t.startsWith('[bad]') && t.includes('azure_xfrm1 is Active') && t.includes('Connection refused')), 'red finding names the peer and error', texts(down).join(' | '));
check(down.daemon.running === true && down.memory.length > 0, 'rest of the page data intact');
check(!texts(down).some(t => /not installed in the kernel/.test(t)), 'no false kernel-sync alarm after losing a peer', texts(down).join(' | '));

console.log('== dual (IPv6) ==');
const dual = load('dual');
const x0 = find(dual, 'azure_xfrm0');
check(x0.channels.length === 2 && x0.channels[0].afi === 'ipv4' && x0.channels[1].afi === 'ipv6', 'two channels parsed on a dual-stack peer', x0.channels.map(c => c.afi).join());
check(x0.channels[1].table === 'master6' && x0.channels[1].routes.imported === 3, 'ipv6 channel details parsed', JSON.stringify(x0.channels[1].routes));
check(x0.channels[1].stats.export_updates.accepted === 1 && x0.channels[1].stats.import_updates.received === 3, 'ipv6 channel statistics parsed');
const v6 = dual.paths.filter(p => p.prefix.includes(':'));
check(v6.length === 3 && v6.every(p => p.table === 'master6'), 'three IPv6 paths tagged master6', String(v6.length));
const ecmp = v6.filter(p => p.prefix === '2001:db8:100::/48');
check(ecmp.length === 2 && ecmp.every(p => p.in_kernel && p.kernel_paths === 2), 'IPv6 ECMP pair is installed (link-local next hops matched)', JSON.stringify(ecmp.map(p => [p.next_hop, p.in_kernel, p.kernel_paths])));
check(ecmp[0].next_hop === '2001:db8:ffff::1 fe80::a', 'both next-hop addresses kept', ecmp[0].next_hop);
check(ecmp[0].large_communities.length === 1 && ecmp[0].large_communities[0] === '65515, 1, 2', 'large community parsed', JSON.stringify(ecmp[0].large_communities));
const missing = v6.find(p => p.prefix === '2001:db8:300::/48');
check(missing && missing.best && !missing.in_kernel, 'IPv6 best route absent from kernel is detected');
check(texts(dual).some(t => t.startsWith('[bad]') && t.includes('2001:db8:300::/48')), 'red finding lists the missing IPv6 prefix', texts(dual).join(' | '));
check(!texts(dual).some(t => /2001:db8:100::\/48/.test(t) && t.startsWith('[bad]')), 'installed IPv6 prefix is not flagged');
check(x0.exported.some(e => e.prefix === '2001:db8:f00d::/48' && e.table === 'master6' && e.kind === 'blackhole'), 'IPv6 announcement parsed with its table', JSON.stringify(x0.exported));
const l6 = dual.local.find(l => l.prefix === '2001:db8:f00d::/48');
check(l6 && l6.in_kernel && l6.kind === 'blackhole', 'IPv6 static blackhole shows as installed local route');
check(dual.protocols.find(p => p.name === 'static2')?.channels[0].table === 'master6', 'IPv6 static protocol parsed');
check(find(dual, 'azure_xfrm1').channels.length === 2 && find(dual, 'azure_xfrm2').channels.length === 1, 'only the dual-stack peers have two channels');

console.log('== announce (per-peer announcements) ==');
const an = load('announce');
const ex = n => find(an, n).exported.map(e => `${e.prefix}:${e.protocol}`).sort();
check(JSON.stringify(ex('azure_xfrm0')) === JSON.stringify(['10.0.0.12/32:direct1', '192.168.0.0/16:static1']), 'peer 0 announces aggregate + direct route', ex('azure_xfrm0').join());
check(JSON.stringify(ex('azure_xfrm1')) === JSON.stringify(['192.168.0.0/16:static1', '192.168.50.0/24:ospf1']), 'peer 1 announces the OSPF-origin prefix (preference 150/10 parsed)', ex('azure_xfrm1').join());
check(find(an, 'azure_xfrm3').exported.length === 0, 'peer 3 receives nothing');
check(find(an, 'azure_xfrm1').exported.find(e => e.protocol === 'ospf1').preference === 150, 'metric suffix in "(150/10)" ignored for preference');
check(texts(an).some(t => t.startsWith('[warn]') && t.includes('azure_xfrm3') && /announcement/.test(t)), 'warning for the peer that receives no announcement', texts(an).join(' | '));
check(!texts(an).some(t => t.includes('azure_xfrm0') && t.startsWith('[warn]')), 'no warning for peers that receive announcements');

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nall backend checks passed');
process.exit(failed ? 1 : 0);
