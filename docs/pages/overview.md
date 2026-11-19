# Overview (default)
A dashboard that opens with a hero card (model, CPU and target, OpenWrt build number, kernel, plus uptime, load, memory, free storage and
CPU temperature KPIs), then one Network card (Internet connectivity and IPv6 delegation), a CPU load card, a Temperatures
card and a Storage card listing every mount point. Nothing is shown twice: CPU usage and per-sensor temperatures live
in their own cards.

The Network card reads `network.interface dump`. It reports IPv4 and IPv6 independently from active default routes:
the primary WAN name, protocol, address, gateway and DNS servers. "Online" means an active global WAN address and
default route; it is a routing-state verdict, not an external probe. Its IPv6 delegation half shows a global delegated
prefix and every prefix assignment reported for LAN interfaces. Inactive, loopback and unique-local prefixes are
not presented as provider connectivity.

`flab.system storage` reads the mounted-filesystem table without depending on a feature package. Overview also describes each physical disk (vendor, model, capacity, manufacture date,
firmware, the device's own wear estimate and end-of-life state, bytes written and read since boot, erase unit and the
partition table) and shows each
mount point with its backing hardware (kind, model, partition, e.g. eMMC), filesystem type, device, read-only state,
used/free/total bytes and utilization, for the root overlay, flash, temporary and other meaningful mounts.

**CPU load** comes from `flab.system cpu`, which returns the kernel's cumulative counters from
`/proc/stat` (plus load average and task counts). Utilization is a rate, so the browser derives it from
the difference between two successive samples (`overview/cpu.js`): total busy percentage, a stacked bar per
state (user, system, interrupts = irq + softirq, I/O wait, steal), one bar per core and a 60-sample history
chart. "Busy" excludes idle and I/O wait, like top and htop. On a router the interrupts share is worth
watching: packet forwarding and Wi-Fi show up as softirq. The first visit takes a second sample a moment after
the first, so numbers appear immediately; the history restarts if the router uptime shows a gap longer than
20 s (page paused or not open), since a delta over minutes would be a misleading average. A fixed-clock CPU
(no cpufreq policy) shows no frequency.

Temperatures come from `flab.sensors`: thermal zones plus hwmon sensors (deduplicated, since the CPU appears
as both). Health: Normal below 75 C, Warm from 75 C, Hot from 90 C or at a sensor's own throttle/critical
limit. Also shows CPU trip points, throttling state and cooling devices (passive only when no fan is reported).
Sensor names are friendly for the drivers seen so far (MediaTek and Qualcomm radios, the SoC thermal zone, MDIO PHYs); others
show their own label or name.
