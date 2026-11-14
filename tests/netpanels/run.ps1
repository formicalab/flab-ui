#Requires -Version 7.0
<#
.SYNOPSIS
Tests the side panels and the "New network" wizard of the Devices and Interfaces page. It needs no router and never touches one.

.DESCRIPTION
1. Unit tests of the panels' pure model (www/js/pages/interfaces/panelmodel.js and wizardmodel.js): protocol cards, essential and advanced options, the
   device chooser, what a change of protocol drops, what an interface or device is used by, a free private /24 and name suggestions, and the effects of
   each wizard choice on the draft, its validation and the UCI plan it produces.
2. With -Browser, serves the UI from this checkout with a tiny local web server and opens harness.html in Edge. The page mounts the real panels in the
   real drawer and the real wizard against a stateful mock of the network configuration: protocol cards, essential and advanced options, the device
   chooser, the bridge ports picker, VLAN and port panels, read-only protocols, the write-only password, a login that may not write, the wizard from start
   to finish with its validation, the saved result read back through the model's own check, wrapping at several widths, light and dark. No request to a
   router is possible: the test fails if the page asks for anything outside the local server (such as /ubus).

Needs Node.js. -Browser also needs Edge and installs playwright-core into a temporary work folder, removed afterwards. Set FLAB_SHOTS to a folder to
keep screenshots.

.PARAMETER Browser
Also run the browser test.
#>
[CmdletBinding()]
param(
    [switch]$Browser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
. (Join-Path $here '..\TestSession.ps1')
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-netpanels-test'

try {
    Write-Host '1/2 Unit tests: the panels and wizard model'
    Invoke-Native 'node' @((Join-Path $here 'panelmodel.test.mjs'))

    if ($Browser) {
        Write-Host '2/2 Browser test'
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory $work -Force | Out-Null
        Copy-Item (Join-Path $here 'live.mjs') $work
        Push-Location $work
        try {
            Invoke-Native 'npm' @('init', '-y', '--silent')
            Invoke-Native 'npm' @('install', '--silent', 'playwright-core')
            $env:FLAB_ROOT = $root
            Invoke-Native 'node' @('live.mjs')
        }
        finally {
            Pop-Location
        }
    }
}
finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
