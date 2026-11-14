# Overview (default)
KPI tiles (uptime, CPU usage, load, memory, CPU temperature, hottest sensor), a CPU load card, a
Temperatures card, system info (including the kernel version) and the memory breakdown.

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
