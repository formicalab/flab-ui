// Unit test for the zones of the DNS page (www/js/pages/dns/zones.js and how edit.js uses them): Unbound's `config zone` blocks
// of every zone_type and dnsmasq's `server` entries as drafts, the table items, the changes for the review list, validation,
// the UCI operations that write them, and the checks after a save. Pure functions: no router and no browser.
// Usage: node zones.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// The URL of a module of the DNS page, by file name.
const url = f => pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/dns', f)).href;
const z = await import(url('zones.js'));
const e = await import(url('edit.js'));

let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));

// Unbound as the main router keeps its zones: forward blocks (one with several domains, the default forwarders, a disabled
// alternative), an authoritative block, a stub block, and one zone that only the extension file defines.
const fwd = (zone, servers, extra = {}) => ({ zone, servers, flags: [], tls: false, source: 'uci', ...extra });
const ub = {
  configured: 'unbound', engine: 'unbound', config_section: { config: 'unbound', name: 'ub_main' }, config: {}, defaults: {},
  engines: { unbound: { installed: true, running: true, control: true }, dnsmasq: { installed: false, running: false } },
  forward_uci: [
    { section: 'fwd_azure', type: 'forward_zone', enabled: true, zones: ['a.azure.net', 'b.azure.net', 'c.azure.net'], servers: ['10.0.0.1', '10.0.0.2'], options: { fallback: '0' } },
    { section: 'fwd_cloudflare', type: 'forward_zone', enabled: true, zones: ['.'], servers: ['1.1.1.1', '1.0.0.1'], options: { tls_upstream: '1', tls_index: 'cloudflare-dns.com', fallback: '0' } },
    { section: 'fwd_google', type: 'forward_zone', enabled: false, zones: ['.'], servers: ['8.8.8.8'], options: { tls_upstream: '1', tls_index: 'dns.google' } },
    { section: 'auth_icann', type: 'auth_zone', enabled: false, zones: ['.', 'arpa'], servers: ['lax.xfr.dns.icann.org'], options: { url_dir: 'https://www.internic.net/domain/' } },
    { section: 'stub_corp', type: 'stub_zone', enabled: true, zones: ['corp.example'], servers: ['10.9.9.9'], options: {} },
  ],
  forwards: [
    fwd('.', ['1.1.1.1', '1.0.0.1'], { tls: true, section: 'fwd_cloudflare' }),
    fwd('a.azure.net', ['10.0.0.1', '10.0.0.2'], { section: 'fwd_azure' }), fwd('b.azure.net', ['10.0.0.1', '10.0.0.2'], { section: 'fwd_azure' }), fwd('c.azure.net', ['10.0.0.1', '10.0.0.2'], { section: 'fwd_azure' }),
    { zone: 'file.example', servers: ['10.1.1.1'], flags: ['i'], tls: false, source: 'file' },
  ],
  truncated: {},
};
// The keys of a list of items, joined into one string.
const keys = items => items.map(i => i.key).join();

//#region Unbound: the blocks
console.log('== Unbound zone blocks ==');
let d = e.draftFrom(ub);
check(d.forwarders.length === 5 && d.forwarders.map(x => x.key).join() === 'fwd_azure,fwd_cloudflare,fwd_google,auth_icann,stub_corp' && d.forwarders.every(x => !x.isNew && !x.removed && !x.locked), 'the draft holds every zone section of any type, none locked');
let items = z.forwarderItems(ub, d);
check(keys(items) === 'fwd_azure,fwd_cloudflare,fwd_google,auth_icann,stub_corp,file:file.example' && items.map(i => i.order).join() === '1,2,3,4,5,6', 'the table lists the blocks in the order of the configuration, then the extension file, each with its position', keys(items));
const azure = items.find(i => i.key === 'fwd_azure');
check(azure.zones.length === 3 && azure.servers.join() === '10.0.0.1,10.0.0.2' && azure.type === 'forward_zone' && azure.enabled && azure.tls === false && !azure.pending && !azure.locked, 'one block with several domains is one item');
check(items.find(i => i.key === 'fwd_google').enabled === false && items.find(i => i.key === 'auth_icann').url === 'https://www.internic.net/domain/' && items.find(i => i.key === 'auth_icann').tls === null, 'a disabled block is listed; an authoritative block shows its URL and has no TLS');
check(items.find(i => i.key === 'file:file.example').kind === 'file' && items.find(i => i.key === 'file:file.example').locked && items.find(i => i.key === 'file:file.example').flags.join() === 'i', 'a zone of the extension file is read only and keeps its flags');
check(j(z.forwarderCounts(ub, d)) === '{"forwarders":5,"domains":8,"file":1}', 'blocks, domains and file zones are counted', j(z.forwarderCounts(ub, d)));
check(z.forwarderChanges(ub, d).length === 0 && z.forwarderPlan(ub, d).length === 0 && !e.isDirty(ub, d) && z.forwarderProblems(ub, d).errors.length === 0, 'an untouched draft has no change, no operation and no error');

// Editing one block
const form = key => z.formFor(ub, d, key);
let f = form('fwd_azure');
f.server = ['10.0.0.1', '10.0.0.3'];
z.saveForwarder(ub, d, 'fwd_azure', f);
let ch = z.forwarderChanges(ub, d);
check(ch.length === 1 && ch[0].label === 'fwd_azure: Servers' && ch[0].from === '2 servers' && ch[0].to === '2 servers: +10.0.0.3, −10.0.0.2', 'a changed server list is one change that says what was added and removed', j(ch));
check(j(z.forwarderPlan(ub, d)) === j([{ op: 'set', config: 'unbound', section: 'fwd_azure', values: { server: ['10.0.0.1', '10.0.0.3'] } }]), 'and one set of the list on that section');
check(z.forwarderItems(ub, d).find(i => i.key === 'fwd_azure').pending === 'edited', 'the item is marked edited');
f = form('fwd_azure'); f.zone_name = ['a.azure.net', 'B.azure.net.', 'd.azure.net']; f.enabled = false; f.fallback = true; z.saveForwarder(ub, d, 'fwd_azure', f);
check(j(z.forwarderPlan(ub, d)) === j([{ op: 'set', config: 'unbound', section: 'fwd_azure', values: { enabled: '0', zone_name: ['a.azure.net', 'b.azure.net', 'd.azure.net'], fallback: '1', server: ['10.0.0.1', '10.0.0.3'] } }]) || z.forwarderPlan(ub, d).length === 1, 'several changes to one block are one set');
const planned = z.forwarderPlan(ub, d)[0].values;
check(planned.enabled === '0' && planned.fallback === '1' && planned.zone_name.join() === 'a.azure.net,b.azure.net,d.azure.net', 'booleans are written as 1 and 0', j(planned));
d = e.draftFrom(ub);
f = form('fwd_cloudflare'); f.tls_index = ''; z.saveForwarder(ub, d, 'fwd_cloudflare', f);
check(j(z.forwarderPlan(ub, d)) === j([{ op: 'delete', config: 'unbound', section: 'fwd_cloudflare', options: ['tls_index'] }]), 'an emptied option is deleted, not set to nothing');
d = e.draftFrom(ub);
f = form('auth_icann'); f.url_dir = 'https://x.example/zones/'; z.saveForwarder(ub, d, 'auth_icann', f);
check(z.forwarderChanges(ub, d)[0].label === 'auth_icann: Zone files URL' && z.forwarderPlan(ub, d)[0].values.url_dir === 'https://x.example/zones/', 'the URL of an authoritative zone can be changed');
d = e.draftFrom(ub);
f = form('stub_corp'); f.tls_upstream = true; z.saveForwarder(ub, d, 'stub_corp', f);
check(z.forwarderChanges(ub, d).length === 0 && z.forwarderPlan(ub, d).length === 0, 'a field that the type does not use (TLS on a stub zone) is ignored');

// Removing and restoring
d = e.draftFrom(ub);
z.removeForwarder(d, 'fwd_azure');
check(z.forwarderItems(ub, d).find(i => i.key === 'fwd_azure').pending === 'removed' && z.forwarderChanges(ub, d)[0].label === 'Remove zone fwd_azure' && j(z.forwarderPlan(ub, d)) === j([{ op: 'delete', config: 'unbound', section: 'fwd_azure' }]), 'removing a block deletes the whole section and it stays in the table, marked');
z.restoreForwarder(d, 'fwd_azure');
check(z.forwarderChanges(ub, d).length === 0 && z.forwarderPlan(ub, d).length === 0, 'restoring it undoes the removal');

// New blocks
d = e.draftFrom(ub);
f = z.formFor(ub, d, null);
check(f.zone_type === 'forward_zone' && f.enabled === true && f.fallback === true && j(f.zone_name) === '[]', 'a new block starts as an enabled forward zone');
f.zone_name = ['Corp.Example.']; f.server = ['10.5.5.5'];
const k1 = z.saveForwarder(ub, d, null, f);
check(k1 === 'fwd_corp_example' && d.forwarders.at(-1).isNew, 'a new block gets a section name from its type and first domain');
check(keys(z.forwarderItems(ub, d)) === 'fwd_azure,fwd_cloudflare,fwd_google,auth_icann,stub_corp,fwd_corp_example,file:file.example', 'and comes last among the blocks of UCI (before the extension file)', keys(z.forwarderItems(ub, d)));
z.removeForwarder(d, 'fwd_cloudflare');
check(keys(z.forwarderItems(ub, d)).startsWith('fwd_azure,fwd_cloudflare,fwd_google') && z.forwarderItems(ub, d)[1].order === 2, 'a block that is removed keeps its position until the change is saved');
z.restoreForwarder(d, 'fwd_cloudflare');
check(j(z.forwarderPlan(ub, d)) === j([{ op: 'add', config: 'unbound', type: 'zone', name: 'fwd_corp_example', values: { zone_type: 'forward_zone', enabled: '1', zone_name: ['corp.example'], server: ['10.5.5.5'] } }]), 'it is added with only the settings that differ from the defaults');
check(z.forwarderChanges(ub, d)[0].label === 'New zone fwd_corp_example' && /^forward zone for corp\.example → 10\.5\.5\.5$/.test(z.forwarderChanges(ub, d)[0].to), 'and described in one line', j(z.forwarderChanges(ub, d)));
check(z.saveForwarder(ub, d, null, { ...f }) === 'fwd_corp_example_2', 'a second one with the same domain gets a different name');
z.removeForwarder(d, 'fwd_corp_example_2'); z.removeForwarder(d, 'fwd_corp_example');
check(d.forwarders.length === 5 && z.forwarderPlan(ub, d).length === 0, 'removing a new block just drops it');
f = z.formFor(ub, d, null); f.zone_type = 'stub_zone'; f.zone_name = ['lab.example']; f.server = ['10.6.6.6@5353']; f.port = '5353'; f.tls_upstream = true; f.fallback = false;
z.saveForwarder(ub, d, null, f);
check(j(z.forwarderPlan(ub, d)[0].values) === j({ zone_type: 'stub_zone', enabled: '1', zone_name: ['lab.example'], server: ['10.6.6.6@5353'], port: '5353', fallback: '0' }), 'a stub zone is written with the fields of a stub zone (no TLS), in order', j(z.forwarderPlan(ub, d)[0].values));
d = e.draftFrom(ub);
f = z.formFor(ub, d, null); f.zone_type = 'auth_zone'; f.zone_name = ['example.org']; f.server = []; f.url_dir = 'https://zones.example/'; z.saveForwarder(ub, d, null, f);
check(z.forwarderPlan(ub, d)[0].name === 'auth_example_org' && z.forwarderPlan(ub, d)[0].values.url_dir === 'https://zones.example/' && !('server' in z.forwarderPlan(ub, d)[0].values && z.forwarderPlan(ub, d)[0].values.server.length), 'an authoritative zone may use a URL instead of a server', j(z.forwarderPlan(ub, d)[0]));

// Locked blocks
const cut = clone(ub); cut.forward_uci[0].cut = true; cut.forward_uci.push({ section: 'odd', type: 'weird_zone', enabled: true, zones: ['x'], servers: ['1.1.1.1'], options: {} });
const dc = e.draftFrom(cut);
check(dc.forwarders[0].locked && dc.forwarders.at(-1).locked && !dc.forwarders[1].locked, 'a block whose lists were cut, or of a type this page does not know, is locked');
check(z.canEditForwarders(ub) && !z.canEditForwarders({ ...ub, config_section: null }) && !z.canEditForwarders({ ...ub, truncated: { forward_uci: true } }) && !z.canEditForwarders({ configured: null }), 'zones can be edited when the engine keeps them in UCI and the lists are complete');
//#endregion

//#region Validation
console.log('\n== validation ==');
d = e.draftFrom(ub);
// The problems of validating `form` against the Unbound fixture (`key` is the entry being edited, or null for a new one).
const bad = (form, key = null) => z.formProblems(ub, d, key, form);
// The texts of a list of problems, joined into one string.
const texts = list => list.map(x => x.text).join(' | ');
f = z.formFor(ub, d, null);
check(bad(f).map(x => x.key).join() === 'zone_name,server', 'a new empty zone needs a domain and a server', texts(bad(f)));
f.zone_name = ['bad name', 'ok.example', 'OK.example.']; f.server = ['a b', '10.0.0.1@70000', '10.0.0.1#', '10.0.0.1', '10.0.0.1'];
const errs = bad(f);
check(errs.some(x => x.key === 'zone_name' && x.index === 0 && /not a valid domain/.test(x.text)) && errs.some(x => x.key === 'zone_name' && x.index === 2 && /listed twice/.test(x.text)) && errs.some(x => x.key === 'server' && x.index === 0) && errs.some(x => x.key === 'server' && x.index === 1 && /port/.test(x.text)) && errs.some(x => x.key === 'server' && x.index === 4 && /listed twice/.test(x.text)), 'every bad or repeated domain and server is reported with its row', texts(errs));
f = z.formFor(ub, d, null); f.zone_name = ['x.example']; f.server = ['10.0.0.1']; f.port = '99999'; f.tls_port = 'abc';
check(bad(f).some(x => x.key === 'port') && bad(f).some(x => x.key === 'tls_port'), 'numbers are checked');
f = z.formFor(ub, d, null); f.zone_type = 'stub_zone'; f.zone_name = ['x.example']; f.server = ['ns.example.net'];
check(bad(f).some(x => x.key === 'server' && /IP address/.test(x.text)), 'a stub zone needs addresses, not names');
f.zone_type = 'forward_zone';
check(!bad(f).length, 'a forward zone may use a host name');
f.zone_type = 'auth_zone'; f.server = []; f.url_dir = '';
check(bad(f).some(x => x.key === 'server' && /URL/.test(x.text)), 'an authoritative zone needs a server or a URL');
f.url_dir = 'ftp://x'; check(bad(f).some(x => x.key === 'url_dir'), 'the URL must be http or https');
f.url_dir = 'https://x.example/'; check(!bad(f).length, 'with a URL it is valid');
f = z.formFor(ub, d, null); f.zone_name = ['a.azure.net', 'new.example']; f.server = ['10.0.0.9'];
check(bad(f).some(x => /already taken by fwd_azure/.test(x.text)), 'a domain that an enabled zone already takes is refused');
check(!bad(z.formFor(ub, d, 'fwd_azure'), 'fwd_azure').length, 'a zone does not clash with itself');
f.enabled = false; check(!bad(f).length, 'nor when the new zone is switched off');
f.enabled = true; f.zone_name = ['file.example']; check(bad(f).some(x => /unbound_ext\.conf/.test(x.text)), 'nor with a zone of the extension file');
f.zone_name = ['.']; check(bad(f).some(x => /fwd_cloudflare/.test(x.text)), 'the root zone is taken by the default forwarders');
f.zone_type = 'auth_zone'; f.url_dir = 'https://x.example/'; check(!bad(f).length, 'an authoritative zone is a separate group: the same domains do not clash');
check(bad({ ...f, zone_type: '' })[0].key === 'zone_type', 'the type must be chosen');
// What stops a save and what warns, in the whole draft
d = e.draftFrom(ub);
f = form('fwd_cloudflare'); f.tls_upstream = false; z.saveForwarder(ub, d, 'fwd_cloudflare', f);
let pr = z.forwarderProblems(ub, d);
check(!pr.errors.length && pr.warnings.some(w => /fwd_cloudflare sends queries to a public server .* in clear text/.test(w)), 'turning TLS off for a public server warns about clear text', j(pr));
d = e.draftFrom(ub); f = form('fwd_cloudflare'); f.tls_index = ''; z.saveForwarder(ub, d, 'fwd_cloudflare', f);
check(z.forwarderProblems(ub, d).warnings.some(w => /without a certificate name/.test(w)), 'TLS without a certificate name warns that nobody is checked');
d = e.draftFrom(ub); f = form('fwd_azure'); f.server = ['127.0.0.1']; z.saveForwarder(ub, d, 'fwd_azure', f);
check(z.forwarderProblems(ub, d).warnings.some(w => /this router itself/.test(w)), 'forwarding to this router itself warns');
d = e.draftFrom(ub); z.removeForwarder(d, 'fwd_cloudflare');
check(z.forwarderProblems(ub, d).warnings.some(w => /No forward zone takes every other name/.test(w)) && !z.forwarderProblems(ub, d).errors.length, 'removing the only default forwarder warns that Unbound will recurse');
d = e.draftFrom(ub); f = form('fwd_google'); f.enabled = true; z.saveForwarder(ub, d, 'fwd_google', f);
check(z.forwarderProblems(ub, d).errors.some(x => /fwd_google: .*already taken by fwd_cloudflare/.test(x.text)), 'switching on a second default forwarder is an error naming the other block', j(z.forwarderProblems(ub, d).errors));
d = e.draftFrom(ub); z.removeForwarder(d, 'fwd_cloudflare'); f = form('fwd_google'); f.enabled = true; z.saveForwarder(ub, d, 'fwd_google', f);
check(!z.forwarderProblems(ub, d).errors.length && !z.forwarderProblems(ub, d).warnings.some(w => /No forward zone/.test(w)), 'but it is fine once the first one is removed');
check(z.forwarderProblems(ub, d).warnings.every(w => !/auth_icann|stub_corp/.test(w)), 'zones that were not changed are not judged');
//#endregion

//#region Editing as a whole
console.log('\n== the editing model ==');
d = e.draftFrom(ub);
check(Array.isArray(d.forwarders) && d.values !== undefined, 'the draft has the options and the zones');
f = z.formFor(ub, d, 'fwd_azure'); f.server = ['10.0.0.7']; z.saveForwarder(ub, d, 'fwd_azure', f);
check(e.isDirty(ub, d) && e.changesOf(ub, d).length === 1 && e.plan(ub, d).length === 1 && e.plan(ub, d)[0].section === 'fwd_azure', 'a changed zone makes the page dirty and is part of the plan');
// The status after a save
let after = clone(ub); after.forward_uci[0].servers = ['10.0.0.7']; after.forwards = after.forwards.map(r => (r.section === 'fwd_azure' ? { ...r, servers: ['10.0.0.7'] } : r));
let threw = null; try { e.checkApplied(ub, after, d); } catch (x) { threw = x.message; }
check(threw === null && e.zonesReady(ub, after, d), 'a status that holds the change passes the check');
threw = null; try { e.checkApplied(ub, ub, d); } catch (x) { threw = x.message; }
check(/fwd_azure was not saved as written/.test(threw ?? '') && !e.zonesReady(ub, ub, d), 'a status that does not fails it, naming the block', threw);
d = e.draftFrom(ub); f = z.formFor(ub, d, null); f.zone_name = ['new.example']; f.server = ['10.2.2.2']; const nk = z.saveForwarder(ub, d, null, f);
after = clone(ub); after.forward_uci.push({ section: nk, type: 'forward_zone', enabled: true, zones: ['new.example'], servers: ['10.2.2.2'], options: {} });
threw = null; try { e.checkApplied(ub, after, d); } catch (x) { threw = x.message; }
check(/Unbound is not forwarding "new\.example" yet/.test(threw ?? '') && !e.zonesReady(ub, after, d), 'Unbound must also list the new domain among the zones it forwards (it may still be restarting)', threw);
after.forwards.push(fwd('new.example', ['10.2.2.2'], { section: nk }));
check(e.zonesReady(ub, after, d), 'which it does once it is listed');
threw = null; try { e.checkApplied(ub, ub, d); } catch (x) { threw = x.message; }
check(new RegExp(`${nk} was not saved`).test(threw ?? ''), 'a new block that is missing after the save is reported');
d = e.draftFrom(ub); z.removeForwarder(d, 'fwd_azure');
after = clone(ub);
threw = null; try { e.checkApplied(ub, after, d); } catch (x) { threw = x.message; }
check(/fwd_azure was not removed/.test(threw ?? ''), 'a block that is still there after its removal is reported');
after.forward_uci.shift();
check(/Unbound still forwards 3 domains of the removed fwd_azure/.test(z.forwardingProblem(ub, after, d) ?? ''), 'and so are the domains Unbound still forwards', z.forwardingProblem(ub, after, d));
after.forwards = after.forwards.filter(r => r.section !== 'fwd_azure');
check(z.forwardingProblem(ub, after, d) === null && e.zonesReady(ub, after, d), 'once they are gone the check passes');
after.engines.unbound.control = false; after.forwards = clone(ub).forwards;
check(z.forwardingProblem(ub, after, d) === null, 'without unbound-control the running forwarders are not asked');
//#endregion

//#region dnsmasq
console.log('\n== dnsmasq server entries ==');
const dmEntries = ['1.1.1.1', '/lan.example/10.0.0.1', '/a.example/b.example/10.0.0.2', '/local.example/', '/x.example/#'];
const dm = { configured: 'dnsmasq', engine: 'dnsmasq', config_section: { config: 'dhcp', name: 'cfg01' }, config: {}, defaults: {}, engines: { dnsmasq: { running: true } }, forward_uci: dmEntries.map((value, index) => ({ index, value })), forwards: [], truncated: {} };
check(j(z.parseEntry('1.1.1.1')) === '{"zones":["."],"mode":"forward","server":"1.1.1.1"}' && j(z.parseEntry('/a.example/b.example/10.0.0.2')) === '{"zones":["a.example","b.example"],"mode":"forward","server":"10.0.0.2"}' && z.parseEntry('/local.example/').mode === 'local' && z.parseEntry('/x.example/#').mode === 'default' && z.parseEntry('/x.example/#').server === '', 'an entry is read: default forwarder, several domains, answer locally, use the default servers');
check(dmEntries.every(v => z.composeEntry(z.parseEntry(v)) === v), 'composing an entry gives back the text that was read');
let dd = e.draftFrom(dm);
items = z.forwarderItems(dm, dd);
check(items.length === 5 && items[0].zones.join() === '.' && items.find(i => i.name === '/a.example/b.example/10.0.0.2').zones.length === 2 && items.find(i => i.name === '/local.example/').flags.join() === 'local-only' && items.find(i => i.name === '/x.example/#').flags.join() === 'default-servers', 'each entry is one item (with several domains), the default forwarder first; the mode gives the flags', keys(items));
check(j(z.forwarderCounts(dm, dd)) === '{"forwarders":5,"domains":6,"file":0}', 'entries and domains are counted', j(z.forwarderCounts(dm, dd)));
check(!e.isDirty(dm, dd) && z.forwarderPlan(dm, dd).length === 0, 'an untouched draft changes nothing');
z.removeForwarder(dd, 'e1');
check(z.forwarderChanges(dm, dd)[0].label === 'Remove zone lan.example' && j(z.forwarderPlan(dm, dd)) === j([{ op: 'set', config: 'dhcp', section: 'cfg01', values: { server: ['1.1.1.1', '/a.example/b.example/10.0.0.2', '/local.example/', '/x.example/#'] } }]), 'removing an entry writes the list without it');
z.restoreForwarder(dd, 'e1'); check(!z.forwarderPlan(dm, dd).length, 'and restoring it writes nothing');
f = z.formFor(dm, dd, 'e2'); f.zones = ['a.example', 'c.example']; f.server = '10.0.0.3#5353'; z.saveForwarder(dm, dd, 'e2', f);
check(z.forwarderPlan(dm, dd)[0].values.server[2] === '/a.example/c.example/10.0.0.3#5353' && z.forwarderChanges(dm, dd)[0].to === '/a.example/c.example/10.0.0.3#5353', 'editing an entry keeps its place in the list');
dd = e.draftFrom(dm); f = z.formFor(dm, dd, null); f.zones = ['.']; f.server = '9.9.9.9'; z.saveForwarder(dm, dd, null, f);
check(z.forwarderPlan(dm, dd)[0].values.server.at(-1) === '9.9.9.9' && z.forwarderChanges(dm, dd)[0].label === 'New zone every other name', 'a new default forwarder is a plain address at the end of the list');
dd = e.draftFrom(dm); f = z.formFor(dm, dd, null); f.zones = ['Corp.Example']; f.mode = 'local'; z.saveForwarder(dm, dd, null, f);
check(z.forwarderPlan(dm, dd)[0].values.server.at(-1) === '/Corp.Example/', 'answering locally is /domain/');
dd = e.draftFrom(dm); for (const k of ['e0', 'e1', 'e2', 'e3', 'e4']) z.removeForwarder(dd, k);
check(j(z.forwarderPlan(dm, dd)) === j([{ op: 'delete', config: 'dhcp', section: 'cfg01', options: ['server'] }]) && z.forwarderProblems(dm, dd).warnings.some(w => /No default server is left/.test(w)), 'removing every entry deletes the option, and the lack of a default server is a warning');
// The problems of validating `form` as a new entry against the dnsmasq fixture.
const dp = form => z.formProblems(dm, dd, null, form);
check(dp(z.newEntryForm()).length === 2 && dp({ zones: ['.'], mode: 'local', server: '' }).some(x => /not "\."/.test(x.text)) && dp({ zones: ['.', 'a.example'], mode: 'forward', server: '1.1.1.1' }).some(x => /cannot be mixed/.test(x.text)) && dp({ zones: ['a.example'], mode: 'forward', server: 'a b' }).some(x => x.key === 'server') && !dp({ zones: ['a.example'], mode: 'default', server: '' }).length && !dp({ zones: ['a.example'], mode: 'forward', server: '10.0.0.1#5353' }).length, 'the entry form is checked: domains, the root zone, the server');
dd = e.draftFrom(dm); f = z.formFor(dm, dd, 'e1'); f.server = '10.0.0.9'; z.saveForwarder(dm, dd, 'e1', f);
let dafter = clone(dm); dafter.forward_uci[1].value = '/lan.example/10.0.0.9';
threw = null; try { e.checkApplied(dm, dafter, dd); } catch (x) { threw = x.message; }
check(threw === null, 'a status that holds the new list passes the check');
threw = null; try { e.checkApplied(dm, dm, dd); } catch (x) { threw = x.message; }
check(/server entries were not saved/.test(threw ?? ''), 'one that does not fails it');
check(!z.canEditForwarders({ ...dm, truncated: { forward_uci: true } }), 'a list that was cut is not edited');
//#endregion

//#region Words and filter
console.log('\n== words ==');
check(z.normZone('Example.COM.') === 'example.com' && z.normZone('*.Example.com') === 'example.com' && z.normZone('.example.com') === 'example.com' && z.normZone('.') === '.' && z.normZone('') === '.' && z.normZone(' A.b ') === 'a.b' && z.zoneError('*.example.com') === null, 'domains are normalized like the plugin does (lowercase, no leading "*." or ".", no trailing dot)');
check(z.zoneError('example.com') === null && z.zoneError('.') === null && z.zoneError('a_b.example') === null && z.zoneError('bad name') && z.zoneError('-a.example') && z.zoneError('a..b'), 'domain checks');
check(z.serverError('10.0.0.1') === null && z.serverError('2001:db8::1') === null && z.serverError('10.0.0.1@853#dns.example.net') === null && z.serverError('dns.example.net') === null && z.serverError('') && z.serverError('10.0.0.1@0') && z.serverError('10.0.0.1@853#') && z.serverError('a b'), 'Unbound server checks (address@port#name)');
check(z.serverError('ns.example.net', 'stub_zone') && z.serverError('10.0.0.1', 'stub_zone') === null, 'a stub zone needs an IP address');
check(z.dnsmasqServerError('10.0.0.1#5353') === null && z.dnsmasqServerError('dns.example.net') === null && z.dnsmasqServerError('a b') && z.dnsmasqServerError('/x/'), 'dnsmasq server checks');
check(z.typeLabel('forward_zone') === 'Forward' && z.typeLabel('auth_zone') === 'Authoritative' && z.typeLabel('weird') === 'weird' && z.typeLabel('') === 'Unknown', 'type labels');
check(z.fieldsOf('stub_zone').map(x => x.key).join() === 'enabled,zone_name,server,port,fallback,dns_assist,resolv_conf' && z.fieldsOf('nope').length === 0, 'each type uses its own fields');
d = e.draftFrom(ub); items = z.forwarderItems(ub, d);
// The keys of the items that the search `text` matches, joined into one string.
const hits = text => items.filter(i => z.matchItem(i, text)).map(i => i.key).join();
check(hits('') === keys(items) && hits('AZURE') === 'fwd_azure' && hits('10.9.9.9') === 'stub_corp' && hits('authoritative') === 'auth_icann' && hits('disabled') === 'fwd_google,auth_icann' && hits('validated') === 'file:file.example' && hits('stub corp') === 'stub_corp' && hits('zzz') === '', 'the filter looks at names, types, domains, servers, flags and state, every word must match');
z.removeForwarder(d, 'stub_corp'); items = z.forwarderItems(ub, d);
check(hits('removed') === 'stub_corp', 'and at what is pending');
//#endregion

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
