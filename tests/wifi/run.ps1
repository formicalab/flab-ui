#Requires -Version 7.0
<#
.SYNOPSIS
Tests changing a radio's channel on the Wi-Fi page without changing the router's configuration.

.DESCRIPTION
1. Unit tests: the channel model (width, the block of channels a channel would occupy, what the draft changes,
   errors and warnings, the operations, the read-back check) and, from the network suite, the
   configuration-change helpers. They need no router.
2. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1). The page
   first shows the router's own radios with the channel picker built from their channel lists, and any write it
   tried would be blocked and fail the test. Then a mock of the radio and Wi-Fi plugins and a stateful mock of
   rpcd's `uci` object take over and the editing flow (hover previews, choosing, Auto, the review banner, a
   successful save, a change the router does not keep, a radio that does not come back, a login without write
   access, an expired session) is exercised without touching /etc/config/wireless.

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
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-wifi-test'

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
    Write-Host '1/2 Unit tests: channel model, configuration-change helpers'
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
