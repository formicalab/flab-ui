// Unit tests for the BGP tab's pure models: the BIRD configuration reader (www/js/pages/routing/bgp/configmodel.js) and the best-path
// explanation (routemodel.js); need no router. Usage: node config.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const here = rel => import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/routing/bgp', rel)).href);
const { mask, parseConfig, blockText, configOf, optionsOf, reviewConfig } = await here('configmodel.js');
const { candidates, decidedBy, explainPrefix } = await here('routemodel.js');

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

console.log('== scanning ==');
const m = mask('a { # note {\n  "x}y" /* c\n d */ b }\n');
check(m.masked === `a {${' '.repeat(9)}\n  "   "${' '.repeat(5)}\n${' '.repeat(6)}b }\n`, 'comments and string contents become spaces, newlines stay', j(m.masked));
check(j(m.commentCols) === '[4,8,0,-1]', 'comment columns per line (a block comment continues on the next line)', j(m.commentCols));

console.log('== blocks ==');
const text = [
  '# Kernel sync',
  'router id 192.168.1.1;',
  '',
  'protocol kernel {',
  '  ipv4 { export all; };',
  '}',
  '# A template { with braces in a comment }',
  'template bgp azure_vwan {',
  '  local 192.168.1.1 as 64512;',
  '  password "s3cret {not a block}";',
  '  ipv4 {',
  '    import filter bgp_in;',
  '    import limit 100 action restart;',
  '  };',
  '}',
  'filter bgp_in {',
  '  if net = 10.0.0.0/8 then reject; # }',
  '  accept;',
  '}',
  'function helper(int x) -> bool { return x > 1; }',
  '# Session 1',
  '# Direct peer',
  'protocol bgp azure_xfrm0 from azure_vwan {',
  '  neighbor 10.0.0.12 as 65515;',
  '}',
  'protocol bgp from azure_vwan { neighbor 10.0.0.13 as 65515; }',
  'protocol static { route 192.168.0.0/16 blackhole; }',
  '',
].join('\n');
const cfg = parseConfig(text);
const summary = cfg.blocks.map(b => `${b.kind}:${b.type ?? ''}:${b.name ?? ''}:${b.from ?? ''}:${b.startLine}-${b.endLine}`);
check(summary.join(' ') === 'protocol:kernel:::4-6 template:bgp:azure_vwan::8-15 filter::bgp_in::16-19 function::helper::20-20 protocol:bgp:azure_xfrm0:azure_vwan:23-25 protocol:bgp::azure_vwan:26-26 protocol:static:::27-27',
  'top-level blocks with kind, type, name, template and lines (braces in strings and comments ignored, channel blocks stay inside)', summary.join(' '));
const peer = cfg.blocks.find(b => b.name === 'azure_xfrm0');
check(peer.firstLine === 21 && blockText(cfg, peer).split('\n')[0] === '# Session 1', 'the comment lines right above a block are its documentation', String(peer.firstLine));
check(blockText(cfg, peer, false).startsWith('protocol bgp azure_xfrm0') && blockText(cfg, peer, false).endsWith('}'), 'blockText without the documentation');
check(configOf({ available: false }) === null && configOf({ available: true, text }) === configOf({ available: true, text }), 'configOf: null without a file, cached for the same text');

console.log('== options ==');
const bgp = body => parseConfig(`template bgp t { ${body} }\nprotocol bgp p1 from t { neighbor 1.1.1.1 as 2; }\nprotocol bgp p2 from t { authentication none; import all; export all; neighbor 1.1.1.2 as 2; }\nprotocol bgp p3 { neighbor 1.1.1.3 as 2; ipv4 { receive limit off; }; }`);
const withPassword = bgp('password "x"; ipv4 { import limit 10; };');
check(j(optionsOf(withPassword, 'p1')) === j({ authenticated: true, importLimit: true, importAll: false, exportAll: false }), 'a password and a limit in the template are inherited', j(optionsOf(withPassword, 'p1')));
check(optionsOf(withPassword, 'p2').authenticated === false && optionsOf(withPassword, 'p2').importAll && optionsOf(withPassword, 'p2').exportAll, 'the protocol overrides the template (authentication none) and says import/export all');
check(optionsOf(withPassword, 'p3').authenticated === false && optionsOf(withPassword, 'p3').importLimit === false, 'no template: nothing inherited, "limit off" is no limit');
check(optionsOf(bgp('authentication md5;'), 'p1').authenticated === true, 'authentication md5 counts');
check(optionsOf(withPassword, 'nosuch') === null, 'a protocol that is not in the file has no options');

console.log('== review ==');
const peerOf = (name, session = 'external multihop AS4') => ({ name, session });
const data = {
  config: { available: true, path: '/etc/bird.conf', mtime: 2000, text: `template bgp t { password "<redacted>"; }\nprotocol bgp a from t { neighbor 1.1.1.1 as 2; }\nprotocol bgp b { neighbor 1.1.1.2 as 2; import all; }\nprotocol bgp c { neighbor 1.1.1.3 as 2; }\nprotocol bgp gone { neighbor 1.1.1.4 as 2; }` },
  daemon: { reconfigured: 1000 },
  peers: [peerOf('a'), peerOf('b'), peerOf('c'), peerOf('i', 'internal')],
};
const review = reviewConfig(data).map(f => `[${f.level}] ${f.text}`);
check(review.some(t => t.startsWith('[warn]') && /changed after BIRD last read/.test(t)), 'a file newer than the last reconfiguration is reported', review.join(' | '));
check(review.some(t => /gone is in \/etc\/bird\.conf but not running/.test(t)), 'a configured protocol that is not running is reported');
check(review.some(t => /^\[warn\] b import every route/.test(t)), 'import all on an external session is a warning');
check(review.some(t => /^\[info\] No route limit .*sessions a, b and c:/.test(t)), 'sessions without a limit are named in one finding', review.join(' | '));
check(review.some(t => /^\[info\] No TCP authentication .*sessions b and c\./.test(t)) && !review.some(t => /authentication.*\ba\b/.test(t)), 'only the sessions without authentication are named; the internal one is not reviewed');
data.daemon.reconfigured = 3000;
check(!reviewConfig(data).some(t => /changed after BIRD/.test(t.text)), 'no drift warning when BIRD read the file after it changed');
check(reviewConfig({ ...data, config: null }).length === 0, 'no config, no review');

console.log('== best path ==');
const peers = [
  { name: 'p0', neighbor_as: 65515, session: 'external multihop AS4', router_id: '10.0.0.12' },
  { name: 'p1', neighbor_as: 65515, session: 'external multihop AS4', router_id: '10.0.0.13' },
  { name: 'p2', neighbor_as: 65515, session: 'external multihop AS4', router_id: '10.1.0.12' },
  { name: 'p3', neighbor_as: 65515, session: 'external multihop AS4', router_id: '10.1.0.13' },
];
const path_ = (peer, extra) => ({ prefix: '10.0.0.0/16', peer, best: false, preference: 100, local_pref: 100, med: null, as_path: ['65515'], origin: 'IGP', next_hop: '10.0.0.1', in_kernel: false, ...extra });
const pathsData = { peers, local: [{ prefix: '192.168.0.0/16', protocol: 'static1', preference: 200, best: true, in_kernel: true }], paths: [
  path_('p0', { best: true, in_kernel: true }),
  path_('p1', { in_kernel: true }),
  path_('p2', { as_path: ['65515', '65520', '65530'] }),
  path_('p3', { as_path: ['65515'], origin: 'Incomplete' }),
  { ...path_('p2', { prefix: '10.9.0.0/16', best: true, in_kernel: true }), local_pref: 200 },
  { ...path_('p3', { prefix: '10.9.0.0/16' }), local_pref: 100 },
  { ...path_('p0', { prefix: '10.8.0.0/16', best: true }), med: 10, in_kernel: true },
  { ...path_('p1', { prefix: '10.8.0.0/16' }), med: 50 },
] };
const ex = explainPrefix(pathsData, '10.0.0.0/16');
const roles = ex.rows.map(r => `${r.candidate.peer}:${r.role}`).join(' ');
check(roles === 'p0:best p1:ecmp p2:backup p3:backup', 'the best path first, then the equal-cost one and the backups', roles);
check(/equal-cost next hop/.test(ex.rows[1].reason), 'a tie with the best path that is installed is an ECMP next hop', ex.rows[1].reason);
check(/AS path length \(shortest wins\): 1 against 3/.test(ex.rows.find(r => r.candidate.peer === 'p2').reason), 'the longer AS path lost on the AS path rule', ex.rows.find(r => r.candidate.peer === 'p2').reason);
check(/origin .*: IGP against Incomplete/.test(ex.rows.find(r => r.candidate.peer === 'p3').reason), 'an incomplete origin lost on the origin rule');
check(/local preference .*: 200 against 100/.test(explainPrefix(pathsData, '10.9.0.0/16').rows[1].reason), 'local preference decides before the AS path');
check(/MED .*: 10 against 50/.test(explainPrefix(pathsData, '10.8.0.0/16').rows[1].reason), 'MED decides between paths of the same neighboring AS');
const lone = explainPrefix(pathsData, '192.168.0.0/16');
check(lone.rows.length === 1 && lone.rows[0].role === 'best' && /only route/.test(lone.rows[0].reason), 'a prefix with one route says so (a static route here)', j(lone.rows));
check(candidates(pathsData, '10.0.0.0/16').length === 4 && explainPrefix(pathsData, '1.1.1.0/24').best === null, 'candidates of a prefix; an unknown prefix has no best');
const a = { kind: 'bgp', preference: 100, localPref: 100, asPathLength: 1, origin: 'IGP', med: 0, neighborAs: 1, external: true, routerId: '10.0.0.12' };
check(decidedBy(a, { ...a, routerId: '10.0.0.13' }).rule.id === 'router_id' && decidedBy(a, { ...a }) === null, 'router ID is the last rule; identical paths are not decided');
check(decidedBy(a, { ...a, med: 5, neighborAs: 2 }) === null, 'MED is not compared between different neighboring ASes');

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall BGP model checks passed');
