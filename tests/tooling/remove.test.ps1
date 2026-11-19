#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '..\..\tools\package.ps1') -Action Remove

function Assert-Remove {
    <#
    .SYNOPSIS
    Asserts an expected removal workflow result.
    .DESCRIPTION
    Stops immediately when the simulated router state differs from the expected result.
    .PARAMETER Condition
    Whether the invariant holds.
    .PARAMETER Message
    Failure explanation.
    #>
    param([bool]$Condition, [string]$Message)

    if (-not $Condition) { throw $Message }
}

$installed = [Collections.Generic.List[string]]::new()
$removed = [Collections.Generic.List[string]]::new()
$leftovers = [Collections.Generic.List[string]]::new()
$objects = [Collections.Generic.List[string]]::new()

function Invoke-Remote {
    <#
    .SYNOPSIS
    Simulates the router operations used by removal.
    .DESCRIPTION
    Maintains installed package and residual state so the production removal and verification functions are exercised.
    .PARAMETER Script
    Router shell script.
    .OUTPUTS
    Simulated router command output.
    #>
    param([Parameter(Mandatory)][string]$Script)

    if ($Script -match "apk info 2>/dev/null \| grep") {
        return @($installed)
    }
    if ($Script -match '(?m)^apk del (.+)$') {
        $removed.AddRange([string[]](($Matches[1] -split '\s+') | Where-Object { $_ }))
        $installed.Clear()
    }
    if ($Script -match 'rm -rf /www/flab') {
        $leftovers.Clear()
        $objects.Clear()
    }
    if ($Script -match '\[ ! -e "\$path" \]') {
        return @($leftovers)
    }
    if ($Script -match 'ubus list \| grep') {
        return @($objects)
    }
    return @()
}

foreach ($scenario in @(
    @{
        Name = 'full installation'
        Installed = @('flab-ui', 'flab-ui-base', 'flab-ui-mod-dns', 'flab-ui-mod-network')
    },
    @{
        Name = 'partial installation'
        Installed = @('flab-ui-base', 'flab-ui-mod-dns')
    },
    @{
        Name = 'already removed'
        Installed = @()
    }
)) {
    $installed.Clear()
    $installed.AddRange([string[]]$scenario.Installed)
    $removed.Clear()
    $leftovers.Clear()
    $objects.Clear()
    if ($installed.Count) {
        $leftovers.Add('/www/flab/index.html')
        $objects.Add('flab.system')
    }

    Remove-FlabPackages

    Assert-Remove ($installed.Count -eq 0) "Packages remain after $($scenario.Name)."
    Assert-Remove ($leftovers.Count -eq 0) "Files remain after $($scenario.Name)."
    Assert-Remove ($objects.Count -eq 0) "ubus objects remain after $($scenario.Name)."
    $expected = @($scenario.Installed | Sort-Object)
    $actual = @($removed | Sort-Object)
    $difference = if ($expected.Count -ne $actual.Count) {
        $true
    }
    else {
        @(Compare-Object $expected $actual).Count -ne 0
    }
    Assert-Remove (-not $difference) "Removed package set differs for $($scenario.Name): expected '$($expected -join ', ')', actual '$($actual -join ', ')'."
    Write-Host "PASS removal: $($scenario.Name)"
}

$leftovers.Add('/www/flab/stale.js')
try {
    Test-FlabRemoved
    throw 'Removal verification accepted a stale flab-ui file.'
}
catch {
    if ($_ -notlike '*flab-ui files remain on the router*') { throw }
}
Write-Host 'PASS removal: stale files are rejected'
