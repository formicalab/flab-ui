// Builds the fixture directories for the IPsec scenarios from the output captured on the router.
// Usage: node mkfx.mjs <work dir containing fx-real/>
// Writes <work>/<scenario>/ with one file per command the plugin runs (see FLAB_FIXTURES in util.uc) plus
// ifaces.json, which stands in for the UCI + netifd lookup.
import fs from 'node:fs';
import path from 'node:path';

const work = process.argv[2];
const real = path.join(work, 'fx-real');
// Reads one captured file with LF line endings.
const read = f => fs.readFileSync(path.join(real, f), 'utf8').replace(/\r/g, '');

// A recognisable fake key replaces the redacted one so the assertions can prove it never leaves the plugin.
const CANARY = 'deadbeefdeadbeefdeadbeefdeadbeef';

//#region Baseline files
const files = {
  'swanctl_list_conns_raw.txt': read('swanctl_list_conns_raw.txt'),
  'swanctl_list_sas_raw.txt': read('swanctl_list_sas_raw.txt'),
  'swanctl_stats_raw.txt': read('swanctl_stats_raw.txt'),
  'swanctl_version.txt': read('swanctl_version.txt'),
  'ip_s_xfrm_state.txt': read('ip_s_xfrm_state.txt').replace(/^(\s+(?:aead|enc|auth-trunc|auth) \S+) 0x00/gm, `$1 0x${CANARY}`),
};

// Non-empty lines of a text.
const lines = t => t.split('\n').filter(Boolean);
// Connection names (sorted), taken from the `list-conn` events of the captured swanctl output.
const names = lines(files['swanctl_list_conns_raw.txt']).filter(l => l.startsWith('list-conn event {')).map(l => l.match(/^list-conn event \{(\S+) /)[1]).sort();
if (names.length < 4) throw new Error(`expected at least 4 connections on the router, found ${names.length}`);

const addrFiles = fs.readdirSync(real).filter(f => /^ip_o_addr_show_dev_xfrm\d+\.txt$/.test(f)).sort();
for (const f of addrFiles) files[f] = read(f);

// ifaces.json mirrors what live_xfrm_interfaces() builds from UCI and netifd.
const sections = {};
for (const l of lines(read('uci.txt'))) {
  const m = l.match(/^network\.(\w+)\.(\w+)='(.*)'$/);
  if (m) (sections[m[1]] ??= {})[m[2]] = m[3];
}
const ifaces = Object.entries(sections).filter(([, s]) => s.proto === 'xfrm').sort(([a], [b]) => a.localeCompare(b)).map(([name, s]) => {
  const dev = JSON.parse(read(`dev_${name}.json`));
  const st = dev.statistics ?? {};
  return {
    name, ifid: +s.ifid, tunlink: s.tunlink, zone: s.zone, mtu: dev.mtu ?? +s.mtu, up: dev.up ?? false,
    rx_bytes: st.rx_bytes, tx_bytes: st.tx_bytes, rx_packets: st.rx_packets, tx_packets: st.tx_packets,
    rx_errors: st.rx_errors, tx_errors: st.tx_errors, rx_dropped: st.rx_dropped, tx_dropped: st.tx_dropped,
  };
});
if (!ifaces.length) throw new Error('no xfrm interfaces captured');
files['ifaces.json'] = JSON.stringify(ifaces);
//#endregion

//#region Scenarios
// The `<kind> event {<name> ...}` line of one connection in raw swanctl output (kind = list-conn or list-sa).
const eventLine = (text, name, kind) => lines(text).find(l => l.startsWith(`${kind} event {${name} `));
// Raw swanctl output without the events of one connection.
const dropEvent = (text, name, kind) => lines(text).filter(l => !l.startsWith(`${kind} event {${name} `)).join('\n') + '\n';
// Raw swanctl output with the events of one connection rewritten by `fn`.
const replaceEvent = (text, name, kind, fn) => lines(text).map(l => (l.startsWith(`${kind} event {${name} `) ? fn(l) : l)).join('\n') + '\n';

// A copy of the child SA block with fresh SPIs, a new id and a young install time, as seen while a rekey overlaps.
const rekeyed = line => line.replace(/(\S+)-(\d+) \{name=(\S+) uniqueid=\d+([^}]*)\}/, (block, key, id, name, rest) => {
  const copy = `${key}-9999 {name=${name} uniqueid=9999${rest}}`
    .replace(/spi-in=\w+/, 'spi-in=aaaa1111').replace(/spi-out=\w+/, 'spi-out=bbbb2222').replace(/install-time=\d+/, 'install-time=5');
  return `${block} ${copy}`;
});

// A second IKE SA for the same connection (unique = no / road-warrior style), a bit younger than the first.
const secondIkeSa = line => line
  .replace(/uniqueid=\d+/, 'uniqueid=900').replace(/initiator-spi=\w+/, 'initiator-spi=dddddddddddddddd')
  .replace(/responder-spi=\w+/, 'responder-spi=eeeeeeeeeeeeeeee').replace(/established=\d+/, 'established=100')
  .replace(/(\S+)-\d+ \{name=(\S+) uniqueid=\d+/, '$1-901 {name=$2 uniqueid=901')
  .replace(/spi-in=\w+/, 'spi-in=cccc3333').replace(/spi-out=\w+/, 'spi-out=dddd4444');

// Scenario builders: each maps the baseline file set to the files of one scenario (see assert.mjs for what each proves).
const scenarios = {
  base: f => f,
  down: f => ({ ...f, 'swanctl_list_sas_raw.txt': dropEvent(f['swanctl_list_sas_raw.txt'], names[1], 'list-sa') }),
  rekey: f => ({ ...f, 'swanctl_list_sas_raw.txt': replaceEvent(f['swanctl_list_sas_raw.txt'], names[0], 'list-sa', rekeyed) }),
  multi: f => ({
    ...f,
    'swanctl_list_sas_raw.txt': f['swanctl_list_sas_raw.txt'] + secondIkeSa(eventLine(f['swanctl_list_sas_raw.txt'], names[2], 'list-sa')) + '\n',
  }),
  // names[3] loses its connection (SA stays); names[0] keeps its connection but loses its child configuration.
  orphan: f => ({
    ...f,
    'swanctl_list_conns_raw.txt': replaceEvent(dropEvent(f['swanctl_list_conns_raw.txt'], names[3], 'list-conn'), names[0], 'list-conn',
      l => l.slice(0, l.indexOf('children {')) + 'children {}}}'),
  }),
  ipv6: f => ({
    ...f,
    [addrFiles[0]]: f[addrFiles[0]] + '22: xfrm0    inet6 fd00:ab::1/64 scope global \\       valid_lft forever preferred_lft forever\n'
      + '22: xfrm0    inet6 fd00:cd::1 peer fd00:cd::2/128 scope global \\       valid_lft forever preferred_lft forever\n',
  }),
  daemondown: f => ({ ...f, 'swanctl_stats_raw.txt': '' }),
};

for (const [name, build] of Object.entries(scenarios)) {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(build(files))) fs.writeFileSync(path.join(dir, file), text);
}
fs.writeFileSync(path.join(work, 'names.json'), JSON.stringify({ names, iface: addrFiles[0].match(/xfrm\d+/)[0] }));
console.log(`built ${Object.keys(scenarios).join(', ')} for ${names.join(', ')}`);
//#endregion
