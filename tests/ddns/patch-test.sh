#!/bin/sh
# Tests tools/patch-ddns-scripts.sh on a copy of the router's ddns-scripts files; nothing under /usr/lib/ddns is touched.
# Usage: patch-test.sh <patch-ddns-scripts.sh>      prints PASS/FAIL lines, exits 1 when any failed
PATCH=$1
T=/tmp/flab-ddns-patch-test
FAILED=0
rm -rf $T; mkdir -p $T/lib $T/pristine
# The pristine package files: the router's, or the originals the patch kept when the router has been patched already.
cp -p /usr/lib/ddns/* $T/pristine/
for f in $T/pristine/*.flab-orig; do [ -f "$f" ] && mv -f "$f" "${f%.flab-orig}"; done
cp -p $T/pristine/* $T/lib/
export DDNS_LIB_DIR=$T/lib

# Prints PASS or FAIL for the condition (a command) and counts failures.
check() {
	if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; FAILED=$((FAILED + 1)); fi
}

check 'the original files are reported as original' '[ "$(sh $PATCH status)" = original ]'
check 'apply succeeds' 'sh $PATCH apply'
check 'and the files are reported as patched' '[ "$(sh $PATCH status)" = patched ]'
check 'the originals are kept next to them' '[ -f $T/lib/dynamic_dns_functions.sh.flab-orig ] && [ -f $T/lib/update_cloudflare_com_v4.sh.flab-orig ]'
check 'the patched files keep the originals mode' '[ "$(ls -l $T/lib/dynamic_dns_functions.sh | cut -c1-10)" = "$(ls -l $T/pristine/dynamic_dns_functions.sh | cut -c1-10)" ] && [ "$(ls -l $T/lib/update_cloudflare_com_v4.sh | cut -c1-10)" = "$(ls -l $T/pristine/update_cloudflare_com_v4.sh | cut -c1-10)" ]'
cp $T/lib/dynamic_dns_functions.sh $T/once.sh
check 'a second apply changes nothing' 'sh $PATCH apply && cmp -s $T/lib/dynamic_dns_functions.sh $T/once.sh && [ "$(grep -c "flab-ui: byte-exact" $T/lib/dynamic_dns_functions.sh)" = 1 ]'
check 'the other scripts are untouched' 'cmp -s $T/pristine/dynamic_dns_updater.sh $T/lib/dynamic_dns_updater.sh && cmp -s $T/pristine/dynamic_dns_lucihelper.sh $T/lib/dynamic_dns_lucihelper.sh'

# The patched urlencode: every password must come back as it was, after the URL decoding a provider does.
sed -n '/^urlencode() {/,/^}/p' $T/lib/dynamic_dns_functions.sh > $T/enc.sh
write_log() { echo "write_log: $*"; }
. $T/enc.sh
for pw in 'plain' 'a$b' "it's" 'a\b' 'a\nb' 'p%41' 'sp ace' 'caffè' '€uro' 'a&b=c' '~-_.' '"q"' 'a`id`' 'x$(id)y' 'tab	x' '\\' "'\"\\\$\`%&"; do
	urlencode OUT "$pw"
	back=$(printf '%b' "$(printf '%s' "$OUT" | sed 's/%/\\x/g')")
	check "urlencode keeps [$pw] exactly ($OUT)" '[ "$back" = "$pw" ] && ! printf "%s" "$OUT" | grep -q "[^-_.~a-zA-Z0-9%]"'
done

# The patched Cloudflare headers, eval'ed like the script does: the header must carry the password and nothing may run.
write_log() { :; }
sed -n '/^# set headers/,/^__PRGBASE="\$__PRGBASE --header .Content-Type/p' $T/lib/update_cloudflare_com_v4.sh > $T/cf.sh
for pw in 'tok' "it's" 'a$b' 'a\b' 'x`touch $T/ran`' 'q"q' "'; touch $T/ran; '" 'caffè'; do
	username=Bearer; password="$pw"; __PRGBASE="printf '[%s]\n'"
	. $T/cf.sh
	got=$(eval "$__PRGBASE" | sed -n 2p)
	check "the Cloudflare header carries [$pw] and runs nothing" '[ "$got" = "[Authorization: Bearer $pw]" ] && [ ! -e $T/ran ]'
done

check 'the same for the global API key header' 'username=me; password="it'"'"'s"; __PRGBASE="printf \"[%s]\n\""; . $T/cf.sh; [ "$(eval "$__PRGBASE" | sed -n 4p)" = "[X-Auth-Key: it'"'"'s]" ]'

# A file that is not the expected version is left alone and reported.
printf 'urlencode() {\n\techo changed\n}\n' > $T/lib/dynamic_dns_functions.sh
rm -f $T/lib/dynamic_dns_functions.sh.flab-orig
cp -p $T/pristine/update_cloudflare_com_v4.sh $T/lib/update_cloudflare_com_v4.sh; rm -f $T/lib/update_cloudflare_com_v4.sh.flab-orig
check 'an unexpected urlencode() is left alone and apply says so' 'sh $PATCH apply 2>/dev/null; [ $? = 1 ] && grep -q changed $T/lib/dynamic_dns_functions.sh && [ "$(sh $PATCH status)" = original ]'

# Restore.
rm -rf $T/lib; mkdir -p $T/lib; cp -p $T/pristine/* $T/lib/
sh $PATCH apply
check 'restore puts the originals back' 'sh $PATCH restore && cmp -s $T/pristine/dynamic_dns_functions.sh $T/lib/dynamic_dns_functions.sh && cmp -s $T/pristine/update_cloudflare_com_v4.sh $T/lib/update_cloudflare_com_v4.sh && [ "$(sh $PATCH status)" = original ] && ! ls $T/lib | grep -q flab-orig'

rm -rf $T
[ $FAILED = 0 ]
