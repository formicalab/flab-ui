// Builds synthetic BIRD scenarios from real captured command output (see run.ps1). Every scenario is a
// directory with the file names flab.bgp reads when FLAB_BGP_FIXTURES is set. The "down" block is modeled
// on BIRD's documented format for a session that cannot connect; it is synthetic, not captured.
// Usage: node mkfx.mjs <dir containing fx-real/>
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const real = path.join(root, 'fx-real');
const read = n => fs.readFileSync(path.join(real, n), 'utf8').replace(/\r\n/g, '\n');
const files = fs.readdirSync(real);

function scenario(name, edit) {
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const data = Object.fromEntries(files.map(f => [f, read(f)]));
  edit(data);
  for (const [f, text] of Object.entries(data)) fs.writeFileSync(path.join(dir, f), text);
}

// Splits `show protocols all` into per-protocol blocks (a block starts at a non-indented line).
const blocks = text => text.split(/^(?=\S)/m);
const joinBlocks = bs => bs.join('');

// Drops route entries of one protocol from `show route all`, handing the prefix (and the best marker) to the next path.
function dropRoutes(text, proto) {
  const lines = text.split('\n');
  const entries = [];
  for (const line of lines) {
    const isHead = !line.startsWith('\t') && /\s(unicast|blackhole|unreachable)\s/.test(line);
    if (isHead || !entries.length) entries.push({ head: line, body: [] }); else entries.at(-1).body.push(line);
  }
  const out = [];
  let carry = null;
  for (const e of entries) {
    const hasPrefix = /^\S/.test(e.head) && /\s(unicast|blackhole|unreachable)\s/.test(e.head);
    if (e.head.includes(`[${proto} `)) {
      if (hasPrefix) carry = { prefix: e.head.split(/\s+/)[0], best: /\] \* \(/.test(e.head) };
      continue;
    }
    if (carry && !hasPrefix && /\s(unicast|blackhole)\s/.test(e.head)) {
      e.head = carry.prefix.padEnd(21) + e.head.trimStart();
      if (carry.best && !/\] \* \(/.test(e.head)) e.head = e.head.replace(/\] \(/, '] * (');
      carry = null;
    } else if (hasPrefix) carry = null;
    out.push(e.head, ...e.body);
  }
  return out.join('\n');
}

// --- baseline: unchanged, proves the fixture path matches the live behavior
scenario('base', () => {});

// --- one session is down (Active), modeled on BIRD's documented format for a session that cannot connect
scenario('down', d => {
  const bs = blocks(d['show_protocols_all.txt']);
  const i = bs.findIndex(b => b.startsWith('azure_xfrm1'));
  bs[i] = [
    'azure_xfrm1 BGP        ---        start  2026-11-11    Active        Socket: Connection refused',
    '  Description:        Azure VPN - Tunnel_Azure_2',
    '  Created:            2026-11-06',
    '  BGP state:          Active',
    '    Neighbor address: 10.0.0.13',
    '    Neighbor AS:      65515',
    '    Local AS:         64512',
    '    Connect delay:    3.210/5',
    '    Last error:       Socket: Connection refused',
    '  Channel ipv4',
    '    State:          DOWN',
    '    Table:          master4',
    '    Preference:     100',
    '    Input filter:   bgp_azure_import',
    '    Output filter:  bgp_azure_export',
    '    IGP IPv4 table: master4',
    '',
  ].join('\n');
  d['show_protocols_all.txt'] = joinBlocks(bs);
  d['show_route_all.txt'] = dropRoutes(d['show_route_all.txt'], 'azure_xfrm1');
  d['show_route_export_azure_xfrm1.txt'] = 'BIRD 3.3.3 ready.\n';
  d['ip4.txt'] = d['ip4.txt'].split('\n').filter(l => !l.includes('via 10.0.0.13 dev xfrm1')).join('\n');
});

// --- dual stack: IPv6 channels, IPv6 routes with ECMP, one best route missing from the kernel, IPv6 announcement
scenario('dual', d => {
  const v6Channel = [
    '  Channel ipv6',
    '    State:          UP',
    '    Import state:   UP',
    '    Export state:   READY',
    '    Table:          master6',
    '    Preference:     100',
    '    Input filter:   bgp_azure_import',
    '    Output filter:  bgp_azure_export',
    '    Routes:         3 imported, 1 exported, 2 preferred',
    '    Route change stats:     received   rejected   filtered    ignored   RX limit      limit   accepted',
    '      Import updates:              3          0          0          0          0          0         3',
    '      Import withdraws:            0          0        ---          0        ---        ---          0',
    '      Export updates:              4          1          2          0        ---          0         1',
    '      Export withdraws:            0        ---        ---          0        ---        ---          0',
    '    BGP Next hop:   2001:db8:ffff::99 fe80::99',
    '    IGP IPv6 table: master6',
    '',
  ].join('\n');
  const bs = blocks(d['show_protocols_all.txt']);
  for (const name of ['azure_xfrm0', 'azure_xfrm1']) {
    const i = bs.findIndex(b => b.startsWith(name));
    bs[i] = bs[i].replace(/\n+$/, '\n') + v6Channel;
  }
  bs.push('static2    Static     master6    up     2026-11-06    \n  Created:            2026-11-06\n  Channel ipv6\n    State:          UP\n    Table:          master6\n    Preference:     200\n    Input filter:   ACCEPT\n    Output filter:  REJECT\n    Routes:         1 imported, 0 exported, 1 preferred\n');
  d['show_protocols_all.txt'] = joinBlocks(bs);

  const bgp6 = (proto, via, ll, id) => [
    `\tvia ${ll} on ${via}`, `\thostentry: via ${ll} table master6`, '\tpreference: 100', '\tlocal_metric: 0',
    '\tfrom: 2001:db8:ffff::1', '\tsource: BGP', '\tbgp_origin: IGP', '\tbgp_path: 65515',
    `\tbgp_next_hop: 2001:db8:ffff::${id} ${ll}`, '\tbgp_local_pref: 100', '\tbgp_large_community: (65515, 1, 2)',
    `\tInternal route handling values: 0L 9G 0S id ${90 + id}`].join('\n');
  d['show_route_all.txt'] = d['show_route_all.txt'].replace(/\n*$/, '\n') + [
    'Table master6:',
    '2001:db8:100::/48    unicast [azure_xfrm0 2026-11-06] * (100) [AS65515i]', bgp6('azure_xfrm0', 'xfrm0', 'fe80::a', 1),
    '                     unicast [azure_xfrm1 2026-11-06] (100) [AS65515i]', bgp6('azure_xfrm1', 'xfrm1', 'fe80::b', 2),
    '2001:db8:300::/48    unicast [azure_xfrm0 2026-11-06] * (100) [AS65515i]', bgp6('azure_xfrm0', 'xfrm0', 'fe80::a', 3),
    '2001:db8:f00d::/48   blackhole [static2 2026-11-06] * (200)', '\tpreference: 200', '\tsource: static', '\tInternal route handling values: 0L 4G 0S id 95',
    '',
  ].join('\n');
  d['ip6.txt'] = [
    '2001:db8:100::/48 metric 32 pref medium', '\tnexthop via fe80::a dev xfrm0 weight 1', '\tnexthop via fe80::b dev xfrm1 weight 1',
    'blackhole 2001:db8:f00d::/48 metric 32 pref medium', ''].join('\n');
  d['show_route_export_azure_xfrm0.txt'] = d['show_route_export_azure_xfrm0.txt'].replace(/\n*$/, '\n') +
    'Table master6:\n2001:db8:f00d::/48   blackhole [static2 2026-11-06] * (200)\n\tpreference: 200\n\tsource: static\n';
});

// --- announcements change: per-peer differences, a non-static origin, and one peer receiving nothing
scenario('announce', d => {
  const head = 'BIRD 3.3.3 ready.\nTable master4:\n';
  const direct = '10.0.0.12/32         unicast [direct1 2026-11-06] * (240)\n\tdev xfrm0\n\tpreference: 240\n\tsource: device\n';
  const ospf = '192.168.50.0/24      unicast [ospf1 2026-11-06] * (150/10)\n\tvia 192.168.1.9 on br-lan\n\tpreference: 150\n\tsource: OSPF\n';
  d['show_route_export_azure_xfrm0.txt'] += direct;
  d['show_route_export_azure_xfrm1.txt'] += ospf;
  d['show_route_export_azure_xfrm3.txt'] = head;
});

console.log('scenarios:', fs.readdirSync(root).filter(n => n !== 'fx-real').join(', '));
