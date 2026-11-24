#Requires -Version 7.0
<#
.SYNOPSIS
Tests the flab.asterisk plugin against captured and synthetic Asterisk states without touching the PBX.

.DESCRIPTION
1. Runs the pure model tests of the Asterisk page (dialplan matching, routing map, PJSIP view model); no router needed.
2. Captures the real CLI output, configuration files and log tail the plugin reads, using the plugin's own FLAB_RECORD seam. Everything it
   runs on the router is read only (`asterisk -rx 'show ...'` commands and file reads).
3. Derives synthetic scenarios from the capture: Asterisk unreachable, stopped, disabled or not installed, a rejected registration, a call
   in progress, no PJSIP, a configuration file changed after the last reload, a fresh error in the log, many endpoints, and secrets in
   every place the plugin reads.
4. Runs the repository's flab.asterisk.uc on the router against every scenario (FLAB_FIXTURES) and asserts the JSON.

Needs ssh/scp access to a router with Asterisk, and Node.js. Everything it creates on the router (/tmp/flab-asterisk-test) and locally is
removed afterwards. The secrets of the captured router stay only in the temporary folders.

.PARAMETER Router
SSH destination of the router.

.PARAMETER Url
Base URL of the deployed UI (used by -Browser).

.PARAMETER Browser
Also drive the deployed page in Edge with the scenarios (live.mjs). Needs the page deployed (tools/package.ps1 -Action Sync -Backend) and
installs playwright-core into the temporary work folder.

.PARAMETER Keep
Leave the work folders (local and on the router) in place, for debugging a failing scenario.
#>
[CmdletBinding()]
param(
    [string]$Router = 'root@openwrt.lab.formicalab.casa',
    [string]$Url = 'https://openwrt.lab.formicalab.casa/flab/',
    [switch]$Browser,
    [switch]$Keep
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
. (Join-Path $here '..\TestSession.ps1')
$sid = $null
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$plugin = Join-Path $root 'rpcd\ucode\flab.asterisk.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-asterisk-test'
$remote = '/tmp/flab-asterisk-test'
$scenarios = 'base', 'unreachable', 'stopped', 'disabled', 'notinstalled', 'regfail', 'calls', 'nopjsip', 'changed', 'recenterr', 'benignerr', 'many', 'secrets'
# Output name -> method and JSON arguments, run for every scenario unless listed in $baseOnly.
$methods = [ordered]@{
    'status'            = @('status', '{}')
    'pjsip'             = @('pjsip', '{}')
    'dialplan'          = @('dialplan', '{}')
    'config'            = @('config', '{}')
    'config.pjsip'      = @('config', '{"file":"pjsip.conf"}')
    'config.extensions' = @('config', '{"file":"extensions.conf"}')
    'endpoint'          = @('endpoint', '{"name":"Vodafone"}')
    'reload.core'       = @('reload', '{"what":"core"}')
    'reload.pjsip'      = @('reload', '{"what":"pjsip"}')
}
$baseOnly = [ordered]@{
    'reload.dialplan' = @('reload', '{"what":"dialplan"}')
    'reload.bad'      = @('reload', '{"what":"core; reboot"}')
    'reload.none'     = @('reload', '{}')
    'resolve.ok'      = @('resolve', '{"context":"from-internal","exten":"6000"}')
    'resolve.none'    = @('resolve', '{"context":"from-pstn","exten":"99999"}')
    'resolve.badctx'  = @('resolve', '{"context":"x\u0027; reboot; \u0027","exten":"6000"}')
    'resolve.badnum'  = @('resolve', '{"context":"from-internal","exten":"1 2"}')
    'endpoint.bad'    = @('endpoint', '{"name":"-x; reboot"}')
    'config.bad'      = @('config', '{"file":"../shadow"}')
}

function Invoke-Remote {
    <#
    .SYNOPSIS
    Runs a POSIX shell script on the router over ssh, with LF line endings (BusyBox sh rejects CRLF).
    .PARAMETER Script
    Shell script text.
    #>
    param([string]$Script)

    # The script goes in on stdin: a long command line is refused by some SSH servers. PowerShell ends the piped text with CR LF, so the
    # last line is a comment that swallows the CR.
    (($Script -replace "`r`n", "`n") + "`n# end") | & ssh $Router 'sh -s'
    if ($LASTEXITCODE -ne 0) { throw "ssh failed with exit code $LASTEXITCODE" }
}

try {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory (Join-Path $work 'out') -Force | Out-Null

    Write-Host '1/5 Pure model tests'
    $models = @(Get-ChildItem $here -Filter '*.test.mjs' | ForEach-Object FullName)
    if ($models) { Invoke-Native 'node' (@('--experimental-vm-modules', '--test') + $models) }

    Write-Host '2/5 Uploading the plugin and capturing real Asterisk output'
    Invoke-Remote "rm -rf $remote; mkdir -p $remote/fx-real"
    Invoke-Native 'scp' @('-O', $plugin, (Join-Path $here 'harness.uc'), "${Router}:$remote/")
    Invoke-Native 'scp' @('-O', '-r', $libs, "${Router}:$remote/")
    # ucode -L puts the uploaded libraries ahead of the deployed ones, so the repository code is what runs.
    $capture = @'
set -e
cd @R@
tr -d '\r' < flab.asterisk.uc > p.uc; tr -d '\r' < harness.uc > h.uc
for f in flab/*.uc; do tr -d '\r' < $f > $f.l && mv $f.l $f; done
sed -i "s#/tmp/flab.asterisk.uc#@R@/p.uc#" h.uc
d=@R@/fx-real
date +%s > $d/clock.txt
date '+%b %e %H:%M:%S' > $d/now-log.txt
run() { FLAB_RECORD=$d FLAB_METHOD=$1 FLAB_ARGS="$2" ucode -L "@R@/*.uc" h.uc > /dev/null; }
for m in status pjsip dialplan config; do run $m '{}'; done
run config '{"file":"pjsip.conf"}'
run config '{"file":"extensions.conf"}'
run endpoint '{"name":"Vodafone"}'
'@
    Invoke-Remote ($capture -replace '@R@', $remote)
    Invoke-Native 'scp' @('-O', '-r', "${Router}:$remote/fx-real", $work)

    Write-Host '3/5 Building scenarios'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), $work)

    Write-Host '4/5 Running flab.asterisk against each scenario on the router'
    Invoke-Native 'scp' (@('-O', '-r') + @($scenarios | ForEach-Object { Join-Path $work $_ }) + "${Router}:$remote/")
    $lines = foreach ($sc in $scenarios) {
        $set = @($methods.GetEnumerator())
        if ($sc -eq 'base') { $set += @($baseOnly.GetEnumerator()) }
        foreach ($entry in $set) {
            $method, $json = $entry.Value
            "FLAB_FIXTURES=$remote/$sc FLAB_METHOD=$method FLAB_ARGS='$json' ucode -L `"$remote/*.uc`" h.uc > out-$sc.$($entry.Key).json 2> err.txt || { echo `"$sc $($entry.Key) failed:`"; cat err.txt; exit 1; }"
            "[ -s err.txt ] && { echo `"$sc $($entry.Key) wrote to stderr:`"; cat err.txt; exit 1; }"
        }
    }
    Invoke-Remote ("set -e`ncd $remote`nfor sc in $($scenarios -join ' '); do for f in `$sc/*; do tr -d '\r' < `$f > `$f.l && mv `$f.l `$f; done; done`n" + ($lines -join "`n") + "`ntrue")
    Invoke-Native 'scp' @('-O', "${Router}:$remote/out-*.json", (Join-Path $work 'out'))
    Get-ChildItem (Join-Path $work 'out') -Filter 'out-*.json' | Rename-Item -NewName { $_.Name -replace '^out-', '' }

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
}
finally {
    if ($sid) { Remove-TestSession -Router $Router -Sid $sid }
    if (-not $Keep) {
        ssh $Router "rm -rf $remote" 2>$null
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
