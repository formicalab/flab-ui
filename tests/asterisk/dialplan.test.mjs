// Unit test for the Dialplan model (www/js/pages/asterisk/dialplanmodel.js): pattern matching, the search order over includes, what steps jump to and
// dial, and the routing map. Pure functions: no router and no browser. The sample dialplan has the shape of `flab.asterisk dialplan` and the
// structure of the lab router's real one. Usage: node dialplan.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const m = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/asterisk/dialplanmodel.js')).href);
const { appInfo } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/asterisk/apps.js')).href);

let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

const step = (prio, app, data = '', label = null) => ({ prio, label, app, data, source: null });
const ext = (pattern, ...steps) => ({ pattern, steps: steps.map((s, i) => ({ ...s, prio: i + 1 })) });
const dial = (t, opts = '120,T') => step(0, 'Dial', `${t},${opts}`);

const dp = {
  contexts: [
    { name: 'from-pstn', includes: [], extensions: [
      ext('+390691602383', step(0, 'NoOp', 'in'), step(0, 'GotoIf', '$["${CALLERID(num)}" = "3346407117"]?remote-access,s,1'), step(0, 'Goto', 's,handle-incoming')),
      ext('s', step(0, 'NoOp', 'no DID'), { ...dial('PJSIP/1001', '30,rt'), label: 'handle-incoming' },
        step(0, 'GotoIf', '$["${DIALSTATUS}" = "CHANUNAVAIL"]?unavailable,s,1'), step(0, 'GotoIf', '$["${DIALSTATUS}" = "BUSY"]?busy'), step(0, 'Hangup'),
        { ...step(0, 'Busy', '10'), label: 'busy' }),
      ext('_+X.', step(0, 'Goto', 's,handle-incoming')),
      ext('_X.', step(0, 'Goto', 's,handle-incoming')),
    ] },
    { name: 'from-internal', includes: ['internal-lab'], extensions: [
      ext('112', dial('PJSIP/${EXTEN}@Vodafone', '120')),
      ext('_+39.', dial('PJSIP/${EXTEN}@Vodafone')),
      ext('_00.', dial('PJSIP/+${EXTEN:2}@Vodafone')),
      ext('_0[1-9].', step(0, 'Set', 'N=${LEN(${EXTEN})}'), step(0, 'GotoIf', '$[${N} < 6]?bad'), dial('PJSIP/+39${EXTEN}@Vodafone'), step(0, 'Hangup'), { ...step(0, 'Congestion', '5'), label: 'bad' }),
      ext('_1XXX', dial('PJSIP/${EXTEN}', '30,tT')),
      ext('_3XXXXXXXXX', dial('PJSIP/+39${EXTEN}@Vodafone')),
    ] },
    { name: 'internal-lab', includes: [], extensions: [ext('6000', step(0, 'Answer'), step(0, 'Echo')), ext('_1XXX', step(0, 'NoOp', 'shadowed'))] },
    { name: 'remote-access', includes: [], extensions: [ext('s', step(0, 'Answer'), step(0, 'Goto', 'ghost,s,1'))] },
    { name: 'unavailable', includes: [], extensions: [ext('s', step(0, 'Playback', 'x'), step(0, 'Hangup'))] },
    { name: 'orphan', includes: [], extensions: [ext('s', step(0, 'Hangup'))] },
  ],
};

console.log('== extension patterns ==');
check(m.matchPattern('6000', '6000') && !m.matchPattern('6000', '60001'), 'an exact name must be equal');
check(m.matchPattern('_1XXX', '1002') && !m.matchPattern('_1XXX', '10020') && !m.matchPattern('_1XXX', '102'), 'X is one digit and the whole string is used');
check(m.matchPattern('_0[1-9].', '0612345') && !m.matchPattern('_0[1-9].', '0012345') && !m.matchPattern('_0[1-9].', '06'), '[1-9] is a range and "." needs one more character');
check(m.matchPattern('_Z.', '15') && !m.matchPattern('_Z.', '05') && m.matchPattern('_N.', '25') && !m.matchPattern('_N.', '15'), 'Z is 1-9 and N is 2-9');
check(m.matchPattern('_+X.', '+39612345') && !m.matchPattern('_+X.', '39612345'), 'a plus sign is an ordinary character');
check(m.matchPattern('_[13-5]X', '42') && !m.matchPattern('_[13-5]X', '22'), 'a set with a range and singles');
check(m.matchPattern('_9!', '9') && m.matchPattern('_9!', '91234'), '"!" accepts any rest, even none');
check(m.matchPattern('_1-2 X', '123'), 'spaces and dashes are ignored in a pattern');
check(!m.matchPattern('s', '1') && m.matchPattern('s', 's'), 'the special name s matches only itself');
check(m.describePattern('_0[1-9].') === '“0”, then 1–9, then one or more of anything', 'describes a pattern in words', m.describePattern('_0[1-9].'));
check(m.describePattern('_1XXX') === '“1”, then a digit, then a digit, then a digit' && /^start/.test(m.describePattern('s')) && m.describePattern('6000') === 'exactly “6000”', 'describes names', m.describePattern('_1XXX'));

console.log('== searching the dialplan (as `dialplan show <exten>@<context>` does on the router) ==');
const f = (ctx, num) => m.findExtension(dp, ctx, num);
check(f('from-internal', '1002').extension.pattern === '_1XXX' && f('from-internal', '1002').context === 'from-internal', '1002 in from-internal is handled by _1XXX');
check(f('from-internal', '0612345').extension.pattern === '_0[1-9].', '0612345 is handled by _0[1-9].');
check(f('from-internal', '6000').context === 'internal-lab' && j(f('from-internal', '6000').via) === '["internal-lab"]', '6000 is found through the include');
check(f('from-internal', '1999').context === 'from-internal', 'the context’s own extensions come before the included ones (_1XXX is in both)');
check(f('from-internal', '99999') === null, 'no match');
check(f('from-pstn', '+390691602383').extension.pattern === '+390691602383' && f('from-pstn', '+39555').extension.pattern === '_+X.', 'an exact name wins over a pattern; the more specific pattern comes first');
check(f('nowhere', '1') === null, 'a missing context finds nothing');
const loop = { contexts: [{ name: 'a', includes: ['b'], extensions: [] }, { name: 'b', includes: ['a'], extensions: [ext('1', step(0, 'Hangup'))] }] };
check(m.findExtension(loop, 'a', '1').context === 'b' && m.findExtension(loop, 'a', '2') === null, 'include loops end');

console.log('== what a step does ==');
const from = { context: 'from-pstn', exten: 'x' };
const pstn = dp.contexts[0];
let jumps = m.stepJumps(dp, pstn.extensions[0].steps[1], from);
check(jumps.length === 1 && jumps[0].branch === 'then' && jumps[0].context === 'remote-access' && jumps[0].exten === 's' && jumps[0].prio === 1, 'GotoIf with a full destination', j(jumps));
jumps = m.stepJumps(dp, pstn.extensions[0].steps[2], { context: 'from-pstn', exten: '+390691602383' });
check(jumps.length === 1 && jumps[0].exten === 's' && jumps[0].prio === 2 && jumps[0].label === 'handle-incoming', 'Goto exten,label resolves the label to its priority', j(jumps));
jumps = m.stepJumps(dp, pstn.extensions[1].steps[3], { context: 'from-pstn', exten: 's' });
check(jumps.length === 1 && jumps[0].exten === 's' && jumps[0].label === 'busy' && jumps[0].prio === 6, 'a label in the same extension', j(jumps));
jumps = m.stepJumps(dp, step(1, 'GotoIf', '$[1 = 1]?yes,s,1:no,s,1'), { context: 'remote-access', exten: 's' });
check(jumps.length === 2 && jumps.map(x => x.branch).join() === 'then,else' && jumps[0].missing === 'context', 'GotoIf has two branches, a missing context is flagged', j(jumps));
jumps = m.stepJumps(dp, step(1, 'GotoIf', '$["${X}" = "a?b"]?s,1'), { context: 'unavailable', exten: 's' });
check(jumps.length === 1 && jumps[0].cond.includes('a?b') && jumps[0].prio === 1, 'a question mark inside quotes does not split the condition', j(jumps));
jumps = m.stepJumps(dp, step(1, 'ExecIf', '$[1 = 1]?Goto(unavailable,s,1)'), { context: 'x', exten: 'y' });
check(jumps.length === 1 && jumps[0].context === 'unavailable' && jumps[0].branch === 'then', 'ExecIf wrapping a Goto', j(jumps));
check(m.stepJumps(dp, step(1, 'Goto', '${DEST}'), from)[0].dynamic === true, 'a jump through a variable is dynamic');
check(m.stepJumps(dp, step(1, 'Hangup'), from).length === 0, 'Hangup does not jump');

const dials = d => m.stepDials(step(1, 'Dial', d));
check(j(dials('PJSIP/1001,30,rt')) === j([{ tech: 'PJSIP', kind: 'endpoint', endpoint: '1001', raw: 'PJSIP/1001' }]), 'Dial of a named endpoint');
check(dials('PJSIP/+39${EXTEN}@Vodafone,120,T')[0].endpoint === 'Vodafone', 'Dial number@endpoint names the endpoint after the @');
check(dials('PJSIP/${EXTEN},30')[0].kind === 'dynamic', 'a variable in the endpoint position is dynamic');
check(dials('PJSIP/a&PJSIP/b&Local/s@lab,20').map(x => x.kind).join() === 'endpoint,endpoint,local' && dials('PJSIP/a&PJSIP/b&Local/s@lab,20')[2].context === 'lab', 'several channels with &');
check(dials('DAHDI/1,20')[0].kind === 'other' && m.stepDials(step(1, 'Hangup')).length === 0, 'other technologies; only Dial dials');
const vars = m.globalVars({ globals: [{ name: 'OUTBOUND_TRUNK', value: 'Vodafone' }, { name: 'PIN', value: '<redacted>' }] });
const viaGlobal = m.stepDials(step(1, 'Dial', 'PJSIP/${ARG1}@${OUTBOUND_TRUNK},120,${ARG2}'), vars);
check(viaGlobal.length === 1 && viaGlobal[0].kind === 'endpoint' && viaGlobal[0].endpoint === 'Vodafone' && viaGlobal[0].via === 'OUTBOUND_TRUNK', 'a global in the endpoint position is resolved', j(viaGlobal));
check(m.stepDials(step(1, 'Dial', 'PJSIP/${ARG1}@${OUTBOUND_TRUNK}'))[0].kind === 'dynamic' && m.stepDials(step(1, 'Dial', 'PJSIP/${ARG1}@${NOPE}'), vars)[0].kind === 'dynamic' && !('PIN' in vars), 'an unknown global, or none given, stays dynamic; a redacted one is left out');
const viaMap = m.buildMap({ globals: [{ name: 'OUTBOUND_TRUNK', value: 'Clouditalia' }], contexts: [{ name: 'sub-trunk', includes: [], extensions: [ext('s', dial('PJSIP/${ARG1}@${OUTBOUND_TRUNK}', '120'))] }] },
  { available: true, endpoints: [{ name: 'Clouditalia', role: 'trunk', context: 'sub-trunk', state: 'Not in use' }] });
check(viaMap.edges.some(e => e.kind === 'dial' && e.to === 'tg:Clouditalia') && !viaMap.targets.some(t => t.id === 'tg:dynamic') && viaMap.findings.every(x => x.level !== 'warn'), 'the routing map follows the global to the trunk', j(viaMap.edges));
const gdp = { globals: [{ name: 'OUTBOUND_TRUNK', value: 'Vodafone' }], contexts: [
  { name: 'out', includes: [], extensions: [ext('112', step(1, 'Gosub', 'sub-trunk,s,1(${EXTEN})'), step(2, 'Hangup')), ext('loop', step(1, 'Goto', 'loop,1')), ext('dyn', step(1, 'Goto', '${X},s,1'))] },
  { name: 'sub-trunk', includes: [], extensions: [ext('s', dial('PJSIP/${ARG1}@${OUTBOUND_TRUNK}', '120'), step(2, 'Return'))] }] };
const follow = m.extensionDials(gdp, 'out', gdp.contexts[0].extensions[0], m.globalVars(gdp));
check(follow.length === 1 && follow[0].endpoint === 'Vodafone' && follow[0].through === 'sub-trunk', 'the dials of a subroutine are found through its Gosub', j(follow));
check(m.extensionDials(gdp, 'out', gdp.contexts[0].extensions[1]).length === 0 && m.extensionDials(gdp, 'out', gdp.contexts[0].extensions[2]).length === 0, 'a jump loop ends and a jump through a variable is not followed');

console.log('== the routing map ==');
const ep = (name, role, context, state = 'Not in use') => ({ name, role, context, state });
const pjsip = { available: true, endpoints: [ep('1001', 'phone', 'from-internal', 'Unavailable'), ep('Vodafone', 'trunk', 'from-pstn'), ep('Clouditalia', 'trunk', 'from-pstn')] };
const map = m.buildMap(dp, pjsip);
check(map.entries.length === 3 && map.entries.every(e => e.known), 'every endpoint enters a defined context');
check(map.edges.filter(e => e.kind === 'enter').map(e => `${e.from}>${e.to}`).sort().join() === 'ep:1001>ctx:from-internal,ep:Clouditalia>ctx:from-pstn,ep:Vodafone>ctx:from-pstn', 'entry edges');
const vf = map.edges.find(e => e.kind === 'dial' && e.from === 'ctx:from-internal' && e.to === 'tg:Vodafone');
check(vf && vf.patterns.includes('_0[1-9].') && vf.patterns.includes('112') && vf.count >= 5, 'from-internal reaches Vodafone through its calling extensions', j(vf));
check(map.edges.some(e => e.from === 'ctx:from-internal' && e.to === 'tg:dynamic' && e.patterns.includes('_1XXX')), '_1XXX dials a dynamic endpoint');
check(map.edges.some(e => e.from === 'ctx:from-pstn' && e.to === 'tg:1001'), 'the incoming context dials the phone');
check(map.targets.find(t => t.id === 'tg:Vodafone').state === 'Not in use' && map.targets.find(t => t.id === 'tg:1001').known, 'targets carry the live state of known endpoints');
check(map.contexts.find(c => c.name === 'from-pstn').jumps.join() === 'remote-access,unavailable', 'jumps to other contexts are collected', j(map.contexts.find(c => c.name === 'from-pstn').jumps));
check(map.contexts.find(c => c.name === 'internal-lab').reached && map.contexts.find(c => c.name === 'remote-access').reached && !map.contexts.find(c => c.name === 'orphan').reached, 'reached: entered, included or jumped to; the orphan is not');
check(map.findings.some(x => /“orphan” is not used/.test(x.text)), 'an unused context is noted', j(map.findings));
check(map.findings.some(x => x.level === 'warn' && /ghost/.test(x.text) && /context does not exist/.test(x.text)), 'a jump to a missing context is a warning', j(map.findings));
const wrong = m.buildMap(dp, { available: true, endpoints: [ep('1001', 'phone', 'nowhere'), ep('Vodafone', 'trunk', 'from-pstn')] });
check(wrong.entries[0].known === false && wrong.findings.some(x => /context “nowhere”/.test(x.text)), 'an endpoint with an unknown context is a warning');
check(wrong.findings.some(x => /PJSIP\/1001.*no endpoint|Asterisk has no endpoint/.test(x.text)) === false, 'known endpoints are not reported as missing');
const missing = m.buildMap(dp, { available: true, endpoints: [ep('Vodafone', 'trunk', 'from-pstn')] });
check(missing.findings.some(x => /dials PJSIP\/1001.*no endpoint of that name/.test(x.text)) && missing.targets.find(t => t.id === 'tg:1001').known === false, 'dialing an unknown endpoint is a warning');
const noPjsip = m.buildMap(dp, null);
check(noPjsip.entries.length === 0 && noPjsip.edges.every(e => e.kind === 'dial') && noPjsip.findings.every(x => !/not used by any endpoint/.test(x.text)), 'without PJSIP the map has only the dialplan side and no “unused” noise');

console.log('== applications ==');
check(appInfo('Dial').cat === 'dial' && appInfo('Hangup').cat === 'end' && appInfo('NoSuchApp').cat === 'other' && appInfo('NoSuchApp').text === '', 'application categories and unknown names');

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll dialplan model checks passed');
