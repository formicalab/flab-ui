// The options of /etc/config/wireless that the Wi-Fi radios page edits, as tables of fields in the format of core/fields.js (read that
// file first), with the explanations taken from the OpenWrt documentation of the wireless configuration
// (https://openwrt.org/docs/guide-user/network/wifi/basic) and, for the mesh points, of 802.11s
// (https://openwrt.org/docs/guide-user/network/wifi/mesh/802-11s). Radios are `wifi-device` sections and wireless networks are
// `wifi-iface` sections of mode `ap` (an access point), `sta` (a client of another network) or `mesh` (an 802.11s mesh point).
//
// On top of the usual field keys, a field here has
//   group      the collapsible group of the card it belongs to (RADIO_GROUPS, IFACE_GROUPS)
//   secret     a write-only value: the router never sends it to the page, which only shows whether one is stored
//   dynamic    the list the page fills the options from: 'htmodes', 'countries' or 'encryptions'
//   modes      (wifi-iface) the modes the option applies to; every mode but `mesh` when not given
//   show       (values, ctx) => whether the control is shown; a hidden option keeps its value in the file and is neither
//              validated nor written. `ctx` is { mode, info, features, radio }: the interface's mode, what its encryption
//              means (encryptionInfo), what hostapd was built with, and the radio it is on
//   test       (value) => an error message or null, run on a non-empty value after the generic checks
//   single     a list written as a plain option when it holds one value (as `network` is by convention)

export const CONFIG = 'wireless';

//#region Encryption

// The encryption values this page offers for a new or changed network, in order, with the hostapd feature each one needs
// (`needs`: eap, sae or owe, see the features the flab.radio plugin reports). A value the config already holds that is not
// listed here (WEP, WPA, TKIP) stays selectable so it is not silently replaced.
export const ENCRYPTIONS = [
  { value: 'sae', label: 'WPA3-Personal (SAE)', needs: 'sae' },
  { value: 'sae-mixed', label: 'WPA2/WPA3-Personal (PSK and SAE)', needs: 'sae' },
  { value: 'psk2', label: 'WPA2-Personal (PSK)' },
  { value: 'psk2+ccmp', label: 'WPA2-Personal (PSK, AES only)' },
  { value: 'owe', label: 'Enhanced Open (OWE: encrypted, no password)', needs: 'owe' },
  { value: 'wpa3', label: 'WPA3-Enterprise (RADIUS or EAP)', needs: 'eap' },
  { value: 'wpa3-mixed', label: 'WPA2/WPA3-Enterprise', needs: 'eap' },
  { value: 'wpa2', label: 'WPA2-Enterprise (RADIUS or EAP)', needs: 'eap' },
  { value: 'none', label: 'Open (no encryption)' },
];

// What an `encryption` value means, from its mode (the part before the first "+", which only names ciphers):
//   kind     none | owe | psk (WPA or WPA2 with a passphrase) | sae | psk-sae (WPA2/WPA3 mixed) | eap (enterprise) | wep | other
//   key      the mode takes a passphrase or password (the `key` option)
//   sae      the mode uses SAE (WPA3-Personal), which hostapd only allows with protected management frames
//   pmf      protected management frames are mandatory (WPA3, OWE)
//   weak     WEP, WPA1 or TKIP: broken or deprecated, shown with a warning
//   needs    the hostapd feature the mode needs (eap, sae, owe), or null
export function encryptionInfo(enc) {
  const value = enc || 'none';
  const mode = value.split('+')[0];
  const tkip = /\+tkip/.test(value);
  const info = (kind, extra = {}) => ({ kind, key: false, sae: false, pmf: false, weak: tkip, needs: null, ...extra });
  if (mode === 'none') return info('none', { weak: false });
  if (mode === 'owe') return info('owe', { pmf: true, needs: 'owe', weak: false });
  if (mode === 'sae' || mode === 'psk3') return info('sae', { key: true, sae: true, pmf: true, needs: 'sae' });
  if (mode === 'sae-mixed' || mode === 'psk3-mixed' || mode === 'psk2+psk3') return info('psk-sae', { key: true, sae: true, needs: 'sae' });
  if (mode === 'psk2') return info('psk', { key: true });
  if (mode === 'psk' || mode === 'psk-mixed') return info('psk', { key: true, weak: true });
  if (mode === 'wpa3' || mode === 'wpa3-mixed') return info('eap', { needs: 'eap', pmf: mode === 'wpa3', sae: mode === 'wpa3' });
  if (mode === 'wpa2') return info('eap', { needs: 'eap' });
  if (mode === 'wpa' || mode === 'wpa-mixed') return info('eap', { needs: 'eap', weak: true });
  if (mode === 'wep') return info('wep', { weak: true });
  return info('other', { weak: false });
}

// The words for an `encryption` value in the review list and in warnings.
export function encryptionLabel(enc) {
  return ENCRYPTIONS.find(e => e.value === (enc || 'none'))?.label ?? enc;
}

//#endregion

//#region Value checks

// The error for an SSID, or null: 1 to 32 bytes (a multi-byte character counts as several).
export function ssidError(v) {
  const bytes = new TextEncoder().encode(v).length;
  return bytes > 32 ? `is ${bytes} bytes long; an SSID is at most 32 bytes (a character outside ASCII takes several)` : null;
}

// The error for a WPA passphrase or SAE password, or null: 8 to 63 printable ASCII characters, or exactly 64 hexadecimal
// digits, which are taken as the key itself.
export function keyError(v) {
  if (v.length === 64) return /^[0-9A-Fa-f]{64}$/.test(v) ? null : 'of 64 characters must be hexadecimal digits only (a passphrase is at most 63 characters)';
  if (v.length < 8) return 'must be at least 8 characters';
  if (v.length > 63) return 'must be at most 63 characters, or exactly 64 hexadecimal digits';
  return /^[\x20-\x7e]+$/.test(v) ? null : 'may only contain printable ASCII characters';
}

// The error for an htmode of a radio whose hardware did not report its modes, or null.
const htmodeError = v => (/^(NOHT|NONE|HT20|HT40[+-]?|(VHT|HE)(20|40|80|160)|EHT(20|40|80|160|320))$/.test(v) ? null : 'must be a mode such as HT20, VHT80, HE160 or NOHT');

// The error for a country code, or null: two letters or digits (an ISO 3166 code, or 00 for the world domain).
const countryError = v => (/^[A-Z0-9]{2}$/.test(v) ? null : 'must be a two-letter country code such as DE or IT');

//#endregion

//#region Radios

// The groups of a radio's settings, in order: id, title, whether the group starts open and an explanation.
export const RADIO_GROUPS = [
  { id: 'general', title: 'Radio', legend: 'Whether the radio is on, the generation and width it runs, which channels automatic selection may use, where it is (the country decides the channels and the power) and how strong it transmits. The channel is chosen with the tiles under these options.' },
  { id: 'rates', title: 'Rates and coexistence', legend: 'Which data rates the radio offers and how it behaves next to neighbors. Prefer the cell density to the explicit rate lists.' },
  { id: 'advanced', title: 'Advanced', legend: 'Rarely needed. The defaults suit almost every setup. Not every option is used by every driver: the OpenWrt documentation says which ones a chipset reads.' },
];

// The log levels of hostapd and the cell densities, as their words.
const LOG_LEVELS = { 0: 'verbose debugging', 1: 'debugging', 2: 'informational messages', 3: 'notifications', 4: 'warnings' };
const CELL_DENSITIES = { 0: 'disabled', 1: 'normal', 2: 'high', 3: 'very high' };

// The options of a `wifi-device` section. `show` gets the radio's values and { radio } where the radio is the entry of the
// model (its band, its hardware). The channel is edited by the picker, not by a field.
export const RADIO_FIELDS = [
  { key: 'disabled', type: 'bool', group: 'general', label: 'Disable this radio', default: false,
    hint: 'Turns the radio off: every wireless network on it stops and its clients are disconnected. The radio keeps its settings and comes back when this is cleared.' },
  { key: 'htmode', type: 'enum', dynamic: 'htmodes', group: 'general', label: 'Mode and channel width', blank: 'Driver default', test: htmodeError,
    hint: 'The 802.11 generation and the channel width in MHz: HT is 802.11n, VHT 802.11ac, HE 802.11ax and EHT 802.11be. A wider channel is faster but needs more free spectrum, leaves fewer channels to choose from and may reach less far. The list is what this radio\'s hardware reports. NOHT turns off 802.11n and later. On 2.4 GHz, HT40+ and HT40- say which side the second 20 MHz channel is on; plain HT40 picks it by itself.' },
  { key: 'channels', type: 'list', check: 'wifichannels', group: 'general', label: 'Channels for automatic selection', addLabel: 'Add channels', placeholder: '1-11', show: v => v.channel === 'auto' || v.channels.length > 0,
    hint: 'Used when the channel is automatic: hostapd picks one of these channels. Enter a range with a hyphen (36-48) or single channels, one entry each. Empty lets it choose from every channel the country allows.' },
  { key: 'country', type: 'enum', dynamic: 'countries', group: 'general', label: 'Country', blank: 'Driver default', test: countryError,
    hint: 'The two-letter country code. It decides which channels may be used and how strong the radio may transmit, so it must be the country the router is in. Changing it can make the current channel unavailable.' },
  { key: 'txpower', type: 'int', number: true, min: 1, max: 40, group: 'general', label: 'Transmit power (dBm)', placeholder: 'maximum allowed',
    hint: 'The maximum transmit power in dBm. The regulatory limit of the channel still applies, whatever is entered. Empty lets the driver use the maximum allowed. A lower power rarely improves anything except interference with neighbors.' },

  { key: 'cell_density', type: 'enum', options: ['0', '1', '2', '3'], numbered: true, labels: CELL_DENSITIES, group: 'rates', label: 'Coverage cell density', default: '0',
    hint: 'Picks the basic data rates from how densely access points are placed. Normal sets the basic rates to 6, 12 and 24 Mbit/s (5.5 and 11 with legacy rates), high to 12 and 24, very high to 24. Lower rates are not offered. Raise it where access points are close together, so clients leave a weak signal sooner.' },
  { key: 'legacy_rates', type: 'bool', group: 'rates', label: 'Allow legacy 802.11b rates', default: false, show: (v, c) => c.radio.band === '2g' || c.radio.values?.legacy_rates === '1',
    hint: 'Allow the old 802.11b rates (1, 2, 5.5 and 11 Mbit/s). Only legacy or badly behaving devices need them; they use a lot of airtime. Off by default since OpenWrt 21.02.' },
  { key: 'require_mode', type: 'enum', options: ['n', 'ac'], labels: { n: '802.11n or newer', ac: '802.11ac or newer' }, group: 'rates', label: 'Minimum client standard', blank: 'No minimum',
    hint: 'Only clients that support at least this standard may connect. It also turns off the legacy 802.11b rates. Setting 802.11ac makes some Apple devices unreliable even when they support it.' },
  { key: 'noscan', type: 'bool', group: 'rates', label: 'Skip the coexistence scan', default: false, show: (v, c) => c.radio.band === '2g' || c.radio.values?.noscan === '1',
    hint: 'Do not scan for overlapping networks before using a 40 MHz channel on 2.4 GHz, which falls back to 20 MHz when a neighbor is found. The scan is polite behavior in a crowded band, not a regulation.' },
  { key: 'ht_coex', type: 'bool', group: 'rates', label: 'Ignore 40 MHz intolerance (HT coexistence)', default: false, show: (v, c) => c.radio.band === '2g' || c.radio.values?.ht_coex === '1',
    hint: 'Do not honor the 40 MHz intolerance flag of other access points and stations: the radio keeps using 40 MHz channels even when it is received. Off by default.' },
  { key: 'beacon_int', type: 'int', number: true, min: 15, max: 65535, group: 'rates', label: 'Beacon interval', default: 100,
    hint: 'The time between beacon frames in units of 1.024 ms; hostapd allows 15 to 65535. It has no effect on client (sta) networks.' },
  { key: 'basic_rate', type: 'list', check: 'wifirate', group: 'rates', label: 'Basic rates (kb/s)', addLabel: 'Add rate', placeholder: '6000',
    hint: 'The basic data rates, each in kb/s (6000 is 6 Mbit/s). It only has an effect on access points and ad-hoc networks and overrides the cell density, which is the easier way to set it.' },
  { key: 'supported_rates', type: 'list', check: 'wifirate', group: 'rates', label: 'Supported rates (kb/s)', addLabel: 'Add rate', placeholder: '6000',
    hint: 'The data rates the radio offers, each in kb/s. It must include every basic rate, and the lowest basic rate should also be the lowest supported rate. It only has an effect on access points and overrides the cell density.' },

  { key: 'country_ie', type: 'enum', options: ['0', '1'], labels: { 0: 'off', 1: 'on' }, group: 'advanced', label: 'Advertise the country (802.11d)', blank: 'Default (on when a country is set)',
    hint: 'Put the country code and the channel and power map in beacon and probe response frames. It needs a country.' },
  { key: 'distance', type: 'int', number: true, min: 0, group: 'advanced', label: 'Distance to the furthest client (m)', placeholder: 'driver default',
    hint: 'The distance in meters between the access point and its furthest client; the driver adjusts its timeouts to it.' },
  { key: 'rts', type: 'int', number: true, min: 0, group: 'advanced', label: 'RTS/CTS threshold', placeholder: 'driver default',
    hint: 'Override the size in bytes above which frames are announced with a request-to-send exchange.' },
  { key: 'frag', type: 'int', number: true, min: 256, max: 2346, group: 'advanced', label: 'Fragmentation threshold', placeholder: 'none',
    hint: 'Frames longer than this many bytes are sent in fragments. Leave it empty unless a poor link needs it.' },
  { key: 'antenna_gain', type: 'int', number: true, min: 0, group: 'advanced', label: 'Antenna gain reduction (dBi)', default: 0,
    hint: 'How far an antenna with more gain than the radio was approved with lowers the transmit power below the regulatory maximum, in dBi.' },
  { key: 'log_level', type: 'enum', options: ['0', '1', '2', '3', '4'], numbered: true, labels: LOG_LEVELS, group: 'advanced', label: 'hostapd log level', default: '2',
    hint: 'How much hostapd writes to the system log for this radio. Level 1 shows, for example, whether 802.11r roaming completed.' },
  { key: 'diversity', type: 'bool', group: 'advanced', label: 'Automatic antenna selection', default: true,
    hint: 'Let the driver choose the antenna by itself. Only some drivers (ath9k and a few more) have antennas to choose from; the others ignore it.' },
  { key: 'rxantenna', type: 'int', number: true, min: 0, group: 'advanced', label: 'Antenna for receiving', placeholder: 'driver default',
    hint: 'The antenna used for receiving, driver specific: usually 1 for the first and 2 for the second, 0 for automatic where the driver supports it. It has no effect while automatic selection is on.' },
  { key: 'txantenna', type: 'int', number: true, min: 0, group: 'advanced', label: 'Antenna for transmitting', placeholder: 'driver default',
    hint: 'The antenna used for transmitting; the values are those of the receiving antenna.' },
  { key: 'chanbw', type: 'enum', options: ['5', '10', '20'], numbered: true, group: 'advanced', label: 'Narrow channel width (MHz)', blank: 'Default (20)', show: (v, c) => Boolean(c.radio.values?.chanbw),
    hint: 'Run a narrower channel of 5 or 10 MHz instead of 20. Only the ath9k and ath5k drivers support it, so it is shown only when the file already sets it.' },
  { key: 'ht_capab', type: 'list', check: 'htcapab', group: 'advanced', label: 'High throughput capabilities', addLabel: 'Add capability', placeholder: 'SHORT-GI-40',
    hint: 'The capabilities the radio advertises for 802.11n, for example LDPC or SHORT-GI-20. They are detected by themselves; change them only when you know the hostapd documentation, and compare with the hostapd version installed.' },
  { key: 'hostapd_options', type: 'list', group: 'advanced', label: 'Extra hostapd options', addLabel: 'Add option', placeholder: 'vendor_elements=dd0a0017f206010103010000',
    hint: 'Options passed as they are into the hostapd configuration of this radio, one per entry, for example a vendor-specific information element. A wrong line can stop every network on the radio.' },
];

//#endregion

//#region Wireless networks

// The groups of a wireless network's settings, in order.
export const IFACE_GROUPS = [
  { id: 'basic', title: 'Network', legend: 'The name, the networks it is attached to and how it is protected.' },
  { id: 'mesh', title: 'Mesh options', legend: 'What the wireless configuration can pass to a mesh point. The mesh parameters (forwarding, RSSI threshold, HWMP root mode and the rest) are not among them; the ones in force are listed with the interface.' },
  { id: 'enterprise', title: 'Enterprise authentication', legend: 'WPA-Enterprise authenticates each user instead of using one shared password: an access point asks a RADIUS server, a client proves itself with EAP.' },
  { id: 'security', title: 'Security options', legend: 'Protected management frames, SAE and WPS.' },
  { id: 'clients', title: 'Clients and traffic', legend: 'Who may connect, how many, and how traffic is handled.' },
  { id: 'roaming', title: 'Roaming (802.11r, k, v)', legend: 'Features that help clients move between access points of the same network. The access points must agree on them, and the 802.11k and r features need the full hostapd (wpad), not the basic one.' },
];

// Whether the encryption of these values is one that has a passphrase or password.
const needsKey = v => encryptionInfo(v.encryption).key;
// Whether the values are those of an enterprise access point, and of an enterprise client.
const eapAp = (v, c) => c.mode === 'ap' && c.info.kind === 'eap';
const eapSta = (v, c) => c.mode === 'sta' && c.info.kind === 'eap';
// Whether a station EAP method needs a username and password (PEAP and TTLS) or certificates (TLS).
const eapPassword = (v, c) => eapSta(v, c) && v.eap_type !== 'tls';
const eapTls = (v, c) => eapSta(v, c) && v.eap_type === 'tls';
// Whether 802.11r is on.
const onFt = v => v.ieee80211r;

// The options of a `wifi-iface` section of mode ap, sta or mesh. `network` is a list the page draws as check boxes.
export const IFACE_FIELDS = [
  { key: 'ssid', type: 'string', test: ssidError, modes: ['ap', 'sta'], group: 'basic', label: 'SSID', placeholder: 'network name',
    hint: 'The name this network broadcasts, 1 to 32 bytes. For a client network (sta) it is the name of the network to join.' },
  { key: 'mesh_id', type: 'string', test: ssidError, modes: ['mesh'], group: 'basic', label: 'Mesh ID', placeholder: 'mesh name',
    hint: 'The name of the mesh as defined in IEEE 802.11s, 1 to 32 bytes. Every node of the mesh must use the same Mesh ID, the same channel and the same password.' },
  { key: 'network', type: 'list', single: true, modes: ['ap', 'sta', 'mesh'], group: 'basic', label: 'Attached to',
    hint: 'The network interfaces (from /etc/config/network, usually a bridge) the wireless clients become part of. Each should be a layer 3 interface that a wireless network can be added to.' },
  { key: 'encryption', type: 'enum', dynamic: 'encryptions', modes: ['ap', 'sta', 'mesh'], group: 'basic', label: 'Encryption', blank: 'Open (no encryption)',
    hint: 'How the network is protected. WPA3-Personal (SAE) is the strongest password mode but older devices cannot join it; WPA2/WPA3 mixed lets both join, at the strength of WPA2 for the older ones. WPA2-Personal suits older devices. Open networks, WEP, WPA1 and TKIP offer little or no protection.' },
  { key: 'key', type: 'string', secret: true, test: keyError, modes: ['ap', 'sta', 'mesh'], group: 'basic', label: 'Password', show: v => needsKey(v),
    hint: 'The passphrase, 8 to 63 characters, or exactly 64 hexadecimal digits taken as the key itself. It is stored in the file but never shown here: leave this empty to keep the stored value, type a new one to replace it.' },
  { key: 'mcast_rate', type: 'int', number: true, min: 1, modes: ['mesh'], group: 'mesh', label: 'Multicast rate (kb/s)', placeholder: 'driver default',
    hint: 'A fixed rate for multicast frames over the mesh, in kb/s. Empty leaves the choice to the driver.' },
  { key: 'bssid', type: 'string', check: 'mac', modes: ['sta'], group: 'basic', label: 'Access point (BSSID)', placeholder: 'any access point with this SSID',
    hint: 'Join only the access point with this MAC address, when several share the name.' },
  { key: 'hidden', type: 'bool', group: 'basic', label: 'Hide the SSID', default: false,
    hint: 'Stop broadcasting the name in beacon frames. It does not protect the network, since the name still appears in clients\' requests, and clients may fail to roam and airtime efficiency may drop.' },
  { key: 'disabled', type: 'bool', modes: ['ap', 'sta', 'mesh'], group: 'basic', label: 'Disable this network', default: false,
    hint: 'The network stays in the file but is not started.' },

  { key: 'auth_server', type: 'string', check: 'host', group: 'enterprise', label: 'RADIUS server', placeholder: 'radius.example.com', show: eapAp,
    hint: 'The RADIUS server that authenticates the clients: a host name or an address.' },
  { key: 'auth_port', type: 'int', number: true, min: 1, max: 65535, group: 'enterprise', label: 'RADIUS port', default: 1812, show: eapAp,
    hint: 'The port of the RADIUS authentication server.' },
  { key: 'auth_secret', type: 'string', secret: true, group: 'enterprise', label: 'RADIUS secret', show: eapAp,
    hint: 'The secret shared with the RADIUS server. It is never shown here: leave this empty to keep the stored value, type a new one to replace it.' },
  { key: 'acct_server', type: 'string', check: 'host', group: 'enterprise', label: 'Accounting server', placeholder: 'none', show: eapAp,
    hint: 'A RADIUS server that is told when clients connect and disconnect. Optional.' },
  { key: 'acct_port', type: 'int', number: true, min: 1, max: 65535, group: 'enterprise', label: 'Accounting port', default: 1813, show: eapAp,
    hint: 'The port of the RADIUS accounting server.' },
  { key: 'acct_secret', type: 'string', secret: true, group: 'enterprise', label: 'Accounting secret', show: eapAp,
    hint: 'The secret shared with the accounting server. Never shown: leave empty to keep the stored value.' },
  { key: 'wpa_group_rekey', type: 'int', number: true, min: 0, group: 'enterprise', label: 'Group key renewal (s)', default: 600, show: eapAp,
    hint: 'How often the key shared by all clients of the network is replaced, in seconds.' },
  { key: 'eap_type', type: 'enum', options: ['peap', 'ttls', 'tls'], labels: { peap: 'PEAP', ttls: 'TTLS', tls: 'TLS (certificates)' }, group: 'enterprise', label: 'EAP method', blank: 'choose a method', show: eapSta,
    hint: 'The EAP protocol the client uses: TLS with certificates, or PEAP or TTLS with a user name and password.' },
  { key: 'auth', type: 'enum', options: ['MSCHAPV2', 'PAP'], group: 'enterprise', label: 'Inner authentication', default: 'MSCHAPV2', show: eapPassword,
    hint: 'The phase 2 method for PEAP and TTLS. With PEAP against an Active Directory server it must be set to MSCHAPV2 or PAP explicitly.' },
  { key: 'identity', type: 'string', secret: true, group: 'enterprise', label: 'Identity', show: eapPassword,
    hint: 'The EAP identity (user name) sent during authentication. It is not shown here: leave empty to keep the stored value.' },
  { key: 'password', type: 'string', secret: true, group: 'enterprise', label: 'EAP password', show: eapPassword,
    hint: 'The password sent during EAP authentication. It is not shown here: leave empty to keep the stored value.' },
  { key: 'ca_cert', type: 'string', check: 'path', group: 'enterprise', label: 'CA certificate', placeholder: '/etc/ssl/certs/ca.pem', show: eapSta,
    hint: 'The path of the certificate authority file that vouches for the server.' },
  { key: 'client_cert', type: 'string', check: 'path', group: 'enterprise', label: 'Client certificate', show: eapTls,
    hint: 'The path of the client certificate.' },
  { key: 'priv_key', type: 'string', check: 'path', group: 'enterprise', label: 'Private key file', show: eapTls,
    hint: 'The path of the private key of the client certificate.' },
  { key: 'priv_key_pwd', type: 'string', secret: true, group: 'enterprise', label: 'Private key password', show: eapTls,
    hint: 'The password that unlocks the private key file. Never shown: leave empty to keep the stored value.' },

  { key: 'ieee80211w', type: 'enum', options: ['0', '1', '2'], labels: { 0: 'disabled', 1: 'optional', 2: 'required' }, numbered: true, modes: ['ap', 'sta'], group: 'security', label: 'Protected management frames (802.11w)', blank: 'Default (set by the encryption)',
    hint: 'Protects deauthentication and similar frames against forgery. Left empty, OpenWrt requires it for WPA3 and Enhanced Open and makes it optional for WPA2/WPA3 mixed mode. WPA3 cannot work with it disabled.' },
  { key: 'sae_require_mfp', type: 'bool', group: 'security', label: 'Require protected frames for SAE', default: true, show: (v, c) => c.info.kind === 'psk-sae',
    hint: 'In WPA2/WPA3 mixed mode, require protected management frames from the clients that use SAE even when they are optional for the others.' },
  { key: 'sae_pwe', type: 'enum', options: ['0', '1', '2'], labels: { 0: 'hunting-and-pecking only', 1: 'hash-to-element only', 2: 'both' }, numbered: true, modes: ['ap', 'sta'], group: 'security', label: 'SAE password derivation', blank: 'Default (hunting-and-pecking)', show: (v, c) => c.info.sae,
    hint: 'How the SAE password element is derived. Hash-to-element resists side-channel attacks and is needed for some newer features and for 6 GHz, but older clients do not support it.' },
  { key: 'ocv', type: 'enum', options: ['0', '1', '2'], labels: { 0: 'disabled', 1: 'enabled', 2: 'enabled in workaround mode' }, numbered: true, modes: ['ap', 'sta'], group: 'security', label: 'Operating channel validation', blank: 'Default (disabled)',
    hint: 'Clients and the access point check each other\'s operating channel to defeat channel-switch attacks; it needs protected management frames. Workaround mode lets a client that claims support but does not send the information connect anyway.' },
  { key: 'wps_pushbutton', type: 'bool', group: 'security', label: 'WPS push button', default: false, show: (v, c) => c.info.kind === 'psk' || v.wps_pushbutton,
    hint: 'Allow a device to join by pressing a WPS button (or running hostapd_cli wps_pbc). Only works with WPA2-PSK and needs the full wpad and hostapd-utils. WPS has known weaknesses; leave it off unless you need it.' },
  { key: 'wpa_disable_eapol_key_retries', type: 'bool', group: 'security', label: 'No EAPOL key retransmissions', default: false, show: (v, c) => c.info.kind !== 'none' && c.info.kind !== 'owe',
    hint: 'A workaround for key reinstallation attacks (KRACK) on client devices that cannot be updated: the access point does not resend the key messages. It can make connecting less robust under load.' },

  { key: 'isolate', type: 'bool', group: 'clients', label: 'Isolate clients', default: false,
    hint: 'Wireless clients of this network cannot talk to each other, only to the network behind the access point.' },
  { key: 'bridge_isolate', type: 'bool', group: 'clients', label: 'Isolate clients on the bridge', default: false,
    hint: 'Isolate the wireless clients from each other on the access point\'s bridge too, for example those of the 2.4 GHz and 5 GHz networks.' },
  { key: 'maxassoc', type: 'int', number: true, min: 1, group: 'clients', label: 'Maximum clients', placeholder: 'driver default',
    hint: 'The most clients that may be connected at the same time.' },
  { key: 'macfilter', type: 'enum', options: ['disable', 'allow', 'deny'], labels: { disable: 'off', allow: 'only the listed devices may connect', deny: 'the listed devices may not connect' }, group: 'clients', label: 'MAC address filter', default: 'disable',
    hint: 'Allow only the listed devices, or block the listed devices. A MAC address is easy to copy, so this is not a protection against a determined intruder.' },
  { key: 'maclist', type: 'list', check: 'mac', group: 'clients', label: 'MAC addresses', addLabel: 'Add address', placeholder: '00:11:22:33:44:55', show: v => v.macfilter === 'allow' || v.macfilter === 'deny' || v.maclist.length > 0,
    hint: 'The devices the filter applies to, as 00:11:22:33:44:55.' },
  { key: 'wmm', type: 'bool', group: 'clients', label: 'WMM (Wi-Fi multimedia)', default: true,
    hint: 'Quality-of-service queues for voice, video, best effort and background traffic. Required for 802.11n, 802.11ac and 802.11ax; with it off, clients may be held to the 802.11a/g rates.' },
  { key: 'dtim_period', type: 'int', number: true, min: 1, max: 255, group: 'clients', label: 'DTIM period', default: 2,
    hint: 'One delivery traffic indication message is sent every this many beacons, so sleeping clients wake up less often with a higher value. Some users report that 3 avoids problems with Apple devices.' },
  { key: 'max_inactivity', type: 'int', number: true, min: 1, group: 'clients', label: 'Inactivity limit (s)', default: 300,
    hint: 'A client that has sent nothing for this long is polled with an empty frame; if that is not acknowledged it is disconnected.' },
  { key: 'disassoc_low_ack', type: 'bool', group: 'clients', label: 'Disconnect on lost frames', default: true,
    hint: 'Disconnect clients when transmissions to them keep failing, which signals that they are gone. It depends on the driver.' },
  { key: 'skip_inactivity_poll', type: 'bool', group: 'clients', label: 'Skip the inactivity poll', default: false,
    hint: 'Do not poll idle clients: they are disconnected at the inactivity limit even if they are still in range.' },
  { key: 'multicast_to_unicast', type: 'bool', group: 'clients', label: 'Multicast to unicast', default: false,
    hint: 'Send each multicast frame to every client as its own unicast frame. Multicast goes out at a low rate without acknowledgement, so this makes streams more reliable with a few clients, at the cost of airtime with many.' },
  { key: 'proxy_arp', type: 'bool', group: 'clients', label: 'Proxy ARP', default: false,
    hint: 'The access point answers ARP requests for its associated clients itself, so those broadcasts are not sent over the air to every client.' },
  { key: 'short_preamble', type: 'bool', group: 'clients', label: 'Short preamble', default: true,
    hint: 'Use the short preamble where clients support it. It is a small gain in airtime.' },

  { key: 'ieee80211r', type: 'bool', group: 'roaming', label: 'Fast transition (802.11r)', default: false,
    hint: 'Lets clients move to another access point of the same network in 15 to 75 ms instead of over 150 ms. It only matters for traffic that cannot pause, such as calls. Some older devices cannot connect to a network that has it on.' },
  { key: 'mobility_domain', type: 'string', test: v => (/^[0-9A-Fa-f]{4}$/.test(v) ? null : 'must be four hexadecimal digits'), group: 'roaming', label: 'Mobility domain', placeholder: 'from the SSID', show: onFt,
    hint: 'A 2-byte identifier, as four hexadecimal digits, shared by the access points a client may move between. Empty derives it from the SSID.' },
  { key: 'ft_over_ds', type: 'bool', group: 'roaming', label: 'Fast transition over the wired network', default: false, show: onFt,
    hint: 'Do the roaming exchange through the wired network instead of over the air. It is known to cause problems with Apple devices, so it is off by default.' },
  { key: 'ft_psk_generate_local', type: 'enum', options: ['0', '1'], labels: { 0: 'off', 1: 'on' }, group: 'roaming', label: 'Generate PSK keys locally', blank: 'Default (automatic)', show: (v, c) => onFt(v) && c.info.kind !== 'eap',
    hint: 'Create the fast transition keys of a WPA2-Personal network on the access point itself, so no key has to be pushed or pulled between access points. Do not enable it for WPA3 or WPA2/WPA3 mixed mode: it breaks fast transition there.' },
  { key: 'pmk_r1_push', type: 'bool', group: 'roaming', label: 'Push PMK-R1 keys', default: false, show: onFt,
    hint: 'Whether the first access point of a roam pushes the roaming key to the others. With WPA3 (SAE) it breaks fast transition.' },
  { key: 'nasid', type: 'string', test: v => (v.length > 48 ? 'must be at most 48 characters' : null), group: 'roaming', label: 'NAS identifier', placeholder: 'the BSSID without colons', show: onFt,
    hint: 'The identifier of this access point as the first one of a roam (PMK-R0 key holder), 1 to 48 characters. It must be unique among the access points.' },
  { key: 'r1_key_holder', type: 'string', test: v => (/^[0-9A-Fa-f]{12}$/.test(v) ? null : 'must be 12 hexadecimal digits'), group: 'roaming', label: 'R1 key holder', placeholder: 'the BSSID', show: onFt,
    hint: 'The identifier of this access point as the next one of a roam (PMK-R1 key holder): a 6-byte value as 12 hexadecimal digits.' },
  { key: 'reassociation_deadline', type: 'int', number: true, min: 1000, max: 65535, group: 'roaming', label: 'Reassociation deadline', default: 1000, show: onFt,
    hint: 'How long a client has to reassociate after authenticating, in time units of 1.024 ms (1000 to 65535). Some devices fail with 1000; 20000 is what Cisco equipment uses.' },
  { key: 'ieee80211k', type: 'bool', group: 'roaming', label: 'Neighbor reports (802.11k)', default: false,
    hint: 'Clients can ask the access point for a list of nearby access points when they look for a better one. A list that covers all your access points needs more software beyond this switch.' },
  { key: 'bss_transition', type: 'bool', group: 'roaming', label: 'BSS transition (802.11v)', default: false,
    hint: 'The access point can suggest that a client move to another access point.' },
  { key: 'wnm_sleep_mode', type: 'bool', group: 'roaming', label: 'WNM sleep mode', default: false,
    hint: 'Extended sleep mode for clients: they can sleep longer between checks of the access point.' },
  { key: 'time_advertisement', type: 'enum', options: ['0', '2'], labels: { 0: 'off', 2: 'on' }, numbered: true, group: 'roaming', label: 'Time advertisement', default: '0',
    hint: 'Send the time of day to clients in the beacon (part of 802.11v). It needs the time zone below.' },
  { key: 'time_zone', type: 'string', group: 'roaming', label: 'Time zone', placeholder: 'CET-1CEST,M3.5.0,M10.5.0/3', show: v => v.time_advertisement === '2' || v.time_zone !== '',
    hint: 'The local time zone in POSIX form (IEEE 1003.1), sent with the time.' },
];

//#endregion
