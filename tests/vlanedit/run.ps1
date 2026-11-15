#Requires -Version 7.0
<#
.SYNOPSIS
Tests the VLAN editor of the Ethernet page without changing the router.

.DESCRIPTION
1. Unit tests of the editor's model (reading the VLAN sections of the network config, the editable tables, the draft, the review
   list, validation and warnings, the UCI operations, the check after a save), for DSA bridges and swconfig switches.
2. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1). The Ethernet page is first
   shown against the router's own configuration with every write blocked (and failing the test if one is attempted): the editor opens
   and closes, reads only sections of one type from the network config (never the whole config, which holds secrets) and stages
   nothing. Then the whole editing flow is driven against a stateful mock of rpcd's uci object and a flab.network status that
   follows the mocked config: bridge VLANs (cells, adding and removing a VLAN, validation, VLAN filtering, warnings, a change the
   router does not keep, a refused confirmation, leftovers staged in the session), a swconfig switch (an older board; this
   repository's router has none, so it exists only in the mock), a login without write permission and an expired session. The
   router's configuration is never touched.

There is no backend part: the editor adds no plugin and reads the config through rpcd's uci object.

Needs ssh access to the router and Node.js. -Browser also needs the deployed UI (tools/package.ps1) and installs playwright-core into the
temporary work folder; the work folder is removed afterwards.

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
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-vlanedit-test'

try {
    Write-Host '1/2 Unit tests: the VLAN editor model'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))

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
    # Always remove the session and the local folder, even after a failure.
    Remove-TestSession -Router $Router -Sid $sid
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
