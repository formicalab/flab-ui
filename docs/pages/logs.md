# Logs (route `#logs`)
Refreshed every 5 s, from `flab.logs`. The last entries of the **system log** (`logread`, logd's ring buffer
in RAM: every daemon's messages and the kernel's) or the **kernel log** (`dmesg`), newest at the bottom.
- **Parsing** happens on the router: a system line `Wed Nov 11 12:06:15 2026 daemon.info odhcpd[2571]: ...`
  becomes time, facility, severity (emerg 0 to debug 7; logd's short names `warn`, `error` and `panic` count as
  warning, err and emerg), program, pid and message; a kernel line
  `<6>[ 272373.68] ...` takes its severity and facility from the syslog priority and its wall-clock time from
  the boot time. A line that does not parse is kept whole, with no time or origin, so nothing is dropped.
- **Controls**: log to read, text filter (origin, priority and message; every word must match), minimum
  severity, one source (program), how many lines to load (200 to 2000), Newest (jump to the bottom), Download
  (the filtered entries as a text file; nothing is uploaded), pause, refresh.
- **Follow**: the pane opens scrolled to the bottom and keeps following new entries while it stays there;
  scrolling up stops following and a refresh keeps the position.
- **Tiles**: entries shown of loaded, errors (severity err or worse), warnings, age of the newest entry.
  Rows are tinted by severity.
- **Redaction**: values after `password`, `psk`, `secret`, `token`, `key` and similar names are replaced with
  `<redacted>` on the router before they are sent.
- Filtering is done in the browser on the loaded tail, so changing a filter is instant; the log and the line
  count are requested from the router.
