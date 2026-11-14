#Requires -Version 7.0
<#
.SYNOPSIS
Tests the DNS page (the state of the router's resolver, Unbound or dnsmasq) without changing the router.

.DESCRIPTION
1. Unit tests of the page model (tiles, findings, activity, configuration rows) and of the zones (Unbound's zone blocks of every
   type and dnsmasq's server entries: drafts, changes, validation, the UCI operations, the checks after a save).
2. Captures what the flab.dns plugin reads from the router (service list, sockets, UCI, unbound-control or dnsmasq
   metrics, all read-only) as the "real" scenario.
3. Builds synthetic scenarios (Unbound with and without extended statistics, Unbound without its control channel, lists
   that are cut, dnsmasq, both engines, stopped, none) and runs the repository's flab.dns.uc on the router against every
   scenario (FLAB_FIXTURES), asserting the JSON. A call with shell metacharacters as arguments must give the same reply
   and create no file.
4. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1) and drives the DNS
   page with mocked flab.dns replies: every tile, finding and card, both engines, no resolver, the folded Zones card with its filter,
   and adding, editing, removing and saving zones in the dialog. The uci object is a stateful mock; nothing reaches the router's
   configuration.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (tools/apk-deploy.ps1 -Action Deploy) and
installs playwright-core into the temporary work folder. Everything created on the router (/tmp/flab-dns-test) and
locally is removed afterwards.

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
$plugin = Join-Path $root 'rpcd\ucode\flab.dns.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-dns-test'
$remote = '/tmp/flab-dns-test'

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

    Write-Host '1/4 Unit tests: DNS model'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))
    Invoke-Native 'node' @((Join-Path $here 'zones.test.mjs'))

    Write-Host '2/4 Capturing the router (read-only: service list, sockets, UCI, unbound-control or dnsmasq metrics)'
    Invoke-Remote "rm -rf $remote; mkdir -p $remote/fx-real"
    Invoke-Native 'scp' @('-O', '-r', $libs, $plugin, (Join-Path $here 'harness.uc'), "${Router}:$remote/")
    Invoke-Remote @"
set -e
cd $remote
for f in *.uc flab/*.uc; do tr -d '\r' < `$f > `$f.l && mv `$f.l `$f; done
FLAB_RECORD=$remote/fx-real FLAB_PLUGIN=$remote/flab.dns.uc FLAB_METHOD=status ucode -L "$remote/*.uc" harness.uc > /dev/null
"@
    Invoke-Native 'scp' @('-O', '-r', "${Router}:$remote/fx-real", $work)

    Write-Host '3/4 Building scenarios and running the plugin on the router'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), $work)
    $scenarios = @(Get-Content (Join-Path $work 'scenarios.json') -Raw | ConvertFrom-Json)
    Invoke-Remote "mkdir -p $remote/out; rm -f /tmp/flab-dns-canary"
    Invoke-Native 'scp' (@('-O', '-r') + @($scenarios | ForEach-Object { Join-Path $work $_ }) + (Join-Path $work 'cases') + (Join-Path $work 'cases.txt') + "${Router}:$remote/")
    Invoke-Remote @"
set -e
cd $remote
while read -r name scenario method; do
  args=''
  [ -f cases/`$name.json ] && args="`$(cat cases/`$name.json)"
  FLAB_PLUGIN=$remote/flab.dns.uc FLAB_FIXTURES=$remote/`$scenario FLAB_METHOD=`$method FLAB_ARGS="`$args" ucode -L "$remote/*.uc" harness.uc > out/`$name.json 2> err.txt || { echo "`$name failed:"; cat err.txt; exit 1; }
  if [ -s err.txt ]; then echo "`$name wrote to stderr:"; cat err.txt; exit 1; fi
done < cases.txt
if [ -e /tmp/flab-dns-canary ]; then echo 'canary file exists: a request value reached a shell'; rm -f /tmp/flab-dns-canary; exit 1; fi
"@
    Invoke-Native 'scp' @('-O', '-r', "${Router}:$remote/out", $work)

    Write-Host '4/4 Asserting'
    Invoke-Native 'node' @((Join-Path $here 'assert.mjs'), $work)
    Write-Host 'PASS  the canary file of the call with shell metacharacters does not exist on the router'

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
    ssh $Router "rm -rf $remote /tmp/flab-dns-canary" 2>$null
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
