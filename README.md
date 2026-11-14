# flab-ui

A lightweight web administration UI for OpenWrt. It is a static single-page app served by `uhttpd` that talks to the
router through the standard `ubus` JSON-RPC endpoint and a few small `rpcd` ucode plugins. There is no build step and
no framework, and Bootstrap is bundled, so it works offline and fits comfortably in a small router's RAM.

Developed and tested on a GL.iNet GL-MT6000 running an OpenWrt snapshot. Ports, bridges, radios, tunnels, zones and
peers are discovered at run time, so other boards are shown as they are, but they are untested.

## Pages

| Page | What it does |
|---|---|
| Overview | Uptime, CPU, load, memory and temperatures. |
| Wired network | Physical ports and VLANs; edit the VLAN sections. |
| Devices and Interfaces | The network as a board, from cable to interface, with bridges; edit it. |
| Wi-Fi | Radios, wireless networks and clients; edit channels and settings. |
| Mesh | 802.11s mesh peers and paths (read only). |
| Firewall | Zones, rules and port forwards with live nftables counters; edit them. |
| Routing | Kernel routes and rules, and BGP when BIRD is installed (read only). |
| IPsec VPN | strongSwan connections, tunnels, traffic and a security score (read only). |
| WireGuard | Interfaces and peers; edit them. |
| DHCP | odhcpd and dnsmasq leases, reservations and pools; edit them. |
| DNS | Unbound or dnsmasq state, options and zones; edit them. |
| Dynamic DNS | ddns-scripts services, status and logs; edit them. |
| Traffic | Bandwidth, connections and nlbwmon usage; edit the nlbwmon settings. |
| Services | List, start, stop and restart services. |
| Toolbox | Ping, traceroute, MTR, DNS, TLS checks, an iperf3 server and Wake-on-LAN. |
| Logs | System and kernel log. |
| System settings | `/etc/config/system`: general, time zone and NTP, logging, kernel and cron. |

Each page reads from the program it manages (`swanctl`, `birdc`, `wg`, `nft`, `iw`, `nlbw`, `unbound-control` and so
on). These are optional: install the ones for the pages you use.

## Install

flab-ui is an architecture-independent apk package that depends only on `rpcd`, `rpcd-mod-ucode`, `ucode`
(`ucode-mod-fs`, `ucode-mod-ubus`, `ucode-mod-uci`), `uhttpd` and `uhttpd-mod-ubus`. It is not in an OpenWrt feed yet.
Download the apk (and its `.sha256`) from the [latest release](https://github.com/formicalab/flab-ui/releases/latest),
copy it to the router and install it. The package is unsigned, so apk needs `--allow-untrusted`:

```sh
scp -O flab-ui-<version>.apk root@<router>:/tmp/
ssh root@<router> 'apk add --allow-untrusted /tmp/flab-ui-<version>.apk'
```

It targets apk-based OpenWrt (a snapshot, or a release built with apk). To build it yourself, see
[Package](docs/package.md#building-the-package).

Installing reloads `rpcd`, so no reboot is needed. Then open `https://<router>/flab/` and sign in as `root` with the
router's root password. To remove it:

```sh
apk del flab-ui
```

## Safety

- **No login of its own.** The UI signs in with the router's `root` login through rpcd. The package adds rpcd ACL
  fragments for its own calls but no login, and it changes no rpcd configuration, so it grants nothing that root doesn't
  already have. The session lives in `sessionStorage` and expires after 15 minutes without use.
- **Changes are staged, reviewed and rolled back.** Editing pages stage changes in rpcd's `uci` object, show a review
  list, then apply with an automatic rollback: the page checks that the router is still reachable and confirms within
  30 seconds. If it cannot, for example because the change cut the connection, rpcd restores the previous
  configuration by itself.
- **Secrets stay on the router.** Keys, passwords and tokens are never sent to the browser (only whether they are set),
  and secret-looking values in logs are redacted.

Details are in the [security model](docs/architecture.md#security-model).

## Development

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
