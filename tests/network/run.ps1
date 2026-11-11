#Requires -Version 7.0
<#
.SYNOPSIS
Tests the Network, Bridges, Devices and Interfaces, Wi-Fi radio, Mesh, WireGuard and Firewall pages against captured and synthetic router states without changing the router.

.DESCRIPTION
1. Runs the rate-tracker, network-layer and firewall-matrix unit tests (no router needed).
2. Captures what the flab.network, flab.radio, flab.mesh, flab.wireguard and flab.firewall plugins read by running
   each once on the router with FLAB_RECORD set (keys and passwords are blanked while recording).
3. Derives synthetic scenarios: link down, downshifted link, STP root / blocked port / STP off, VLAN
   filtering, a second bridge, a high bridge port number, no devices, a radio that is down or disabled,
   DFS, a channel change, a new SSID, mesh peers and paths, WireGuard peers (stale, never connected,
   interface down, new peer at run time, no firewall zone, no WireGuard at all) and firewall states (no nftables,
   a port forward, an open WAN, a disabled or unnamed rule, an interface in no zone, a full connection table).
4. Runs the repository's plugins on the router against every scenario (FLAB_FIXTURES) and asserts the JSON,
   including that no secret is forwarded.
5. With -Browser, opens the deployed UI in Edge and drives the pages through the scenarios live,
   checking that tiles, port tiles, bridge cards, radio cards, mesh and WireGuard cards and findings follow
   without a reload.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (deploy.ps1 -Action
Deploy) and installs playwright-core into the temporary work folder. Everything it creates on the router
(/tmp/flab-net-test) and locally is removed afterwards.

.PARAMETER Router
SSH destination of the router.

.PARAMETER Url
Base URL of the deployed UI (used by -Browser).

.PARAMETER Password
Password of the 'flab' rpcd login (used by -Browser).

.PARAMETER Browser
Also run the live-update browser test.
#>
[CmdletBinding()]
param(
    [string]$Router = 'root@openwrt.lab.formicalab.casa',
    [string]$Url = 'https://openwrt.lab.formicalab.casa/flab/',
    [string]$Password = 'flab',
    [switch]$Browser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$plugins = 'flab.network', 'flab.radio', 'flab.mesh', 'flab.wireguard', 'flab.firewall'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-net-test'
$remote = '/tmp/flab-net-test'

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

    #region Unit test
    Write-Host '1/5 Rate tracker and network layer unit tests'
    Invoke-Native 'node' @((Join-Path $here 'rates.test.mjs'))
    Invoke-Native 'node' @((Join-Path $here 'layers.test.mjs'))
    Invoke-Native 'node' @((Join-Path $here 'firewall.test.mjs'))
    #endregion

    #region Capture the real baseline
    Write-Host '2/5 Capturing real router state'
    Invoke-Remote "rm -rf $remote; mkdir -p $remote/fx-real"
    Invoke-Native 'scp' (@('-O', '-r', $libs, (Join-Path $here 'harness.uc')) + @($plugins | ForEach-Object { Join-Path $root "rpcd\ucode\$_.uc" }) + "${Router}:$remote/")
    # The plugins record everything they read (FLAB_RECORD, see rpcd/lib/flab/util.uc), so the capture is
    # simply one real run of each plugin. Keys and passwords are blanked while recording. ucode -L puts the
    # uploaded libraries ahead of the deployed ones, so the repository code is what runs.
    Invoke-Remote @"
set -e
cd $remote
for f in *.uc flab/*.uc; do tr -d '\r' < `$f > `$f.l && mv `$f.l `$f; done
for p in $($plugins -join ' '); do
  FLAB_RECORD=$remote/fx-real FLAB_PLUGIN=$remote/`$p.uc ucode -L "$remote/*.uc" harness.uc > /dev/null
done
"@
    Invoke-Native 'scp' @('-O', '-r', "${Router}:$remote/fx-real", $work)
    #endregion

    #region Build scenarios and run the plugins against them on the router
    Write-Host '3/5 Building scenarios'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), $work)
    $scenarios = @(Get-Content (Join-Path $work 'scenarios.json') -Raw | ConvertFrom-Json)

    Write-Host '4/5 Running the plugins against each scenario on the router'
    Invoke-Native 'scp' (@('-O', '-r') + @($scenarios | ForEach-Object { Join-Path $work $_ }) + "${Router}:$remote/")
    Invoke-Remote @"
set -e
cd $remote
for sc in $($scenarios -join ' '); do
  for p in $($plugins -join ' '); do
    FLAB_PLUGIN=$remote/`$p.uc FLAB_FIXTURES=$remote/`$sc ucode -L "$remote/*.uc" harness.uc > out-`$sc.`$p.json 2> err-`$sc.`$p.txt || { echo "`$sc/`$p failed:"; cat err-`$sc.`$p.txt; exit 1; }
    if [ -s err-`$sc.`$p.txt ]; then echo "`$sc/`$p wrote to stderr:"; cat err-`$sc.`$p.txt; exit 1; fi
  done
done
"@
    foreach ($sc in $scenarios) {
        foreach ($p in $plugins) {
            Invoke-Native 'scp' @('-O', "${Router}:$remote/out-$sc.$p.json", (Join-Path $work "out\$sc.$p.json"))
        }
    }
    Copy-Item (Join-Path $work 'expect.json') (Join-Path $work 'out\expect.json')
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
            $env:FLAB_PASSWORD = $Password
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
    ssh $Router "rm -rf $remote" 2>$null
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
