# System settings (route `#settings`)
Changes the router: it shows and edits `/etc/config/system`: every option the OpenWrt wiki
documents for the `system` section and for its `timeserver` (NTP) section, in four cards that each take the full
width of the page: General, Time zone and NTP, System log, and Kernel, cron and memory. It is shown at the
bottom of the navigation pane and refreshes every 10 s. It reads through rpcd's `uci` object (`uci get system`),
`system info` (the clock) and `service list sysntpd` (what the NTP client runs with); it needs no plugin, only
the ACL fragment `rpcd/acl.d/flab-settings.json`.
- **Tiles**: the router's clock with its UTC offset, the hostname and description, the time zone and its POSIX
  rule, the NTP client (on or off, and whether `ntpd` runs).
- **The options are data.** `settings/schema.js` lists every field (key, section, card, type, label, hint,
  default, check, bounds); the controls, validation, change list and UCI operations are generated from it by
  `index.js` and `model.js`, so supporting another option is one entry. Options in the file that the table does
  not know are left untouched.
- **General**: `hostname`, `description`, `notes`, `ttylogin`, `urandom_seed`; the fields flow in as many
  columns as fit.
- **Time zone and NTP**: one pane with three columns side by side. *Time zone*: pick an IANA zone. Saving writes
  **both** `zonename` (the name) and `timezone` (its POSIX rule, which is what the system applies, including
  daylight saving time). The router has no zoneinfo files, so `pages/settings/zones.js` carries the table (about
  420 zones, from the IANA database); regenerate it with `python tools/gen-zones.py` (needs `pip install tzdata`;
  `--check` tells whether it is current). "Custom POSIX rule" edits the rule alone and drops `zonename`; a router
  whose zone name is not in the table (a hand-written rule) is shown that way and left alone unless the zone is
  touched. *NTP client* (`timeserver` section): `enabled`, `use_dhcp`, the ordered `server` list,
  `dhcp_interface`, and what `ntpd` is running with. *NTP server for the network*: `enable_server`, `interface`.
  NTP on with no way to find a server is only a warning. A missing `timeserver` section is created, named `ntp`.
- **System log**: `log_size`, `log_buffer_size`, `log_type`, `log_file`, `log_remote`, `log_ip`, `log_port`,
  `log_proto`, `log_hostname`, `log_prefix`, `log_trailer_null`.
- **Kernel, cron and memory**: `buffersize`, `conloglevel`, `cronloglevel`, `zram_comp_algo`, `zram_size_mb`.
- **Controls**: checkboxes show the value, or OpenWrt's default when the option is absent. An empty text control
  shows "default: ..." or an example in gray italics, never a value-looking placeholder. Numbers, hosts, IP
  addresses, paths, interface names, enums and the time zone rule are validated; a bad entry is marked, explained
  and blocks saving. An emptied option is deleted from the file instead of being stored empty.
- **Review banner**: a row at the bottom of the sticky command bar, so Save is always on screen however far the
  form is scrolled. It is hidden while there is nothing to report and appears with the first edit: the number and
  names of the pending changes, Details (the full list of what changes from what to what, and how a save works),
  Discard edits and Save and apply (flow in [Configuration changes](../architecture.md#configuration-changes)), then the
  validation errors and warnings and the outcome of the last save (dismissable; it also disappears with the next
  edit). A renamed router shows its new hostname in the navigation header right away. Changes already staged in
  the session (for example from an attempt that was rolled back) are shown with a "Discard them" button. The page
  does not poll over unsaved edits, a focused control or a save in progress.
