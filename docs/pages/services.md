# Services (route `#services`)
Refreshed every 5 s. Lists the router's services and starts, stops, restarts, enables and disables them. Two sources are merged by
name: the init scripts in `/etc/init.d` (`flab.services list`: whether each starts at boot and in which position,
from the `S<NN><name>` links of `/etc/rc.d`), which is why a service that is stopped but installed still appears, and
the daemons procd reports (`service list`: state and PIDs). procd's own `service` object cannot start or stop
anything, so the init scripts do the work, as they do for `/etc/init.d/<name> restart` in a shell.

- **State**: `running` (procd reports every instance running), `idle` (procd knows the service, nothing runs) or
  `no instance` (procd does not list it: stopped, a one-shot service such as `firewall` or `network`, or not managed
  by procd). The legend above the table says so. A procd service without an init script is listed without buttons.
- **Listening**: the TCP and UDP ports the service's processes have open, one chip per protocol and port (TCP first,
  then by port), matched by PID: `flab.services list` also returns `listening` (from `netstat -lntup`, run as root so every
  socket has its owner), and a socket belongs to the row whose procd PIDs include its owner. The chip's tooltip names the
  addresses; a port open on loopback only (`127.0.0.1`, `::1`) is dashed and dimmed, so the ones reachable from the network
  stand out. UDP sockets in the kernel's ephemeral range (`ip_local_port_range`, 32768 and up: the port picked for an
  outgoing query) and sockets that no process owns (WireGuard's, which the kernel holds) are left out. A service that
  procd does not track by PID, or that has no open port, shows a dash.
- **Buttons**: Start (disabled while the service runs; a disabled button keeps the normal look at reduced opacity, as
  `base.css` defines the Bootstrap disabled-state variables for `.btn-fl` and `.btn-brand`), Stop and Restart on every
  init script, then **Disable** for a service that starts at boot or **Enable** for one that does not (the script's own
  `disable` and `enable`, which remove or add the `S<NN><name>` link in `/etc/rc.d`; the running service is not touched,
  and the Start at boot column changes once the list refreshes). The boot-sequence
  scripts (`boot`, `done`, `umount`) have none. While a call runs every button is disabled and the row says
  "Restarting…"; afterwards the outcome is shown above the tiles (green when the script exited 0, red with the
  script's own output when it failed, until dismissed) and the list is refreshed. A login that may not call
  `flab.services control` (`can()`) sees no buttons and a note (the shared `note()` of `core/forms.js`); without the plugin the page is the read-only procd list.
- **Confirmation** (`model.js`, `riskOf`): stopping or restarting `rpcd`, `uhttpd`, `network`, `dropbear`,
  `firewall`, `wpad`, `dnsmasq`, `odhcpd` or `log`, and disabling any of them at boot, first shows what will happen, in
  plain words, with Confirm and Cancel; nothing is sent before Confirm. The notes that can lock the user out are red
  (restarting `rpcd` signs everyone out, including the user; stopping `uhttpd` or `rpcd` cannot be undone from the page;
  stopping `network` or `wpad` can cut the connection; disabling `rpcd`, `uhttpd`, `network` or `firewall` does nothing
  now but locks the router out or leaves it unprotected after its next restart), the others yellow. Starting and enabling
  never ask.
- **Session loss**: `rpcd` keeps the sessions in memory, so after it restarts the next request is refused and the
  shell returns to the sign-in screen with "Session expired"; the outcome note says beforehand that the session ends.
- **Backend** (`flab.services`): `control` accepts a name that is, as a whole and on a single line (`one_line()` in `flab.util`:
  `^...$` patterns match the first line of a multi-line string), a plain file name (letter or digit
  first, then letters, digits, `_`, `.` and `-`, at most 64 characters) **and** is in the list of executable files
  of `/etc/init.d`, an action that is exactly `start`, `stop`, `restart`, `enable` or `disable`, and refuses the boot-sequence scripts.
  Only that validated name and action reach the shell command line; nothing else is interpolated. A refused call
  returns `ok: false` and an `error`, and runs nothing. `reload` is not offered because whether a script supports
  it is not known without running it. The reply is `{ name, action, ok, code, detached, output, error }`; `output`
  is the script's output, at most 4096 bytes.
- **Waiting and background**: a deferred worker waits for the script (at most 20 seconds), preserving its exit
  status and at most 4096 bytes of output while rpcd stays responsive. Timeout or output exhaustion is an explicit
  failure, not a successful empty reply. `stop` and `restart`
  of `rpcd`, `uhttpd` and `network`, which carry the reply or the connection, instead run in the background two
  seconds later and return `detached: true` at once; their result cannot be reported, so the page says the action
  was requested and refreshes a few seconds later. `enable` and `disable` of those services only touch the boot links
  and run in the foreground like any other call.
- **ACL**: `rpcd/acl.d/flab-services.json` grants `flab.services` `list` (read) and `control` (write) and nothing
  generic such as `file exec`; the `service list` call comes from `flab-base.json`.
