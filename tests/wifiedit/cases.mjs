// Shared description of the Wi-Fi editing backend test: the commands flab.radio builds (fixtures are named after them, see
// rpcd/lib/flab/util.uc), the secrets planted in the fake router's wireless config and the calls made against it. Used by
// mkfx.mjs (fixtures) and assert.mjs (checks).

// The fixture file name of a command: the command with every run of non-alphanumerics turned into "_".
export const slug = cmd => cmd.replace(/ 2>\/dev\/null$/, '').replace(/[^A-Za-z0-9]+/g, '_') + '.txt';

// The commands the plugin reads the router with.
export const CMD = {
  phys: 'ls /sys/class/ieee80211 2>/dev/null',
  phyDevice: phy => `readlink -f /sys/class/ieee80211/${phy}/device 2>/dev/null`,
  phyInfo: phy => `iw phy ${phy} info 2>/dev/null`,
  htmodes: ifname => `iwinfo ${ifname} htmodelist 2>/dev/null`,
  countries: ifname => `iwinfo ${ifname} countrylist 2>/dev/null`,
  hostapd: 'hostapd -v 2>&1',
  feature: f => `hostapd -v${f} >/dev/null 2>&1 && echo yes`,
};

// Every secret planted in the fake router's config (one canary per option that holds one): none may appear in any reply, and the
// reply must name the options that hold one. A passphrase with spaces and a hex key are among them.
export const SECRETS = {
  key: 'CANARY-passphrase one', sae_password: 'CANARY-sae-password', auth_secret: 'CANARY-radius-secret', acct_secret: 'CANARY-acct-secret',
  identity: 'CANARY-identity@example.com', password: 'CANARY-eap-password', priv_key_pwd: 'CANARY-privkey-pass', wps_pin: 'CANARY-12345670',
  key1: 'CANARY-wep-key-1', key2: 'CANARY-wep-key-2', r0kh: 'ff:ff:ff:ff:ff:ff,*,CANARY-r0kh-key', r1kh: '00:00:00:00:00:00,00:00:00:00:00:00,CANARY-r1kh-key',
  note_secret: 'CANARY-odd-secret', api_token: 'CANARY-odd-token', station_psk: 'CANARY-station-psk',
  hex: 'CANARY0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

// The secret options of each section of the fake config, by section name (what the page must be told only the names of).
export const SECRET_NAMES = {
  ap_2g: ['key', 'r0kh', 'r1kh'], ap_5g: ['sae_password', 'wps_pin'], cfg0a1b2c: ['auth_secret', 'acct_secret'], mesh_2g: ['key'],
  sta_5g: ['identity', 'password', 'priv_key_pwd', 'key1', 'key2'], odd: ['note_secret', 'api_token'],
};

// The calls made against each scenario: the two methods, with arguments that must be ignored.
export const CASES = [
  { id: 'config', method: 'config', args: {} },
  { id: 'config-args', method: 'config', args: { section: 'ap_2g', config: 'network', secrets: true } },
  { id: 'status', method: 'status', args: {} },
];
