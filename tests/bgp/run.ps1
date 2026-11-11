#Requires -Version 7.0
<#
.SYNOPSIS
Tests the BGP page against captured and synthetic BIRD states without touching the router's BGP sessions.

.DESCRIPTION
1. Captures the real birdc/ip output the flab.bgp plugin parses (read-only commands).
2. Derives synthetic scenarios from it: a peer that is down, a dual-stack setup with IPv6 routes and
   changed announcements.
3. Runs the repository's flab.bgp.uc on the router against every scenario (FLAB_BGP_FIXTURES) and
   asserts the parsed JSON.
4. With -Browser, opens the deployed UI in Edge and drives the page through the scenarios live, checking
   that peers, routes, announcements, health findings and colors update without a reload.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (deploy.ps1 -Action
Deploy) and installs playwright-core into the temporary work folder. Everything it creates on the router
(/tmp/flab-bgp-test) and locally is removed afterwards.

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
$plugin = (Resolve-Path (Join-Path $here '..\..\rpcd\ucode\flab.bgp.uc')).Path
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-bgp-test'
$remote = '/tmp/flab-bgp-test'
# Scenario directories built by mkfx.mjs (base = unchanged capture); each is also the name of its output JSON.
$scenarios = 'base', 'down', 'dual', 'announce'

#region Helpers
function Invoke-Native {
    <#
    .SYNOPSIS
    Runs a native command and throws on a nonzero exit code.
    .DESCRIPTION
    Arguments are passed as an array so options such as scp's -O are not parsed as PowerShell parameters.
    .PARAMETER Command
    Executable name.
    .PARAMETER Arguments
    Argument array passed to the executable.
    #>
    param([string]$Command, [string[]]$Arguments)

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

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

    #region Capture the real baseline
    Write-Host '1/4 Capturing real BIRD output'
    Invoke-Remote @"
set -e
d=$remote/fx-real
rm -rf $remote; mkdir -p `$d
birdc show status        > `$d/show_status.txt 2>&1
birdc show protocols all > `$d/show_protocols_all.txt 2>&1
birdc show route all     > `$d/show_route_all.txt 2>&1
birdc show memory        > `$d/show_memory.txt 2>&1
for p in `$(birdc show protocols | awk '/ BGP /{print `$1}'); do birdc show route export `$p > `$d/show_route_export_`$p.txt 2>&1; done
/sbin/ip -4 route show proto bird > `$d/ip4.txt 2>&1
/sbin/ip -6 route show proto bird > `$d/ip6.txt 2>&1
"@
    Invoke-Native 'scp' @('-O', '-r', "${Router}:$remote/fx-real", $work)
    #endregion

    #region Build scenarios and run the plugin against them on the router
    Write-Host '2/4 Building scenarios'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), $work)

    Write-Host '3/4 Running flab.bgp against each scenario on the router'
    Invoke-Native 'scp' (@('-O', '-r') + @($scenarios | ForEach-Object { Join-Path $work $_ }) + "${Router}:$remote/")
    Invoke-Native 'scp' @('-O', $plugin, (Join-Path $here 'harness.uc'), "${Router}:$remote/")
    Invoke-Remote @"
set -e
cd $remote
tr -d '\r' < flab.bgp.uc > p.uc; tr -d '\r' < harness.uc > h.uc
sed -i "s#/tmp/flab.bgp.uc#$remote/p.uc#" h.uc
for sc in $($scenarios -join ' '); do
  for f in `$sc/*.txt; do tr -d '\r' < `$f > `$f.l && mv `$f.l `$f; done
  FLAB_BGP_FIXTURES=$remote/`$sc ucode h.uc > out-`$sc.json 2> err-`$sc.txt || { echo "`$sc failed:"; cat err-`$sc.txt; exit 1; }
  if [ -s err-`$sc.txt ]; then echo "`$sc wrote to stderr:"; cat err-`$sc.txt; exit 1; fi
done
"@
    foreach ($sc in $scenarios) {
        Invoke-Native 'scp' @('-O', "${Router}:$remote/out-$sc.json", (Join-Path $work "out\$sc.json"))
    }
    #endregion

    #region Assert
    Write-Host '4/4 Asserting'
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
