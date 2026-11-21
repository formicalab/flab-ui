// Unit tests for the flow diagram of the BGP tab's protocols card (www/js/pages/routing/bgp/flowmodel.js) and for what it reads from the
// configuration file (configmodel.js: protocols BIRD names itself, import and export statements per channel); need no router.
// The fixture is shaped like the real router: unnamed kernel, device, direct and static protocols, four BGP sessions from one template.
// Usage: node flow.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const here = rel => import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/routing/bgp', rel)).href);
const { parseConfig, channelPolicy, findBlock, nameOf } = await here('configmodel.js');
const { buildFlow, edgeRoutes, FLOW, LIST_MAX } = await here('flowmodel.js');

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

const CONF = [
  '# the kernel',
  'protocol kernel {',
  '    ipv4 { import none; export all; };',
  '    scan time 20;',
  '}',
  'protocol device { scan time 10; }',
  'protocol direct { ipv4; interface "xfrm*"; }',
  'filter bgp_in { accept; }',
  'filter bgp_out { if net = 192.168.0.0/16 then accept; reject; }',
  'template bgp azure_vwan {',
  '    local 192.168.1.1 as 64512;',
  '    ipv4 { import filter bgp_in; export filter bgp_out; };',
  '}',
  'protocol static { ipv4; route 192.168.0.0/16 blackhole; }',
  'protocol bgp azure_xfrm0 from azure_vwan { neighbor 10.0.0.12 as 65515; }',
  'protocol bgp azure_xfrm1 from azure_vwan { neighbor 10.0.0.13 as 65515; }',
  'protocol bgp azure_xfrm2 from azure_vwan { neighbor 10.1.0.12 as 65515; }',
  'protocol bgp azure_xfrm3 from azure_vwan { neighbor 10.1.0.13 as 65515; ipv4 { export none; }; }',
  '',
].join('\n');

console.log('== protocols BIRD names itself ==');
const cfg = parseConfig(CONF);
const names = cfg.blocks.filter(b => b.kind === 'protocol').map(b => `${b.type}:${nameOf(b)}`);
check(names.join(' ') === 'kernel:kernel1 device:device1 direct:direct1 static:static1 bgp:azure_xfrm0 bgp:azure_xfrm1 bgp:azure_xfrm2 bgp:azure_xfrm3', 'unnamed protocols get their type and a counter, as BIRD names them', names.join(' '));
const clash = parseConfig('protocol static static1 { }\nprotocol static { }\nprotocol static { }\nprotocol bgp { neighbor 1.1.1.1 as 2; }');
check(clash.blocks.filter(b => b.kind === 'protocol').map(nameOf).join() === 'static1,static2,static3,bgp1', 'the counter skips a name the file already uses, and counts per type', clash.blocks.map(nameOf).join());
check(findBlock(cfg, 'protocol', 'kernel1')?.type === 'kernel' && findBlock(cfg, 'protocol', 'nosuch') === undefined, 'findBlock finds a protocol by the name BIRD shows');

console.log('== import and export statements ==');
const pol = (name, ch = 'ipv4') => channelPolicy(cfg, name, ch);
check(j(pol('kernel1').import) === '{"kind":"none"}' && j(pol('kernel1').export) === '{"kind":"all"}', 'kernel: import none and export all are in the file');
check(pol('direct1').known && pol('direct1').import === null && pol('direct1').export === null, 'direct: a bare "ipv4;" says nothing, so BIRD\'s defaults apply');
check(pol('static1').import === null && pol('static1').export === null, 'static: the same');
check(j(pol('azure_xfrm0').import) === '{"kind":"filter","name":"bgp_in"}' && j(pol('azure_xfrm0').export) === '{"kind":"filter","name":"bgp_out"}', 'a BGP session inherits its filters from the template');
check(j(pol('azure_xfrm3').export) === '{"kind":"none"}' && pol('azure_xfrm3').import.name === 'bgp_in', 'a protocol\'s own channel overrides one statement of the template and keeps the rest');
check(pol('nosuch').known === false && pol('device1', 'ipv4').import === null, 'a protocol the file does not define is not known; a channel it does not have says nothing');
const limit = parseConfig('protocol bgp p { ipv4 { import limit 10 action block; import keep filtered on; import filter f; }; }');
check(channelPolicy(limit, 'p', 'ipv4').import?.name === 'f', 'import limit and import keep filtered are options, not the policy');
const inline = parseConfig('protocol bgp p { ipv4 { import where net ~ [10.0.0.0/8+]; export filter { accept; }; }; }');
check(channelPolicy(inline, 'p', 'ipv4').import?.kind === 'inline' && channelPolicy(inline, 'p', 'ipv4').export?.kind === 'inline', 'an inline filter and a "where" expression are policies of kind inline');

console.log('== the flow ==');
const channel = (inF, outF, imported, exported) => ({ afi: 'ipv4', table: 'master4', state: 'UP', input_filter: inF, output_filter: outF, routes: { imported, exported, preferred: imported } });
const bgp = n => ({ name: `azure_xfrm${n}`, proto: 'BGP', state: 'up', since: '', info: 'Established', channels: [channel('bgp_in', 'bgp_out', 10, 1)] });
const kernelRoutes = Array.from({ length: 16 }, (_, i) => ({ prefix: `10.${i}.0.0/24`, table: 'master4', protocol: i < 11 ? 'azure_xfrm0' : i < 15 ? 'direct1' : 'static1', kind: 'unicast', preference: 100 }));
const data = {
  protocols: [
    { name: 'kernel1', proto: 'Kernel', state: 'up', channels: [channel('REJECT', 'ACCEPT', 0, 16)], exported: kernelRoutes },
    { name: 'device1', proto: 'Device', state: 'up', channels: [], exported: null },
    { name: 'direct1', proto: 'Direct', state: 'up', channels: [channel('ACCEPT', 'REJECT', 4, 0)], exported: null },
    { name: 'static1', proto: 'Static', state: 'up', channels: [channel('ACCEPT', 'REJECT', 1, 0)], exported: null },
    bgp(0), bgp(1), bgp(2), bgp(3),
  ],
  peers: [0, 1, 2, 3].map(n => ({ name: `azure_xfrm${n}`, state: 'Established', session: 'external multihop AS4', neighbor: ['10.0.0.12', '10.0.0.13', '10.1.0.12', '10.1.0.13'][n], neighbor_as: 65515, exported: [{ prefix: '192.168.0.0/16', table: 'master4', protocol: 'static1', kind: 'blackhole', preference: 200 }] })),
  paths: [0, 1, 2, 3].flatMap(n => Array.from({ length: 10 }, (_, i) => ({ peer: `azure_xfrm${n}`, prefix: `10.${n}.${i}.0/24`, table: 'master4', best: i < 2, in_kernel: i < 2, as_path: ['65515'], next_hop: `10.0.0.${n}` }))),
  local: [
    ...['10.0.0.12/32', '10.0.0.13/32', '10.1.0.12/32', '10.1.0.13/32'].map(prefix => ({ prefix, table: 'master4', protocol: 'direct1', kind: 'unicast', source: 'device' })),
    { prefix: '192.168.0.0/16', table: 'master4', protocol: 'static1', kind: 'blackhole', source: 'static' },
  ],
};
const flow = buildFlow(data, cfg);
check(flow.lanes.map(l => l.label).join() === 'kernel1,device1,direct1,static1,azure_xfrm ×4', 'one lane per protocol; the four alike BGP sessions share one, named by what they have in common', flow.lanes.map(l => l.label).join());
check(flow.lanes[4].group && flow.lanes[4].sessions === 4 && /4 of 4 Established/.test(flow.lanes[4].sub), 'the group lane says how many of its sessions are up', flow.lanes[4].sub);
check(flow.lanes[1].edges.length === 0 && flow.lanes.slice(0, 4).map(l => l.edges.length).join() === '2,0,2,2', 'Device has no channel and so no edge; every other channel has an import and an export edge');
check(flow.tables.length === 1 && flow.tables[0].name === 'master4' && flow.tables[0].routes === 45, 'one routing table, with the routes it holds', j(flow.tables));
const edge = (lane, dir) => flow.edges.find(e => e.lane === lane && e.dir === dir);
check(edge('kernel1', 'in').blocked && edge('kernel1', 'in').tag.text === '→ reject all' && edge('kernel1', 'in').tag.source === 'file', 'kernel import: blocked, and set in the file (no "default")', j(edge('kernel1', 'in').tag));
check(!edge('kernel1', 'out').blocked && edge('kernel1', 'out').tag.text === '← accept all' && edge('kernel1', 'out').count === 16 && edge('kernel1', 'out').countText === '16 routes', 'kernel export: 16 routes pass, set in the file');
check(edge('direct1', 'in').tag.text === '→ accept all · default' && edge('direct1', 'out').tag.text === '← reject all · default' && edge('direct1', 'out').blocked, 'direct: BIRD\'s defaults, import all and export none, are labelled as defaults');
check(edge('direct1', 'in').count === 4 && edge('static1', 'in').countText === '1 route', 'counts come from the channel\'s imported and exported routes');
const g = flow.lanes[4].key;
check(edge(g, 'in').count === 40 && edge(g, 'in').tag.text === '→ bgp_in' && edge(g, 'in').tag.filter === 'bgp_in', 'the group imports the sum of its sessions through the template\'s filter', j(edge(g, 'in')));
check(edge(g, 'out').countText === '1 each' && edge(g, 'out').tag.source === 'file', 'its export says "1 each" when every session gets the same');
check(/BIRD's default/.test(edge('direct1', 'in').tag.title) && /imports all routes/.test(edge('direct1', 'in').tag.title) && /exports none/.test(edge('direct1', 'out').tag.title), 'the tooltips say what the default is');
check(/4 of these routes are the addresses of the neighbors of the 4 multihop BGP sessions/.test(edge('direct1', 'in').tag.title) && /gateway recursive/.test(edge('direct1', 'in').tag.title), 'direct\'s import tooltip says its routes are the next hops that the multihop sessions look up');
check(!/multihop/.test(edge('static1', 'in').tag.title) && !/multihop/.test(edge('direct1', 'out').tag.title) && !/multihop/.test(edge(g, 'in').tag.title), 'and nothing else says it: static1 holds no neighbor address, an export edge and a BGP edge are not concerned');
check(flow.edges.filter(e => e.blocked).length === 3 && flow.edges.filter(e => e.blocked).every(e => e.stop && !/NaN/.test(e.path)), 'the three blocked edges are short stubs with a stop mark');
check(flow.edges.filter(e => !e.blocked).every(e => !/NaN|undefined/.test(e.path) && e.tag.y > 0 && e.tag.x > FLOW.laneX + FLOW.laneW), 'the flowing edges are valid splines and their tags lie between the lanes and the table', j(flow.edges.filter(e => /NaN|undefined/.test(e.path))));
check(flow.outside.map(o => `${o.title}:${o.lanes.length}`).join() === 'Linux kernel:1,Network interfaces:2,AS 65515:1' && flow.outside[2].sub === '4 BGP neighbors', 'outside BIRD: the kernel, the interfaces (Device and Direct) and the neighbors', flow.outside.map(o => `${o.title}:${o.lanes.length}`).join());
check(flow.lanes.every((l, i) => i === 0 || l.y >= flow.lanes[i - 1].y + flow.lanes[i - 1].h), 'lanes do not overlap');
const flowing = flow.edges.filter(e => !e.blocked);
check(flowing.every(e => Math.abs(e.tag.x + e.tag.w / 2 - (FLOW.width - FLOW.tableW - 22)) < 0.01 && e.tag.y === e.tableY), 'the tags of the flowing edges sit against the table, right-aligned, at the height where the edge arrives', j(flowing.map(e => [e.tag.x, e.tag.w, e.tag.y, e.tableY])));
check(flowing.filter(e => e.dir === 'in').every(e => e.path.endsWith(`H${+(FLOW.width - FLOW.tableW - e.head.len).toFixed(1)}`) && e.head.x === FLOW.width - FLOW.tableW) && flowing.filter(e => e.dir === 'out').every(e => e.path.startsWith(`M${FLOW.width - FLOW.tableW} `)), 'an import edge runs to the table and an export edge starts there, in a straight run behind the tag; an import ends in its arrowhead at the table');
check(flowing.every(e => e.head.half > e.strokeWidth / 2), 'every arrowhead is wider than its line, so a thick line does not stick out around the tip');
const slots = flowing.map(e => e.tableY).sort((a, b) => a - b);
check(slots.every((y, i) => i === 0 || y - slots[i - 1] >= FLOW.edgeGap - 0.01), 'the edges arrive at the table at least one slot apart, so the tags cannot touch', slots.join());

console.log('== the routes behind an edge ==');
const listOf = (lane, dir) => edgeRoutes(data, edge(lane, dir));
const kernelOut = listOf('kernel1', 'out');
check(kernelOut.kind === 'exported' && kernelOut.total === 16 && kernelOut.title === 'Routes exported to kernel1' && /out of master4 · accept all/.test(kernelOut.subtitle), 'the routes handed to the kernel protocol are listed', j([kernelOut.kind, kernelOut.total, kernelOut.title, kernelOut.subtitle]));
const direct = listOf('direct1', 'in');
check(direct.kind === 'local' && direct.rows.length === 4 && direct.rows.every(r => r.protocol === 'direct1') && direct.title === 'Routes imported from direct1', 'the routes a Direct protocol put into the table');
const groupIn = listOf(g, 'in');
check(groupIn.kind === 'paths' && groupIn.total === 40 && /4 sessions/.test(groupIn.title) && groupIn.rows.every(r => r.peer.startsWith('azure_xfrm')), 'the paths learned from a group of sessions are all of them', j([groupIn.kind, groupIn.total, groupIn.title]));
const groupOut = listOf(g, 'out');
check(groupOut.kind === 'exported' && groupOut.total === 4 && new Set(groupOut.rows.map(r => r.to)).size === 4, 'what the group is sent: one route per session, each marked with the session it goes to');
const one = edgeRoutes(data, buildFlow(data, cfg, new Set([g])).edges.find(e => e.lane === 'azure_xfrm1' && e.dir === 'in'));
check(one.total === 10 && one.rows.every(r => r.peer === 'azure_xfrm1') && one.title === 'Routes imported from azure_xfrm1', 'one session of an opened group lists only its own paths');
const many = { ...data, paths: Array.from({ length: LIST_MAX + 50 }, (_, i) => ({ peer: 'azure_xfrm0', prefix: `10.${i >> 8}.${i & 255}.0/24`, table: 'master4' })) };
const big = edgeRoutes(many, buildFlow(many, cfg, new Set([g])).edges.find(e => e.lane === 'azure_xfrm0' && e.dir === 'in'));
check(big.rows.length === LIST_MAX && big.capped && big.total === LIST_MAX + 50, 'a very long list is cut at the limit and says so');
const noList = { ...data, protocols: data.protocols.map(p => p.name === 'kernel1' ? { ...p, exported: null } : p) };
check(edgeRoutes(noList, buildFlow(noList, cfg).edges.find(e => e.lane === 'kernel1' && e.dir === 'out')).total === 0, 'a protocol whose exports were not collected (too many) lists nothing');

console.log('== a group opened into its sessions ==');
const open = buildFlow(data, cfg, new Set([g]));
check(open.lanes.length === 8 && open.lanes.slice(4).every(l => l.member && !l.group && /^azure_xfrm\d$/.test(l.label)), 'an opened group has one lane per session', open.lanes.map(l => l.label).join());
check(open.edges.filter(e => e.lane.startsWith('azure_xfrm')).length === 8 && open.edges.filter(e => e.dir === 'in' && e.lane.startsWith('azure_xfrm')).every(e => e.count === 10 && e.countText === '10 routes'), 'each session has its own edges and counts');
check(open.outside[2].sub === '4 BGP neighbors', 'the neighbors node still counts the four sessions');
const different = buildFlow({ ...data, protocols: data.protocols.map(p => p.name === 'azure_xfrm3' ? { ...p, channels: [channel('bgp_in', 'bgp_other', 10, 0)] } : p) }, cfg);
check(different.lanes.map(l => l.label).join() === 'kernel1,device1,direct1,static1,azure_xfrm ×3,azure_xfrm3', 'a session with other filters does not join the group', different.lanes.map(l => l.label).join());

console.log('== without the file, and other shapes ==');
const bare = buildFlow(data, null);
check(bare.edges.every(e => e.tag.source === null && !/default/.test(e.tag.text)), 'without a configuration file nothing is called a default (it cannot be known)');
const down = buildFlow({ ...data, peers: data.peers.map(p => p.name === 'azure_xfrm1' ? { ...p, state: 'Active' } : p) }, cfg);
check(down.lanes[4].status === 'warn' && /3 of 4 Established/.test(down.lanes[4].sub), 'a group with a session that is down is flagged');
const dual = buildFlow({ ...data, protocols: data.protocols.map(p => p.name === 'static1' ? { ...p, channels: [...p.channels, { ...channel('ACCEPT', 'REJECT', 2, 0), afi: 'ipv6', table: 'master6' }] } : p) }, cfg);
check(dual.tables.map(t => t.name).join() === 'master4,master6' && dual.lanes[3].edges.length === 4 && dual.tables[0].y + dual.tables[0].h < dual.tables[1].y, 'a protocol with a second channel gets its own edges and a second table', dual.tables.map(t => t.name).join());
check(buildFlow({ protocols: [], peers: [], paths: [], local: [] }, null).lanes.length === 0, 'no protocols, no lanes');
check(buildFlow({ ...data, protocols: [{ name: 'device1', proto: 'Device', state: 'up', channels: [] }] }, null).tables.length === 0, 'a router with only Device has no table to draw');

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall flow checks passed');
