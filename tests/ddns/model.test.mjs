// Unit test of the Dynamic DNS page's model (www/js/pages/ddns/model.js and schema.js): reading the plugin's reply, the draft,
// the review list, validation, the UCI operations, the check after a save, and the verdicts on what a service is doing. Pure
// functions: no router and no browser. Usage: node model.test.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Imports one module of the page.
const mod = f => import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/ddns', f)).href);
const m = await mod('model.js');
const { SERVICE_FIELDS, GLOBAL_FIELDS } = await mod('schema.js');

let failed = 0;
// Prints PASS or FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));

// The providers of the fake router: a plain URL provider, one that needs only a token, one without IPv6, a script that is installed
// and a script that is not.
const PROVIDERS = [
  { name: 'duckdns.example', ipv6: true, needs: ['DOMAIN', 'PASSWORD'], script: null, available: true, source: 'default' },
  { name: 'dyn.example', ipv6: true, needs: ['DOMAIN', 'USERNAME', 'PASSWORD'], script: null, available: true, source: 'default' },
  { name: 'old.example', ipv6: false, needs: ['DOMAIN', 'USERNAME', 'PASSWORD'], script: null, available: true, source: 'default' },
  { name: 'cloud.example-v4', ipv6: true, needs: null, script: 'update_cloud_example_v4.sh', available: true, source: 'default' },
  { name: 'missing.example', ipv6: true, needs: null, script: 'update_missing_example.sh', available: false, source: 'default' },
];
// The reply of flab.ddns status for a router with one enabled service that is up to date (the password is stored but never sent).
const NOW = 1794600000;
// A reply of flab.ddns status like the real router's: five services in different states.
const status = () => ({
  generated: NOW, uptime: 5000, installed: true, version: '2.8.4-12', running: true, at_boot: true, rundir: '/var/run/ddns', logdir: '/var/log/ddns', ca: '/etc/ssl/certs/ca-certificates.crt',
  global: { section: 'global', values: { ddns_dateformat: '%F %R', ddns_loglines: '250', ddns_rundir: '/var/run/ddns', ddns_logdir: '/var/log/ddns' } },
  services: [{
    section: 'home', secrets: { password: true },
    values: { service_name: 'dyn.example', enabled: '1', lookup_host: 'home.example.com', domain: 'home.example.com', username: 'me', use_ipv6: '0', use_https: '1', cacert: '/etc/ssl/certs/ca-certificates.crt',
      ip_source: 'network', ip_network: 'wan', interface: 'wan', use_syslog: '2', check_interval: '10', check_unit: 'minutes', check_interval_min: '1', retry_interval: '30', retry_unit: 'seconds', odd_option: 'x' },
    runtime: { running: true, pid: 4000, registered_ip: '203.0.113.7', local_ip: '203.0.113.7', detected_ip: '203.0.113.7', last_update: NOW - 600, next_check: NOW + 40, error: null, problem: null, terminated: null, log: true },
  }],
  providers: PROVIDERS, networks: ['lan', 'wan', 'wan6'], devices: ['br-lan', 'eth1'], tools: { curl: true, wget: false, uclient_fetch: true, host: false },
});
// The model's reading of that reply.
const data = () => m.readDdns(status());
// The draft of a router, to be edited by the test.
const draftOf = d => m.draftFrom(d ?? data());
// The draft values of the service called `name`.
const svc = (draft, name = 'home') => draft.services[name];

console.log('== reading ==');
const d0 = data();
check(d0.services.length === 1 && d0.services[0].section === 'home' && d0.services[0].secrets.password === true && d0.global.section === 'global' && d0.providers.length === 5 && d0.networks.join() === 'lan,wan,wan6', 'the reply becomes the page\'s data');
check(m.readDdns(null).services.length === 0 && m.readDdns({}).installed === true && m.readDdns({ installed: false }).installed === false && m.readDdns({}).global.section === null, 'a missing or empty reply does not fail');
check(m.providerOf(d0, 'dyn.example').needs.length === 3 && m.providerOf(d0, 'nope') === null && m.providerLabel(PROVIDERS[4]) === 'missing.example (its script is not installed)' && m.providerLabel(PROVIDERS[0]) === 'duckdns.example', 'providers are found by name and labeled when their script is missing');

console.log('\n== the draft ==');
const dr = draftOf();
check(dr.services.home.service_name === 'dyn.example' && dr.services.home.enabled === true && dr.services.home.use_ipv6 === false && dr.services.home.use_logfile === true && dr.services.home.force_interval === '', 'values come from the router; booleans follow their defaults; options that are not set are empty');
check(dr.services.home.password === '' && dr.global.ddns_loglines === '250' && dr.global.upd_privateip === false && dr.added.length === 0, 'the secret field starts empty (it is never sent to the page)');
check(m.serviceList(d0, dr).map(s => `${s.id}:${s.isNew}:${s.removed}`).join() === 'home:false:false', 'the services of the form');
check(j(m.effective({ service_name: 'dyn.example', update_url: 'http://x', update_script: '/s.sh', lookup_host: 'a' })) === j({ service_name: 'dyn.example', update_url: '', update_script: '', lookup_host: 'a' }) && m.effective({ service_name: '', update_url: 'http://x' }).update_url === 'http://x', 'with a provider chosen the custom address and script are dropped');
check(m.isShown(SERVICE_FIELDS.find(f => f.key === 'ip_url'), { ...dr.services.home, ip_source: 'web' }) && !m.isShown(SERVICE_FIELDS.find(f => f.key === 'ip_url'), dr.services.home) && !m.isShown(SERVICE_FIELDS.find(f => f.key === 'update_url'), dr.services.home) && m.isShown(SERVICE_FIELDS.find(f => f.key === 'update_url'), { ...dr.services.home, service_name: '' }) && m.isShown(SERVICE_FIELDS.find(f => f.key === 'ip_network'), { ...dr.services.home, ip_source: '' }), 'which controls are shown depends on the source and on custom or listed providers');

console.log('\n== adding and removing ==');
{
  const d = data(), draft = draftOf(d);
  const id = m.addService(d, draft);
  check(id === 'new1' && draft.added.length === 1 && draft.added[0].name === 'myddns' && draft.services.new1.enabled === true && draft.services.new1.use_https === true && draft.services.new1.cacert === '/etc/ssl/certs/ca-certificates.crt' && draft.services.new1.interface === 'wan', 'a new service starts enabled, with HTTPS, the router\'s CA certificates and the wan network');
  check(m.addService(d, draft) === 'new2' && draft.added[1].name === 'myddns_2', 'the next one gets another name');
  draft.added[0].name = 'home';
  check(/already a section called "home"/.test(m.nameError(d, draft, 'new1')) && m.nameError(d, draft, 'new2') === null, 'a name that is taken is refused');
  for (const [name, re] of [['', /Give the service a name/], ['my-ddns', /letters, digits and underscores/], ['a b', /letters, digits and underscores/], ['global', /already a section/], ['x'.repeat(33), /at most 32/]]) {
    draft.added[0].name = name;
    check(re.test(m.nameError(d, draft, 'new1') ?? ''), `the name "${name.slice(0, 12)}" is refused`, m.nameError(d, draft, 'new1'));
  }
  m.removeService(draft, 'new1');
  check(draft.added.length === 1 && !('new1' in draft.services), 'a service that was only added is dropped');
  m.removeService(draft, 'home');
  check(draft.removed.home === true && m.serviceList(d, draft)[0].removed, 'a saved service is marked for removal');
  m.restoreService(draft, 'home');
  check(!draft.removed.home, 'and can be taken back');
  const d2 = data(); d2.networks = ['lan'];
  const dd2 = m.draftFrom(d2), id2 = m.addService(d2, dd2);
  check(dd2.services[id2].interface === '', 'without a wan network the interface is left for the user to choose');
}

console.log('\n== the review list and the operations ==');
{
  const d = data();
  check(m.changesOf(d, draftOf(d)).length === 0 && !m.isDirty(d, draftOf(d)) && m.plan(d, draftOf(d)).length === 0, 'an untouched form has no changes and writes nothing');
  let draft = draftOf(d);
  svc(draft).lookup_host = ' other.example.com ';
  svc(draft).check_interval = '5';
  svc(draft).use_https = false;
  let ch = m.changesOf(d, draft);
  check(ch.length === 3 && ch.some(c => c.label === 'home: Lookup host name' && c.from === 'home.example.com' && c.to === 'other.example.com') && ch.some(c => c.label === 'home: Use HTTPS' && c.from === 'on' && c.to === 'off') && m.isDirty(d, draft), 'edits are listed with the section, the field and both values', j(ch));
  check(j(m.plan(d, draft)) === j([{ op: 'set', config: 'ddns', section: 'home', values: { lookup_host: 'other.example.com', use_https: '0', check_interval: '5' } }]), 'only what changed is written, trimmed, booleans as 1 and 0', j(m.plan(d, draft)));
  draft = draftOf(d);
  svc(draft).username = ''; svc(draft).check_interval_min = '';
  check(j(m.plan(d, draft)) === j([{ op: 'delete', config: 'ddns', section: 'home', options: ['username', 'check_interval_min'] }]), 'an emptied option is deleted, not set to an empty value', j(m.plan(d, draft)));
  draft = draftOf(d);
  svc(draft).force_interval = '';
  check(m.plan(d, draft).length === 0, 'emptying an option that does not exist writes nothing');

  draft = draftOf(d);
  svc(draft).password = 'n3w-t0ken';
  ch = m.changesOf(d, draft);
  check(ch.length === 1 && ch[0].label === 'home: Password or token' && ch[0].from === 'set (hidden)' && ch[0].to === 'new value (hidden)' && !j(ch).includes('n3w-t0ken'), 'a new password is in the review list as a change but its value is not', j(ch));
  check(j(m.plan(d, draft)) === j([{ op: 'set', config: 'ddns', section: 'home', values: { password: 'n3w-t0ken' } }]), 'and it is written when it was typed', j(m.plan(d, draft)));
  check(!m.plan(d, draftOf(d)).some(o => o.values?.password !== undefined || o.options?.includes('password')), 'a password that was not retyped is never written or deleted');

  draft = draftOf(d);
  svc(draft).service_name = '';
  svc(draft).update_url = 'http://update.example.com/?h=[DOMAIN]';
  check(j(m.plan(d, draft)) === j([{ op: 'set', config: 'ddns', section: 'home', values: { update_url: 'http://update.example.com/?h=[DOMAIN]' } }, { op: 'delete', config: 'ddns', section: 'home', options: ['service_name'] }]), 'a custom provider sets the update address and removes the provider name', j(m.plan(d, draft)));
  const d3 = clone(status()); d3.services[0].values.service_name = ''; d3.services[0].values.update_url = 'http://update.example.com/?h=[DOMAIN]'; d3.services[0].values.update_script = '/usr/bin/x.sh';
  const dd = m.readDdns(d3), cust = m.draftFrom(dd);
  cust.services.home.service_name = 'dyn.example';
  check(j(m.plan(dd, cust)) === j([{ op: 'set', config: 'ddns', section: 'home', values: { service_name: 'dyn.example' } }, { op: 'delete', config: 'ddns', section: 'home', options: ['update_url', 'update_script'] }]), 'choosing a provider removes the custom update address and script', j(m.plan(dd, cust)));

  draft = draftOf(d);
  draft.global.ddns_loglines = '100'; draft.global.use_curl = true;
  check(j(m.plan(d, draft)) === j([{ op: 'set', config: 'ddns', section: 'global', values: { ddns_loglines: '100', use_curl: '1' } }]) && m.changesOf(d, draft).every(c => c.label.startsWith('Global: ')), 'global settings are their own section');
  const noGlobal = status(); noGlobal.global = { section: null, values: {} };
  const dn = m.readDdns(noGlobal), gd = m.draftFrom(dn);
  gd.global.use_curl = true;
  check(j(m.plan(dn, gd)) === j([{ op: 'add', config: 'ddns', type: 'ddns', name: 'global', values: { use_curl: '1' } }]) && m.plan(dn, m.draftFrom(dn)).length === 0, 'a config without a global section gets one only when a setting is changed');

  draft = draftOf(d);
  const id = m.addService(d, draft);
  draft.added[0].name = 'second';
  Object.assign(draft.services[id], { service_name: 'duckdns.example', lookup_host: 'second.example.com', domain: 'second', password: 'tok-en-1234' });
  const ops = m.plan(d, draft);
  check(ops.length === 1 && ops[0].op === 'add' && ops[0].type === 'service' && ops[0].name === 'second' && ops[0].values.enabled === '1' && ops[0].values.use_https === '1' && ops[0].values.password === 'tok-en-1234' && ops[0].values.interface === 'wan' && ops[0].values.service_name === 'duckdns.example' && !('use_logfile' in ops[0].values) && !('use_ipv6' in ops[0].values), 'a new service is added under its name with the options that differ from the defaults', j(ops));
  check(m.changesOf(d, draft).length === 1 && m.changesOf(d, draft)[0].label === 'New service second' && /duckdns\.example · second\.example\.com · enabled/.test(m.changesOf(d, draft)[0].to) && !j(m.changesOf(d, draft)).includes('tok-en-1234'), 'it is one line in the review list, without the secret');
  m.removeService(draft, 'home');
  check(m.plan(d, draft).some(o => o.op === 'delete' && o.section === 'home' && !o.options) && m.changesOf(d, draft).some(c => c.label === 'Remove service home' && c.to === 'removed'), 'a removed service is deleted as a whole');
}

console.log('\n== validation ==');
{
  const d = data();
  /** The errors of an edit of the home service as "key: text" lines. */
  const errs = edit => { const draft = draftOf(d); edit(svc(draft), draft); return m.problems(d, draft).errors; };
  // The warnings the model gives for the draft after `edit` has changed service home.
  const warns = edit => { const draft = draftOf(d); edit(svc(draft), draft); return m.problems(d, draft).warnings; };
  check(m.problems(d, draftOf(d)).errors.length === 0 && m.problems(d, draftOf(d)).warnings.length === 0, 'the router\'s own configuration has no problems');
  let e = errs(v => { v.lookup_host = 'bad host!'; v.domain = 'bad domain!'; v.dns_server = 'a b'; });
  check(e.length === 3 && e.every(x => x.key.startsWith('svc:home:')) && e.some(x => x.key === 'svc:home:lookup_host' && /Lookup host name may only contain/.test(x.text)) && e.some(x => x.key === 'svc:home:domain') && e.some(x => x.key === 'svc:home:dns_server'), 'characters ddns-scripts does not accept are errors on the field that has them', j(e));
  check(errs(v => { v.domain = 'host@example.com'; v.lookup_host = 'a.b-c_d:53'; }).length === 0, '"@" is allowed in a domain and a lookup host name');
  e = errs(v => { v.check_interval = '0'; v.force_interval = 'x'; v.retry_interval = '-1'; v.retry_max_count = '1.5'; });
  check(e.length === 4 && e.some(x => /Check every must be at least 1/.test(x.text)) && e.some(x => /Force an update every must be a whole number/.test(x.text)), 'interval numbers are checked', j(e.map(x => x.text)));
  check(errs(v => { v.proxy = 'proxy.example.com'; }).some(x => /Proxy must be/.test(x.text)) && errs(v => { v.proxy = 'u:p@proxy.example.com:3128'; }).length === 0 && errs(v => { v.proxy = '[::1]:3128'; }).length === 0, 'a proxy needs its port');
  check(errs(v => { v.service_name = ''; v.update_url = ''; }).some(x => x.key === 'svc:home:service_name' && /choose a provider/.test(x.text)), 'an enabled service needs a provider, or a custom update address');
  check(!errs(v => { v.service_name = ''; v.update_url = 'http://u.example.com/[DOMAIN]'; }).some(x => x.key === 'svc:home:service_name') && !errs(v => { v.service_name = ''; v.update_script = '/usr/bin/update.sh'; }).some(x => x.key === 'svc:home:service_name'), 'a custom update address or script is enough');
  check(errs(v => { v.lookup_host = ''; v.domain = ''; }).some(x => x.key === 'svc:home:lookup_host'), 'and a name to keep up to date');
  check(errs(v => { v.service_name = 'duckdns.example'; v.domain = ''; }).some(x => x.key === 'svc:home:domain' && /provider needs a domain/.test(x.text)) && errs(v => { v.username = ''; }).some(x => x.key === 'svc:home:username' && /needs a username/.test(x.text)), 'what the provider\'s update address contains is required');
  check(!errs(v => { v.service_name = 'duckdns.example'; v.username = ''; }).some(x => x.key === 'svc:home:username'), 'and nothing more (this provider has no username)');
  {
    const none = clone(status()); none.services[0].secrets = {};
    const dn = m.readDdns(none), draft = m.draftFrom(dn);
    check(m.problems(dn, draft).errors.some(x => x.key === 'svc:home:password' && /needs a password or token/.test(x.text)), 'a password that is not stored must be typed');
    draft.services.home.password = 'typed-value';
    check(!m.problems(dn, draft).errors.some(x => x.key === 'svc:home:password'), 'and a typed one is enough');
    check(!m.problems(d, draftOf(d)).errors.some(x => x.key === 'svc:home:password'), 'a stored one is enough without typing');
  }
  check(errs(v => { v.service_name = 'cloud.example-v4'; }).length === 0 && errs(v => { v.service_name = 'missing.example'; }).some(x => x.key === 'svc:home:service_name' && /update_missing_example\.sh\) is not installed/.test(x.text)), 'a provider that is a script reads its options itself, and an uninstalled script is an error');
  check(errs(v => { v.ip_source = 'interface'; }).some(x => x.key === 'svc:home:ip_interface') && errs(v => { v.ip_source = 'script'; }).some(x => x.key === 'svc:home:ip_script') && errs(v => { v.ip_source = 'script'; v.ip_script = 'relative.sh'; }).some(x => x.key === 'svc:home:ip_script') && errs(v => { v.ip_source = 'web'; }).length === 0 && errs(v => { v.ip_source = 'web'; v.ip_url = 'ftp://x'; }).some(x => x.key === 'svc:home:ip_url'), 'each address source needs its own setting (a web page falls back to the updater\'s default)');
  check(errs(v => { v.ip_source = 'web'; v.ip_script = 'garbage'; }).length === 0, 'a hidden control is not validated');
  check(errs(v => { v.enabled = false; v.lookup_host = ''; v.domain = ''; v.service_name = ''; }).length === 0, 'a disabled service may be incomplete');
  check(errs(v => { v.proxy = 'u:***@proxy.example.com:3128'; }).some(x => x.key === 'svc:home:proxy' && /hidden/.test(x.text)), 'a masked proxy password cannot be saved');
  const px = clone(status()); px.services[0].values.proxy = 'u:***@proxy.example.com:3128';
  const pd = m.readDdns(px);
  check(m.problems(pd, m.draftFrom(pd)).errors.length === 0 && m.plan(pd, m.draftFrom(pd)).length === 0 && m.changesOf(pd, m.draftFrom(pd)).length === 0, 'a masked proxy that is left alone is not an error and not a change');

  check(warns(v => { v.service_name = 'old.example'; v.use_ipv6 = true; }).some(w => /old\.example does not support IPv6/.test(w)), 'IPv6 with a provider that does not support it is a warning');
  check(warns(v => { v.check_interval = '2'; v.check_interval_min = ''; }).some(w => /check every 2 minutes is replaced by the shortest check interval, so it runs every 5 minutes/.test(w)) && warns(v => { v.check_interval = '2'; v.check_interval_min = '1'; }).some(w => /check every 2 minutes is replaced by the shortest check interval, so it runs every 1 minute\.|so it runs every 1 minute/.test(w)) && !warns(v => { v.check_interval = '1'; v.check_interval_min = '1'; }).some(w => /replaced/.test(w)) && !warns(v => { v.check_interval = '10'; v.check_interval_min = ''; }).some(w => /replaced/.test(w)), 'a check below 5 minutes is replaced by the shortest interval, which the warning explains (and a check of 1 with a minimum of 1 is as asked)');
  check(warns(v => { v.cacert = ''; }).some(w => /without CA certificates/.test(w)) && warns(v => { v.cacert = 'IGNORE'; }).some(w => /insecure/.test(w)) && warns(v => { v.service_name = ''; v.update_url = 'https://u.example.com/x'; }).some(w => /write "http:"/.test(w)), 'HTTPS without certificates, ignored certificates and an https update address are warnings');
  check(warns(v => { v.interface = ''; }).some(w => /no interface is set/.test(w)) && warns(v => { v.interface = 'wan9'; }).some(w => /Interface "wan9" is not a network/.test(w)) &&   ['a\'b', 'a\\b', 'caffè'].every(p => warns(v => { v.password = p; }).some(w => /does not pass a single quote/.test(w))) && !warns(v => { v.password = 'a$b'; }).some(w => /password/.test(w)), 'a missing or unknown interface are warnings; so are a quote, a backslash or a non-ASCII character in the password (ddns-scripts does not pass them through; a $ is fine)');
  check(warns(v => { v.force_dnstcp = true; }).some(w => /bind-host/.test(w)) && !warns(v => { v.force_dnstcp = false; }).some(w => /bind-host/.test(w)) && warns(v => { v.is_glue = true; }).some(w => /needs a DNS server/.test(w)), 'options that need the host command are warnings on a router without it');
  {
    const draft = draftOf(d), id = m.addService(d, draft);
    draft.added[0].name = 'twin';
    Object.assign(draft.services[id], { service_name: 'dyn.example', lookup_host: 'home.example.com', domain: 'home.example.com', username: 'u', password: 'secret1' });
    check(m.problems(d, draft).warnings.some(w => /home also updates home\.example\.com \(IPv4\)/.test(w)), 'two enabled services for the same name and address family are a warning');
    draft.services[id].use_ipv6 = true;
    check(!m.problems(d, draft).warnings.some(w => /also updates/.test(w)), 'but IPv4 and IPv6 of one name are fine');
    draft.added[0].name = 'bad-name';
    check(m.problems(d, draft).errors.some(x => x.key === `svc:${id}:name`), 'a new service with a bad name is an error on its name field');
  }
  const g = draftOf(d); g.global.ddns_rundir = 'run/ddns'; g.global.ddns_loglines = '0';
  check(m.problems(d, g).errors.filter(x => x.key.startsWith('global:')).length === 2, 'global settings are checked too');
  const rm = draftOf(d); svc(rm).lookup_host = ''; svc(rm).domain = ''; m.removeService(rm, 'home');
  check(m.problems(d, rm).errors.length === 0, 'a service that is being removed is not validated');
}

console.log('\n== after a save ==');
{
  const d = data(), draft = draftOf(d);
  svc(draft).lookup_host = 'other.example.com'; svc(draft).password = 'typed-secret';
  const after = status(); after.services[0].values.lookup_host = 'other.example.com';
  let threw = null;
  try { m.checkApplied(m.readDdns(after), draft); } catch (e) { threw = e; }
  check(threw === null, 'the config read back holds what was asked (the stored password counts)', threw?.message);
  const lost = status();
  try { m.checkApplied(m.readDdns(lost), draft); threw = null; } catch (e) { threw = e; }
  check(threw && /Lookup host name/.test(threw.message) && /was not saved|were not saved/.test(threw.message), 'an option that was not kept is reported', threw?.message);
  const nosecret = clone(after); nosecret.services[0].secrets = {};
  try { m.checkApplied(m.readDdns(nosecret), draft); threw = null; } catch (e) { threw = e; }
  check(threw && /Password or token/.test(threw.message), 'a typed password that is not stored is reported');
  const draft2 = draftOf(d); const id = m.addService(d, draft2); draft2.added[0].name = 'added1'; draft2.services[id].lookup_host = 'a.example.com'; draft2.services[id].password = 'abcd1234'; draft2.services[id].service_name = 'duckdns.example'; draft2.services[id].domain = 'a';
  try { m.checkApplied(d, draft2); threw = null; } catch (e) { threw = e; }
  check(threw && /Service added1/.test(threw.message), 'a service that is not there is reported');
  const withNew = status(); withNew.services.push({ section: 'added1', secrets: { password: true }, runtime: {}, values: { enabled: '1', service_name: 'duckdns.example', lookup_host: 'a.example.com', domain: 'a', use_https: '1', cacert: '/etc/ssl/certs/ca-certificates.crt', interface: 'wan' } });
  try { m.checkApplied(m.readDdns(withNew), draft2); threw = null; } catch (e) { threw = e; }
  check(threw === null, 'a new service is found by the name chosen for it', threw?.message);
  const draft3 = draftOf(d); m.removeService(draft3, 'home');
  try { m.checkApplied(d, draft3); threw = null; } catch (e) { threw = e; }
  check(threw && /Service home/.test(threw.message), 'a service that is still there after its removal is reported');
  try { m.checkApplied(m.readDdns({ ...status(), services: [] }), draft3); threw = null; } catch (e) { threw = e; }
  check(threw === null, 'and one that is gone is fine');
  const many = draftOf(d); for (const k of ['lookup_host', 'domain', 'username', 'interface', 'ip_network']) svc(many)[k] = 'zzz';
  try { m.checkApplied(d, many); threw = null; } catch (e) { threw = e; }
  check(threw && /and 1 more were not saved/.test(threw.message), 'a long list is cut', threw?.message);
}

console.log('\n== what a service is doing ==');
{
  // A copy of the first service, for the verdict cases.
  const base = () => clone(m.readDdns(status()).services[0]);
  // The verdict of a service.
  const v = s => m.verdictOf(s);
  check(v(base()).kind === 'ok' && /home\.example\.com resolves to 203\.0\.113\.7, the address of the router/.test(v(base()).detail), 'the registered address is the router\'s: up to date', j(v(base())));
  let s = base(); s.values.enabled = '0';
  check(v(s).kind === 'disabled' && v(s).text === 'Disabled', 'a disabled service');
  s = base(); s.runtime.running = false;
  check(v(s).kind === 'stopped' && /not running/.test(v(s).detail), 'an enabled service whose updater is not running');
  s.runtime.terminated = 'Updating IP at DDNS provider failed after 3 retries';
  check(/The updater stopped: Updating IP at DDNS provider failed after 3 retries\./.test(v(s).detail), 'says why it stopped when the log does');
  s = base(); s.runtime.problem = { time: '203412', level: 'ERROR', text: 'IP update not accepted by DDNS Provider' };
  check(v(s).kind === 'error' && v(s).text === 'Problem' && v(s).detail === '20:34:12 · IP update not accepted by DDNS Provider', 'a problem in the log that nothing has put right');
  s.runtime.problem.level = 'WARN';
  check(v(s).text === 'Warning', 'a warning');
  s = base(); s.runtime.local_ip = '203.0.113.99';
  check(v(s).kind === 'pending' && /The router has 203\.0\.113\.99, but home\.example\.com resolves to 203\.0\.113\.7/.test(v(s).detail), 'a changed address that the provider does not have yet');
  s = base(); s.runtime.registered_ip = null;
  check(v(s).kind === 'unknown', 'no registered address yet: still checking');
  s = base(); s.runtime.local_ip = null; s.runtime.detected_ip = '203.0.113.7';
  check(v(s).kind === 'ok' && m.currentIp(s.runtime) === '203.0.113.7', 'the address the updater detected stands in for one the plugin cannot read (web page, script)');
  s = base(); s.runtime = { running: true, registered_ip: '2001:db8::1', local_ip: '2001:0db8:0000:0000:0000:0000:0000:0001' };
  check(v(s).kind === 'ok' && m.sameIp('2001:DB8::1', '2001:db8:0:0:0:0:0:1') && !m.sameIp('2001:db8::1', '2001:db8::2') && !m.sameIp('1.2.3.4', null) && m.sameIp('1.2.3.4', '1.2.3.4') && !m.sameIp('1.2.3.4', '::ffff:1.2.3.5'), 'IPv6 addresses are the same however they are written');
  check(m.clock('203412') === '20:34:12' && m.clock('') === '' && m.clock(null) === '' && m.clock('12') === '', 'times of day from the log');
  check(m.ago(NOW - 90, NOW) === '1m 30s ago' && m.ago(NOW + 40, NOW) === 'in 40s' && m.ago(null, NOW) === 'never', 'times are in words');
  check(m.spanWords(60) === '1 minute' && m.spanWords(300) === '5 minutes' && m.spanWords(4320 * 60) === '3 days' && m.spanWords(86400) === '1 day' && m.spanWords(30) === '30 seconds' && m.spanWords(0) === '0 seconds' && m.spanWords(90) === '90 seconds', 'spans keep a unit that divides them');

  const dd = m.readDdns(status());
  let sum = m.summarize(dd, NOW);
  check(sum.total === 1 && sum.enabled === 1 && sum.running === 1 && sum.upToDate === 1 && sum.problems === 0 && sum.lastUpdate === NOW - 600 && sum.lastUpdateName === 'home' && sum.nextCheck === NOW + 40, 'the figures of the tiles', j(sum));
  const two = status(); two.services.push({ section: 'off', secrets: {}, values: { enabled: '0' }, runtime: {} }, { section: 'down', secrets: {}, values: { enabled: '1', lookup_host: 'x.example.com' }, runtime: { running: false } });
  sum = m.summarize(m.readDdns(two), NOW);
  check(sum.total === 3 && sum.enabled === 2 && sum.running === 1 && sum.upToDate === 1 && sum.problems === 1, 'disabled services are not counted; a stopped one is a problem', j(sum));
  check(m.summarize(m.readDdns({ services: [] }), NOW).lastUpdate === null && m.summarize(m.readDdns({ services: [] }), NOW).nextCheck === null, 'nothing configured: no times');
}

console.log('\n== the intervals ==');
{
  const t = m.timing({ check_interval: '1', check_unit: 'minutes', check_interval_min: '1' });
  check(t.check === 60 && t.requested === 60 && t.force === 72 * 3600 && t.retry === 60, 'a one minute check with a one minute minimum, and the defaults for the rest', j(t));
  check(m.timing({ check_interval: '2', check_unit: 'minutes' }).check === 300 && m.timing({ check_interval: '2', check_unit: 'minutes' }).requested === 120, 'a check below 5 minutes becomes the minimum (5 minutes by default)');
  check(m.timing({ check_interval: '10', check_unit: 'seconds', check_interval_min: '30' }).check === 30, 'the minimum is in the unit of the check interval');
  check(m.timing({}).check === 600 && m.timing({ check_interval: '', check_unit: '' }).check === 600, 'defaults: every 10 minutes');
  check(m.timing({ check_interval: '10', check_unit: 'minutes', force_interval: '5', force_unit: 'minutes' }).force === 600 && m.timing({ force_interval: '0' }).force === 0, 'a forced update is never sooner than a check; 0 means never');
  check(m.timing({ force_unit: 'minutes' }).force === 72 * 60, 'a unit without a number applies to the default number (72)');
  check(m.timing({ check_interval: '90', check_unit: 'weird', check_interval_min: '1' }).requested === 90 && m.timing({ retry_interval: '5', retry_unit: 'weird' }).retry === 5, 'an unknown unit counts as seconds, as in ddns-scripts');
}

console.log('\n== the log ==');
{
  const raw = [' 203412  info : Update successful', ' 203412       : Detected IP: 1.2.3.4', ' 203413  WARN : Transfer failed - retry 1/3 in 60 seconds', ' 203414 ERROR : IP update not accepted - TERMINATE', ' 203415 CRIT : Boom', ' 203416  note : PID started', 'free text line', '', ' 203417  info : Rerun IP check at 2026-11-13 20:34'].join('\n');
  const lines = m.parseLog(raw);
  check(lines.length === 8 && lines[0].level === 'info' && lines[0].time === '20:34:12' && lines[1].level === '' && lines[2].level === 'warn' && lines[3].level === 'error' && lines[4].level === 'error' && lines[5].level === 'note' && lines[6].time === '' && lines[6].text === 'free text line', 'log lines are split into time, level and text', j(lines.map(l => l.level)));
  check(m.parseLog(null).length === 0 && m.parseLog('').length === 0, 'an empty log has no lines');
  check(lines.filter(m.isNoteworthy).length === 5 && !m.isNoteworthy(lines[7]) && m.isNoteworthy(lines[0]) && !m.isNoteworthy(lines[1]), 'the lines worth showing by default leave out debug lines and the routine check line', j(lines.filter(m.isNoteworthy).map(l => l.text)));
}

console.log('\n== the tables ==');
check(SERVICE_FIELDS.every(f => f.label && f.group && (f.type !== 'enum' || f.dynamic || f.options)), 'every service field has a label and a group, and an enum has its options');
check(SERVICE_FIELDS.filter(f => f.type === 'enum' && f.dynamic).every(f => ['providers', 'networks', 'devices'].includes(f.dynamic)) && new Set(SERVICE_FIELDS.map(f => f.key)).size === SERVICE_FIELDS.length && new Set(GLOBAL_FIELDS.map(f => f.key)).size === GLOBAL_FIELDS.length, 'dynamic lists are known and the keys are unique');
check(SERVICE_FIELDS.filter(f => f.secret).map(f => f.key).join() === 'password' && SERVICE_FIELDS.filter(f => f.unit).every(f => SERVICE_FIELDS.some(u => u.key === f.unit)), 'password is the only secret; every interval has its unit field');
check(SERVICE_FIELDS.find(f => f.key === 'use_syslog').default === '2' && SERVICE_FIELDS.find(f => f.key === 'use_logfile').default === true && SERVICE_FIELDS.find(f => f.key === 'force_interval').default === 72 && SERVICE_FIELDS.find(f => f.key === 'check_interval').default === 10, 'the defaults are the ones ddns-scripts uses');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall Dynamic DNS model checks passed');
process.exit(failed ? 1 : 0);
