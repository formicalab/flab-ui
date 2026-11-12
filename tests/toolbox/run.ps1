#Requires -Version 7.0
<#
.SYNOPSIS
Tests the Toolbox page (connectivity check, ping, traceroute, DNS lookup and comparison, TLS certificate check).

.DESCRIPTION
1. Unit tests of the page model (the request a form may build, the parsers of every tool's output, the connectivity
   check's verdicts, a certificate's findings), against output the routers really printed (samples.mjs,
   samples-tools.mjs).
2. Runs the repository's flab.diag.uc on the router for real: jobs against loopback and localhost (ping, traceroute,
   DNS, the router's own HTTPS certificate, a comparison, a whole connectivity check), read while they run and after,
   stopped, refused (every line of refusals.txt, several of which would create a canary file if a command ran), with
   job ids that are not the plugin's own, and with the cap of three running jobs. The plugin is run with CRLF line
   endings, as a Windows checkout deploys it. Nothing leaves the router except what the connectivity check itself
   asks of the internet.
3. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1) and drives the
   Toolbox page with a scripted job engine in place of flab.diag, so no tool runs on the router. Nothing reaches the
   router's configuration.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (deploy.ps1 -Action Deploy) and
installs playwright-core into the temporary work folder. Everything created on the router (/tmp/flab-toolbox-test,
/tmp/flab-diag) and locally is removed afterwards.

.PARAMETER Router
SSH destination of the router.

.PARAMETER Url
Base URL of the deployed UI (used by -Browser).

.PARAMETER Browser
Also run the browser test.

.PARAMETER KeepWork
Keep the local work folder (the plugin outputs and the browser test's node modules) after the run, so the browser test
can be repeated by hand. The folder is %TEMP%\flab-toolbox-test.
#>
[CmdletBinding()]
param(
    [string]$Router = 'root@openwrt.lab.formicalab.casa',
    [string]$Url = 'https://openwrt.lab.formicalab.casa/flab/',
    [switch]$Browser,
    [switch]$KeepWork
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
. (Join-Path $here '..\TestSession.ps1')
$sid = $null
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$diagPlugin = Join-Path $root 'rpcd\ucode\flab.diag.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-toolbox-test'
$remote = '/tmp/flab-toolbox-test'

#region Helpers
function Invoke-Remote {
    <#
    .SYNOPSIS
    Runs a POSIX shell script on the router over ssh.
    .DESCRIPTION
    Normalizes line endings to LF because BusyBox sh rejects CRLF.
    .PARAMETER Script
    Shell script text.
    #>
    param([string]$Script)

    Invoke-Native 'ssh' @($Router, ($Script -replace "`r`n", "`n"))
}
#endregion

try {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory (Join-Path $work 'out') -Force | Out-Null

    Write-Host '1/3 Unit tests: the Toolbox model'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))

    Write-Host '2/3 Running the diagnostics plugin on the router (real jobs against loopback)'
    Invoke-Remote "rm -rf $remote; mkdir -p $remote"
    Invoke-Native 'scp' @('-O', '-r', $libs, $diagPlugin, (Join-Path $here 'harness.uc'), (Join-Path $here 'refusals.txt'), (Join-Path $here 'wake-refusals.txt'), "${Router}:$remote/")
    Invoke-Remote @"
set -e
cd $remote
for f in *.uc flab/*.uc refusals.txt wake-refusals.txt; do tr -d '\r' < `$f > `$f.l && mv `$f.l `$f; done
# The plugin is run with CRLF line endings, as a Windows checkout deploys it: its scripts must not carry the CRs.
sed 's/`$/\r/' flab.diag.uc > flab.diag.uc.l && mv flab.diag.uc.l flab.diag.uc
"@
    $diagScript = @'
set -e
cd @REMOTE@
d() { FLAB_PLUGIN=@REMOTE@/flab.diag.uc FLAB_METHOD="$1" FLAB_ARGS="$2" ucode -L "@REMOTE@/*.uc" harness.uc; }
idof() { sed -n 's/.*"id": "\([0-9a-f]*\)".*/\1/p'; }
sizeof() { sed -n 's/.*"size": \([0-9]*\).*/\1/p'; }
rm -rf /tmp/flab-diag /tmp/flab-diag-canary
d status '' > out-diag-status.json

# A ping read while it runs, after it ended, from its end and from an offset.
d start '{"tool":"ping","host":"127.0.0.1","count":5}' > out-diag-ping.start.json
id=$(idof < out-diag-ping.start.json)
sleep 2; d read "{\"id\":\"$id\",\"from\":0}" > out-diag-ping.running.json
sleep 5; d read "{\"id\":\"$id\",\"from\":0}" > out-diag-ping.done.json
size=$(sizeof < out-diag-ping.done.json)
d read "{\"id\":\"$id\",\"from\":$size}" > out-diag-ping.tail.json
d read "{\"id\":\"$id\",\"from\":$((size - 40))}" > out-diag-ping.part.json

# Stopping a running job.
d start '{"tool":"ping","host":"127.0.0.1","count":10}' > out-diag-stop.start.json
id=$(idof < out-diag-stop.start.json)
sleep 2; d stop "{\"id\":\"$id\"}" > out-diag-stop.stop.json
sleep 1; d read "{\"id\":\"$id\",\"from\":0}" > out-diag-stop.read.json
ps | grep -c '[p]ing -c 10' > out-diag-stop.procs.txt || true
d stop "{\"id\":\"$id\"}" > out-diag-stop.again.json

# A DNS lookup and a traceroute, both against this router.
d start '{"tool":"dns","host":"localhost","type":"A"}' > out-diag-dns.start.json
id=$(idof < out-diag-dns.start.json); sleep 3; d read "{\"id\":\"$id\",\"from\":0}" > out-diag-dns.read.json
d start '{"tool":"traceroute","host":"127.0.0.1","hops":3,"probes":1}' > out-diag-trace.start.json
id=$(idof < out-diag-trace.start.json); sleep 3; d read "{\"id\":\"$id\",\"from\":0}" > out-diag-trace.read.json
d start '{"tool":"traceroute","host":"127.0.0.1","hops":3,"probes":1,"resolve":true}' > out-diag-resolve.start.json
id=$(idof < out-diag-resolve.start.json); sleep 4; d read "{\"id\":\"$id\",\"from\":0}" > out-diag-resolve.read.json

# The options that are allowed (the command line is what matters; the jobs end within a few seconds).
d start '{"tool":"ping","host":"127.0.0.1","count":1,"size":100,"family":"4","source":"lo"}' > out-diag-variant1.json
d start '{"tool":"traceroute","host":"127.0.0.1","hops":5,"probes":3,"method":"icmp","family":"4","source":"127.0.0.1"}' > out-diag-variant2.json
d start '{"tool":"dns","host":"127.0.0.1","type":"PTR"}' > out-diag-variant3.json
d start '{"tool":"dns","host":"localhost","type":"mx","server":"127.0.0.1"}' > out-diag-variant4.json
sleep 5

# The certificate check against this router's own HTTPS server (a certificate for its name, so the address does not
# match), a STARTTLS run against a closed port, the comparison against the router and loopback, and the connectivity check
# with a name that needs no outside lookup.
d start '{"tool":"tls","host":"127.0.0.1","port":443}' > out-diag-tls.start.json
id=$(idof < out-diag-tls.start.json); sleep 6; d read "{\"id\":\"$id\",\"from\":0}" > out-diag-tls.read.json
d start '{"tool":"tls","host":"127.0.0.1","port":9,"sni":"localhost","starttls":"smtp"}' > out-diag-tls2.start.json
id=$(idof < out-diag-tls2.start.json); sleep 3; d read "{\"id\":\"$id\",\"from\":0}" > out-diag-tls2.read.json
d start '{"tool":"compare","host":"localhost","type":"A","servers":["router","127.0.0.1","router"]}' > out-diag-compare.start.json
id=$(idof < out-diag-compare.start.json); sleep 4; d read "{\"id\":\"$id\",\"from\":0}" > out-diag-compare.read.json
d start '{"tool":"check","host":"localhost"}' > out-diag-check.start.json
id=$(idof < out-diag-check.start.json); sleep 26; d read "{\"id\":\"$id\",\"from\":0}" > out-diag-check.read.json
grep -c "$(printf '\r')" /tmp/flab-diag/$id/job.sh > out-diag-check.cr || true
d start '{"tool":"check"}' > out-diag-check2.start.json
sleep 1; d stop "{\"id\":\"$(idof < out-diag-check2.start.json)\"}" > /dev/null
sleep 1; d read "{\"id\":\"$(idof < out-diag-check2.start.json)\",\"from\":0}" > out-diag-check2.read.json
ps | grep -cE '[o]penssl s_client|[p]ing -4 -c 2' > out-diag-check2.procs.txt || true

# Requests that must be refused: nothing may run, no job may appear, the canary file must not be created.
before=$(ls /tmp/flab-diag | wc -l)
i=0
while IFS= read -r line; do i=$((i + 1)); d start "$line" > out-diag-refused-$i.json; done < refusals.txt
# Wake-on-LAN: one packet out of the loopback device, where nothing hears it, then every refused request (the canary is
# checked below with the others).
d wake '{"mac":"02:00:00:00:00:01","iface":"lo"}' > out-diag-wake.json
d wake '{"mac":"02-00-00-00-00-02","iface":"lo"}' > out-diag-wake2.json
i=0
while IFS= read -r line; do i=$((i + 1)); d wake "$line" > out-diag-wakerefused-$i.json; done < wake-refusals.txt
after=$(ls /tmp/flab-diag | wc -l)
echo "$before $after" > out-diag-refused.count
if [ -e /tmp/flab-diag-canary ]; then echo yes > out-diag-canary.txt; else echo no > out-diag-canary.txt; fi
n=0
for bad in '../../etc' 'zzzzzzzzzzzz' '061e2960506' '' '061e29605065/../x' '..'; do
  d read "{\"id\":\"$bad\"}" > out-diag-badid-$n.read.json
  d stop "{\"id\":\"$bad\"}" > out-diag-badid-$n.stop.json
  n=$((n + 1))
done

# At most three jobs at once; then stop them all. Wait for every earlier job to end first, and record how many were still running.
running_jobs() {
  n=0
  for j in /tmp/flab-diag/*; do
    [ -d "$j" ] || continue
    [ -f "$j/rc" ] && continue
    pid=$(cat "$j/pid" 2>/dev/null); [ -n "$pid" ] && [ -d "/proc/$pid" ] && n=$((n + 1))
  done
  echo $n
}
for t in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ "$(running_jobs)" -eq 0 ] && break; sleep 1; done
running_jobs > out-diag-cap.before
ids=''
for c in 1 2 3 4; do
  d start '{"tool":"ping","host":"127.0.0.1","count":10}' > out-diag-cap-$c.json
  ids="$ids $(idof < out-diag-cap-$c.json)"
done
sleep 1
for id in $ids; do d stop "{\"id\":\"$id\"}" > /dev/null; done
sleep 1
ps | grep -c '[p]ing -c 10' > out-diag-cap.procs.txt || true
rm -rf /tmp/flab-diag /tmp/flab-diag-canary
'@
    Invoke-Remote ($diagScript.Replace('@REMOTE@', $remote))
    Invoke-Native 'scp' @('-O', "${Router}:$remote/out-diag-*", (Join-Path $work 'out'))

    Write-Host '3/3 Asserting'
    Invoke-Native 'node' @((Join-Path $here 'assert.mjs'), (Join-Path $work 'out'))

    if ($Browser) {
        Write-Host 'Browser test'
        foreach ($f in 'live.mjs', 'samples.mjs', 'samples-tools.mjs') { Copy-Item (Join-Path $here $f) $work }
        Push-Location $work
        try {
            Invoke-Native 'npm' @('init', '-y', '--silent')
            Invoke-Native 'npm' @('install', '--silent', 'playwright-core')
            $env:FLAB_URL = $Url
            $session = New-TestSession -Router $Router
            $sid = $session.Sid
            $env:FLAB_SID = $sid
            $env:FLAB_ACLS = $session.Acls
            Invoke-Native 'node' @('live.mjs')
        }
        finally {
            Pop-Location
        }
    }
}
finally {
    # Always remove the router-side work folder and the local one, even after a failure.
    Remove-TestSession -Router $Router -Sid $sid
    ssh $Router "rm -rf $remote /tmp/flab-diag /tmp/flab-diag-canary" 2>$null
    if (-not $KeepWork) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}
