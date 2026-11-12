#Requires -Version 7.0
<#
.SYNOPSIS
Tests the System settings page without changing the router's configuration.

.DESCRIPTION
1. Unit tests: the page model (the option table, validation, the change plan, the zone table) and, from the
   network suite, the configuration-change helpers (staging, apply with rollback, the session ACL check).
   They need no router.
2. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1). The page
   first reads the router's own /etc/config/system, and any write it tried would be blocked and fail the test.
   Then a stateful mock of rpcd's `uci` object, the clock and the NTP client takes over and the editing flow
   (validation, review, save, a change the router does not keep, a late confirmation, an expired session, a login
   without write access) is exercised without touching /etc/config/system.

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

#region Setup
$here = $PSScriptRoot
. (Join-Path $here '..\TestSession.ps1')
$sid = $null
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-settings-test'
#endregion

#region Run
try {
    Write-Host '1/2 Unit tests: page model and zone table, configuration-change helpers'
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
#endregion
