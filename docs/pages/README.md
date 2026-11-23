# Pages

Navigation order: Overview · Ethernet ports · Wi-Fi radios · IPsec VPN · WireGuard · Firewall · DHCP · DNS · Dynamic DNS ·
Devices and Interfaces · Routing · Asterisk · Traffic · Services · Toolbox · Logs, then Settings at the bottom, next to Sign out. The network
pages run from the physical layer up; DHCP and DNS, the services the clients of those networks use, come next; Devices and Interfaces recaps how they fit together, followed by routing
(the kernel's routes, static-route editing and BGP), the optional telephony page (Asterisk), traffic (where the bandwidth goes), the procd services, the toolbox
(diagnostic tools) and the logs.

- [Overview](overview.md)
- [Ethernet ports](network.md)
- [Wi-Fi radios](radios.md) (with the access points, client networks and mesh points on them)
- [IPsec VPN](ipsec.md)
- [WireGuard](wireguard.md)
- [Firewall](firewall.md)
- [DHCP](dhcp.md)
- [DNS](dns.md)
- [Dynamic DNS](ddns.md)
- [Devices and Interfaces](interfaces.md) (with the [Connected devices](connected.md) view)
- [Routing](routing.md)
- [Asterisk](asterisk.md) (optional; read only)
- [Traffic](traffic.md)
- [Services](services.md)
- [Toolbox](toolbox.md)
- [Logs](logs.md)
- [System settings](settings.md)

The Routes view includes the `route` and `route6` editor, policy rules and a combined route list; the BGP tab is read-only. Service
actions, diagnostics and cable tests are on-demand operations, not configuration changes protected by UCI rollback.
