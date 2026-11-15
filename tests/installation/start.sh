#!/bin/sh
# Executed only inside run.sh's disposable rootfs/user/PID namespaces.
set -eu
mkdir -p /var/run/ubus /var/lock /var/state
apk update
# Install only the APK's declared dependencies. Never preinstall a missing flab-ui runtime dependency here.
apk add --allow-untrusted /flab-ui.apk
apk info -e flab-ui
apk info -v > /installed-packages.txt
test -s /www/flab/LICENSE
test -s /usr/share/ucode/flab/util.uc
for plugin in /usr/share/rpcd/ucode/flab.*.uc; do
  ucode -c -o /dev/null "$plugin"
done
hash=$(cat /password.hash)
# Role names refer to the ACLs actually installed by apk; there is no session.grant or checkout ACL union.
for role in editor reader; do
  uci set "rpcd.$role=login"
  uci set "rpcd.$role.username=flab-$role"
  uci set "rpcd.$role.password=$hash"
  uci add_list "rpcd.$role.read=flab"
done
uci add_list rpcd.editor.write=flab
uci commit rpcd
sed -i "s|^root:[^:]*:|root:$hash:|" /etc/shadow
for config in network firewall dhcp system; do
  [ -f "/etc/config/$config" ] || touch "/etc/config/$config"
done
ubusd &
for attempt in $(seq 1 30); do [ -S /var/run/ubus/ubus.sock ] && break; sleep 1; done
rpcd -t 30 &
for attempt in $(seq 1 30); do ubus list session > /dev/null 2>&1 && break; sleep 1; done
for plugin in /usr/share/rpcd/ucode/flab.*.uc; do
  object=${plugin##*/}
  object=${object%.uc}
  ubus list "$object" | grep -Fx "$object"
done
exec uhttpd -f -p "127.0.0.1:$FLAB_SMOKE_PORT" -h /www -u /ubus
