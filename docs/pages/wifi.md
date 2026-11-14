# Wi-Fi (route `#wifi`)
Two sections, both refreshed every 5 s.

**Radios** (`flab.radio`, `wifi/radios.js`): one card per radio from UCI `wifi-device`. Header with band, phy,
state, standards and hardware; key figures (running channel, frequency, width, center, TX power, noise floor,
antennas, clients); the configuration next to what is actually running (channel, mode, TX power with the
regulatory limit of that channel, country vs active regulatory domain, cell density, beacon interval,
options); channel utilization (busy, RX and TX airtime as a percentage and chart, derived in the browser from
the driver's cumulative survey counters); the channels allowed by the regulatory domain (a picker to change the
channel, see Editing below) with the running block highlighted and DFS (radar) channels marked; and a table of the SSIDs (BSSID,
networks, security, clients, live and total traffic, 802.11r/k/v, WPS, OCV, hidden, isolation, MAC filter
policy with entry count, BSS status). Findings appear when something is off: radio down, setup failing,
running channel different from the configured one, high noise, busy channel, DFS availability check in
progress, open network, country mismatch. `status` copies only whitelisted options: keys, passwords, FT key
material and MAC lists never leave the router through it (`config`, below, returns the MAC list of a filter because it is edited there). Mesh (802.11s) interfaces are not listed here: a radio
carrying one shows a `mesh · <id>` badge linking to the Mesh page, and mesh peers are not in the clients list.

**Editing the wireless configuration** (`wifi/schema.js` option tables, `wifi/model.js` pure model, `wifi/editors.js` controls,
`wifi/channels.js` and `wifi/picker.js` for the channel, the shared editor of `core/editpage.js`): the page edits
`/etc/config/wireless`, the radios (`wifi-device`) and the wireless networks (`wifi-iface` of mode `ap` and `sta`; mesh
interfaces are the Mesh page's). Everything it offers comes from what the router reports (radios, bands, channels, supported
modes, countries, hostapd features), so it works on any hardware.
- **Reading without secrets**: the configuration is read through `flab.radio config`, which returns every option of every
  `wifi-device` and `wifi-iface` section except the ones that hold a secret (`key`, `key1`-`key4`, `sae_password`,
  `auth_secret`, `acct_secret`, `dae_secret`, `identity`, `password`, `priv_key_pwd`, `wps_pin`, `r0kh`, `r1kh`, and any
  option whose name says password, passphrase, secret, pwd or token): for those it reports only that they are set. The
  browser never calls `uci get` on this config (the ACL fragment does not grant it), and the read-back after a save goes
  through the same method. Password fields are write-only: they are empty and say "stored; leave empty to keep it", a typed value
  replaces the stored one, and a value that was typed is never shown in the review list. The MAC list of a MAC filter is
  returned (it is edited here); `status` still only reports its entry count. Sections of other types (`wifi-vlan`,
  `wifi-station`, which can hold keys) are listed by name only.
- **Radio settings**: a foldable block per radio card with the options of the OpenWrt documentation, each with a hint: disable
  the radio, mode and channel width (`htmode`), country, transmit power, cell density, legacy 802.11b rates, minimum client
  standard, coexistence scan, beacon interval, 802.11d, distance, RTS and fragmentation thresholds, antenna gain and the hostapd
  log level. The mode list is what the hardware reports: the htmodes `iwinfo` lists for a running interface, else the widths the
  phy's capabilities advertise for the radio's band (HT, VHT, HE, EHT; the explicit `HT40+` and `HT40-` on 2.4 GHz and `NOHT` are
  added); a radio whose phy is unknown gets a text box checked for its form. The country list comes from the driver
  (`iwinfo <if> countrylist`), else a text box. Options that apply to one band are shown on it (legacy rates and the coexistence
  scan on 2.4 GHz) or when they are already set.
- **Wireless networks**: one foldable editor per `ap` and `sta` network on each radio, with groups (network, enterprise
  authentication, security options, clients and traffic, roaming 802.11r/k/v), and buttons that add an access point or a
  client network. Options: SSID, the networks it is attached to (a check box per network interface of the router), encryption
  (what the installed hostapd can do: SAE and OWE and WPA-Enterprise are offered only when `hostapd -vsae`, `-vowe`, `-veap`
  succeed; a value the file already holds, such as WEP or TKIP, stays selectable), the password, hidden SSID, disable,
  RADIUS server, port and secret and accounting for an enterprise access point, EAP method, identity, password and
  certificates for an enterprise client, protected management frames, SAE derivation, OCV, WPS, isolation, client limit,
  MAC filter and list, WMM, DTIM, inactivity, multicast to unicast, proxy ARP, 802.11r (mobility domain, FT over DS, local PSK
  generation, PMK-R1 push, NAS and R1 key holder, reassociation deadline), 802.11k, 802.11v, WNM sleep, time advertisement. An
  option that does not apply to the mode or the encryption is hidden, keeps its value in the file and is not written. A new
  network is added as a named section (`wifinetN`); a section without a name (`cfgXXXXXX`) is addressed by its generated name,
  and the check after a save finds the networks by position because that name changes with the content.
- **Validation** (errors block Save and mark the control; warnings do not): only what the draft changes is checked, so an
  odd configuration does not block an unrelated edit. Errors: an SSID over 32 bytes or empty, a network attached to nothing, a
  password that is not 8 to 63 printable ASCII characters or 64 hexadecimal digits, a missing password on a protected network
  (a stored one counts), an encryption the hostapd cannot do, missing RADIUS or EAP fields, protected management frames
  disabled with WPA3 or OWE, malformed MAC addresses, malformed 802.11r identifiers, numbers out of range, a mode the hardware does not
  report, a country the driver does not know, a channel the new mode cannot carry.
- **Warnings for dangerous changes**: switching a radio off (how many networks and clients it takes down, and that the router
  undoes the change by itself 30 seconds after the apply if the admin loses the connection), changing the SSID,
  password, encryption, networks, protected frames or hiding of a network that has clients (their number, and that the admin may be
  connected through it), removing or disabling a running network, an open network (who can join and what they reach), WEP, WPA1
  or TKIP, two networks with the same SSID on one radio, an access point and a client network sharing a radio (they share its
  channel), a power above the regulatory limit, changing the country, the 802.11r settings that break fast transition with
  WPA3, an allow filter with an empty list, a 40 MHz channel on 2.4 GHz, legacy rates, requiring 802.11ac, a hidden SSID.
- **Saving**: stage, apply with the rollback countdown (rpcd reloads Wi-Fi), read the configuration back through
  `flab.radio config` and compare every shown option (a typed password: that one is now stored), then wait up to 16 seconds for each
  changed radio to be up with its new or changed networks running (a radio that is switched off, or has no enabled network, is not
  waited for); if the check or the wait fails the change is rolled back. A radio on a DFS channel counts as up while it listens for radar.
- Polling is suspended while edits are pending, a control has the focus, the pointer is over a channel picker or a save runs. A login that may not write sees the
  forms read only; a router whose `flab.radio` has no `config` method gets the radios read only with a note, and a radio whose phy did not list its
  channels gets the plain channel strip.
- The page needs the ACL fragment `rpcd/acl.d/flab-radio.json`: `flab.radio` `status` and `config`, `uci changes` (read) and the
  `uci` write methods on `wireless`. It does not grant `uci get`.

**The channel picker** (`wifi/channels.js` model, `wifi/picker.js` control): each radio card shows its allowed channels as tiles. The
`channel` option of the radio is a channel number or `auto`; a channel is only selectable when the whole block of the width of the mode
being edited fits around it in the regulatory domain (others are hatched), so choosing a mode redraws which blocks fit, and a mode that
no longer fits the chosen channel is an error on both controls.
- **Preview**: hovering or focusing a tile shows the block the radio would use at that width, in blue,
  or in red with the reason when it does not fit. The block is made of whole 20 MHz channels: on 5 and 6 GHz the
  fixed blocks (36-48 at 80 MHz, 100-128 at 160 MHz); on 2.4 GHz a 40 MHz block is the channel and the one four
  numbers away, on the side netifd picks (channels 1-6 above, 7-13 below, or an explicit `HT40+`/`HT40-`), so
  channel 4 with channel 8 covers 2417-2457 MHz. The channels between the two are shown as covered, the ones that
  stick out as partly overlapped (dashed). The sentence under the tiles says the same in words.
- **Choosing**: a click selects (green, with its block tinted), a second click undoes it; the Auto chip hands the
  choice to the radio. The yellow review banner lists the change from and to, with warnings that do not block Save:
  a block that reaches radar (DFS) channels (the radio listens for radar for 1 to 10 minutes before clients can
  connect), `auto`, and a radio that carries a mesh interface (the other mesh nodes must be moved to the same
  channel by hand). A channel the regulatory domain disables, or whose block does not fit, is an error that
  blocks Save.

**Clients** (`flab.wifi`, a port of `utilities/list_connected_devices.uc`): clients per radio and SSID with
MAC, IPv4/IPv6, hostname, signal, Wi-Fi standard, bandwidth, TX/RX bitrate, security label, AKM/SAE
group/cipher/PMF details and the 0-100 security score (AKM, cipher, SAE group and PMF scoring). Filter, radio
selector, sortable columns, pause and a legend above the tables.
