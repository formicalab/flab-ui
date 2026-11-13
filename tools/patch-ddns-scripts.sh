#!/bin/sh
# Makes the ddns-scripts updater accept any character in a password or token. Run on the router as root:
#   patch-ddns-scripts.sh apply     patch (does nothing when already patched), keeping the original as <file>.flab-orig
#   patch-ddns-scripts.sh restore   put the originals back
#   patch-ddns-scripts.sh status    print "patched" or "original"
#
# Two things in the package mangle a password:
#   1. urlencode() in dynamic_dns_functions.sh (used for every provider that puts [PASSWORD] in its update address) hands the
#      string to awk with `-v`, which reads backslash sequences as escapes (a backslash and a letter are not kept), and indexes
#      it with a table of the ASCII characters only, so a character such as an accented letter or the euro sign turns into
#      "%00". The patch passes the string in the environment and works on bytes (LC_ALL=C), so every byte is encoded exactly.
#   2. update_cloudflare_com_v4.sh puts the password into a single-quoted header that is later eval'ed, so a single quote in it
#      ends the quoting. The patch writes the quotes of the password the way the shell needs them (' becomes '\'').
# A package upgrade replaces the files; run this again (deploy.ps1 does) and the page warns while they are original.
set -e

DIR=${DDNS_LIB_DIR:-/usr/lib/ddns}
FUNCS=$DIR/dynamic_dns_functions.sh
CF=$DIR/update_cloudflare_com_v4.sh
MARK_ENC='flab-ui: byte-exact'
MARK_CF='flab-ui: quoted'

# Moves the new version $2 over $1, keeping the original once. The content goes into a copy of the original (which keeps its mode)
# next to it and the copy is moved over it, so an updater that is running keeps reading the old inode.
install_new() {
	[ -f "$1.flab-orig" ] || cp -p "$1" "$1.flab-orig"
	cp -p "$1" "$1.mode"
	cat "$2" > "$1.mode"
	rm -f "$2"
	mv -f "$1.mode" "$1"
}

# Patches urlencode().
patch_funcs() {
	[ -f "$FUNCS" ] || return 0
	grep -q "$MARK_ENC" "$FUNCS" && return 0
	grep -q '__ENC="$(awk -v str="$2"' "$FUNCS" || { echo "urlencode() in $FUNCS is not the expected version; left alone" >&2; return 1; }
	cat > "$FUNCS.block" <<'EOF'
	# flab-ui: byte-exact (the string goes in the environment, not through `awk -v`, and is read byte by byte)
	__ENC="$(DDNS_STR="$2" LC_ALL=C awk 'BEGIN{ORS="";str=ENVIRON["DDNS_STR"];for(i=1;i<=255;i++)lookup[sprintf("%c",i)]=i
		for(k=1;k<=length(str);++k){enc=substr(str,k,1);if(enc!~"[-_.~a-zA-Z0-9]")enc=sprintf("%%%02x", lookup[enc]);print enc}}')"
EOF
	awk -v block="$FUNCS.block" '
		BEGIN { while ((getline l < block) > 0) new = new l "\n" }
		index($0, "__ENC=\"$(awk -v str=\"$2\"") { printf "%s", new; skip = 1; next }
		skip { skip = 0; next }
		{ print }
	' "$FUNCS" > "$FUNCS.new"
	rm -f "$FUNCS.block"
	sh -n "$FUNCS.new" || { rm -f "$FUNCS.new"; echo "patched $FUNCS does not parse; left alone" >&2; return 1; }
	grep -q "$MARK_ENC" "$FUNCS.new" || { rm -f "$FUNCS.new"; echo "patch of $FUNCS did not apply; left alone" >&2; return 1; }
	install_new "$FUNCS" "$FUNCS.new"
}

# Patches the headers of the Cloudflare script.
patch_cloudflare() {
	[ -f "$CF" ] || return 0
	grep -q "$MARK_CF" "$CF" && return 0
	grep -q "Bearer \$password'" "$CF" || { echo "headers in $CF are not the expected version; left alone" >&2; return 1; }
	cat > "$CF.block" <<'EOF'
__PWQ="$(printf '%s' "$password" | sed "s/'/'\\\\''/g")"  # flab-ui: quoted (a ' in the password is written as '\'' for the eval)
EOF
	awk -v block="$CF.block" '
		BEGIN { while ((getline l < block) > 0) new = new l "\n" }
		/^local __HOST __DOMAIN / { sub(/__RECID$/, "__RECID __PWQ") }
		$0 == "# set headers" { print; printf "%s", new; next }
		/Bearer \$password/ || /X-Auth-Key: \$password/ { sub(/\$password/, "$__PWQ") }
		{ print }
	' "$CF" > "$CF.new"
	rm -f "$CF.block"
	sh -n "$CF.new" || { rm -f "$CF.new"; echo "patched $CF does not parse; left alone" >&2; return 1; }
	grep -q "$MARK_CF" "$CF.new" || { rm -f "$CF.new"; echo "patch of $CF did not apply; left alone" >&2; return 1; }
	install_new "$CF" "$CF.new"
}

case "$1" in
	apply)
		rc=0
		patch_funcs || rc=1
		patch_cloudflare || rc=1
		exit $rc
		;;
	restore)
		for f in "$DIR"/*.flab-orig; do
			[ -f "$f" ] && mv -f "$f" "${f%.flab-orig}" || true
		done
		exit 0
		;;
	status)
		if { [ ! -f "$FUNCS" ] || grep -q "$MARK_ENC" "$FUNCS"; } && { [ ! -f "$CF" ] || grep -q "$MARK_CF" "$CF"; }; then echo patched; else echo original; fi
		;;
	*)
		echo "usage: $0 apply|restore|status" >&2
		exit 2
		;;
esac
