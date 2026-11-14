#Requires -Version 7.0
<#
.SYNOPSIS
Tests the network board of the Devices and Interfaces page (its model, the drawer and its layout) without changing the router.

.DESCRIPTION
1. Unit tests, no router needed: the board model (the lanes, the edges between ports, devices, interfaces and zones, protocol devices and tunnels,
   wireless, the draft's new and removed items, the highlighting set, findings and counts) and the pure parts of the drawer and of the bridge
   information.
2. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1) against the router's own data, READ ONLY
   (every uci write is blocked and fails the test): the board at 1920, 1280 and 900 px in the light and the dark theme (no sideways scrolling,
   nothing overflowing or overlapping, four lanes with connectors or stacked lanes), highlighting, the drawer (opening, replacing its content,
   keeping it over a poll, Escape, the close button, leaving the page), the Device menu, the Network-wide settings button and the old #bridges
   route. The panels' contents are tested by the Network editors suite.

-Browser needs ssh access to the router, the deployed UI (tools/apk-deploy.ps1 -Action Deploy), Node.js, and installs playwright-core into a
temporary work folder. The router session and the work folder are removed afterwards.

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

#region Setup
$here = $PSScriptRoot
. (Join-Path $here '..\TestSession.ps1')
$sid = $null
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-netboard-test'
#endregion

#region Run
try {
    Write-Host '1/2 Unit tests: board model, drawer, bridge information'
    Invoke-Native 'node' @((Join-Path $here 'boardmodel.test.mjs'))
    Invoke-Native 'node' @((Join-Path $here 'drawer.test.mjs'))

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
#endregion
