# flab-ui

A lightweight web administration UI for OpenWrt. It is a static single-page app served by `uhttpd` that talks to the
router through the standard `ubus` JSON-RPC endpoint and `rpcd` ucode plugins. There is no frontend build step or
runtime framework, and Bootstrap is bundled, so the interface assets need no external CDN.

Developed and tested on a GL.iNet GL-MT6000 running an OpenWrt snapshot. Ports, bridges, radios, tunnels, zones and
peers are discovered at run time, so other boards are shown as they are, but they are untested.

## Pages

| Page | What it does |
|---|---|
| Overview | Uptime, CPU, load, memory and temperatures. |
| Wired network | Physical ports and VLANs; edit the VLAN sections. |
| Wi-Fi | Radios, wireless networks and clients; edit channels and settings. |
| Mesh | 802.11s mesh peers and paths (read only). |
| IPsec VPN | strongSwan connections, tunnels, traffic and a security score (read only). |
| WireGuard | Interfaces and peers; edit them. |
| Firewall | Zones, rules and port forwards with live nftables counters; edit them. |
| DHCP | odhcpd and dnsmasq leases, reservations and pools; edit them. |
| DNS | Unbound or dnsmasq state, options and zones; edit them. |
| Dynamic DNS | ddns-scripts services, status and logs; edit them. |
| Devices and Interfaces | The network as a board, from cable to interface, with bridges; edit it. |
| Routing | Kernel routes and rules; edit the static routes; BGP when BIRD is installed. |
| Traffic | Bandwidth, connections and nlbwmon usage; edit the nlbwmon settings. |
| Services | List, start, stop, restart, enable and disable services. |
| Toolbox | Ping, traceroute, MTR, DNS, TLS checks, an iperf3 server and Wake-on-LAN. |
| Logs | System and kernel log. |
| System settings | `/etc/config/system`: general, time zone and NTP, logging, kernel and cron. |

Each page reads from the program it manages (`swanctl`, `birdc`, `wg`, `nft`, `iw`, `nlbw`, `unbound-control` and so
on). These are optional: install the ones for the pages you use.

Use a current Chrome, Edge, Firefox or Safari: the frontend needs native ES modules, BigInt, `structuredClone` and
`<dialog>`. Browser suites target Edge and headless Chromium; other browsers and boards have not been certified.

## Install

flab-ui is an architecture-independent apk package that depends only on `rpcd`, `rpcd-mod-ucode`, `ucode`
(`ucode-mod-fs`, `ucode-mod-ubus`, `ucode-mod-uci`, `ucode-mod-uloop`), `uhttpd` and `uhttpd-mod-ubus`. It is not in an OpenWrt feed yet.
Download the apk (and its `.sha256`) from the [latest release](https://github.com/formicalab/flab-ui/releases/latest),
copy both to the router, verify the checksum and install it. The package is unsigned, so apk needs `--allow-untrusted`:

```sh
scp -O flab-ui-<version>-r1.apk flab-ui-<version>-r1.apk.sha256 root@<router>:/tmp/
ssh root@<router> 'cd /tmp && sha256sum -c flab-ui-<version>-r1.apk.sha256 && apk add --allow-untrusted ./flab-ui-<version>-r1.apk'
```

It targets apk-based OpenWrt (a snapshot, or a release built with apk). To build it yourself, see
[Package](docs/package.md#building-the-package).

The router must already serve `/www` and `/ubus` through uhttpd. Configure HTTPS, its certificate and an HTTP-to-HTTPS
redirect before signing in; flab-ui does not configure TLS or firewall access. Manage it from a trusted LAN or VPN,
not an exposed WAN port.

Installing reloads `rpcd`, so no reboot is needed. Then open `https://<router>/flab/` and sign in as `root` with the
router's root password. Do not install or remove the package during a configuration apply. To remove it:

```sh
apk del flab-ui
```

## Safety

- **No login of its own.** The UI signs in with the router's `root` login through rpcd. The package adds rpcd ACL
  fragments for its own calls but no login, and it changes no rpcd configuration, so it grants nothing that root doesn't
  already have. The session lives in `sessionStorage` and expires after 15 minutes without RPC activity; an open,
  polling page keeps it alive. Sign out explicitly on a shared browser.
- **Changes use rpcd's rollback.** Editing pages show a review list, stage changes and apply with a rollback timer
  (normally 30 seconds; Devices and Interfaces uses 90). They read back the configuration and confirm automatically.
  Static-route edits also verify installation on running interfaces. This does not prove that the internet or every
  affected service works. Saves reject existing staged changes anywhere in the session; ambiguous transport failures
  are reported as uncertain, not as confirmed rollback. Keep alternate access for network changes, and see the
  [limitations](docs/architecture.md#configuration-change-limitations).
- **Stored credentials are filtered.** Config plugins omit recognized secret options, and logs redact recognizable
  secret-looking text. This is not a guarantee for arbitrary custom options or free text. Secrets you type, and
  WireGuard keys generated in the browser, necessarily exist there and are sent to the router when saved.

Details are in the [security model](docs/architecture.md#security-model).

## Development

- [Changelog](CHANGELOG.md) records the changes in each new release.

- [docs/](docs/README.md) covers the architecture, the frontend and backend, the behavior of every page, how to add a
  page, the test suites and the coding conventions.
- `tools/package.ps1` (PowerShell 7) is the one script for the package. It builds the apk from the working tree with
  an OpenWrt SDK, on Linux or in WSL on Windows (`-Action Build`), installs it on a router (`-Action Deploy`) or removes
  it (`-Action Remove`), and publishes a release (`-Action Release`: it tags the source, updates the package Makefile
  to the same version and hash, builds the apk from the tag and creates the GitHub release). See
  [Package script](docs/package.md#package-script) and [Releasing](docs/package.md#releasing).
- Tests live in `tests/` and need Node.js, PowerShell 7 and, for most suites, ssh access to a test router. They use
  fixtures and mocks and do not change the router's configuration; `-Browser` also drives a browser. See
  [Testing](docs/testing.md).

## License

MIT, see [LICENSE](LICENSE). The bundled Bootstrap 5.3.3 CSS and Bootstrap Icons 1.11.3 paths are also MIT licensed.
The [distributed notices](www/LICENSE) cover all three and are installed with the web files.
