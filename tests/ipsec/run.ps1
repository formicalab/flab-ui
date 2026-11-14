#Requires -Version 7.0
<#
.SYNOPSIS
Tests the IPsec page against captured and synthetic strongSwan states without touching the router's tunnels.

.DESCRIPTION
1. Runs the throughput-history unit test (no router needed).
2. Captures the real swanctl/ip output the flab.ipsec plugin parses (read-only commands; key material in
   `ip xfrm state` is redacted on the router before it is copied).
3. Derives synthetic scenarios from it: a tunnel that is down, a child rekey overlap, a second IKE SA under
   one connection, SAs without configuration, IPv6 addresses and a stopped daemon.
4. Runs the repository's flab.ipsec.uc on the router against every scenario (FLAB_FIXTURES) and asserts the
   parsed JSON.
5. With -Browser, opens the deployed UI in Edge and drives the page through the scenarios live, checking
   that cards, badges and tiles follow the changes without a reload.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (tools/apk-deploy.ps1 -Action
Deploy) and installs playwright-core into the temporary work folder. Everything it creates on the router
(/tmp/flab-ipsec-test) and locally is removed afterwards.

.PARAMETER Router
SSH destination of the router.

.PARAMETER Url
Base URL of the deployed UI (used by -Browser).

.PARAMETER Browser
Also run the live-update browser test.
#>
[CmdletBinding()]
param(
    [string]$Router = 'root@openwrt.lab.formicalab.casa',
    [string]$Url = 'https://openwrt.lab.formicalab.casa/flab/',
    [switch]$Browser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
. (Join-Path $here '..\TestSession.ps1')
$sid = $null
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$plugin = Join-Path $root 'rpcd\ucode\flab.ipsec.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-ipsec-test'
$remote = '/tmp/flab-ipsec-test'
# Scenario directories built by mkfx.mjs (base = unchanged capture); each is also the name of its output JSON.
$scenarios = 'base', 'down', 'rekey', 'multi', 'orphan', 'ipv6', 'daemondown', 'unconfigured'

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

    #region Unit test
    Write-Host '1/5 Throughput history unit test'
    Invoke-Native 'node' @((Join-Path $here 'rates.test.mjs'))
    #endregion

    #region Capture the real baseline
    Write-Host '2/5 Capturing real strongSwan output'
    # Single-quoted so PowerShell leaves the shell syntax alone; @R@ is replaced by the remote folder.
    $capture = @'
set -e
d=@R@/fx-real
rm -rf @R@; mkdir -p $d
swanctl --list-conns --raw 2>/dev/null > $d/swanctl_list_conns_raw.txt
swanctl --list-sas --raw 2>/dev/null > $d/swanctl_list_sas_raw.txt
swanctl --stats --raw 2>/dev/null > $d/swanctl_stats_raw.txt
swanctl --version 2>/dev/null > $d/swanctl_version.txt
ip -s xfrm state 2>/dev/null | sed -E 's/^([[:space:]]+(aead|enc|auth-trunc|auth) [^ ]+) 0x[0-9a-f]+/\1 0x00/' > $d/ip_s_xfrm_state.txt
uci -q show network | grep -E '^network\.xfrm' > $d/uci.txt
for i in $(sed -n "s/^network\.\(xfrm[0-9]*\)\.proto='xfrm'$/\1/p" $d/uci.txt); do
  ip -o addr show dev $i > $d/ip_o_addr_show_dev_$i.txt 2>&1
  ubus call network.device status "{\"name\":\"$i\"}" > $d/dev_$i.json
done
'@
    Invoke-Remote ($capture -replace '@R@', $remote)
    Invoke-Native 'scp' @('-O', '-r', "${Router}:$remote/fx-real", $work)
    #endregion

    #region Build scenarios and run the plugin against them on the router
    Write-Host '3/5 Building scenarios'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), $work)

    Write-Host '4/5 Running flab.ipsec against each scenario on the router'
    Invoke-Native 'scp' (@('-O', '-r') + @($scenarios | ForEach-Object { Join-Path $work $_ }) + "${Router}:$remote/")
    Invoke-Native 'scp' @('-O', $plugin, (Join-Path $here 'harness.uc'), "${Router}:$remote/")
    Invoke-Native 'scp' @('-O', '-r', $libs, "${Router}:$remote/")
    # ucode -L puts the uploaded libraries ahead of the deployed ones, so the repository code is what runs.
    Invoke-Remote @"
set -e
cd $remote
tr -d '\r' < flab.ipsec.uc > p.uc; tr -d '\r' < harness.uc > h.uc
for f in flab/*.uc; do tr -d '\r' < `$f > `$f.l && mv `$f.l `$f; done
sed -i "s#/tmp/flab.ipsec.uc#$remote/p.uc#" h.uc
for sc in $($scenarios -join ' '); do
  for f in `$sc/*; do tr -d '\r' < `$f > `$f.l && mv `$f.l `$f; done
  FLAB_FIXTURES=$remote/`$sc ucode -L "$remote/*.uc" h.uc > out-`$sc.json 2> err-`$sc.txt || { echo "`$sc failed:"; cat err-`$sc.txt; exit 1; }
  if [ -s err-`$sc.txt ]; then echo "`$sc wrote to stderr:"; cat err-`$sc.txt; exit 1; fi
done
"@
    foreach ($sc in $scenarios) {
        Invoke-Native 'scp' @('-O', "${Router}:$remote/out-$sc.json", (Join-Path $work "out\$sc.json"))
    }
    Copy-Item (Join-Path $work 'names.json') (Join-Path $work 'out\names.json')
    #endregion

    #region Assert
    Write-Host '5/5 Asserting'
    Invoke-Native 'node' @((Join-Path $here 'assert.mjs'), (Join-Path $work 'out'))

    if ($Browser) {
        Write-Host 'Browser test'
        Copy-Item (Join-Path $here 'live.mjs') $work
        Push-Location $work
        try {
            Invoke-Native 'npm' @('init', '-y', '--silent')
            Invoke-Native 'npm' @('install', '--silent', 'playwright-core')
            $env:FLAB_URL = $Url
            $session = New-TestSession -Router $Router
            $sid = $session.Sid
            $env:FLAB_SID = $sid
            $env:FLAB_ACLS = $session.Acls
            Invoke-Native 'node' @('live.mjs', (Join-Path $work 'out'))
        }
        finally {
            Pop-Location
        }
    }
    #endregion
}
finally {
    # Always remove the router-side work folder and the local one, even after a failure.
    Remove-TestSession -Router $Router -Sid $sid
    ssh $Router "rm -rf $remote" 2>$null
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
