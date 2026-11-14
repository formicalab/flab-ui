#Requires -Version 7.0
<#
.SYNOPSIS
Tests the Traffic page (live throughput, the connection table and nlbwmon usage) without changing the router.

.DESCRIPTION
1. Unit tests of the page model (rates, summaries, formatting, findings, merging by MAC, filtering and sorting).
2. Captures what the flab.traffic plugin reads from the router (the connection table, the netfilter numbers, the DHCP
   and hosts data, read-only `nlbw` queries) as the "real" scenario.
3. Builds synthetic scenarios (every protocol, TCP state, NAT form and IPv6 spelling, entries without counters, a
   table of 60000 entries, nlbwmon with several periods, no nlbw, no conntrack, no accounting) and runs the
   repository's flab.traffic.uc on the router against every scenario (FLAB_FIXTURES), asserting the JSON against an
   independent reference. Every argument is also tried with shell metacharacters and out-of-range values, which must
   be refused before any command is built.
4. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1) and drives the
   Traffic page with mocked flab.traffic and flab.network replies: every tab, filter, selector and finding, and the
   case without nlbw. Nothing reaches the router's configuration.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (tools/package.ps1 -Action Deploy) and
installs playwright-core into the temporary work folder. Everything created on the router (/tmp/flab-traffic-test)
and locally is removed afterwards.

.PARAMETER Router
SSH destination of the router.

.PARAMETER Url
Base URL of the deployed UI (used by -Browser).

.PARAMETER Browser
Also run the browser test.
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
$plugin = Join-Path $root 'rpcd\ucode\flab.traffic.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-traffic-test'
$remote = '/tmp/flab-traffic-test'

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

    Write-Host '1/4 Unit tests: traffic model'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))

    Write-Host '2/4 Capturing the router (read-only: the connection table and nlbw queries)'
    Invoke-Remote "rm -rf $remote; mkdir -p $remote/fx-real"
    Invoke-Native 'scp' @('-O', '-r', $libs, $plugin, (Join-Path $here 'harness.uc'), "${Router}:$remote/")
    Invoke-Remote @"
set -e
cd $remote
for f in *.uc flab/*.uc; do tr -d '\r' < `$f > `$f.l && mv `$f.l `$f; done
cap() { FLAB_RECORD=$remote/fx-real FLAB_PLUGIN=$remote/flab.traffic.uc FLAB_METHOD=`$1 FLAB_ARGS="`$2" ucode -L "$remote/*.uc" harness.uc > /dev/null; }
cap status
cap connections '{}'
cap usage_periods
cap usage '{"period":"current","group":"mac,ip"}'
cap usage '{"period":"current","group":"ip"}'
cap usage '{"period":"current","group":"layer7"}'
cap usage '{"period":"current","group":"fam"}'
"@
    Invoke-Native 'scp' @('-O', '-r', "${Router}:$remote/fx-real", $work)

    Write-Host '3/4 Building scenarios and running the plugin on the router'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), $work)
    $scenarios = @(Get-Content (Join-Path $work 'scenarios.json') -Raw | ConvertFrom-Json)
    Invoke-Remote "mkdir -p $remote/out"
    Invoke-Native 'scp' (@('-O', '-r') + @($scenarios | ForEach-Object { Join-Path $work $_ }) + (Join-Path $work 'cases') + (Join-Path $work 'cases.txt') + "${Router}:$remote/")
    Invoke-Remote @"
set -e
cd $remote
while read -r name scenario method; do
  args=''
  [ -f cases/`$name.json ] && args="`$(cat cases/`$name.json)"
  budget=0
  case `$name in budget-*) budget=50;; esac
  FLAB_TRAFFIC_TODAY=2026-11-12 FLAB_TRAFFIC_BUDGET_MS=`$budget FLAB_PLUGIN=$remote/flab.traffic.uc FLAB_FIXTURES=$remote/`$scenario FLAB_METHOD=`$method FLAB_ARGS="`$args" FLAB_TIME_FILE=out/`$name.ms ucode -L "$remote/*.uc" harness.uc > out/`$name.json 2> err.txt || { echo "`$name failed:"; cat err.txt; exit 1; }
  if [ -s err.txt ]; then echo "`$name wrote to stderr:"; cat err.txt; exit 1; fi
done < cases.txt
"@
    Invoke-Native 'scp' @('-O', '-r', "${Router}:$remote/out", $work)

    Write-Host '4/4 Asserting'
    Invoke-Native 'node' @((Join-Path $here 'assert.mjs'), $work)

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
            Invoke-Native 'node' @('live.mjs', $work)
        }
        finally {
            Pop-Location
        }
    }
}
finally {
    # Always remove the router-side work folder and the local one, even after a failure.
    Remove-TestSession -Router $Router -Sid $sid
    ssh $Router "rm -rf $remote" 2>$null
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
