# Connected devices (a view of Devices and Interfaces; the tab **Connected devices**)

The devices connected now, for the time being the Wi-Fi clients: they used to be the second half of the [Wi-Fi](wifi.md) page and moved here (`connected/index.js`, hosted by `interfaces/index.js`; refreshed every 5 s, the Pause and Refresh buttons are the page's). Data comes from `flab.wifi clients` (the backend is unchanged); without the plugin the view says so. Wired clients and DHCP leases are meant to be listed here too, later.

- **Tiles**: the connected clients, the clients of each radio (with its channel and mode), the average signal, how many use WPA3 or OWE, and how many have a security grade of C or D.
- **Legend** (folded): what the AKM, cipher, SAE group and PMF values and the security score mean.
- One card per wireless network (SSID; mesh interfaces and their peers are on the [Mesh](mesh.md) page): its mode, security, interface, radio and channel, and a table of its clients with MAC, IPv4 and IPv6, hostname, signal, Wi-Fi standard, bandwidth, TX/RX bitrate, security label, AKM, SAE group, cipher and PMF, and the 0-100 security score. The columns sort on a click on the header.
- The **filter** box and the **radio** selector are in the command bar on this tab only (`connected.setActive`); the filter searches the MAC, addresses, hostname, SSID, security, AKM, cipher and standard, every word of it must match, and the selector limits the cards to one radio. The tiles count all radios whatever the selector says.
