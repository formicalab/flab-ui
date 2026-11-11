#Requires -Version 7.0
<#
.SYNOPSIS
Tests the DHCP page (odhcpd leases, reservations and settings) without changing the router's configuration.

.DESCRIPTION
1. Unit tests: the page model (option tables, address and range helpers, reading the config and the lease data,
   validation, the change plan and the read-back check) and, from the network suite, the configuration-change
   helpers. They need no router.
2. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1). The page
   first shows the router's own leases, reservations and pools, and any write it tried would be blocked and fail
   the test. Then a stateful mock of rpcd's `uci` object, of odhcpd's `dhcp` object and of the interfaces takes
   over and the editing flow (validation, reserving a lease, editing a pool and the daemon, saving, a change the
   router does not keep, a stopped odhcpd, a login without write access, an expired session) is exercised without
   touching /etc/config/dhcp.

-Browser needs ssh access to the router, the deployed UI (deploy.ps1 -Action Deploy), Node.js, and installs
playwright-core into a temporary work folder. The router session and the work folder are removed afterwards.

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
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-dhcp-test'

function Invoke-Native {
    <#
    .SYNOPSIS
    Runs a native command and throws on a nonzero exit code.
    .PARAMETER Command
    Executable name.
    .PARAMETER Arguments
    Argument array passed to the executable.
    #>
    param([string]$Command, [string[]]$Arguments)

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

try {
    Write-Host '1/2 Unit tests: DHCP model, configuration-change helpers'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))
    Invoke-Native 'node' @((Join-Path $here '..\network\uci.test.mjs'))

    if ($Browser) {
        Write-Host '2/2 Browser test'
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory $work -Force | Out-Null
        Copy-Item (Join-Path $here 'live.mjs') $work
        Push-Location $work
        try {
            Invoke-Native 'npm' @('init', '-y', '--silent')
            Invoke-Native 'npm' @('install', '--silent', 'playwright-core')
            $session = New-TestSession -Router $Router
            $sid = $session.Sid
            $env:FLAB_URL = $Url
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
    Remove-TestSession -Router $Router -Sid $sid
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
